import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  APPROVED_OPENROUTER_ORIGIN,
  OpenRouterApiAdapter,
} from '../packages/runtime-adapters/openai-compat/openrouter-adapter.ts'
import { assertPinnedHttpsOriginUrl } from '../packages/runtime-adapters/openai-compat/openai-compatible-transport.ts'
import { GhostBotDaemon } from '../apps/daemon/src/server.ts'
import { InMemoryTestSecretStore } from '../apps/daemon/src/secrets/store.ts'

async function apiJson<T>(
  port: number,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  const data = (text ? JSON.parse(text) : {}) as T
  return { status: res.status, data }
}

async function waitForRunTerminal(
  port: number,
  token: string,
  runId: string,
  timeoutMs = 8000,
): Promise<{
  status: string
  error: { code: string; message: string } | null
}> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await apiJson<{
      status: string
      error: { code: string; message: string } | null
    }>(port, token, 'GET', `/runs/${runId}`)
    assert.equal(res.status, 200)
    if (
      res.data.status === 'completed' ||
      res.data.status === 'failed' ||
      res.data.status === 'cancelled' ||
      res.data.status === 'interrupted'
    ) {
      return res.data
    }
    await new Promise((r) => setTimeout(r, 40))
  }
  throw new Error(`Timed out waiting for run ${runId} to reach terminal status`)
}

test('Provider.7: Unified multi-provider execution through GhostBotDaemon, RunOrchestrator, RuntimePolicyBroker, and real loopback LM Studio + synthetic OpenRouter', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'ghost-p7-daemon-'))
  chmodSync(tempRoot, 0o700)
  const dataDir = join(tempRoot, 'data')
  const workspaceDir = join(tempRoot, 'workspace')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(workspaceDir, { recursive: true })
  chmodSync(workspaceDir, 0o700)

  let serverMode: 'normal' | 'stall' | 'incomplete' | 'oversized_models' = 'normal'
  let chatRequestsReceived = 0
  let lastRequestMessages: Array<{ role: string; content: string }> = []
  let stalledRes: import('node:http').ServerResponse | null = null

  const lmServer = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      if (serverMode === 'oversized_models') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('x'.repeat(300_000))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'local-qwen-7b' }] }))
      return
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      chatRequestsReceived += 1
      const chunks: Buffer[] = []
      for await (const c of req) {
        chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
      }
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages?: Array<{ role: string; content: string }>
      }
      lastRequestMessages = parsed.messages ?? []

      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (serverMode === 'stall') {
        res.write('data: {"choices":[{"delta":{"content":"Partial before cancel "}}]}\n\n')
        stalledRes = res
        req.on('close', () => {
          stalledRes = null
        })
        return
      }
      if (serverMode === 'incomplete') {
        res.write('data: {"choices":[{"delta":{"content":"Cut off mid-stream"}}]}\n\n')
        res.end()
        return
      }
      res.write('data: {"choices":[{"delta":{"content":"Unified "}}]}\n\n')
      res.write('data: {"choices":[{"delta":{"content":"LM Studio reply"}}]}\n\n')
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.writeHead(404).end()
  })

  await new Promise<void>((resolve) => lmServer.listen(0, '127.0.0.1', resolve))
  const lmAddress = lmServer.address()
  assert(lmAddress && typeof lmAddress !== 'string')
  const lmBaseUrl = `http://127.0.0.1:${lmAddress.port}/v1`

  // Secondary loopback server to verify endpoint A -> B -> A session invalidation
  const lmServerB = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'local-qwen-7b' }] }))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => lmServerB.listen(0, '127.0.0.1', resolve))
  const lmBAddress = lmServerB.address()
  assert(lmBAddress && typeof lmBAddress !== 'string')
  const lmBaseUrlB = `http://127.0.0.1:${lmBAddress.port}/v1`

  const secretStore = new InMemoryTestSecretStore()
  const authToken = `p7-token-${randomUUID()}`

  let openRouterAuthHeaderSeen = ''
  let openRouterAuthorized = false
  const openRouterAdapter = new OpenRouterApiAdapter({
    resolveApiKey: () =>
      secretStore.resolveProviderSecret({
        ownerId: 'local-user',
        providerId: 'openrouter',
        accountRef: 'default',
      }),
    isExecutionAuthorized: () => openRouterAuthorized,
    transport: async (url, init) => {
      const headers = new Headers(init?.headers)
      openRouterAuthHeaderSeen = headers.get('Authorization') ?? ''
      if (url.endsWith('/api/v1/models')) {
        return new Response(
          JSON.stringify({ data: [{ id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini' }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.endsWith('/api/v1/chat/completions')) {
        const sse =
          'data: {"choices":[{"delta":{"content":"OpenRouter "}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"cloud reply"}}]}\n\n' +
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
          'data: [DONE]\n\n'
        return new Response(sse, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      }
      return new Response('Not found', { status: 404 })
    },
  })

  const daemon = new GhostBotDaemon({
    authToken,
    port: 0,
    dataDir,
    runtimeMode: 'codex',
    // Keep the unified provider tests independent of a host Codex install/profile.
    codexVersion: '0.171.0',
    secretStore,
    testProviderAdapters: {
      openrouter: openRouterAdapter,
    },
  })

  try {
    const info = await daemon.start()
    const port = Number(new URL(info.address).port)

    // 1. Provider.6 residual check: pinned HTTPS path validator rejects query/fragments/extra paths
    assert.throws(
      () =>
        assertPinnedHttpsOriginUrl(
          'https://openrouter.ai/api/v1/models?evil=1',
          APPROVED_OPENROUTER_ORIGIN,
          ['/api/v1/models'],
        ),
      /query|fragment/i,
    )
    assert.throws(
      () =>
        assertPinnedHttpsOriginUrl(
          'https://openrouter.ai/api/v1/models/extra',
          APPROVED_OPENROUTER_ORIGIN,
          ['/api/v1/models'],
        ),
      /allowlisted paths/i,
    )

    // 2. Provider.6 residual check: OpenRouter allowNetworkDiscovery=true MUST NOT hit network before executionAuthorized=true
    const credBeforeRes = await apiJson(port, authToken, 'PUT', '/openrouter/credential', {
      apiKey: 'sk-or-v1-test-key-0001',
    })
    assert.equal(credBeforeRes.status, 200)
    const unauthDiscovery = await openRouterAdapter.listModels()
    assert.equal(openRouterAuthHeaderSeen, '')
    assert.equal(unauthDiscovery.length, 0)

    // 3. Configure LM Studio loopback endpoint & verify oversized /v1/models metadata bound
    serverMode = 'oversized_models'
    const oversizedRes = await apiJson<{ available: boolean; lastError?: string }>(
      port,
      authToken,
      'PUT',
      '/lmstudio/config',
      { baseUrl: lmBaseUrl },
    )
    assert.equal(oversizedRes.status, 200)
    assert.equal(oversizedRes.data.available, false)

    serverMode = 'normal'
    await apiJson<{ available: boolean; executionAuthorized: boolean }>(
      port,
      authToken,
      'PUT',
      '/lmstudio/config',
      { baseUrl: lmBaseUrl },
    )
    const lmConfigRes = await apiJson<{ available: boolean; executionAuthorized: boolean }>(
      port,
      authToken,
      'PUT',
      '/lmstudio/config',
      { baseUrl: lmBaseUrl, executionAuthorized: true },
    )
    assert.equal(lmConfigRes.status, 200)
    assert.equal(lmConfigRes.data.available, true)
    assert.equal(lmConfigRes.data.executionAuthorized, true)

    // 4. Create bots for LM Studio, OpenRouter, and gated runtimes (OpenClaw, Ollama, Kimi, Claude, Gemini)
    const createBot = async (name: string, runtimeId: string, modelId: string, effort = '') => {
      const catalog = await apiJson<{
        providers: Array<{
          id: string
          catalogState: string
          catalogGeneration: string | null
          models: Array<{ id: string; efforts: string[]; permissionModes: string[] }>
        }>
      }>(port, authToken, 'POST', '/runtime/provider-capabilities', {
        refresh: true,
        ...(runtimeId === 'claude-api' || runtimeId === 'gemini-api' || runtimeId === 'openrouter'
          ? { discoverProviderId: runtimeId }
          : {}),
      })
      assert.equal(catalog.status, 200)
      const provider = catalog.data.providers.find((item) => item.id === runtimeId)
      assert.equal(provider?.catalogState, 'available', `Expected a discovered ${runtimeId} catalog`)
      assert.ok(provider?.catalogGeneration)
      assert.ok(provider.models.some((item) => item.id === modelId), `Expected ${modelId} in the discovered ${runtimeId} catalog`)
      const res = await apiJson<{ id: string }>(port, authToken, 'POST', '/bots', {
        name,
        runtimeId,
        modelId,
        effort,
        catalogGeneration: provider.catalogGeneration,
        permission: 'read-only',
        workspacePath: workspaceDir,
        instructions: 'Be concise.',
        avatar: {
          kind: 'preset',
          shape: 'assistant',
          color: '#2563eb',
          eyes: 'classic',
          rotation: 0,
          animation: false,
        },
      })
      assert.equal(res.status, 201, `Expected bot creation 201 for ${runtimeId}: ${JSON.stringify(res.data)}`)
      return res.data.id
    }

    const createSession = async (botId: string) => {
      const res = await apiJson<{ id: string }>(port, authToken, 'POST', '/sessions', {
        agentId: botId,
        title: `Session for ${botId}`,
      })
      assert.equal(res.status, 201, `Expected session creation 201: ${JSON.stringify(res.data)}`)
      return res.data.id
    }

    const startRun = <T>(targetPort: number, sessionId: string, text: string) =>
      apiJson<T>(targetPort, authToken, 'POST', '/runs', {
        sessionId,
        idempotencyKey: randomUUID(),
        text,
      })

    // 4a. A provider bot cannot be configured from a guessed model or a missing
    // catalog generation. The daemon must fail closed before creating a session
    // or allowing any possible Codex/mock fallback.
    for (const [runtimeId, modelId] of [
      ['openclaw', 'openclaw-default'],
      ['ollama', 'llama3.2'],
      ['kimi-acp', 'kimi-k2'],
      ['llamacpp', 'local-gguf'],
      ['claude-api', 'claude-sonnet-4-6'],
      ['gemini-api', 'gemini-2.5-flash'],
      ['openrouter', 'openai/gpt-4o-mini'],
    ] as const) {
      const rejected = await apiJson<{ code?: string }>(port, authToken, 'POST', '/bots', {
        name: `${runtimeId} Bot`, runtimeId, modelId, effort: 'medium',
        permission: 'read-only', workspacePath: workspaceDir, instructions: 'Be concise.',
        avatar: { kind: 'preset', shape: 'assistant', color: '#2563eb', eyes: 'classic', rotation: 0, animation: false },
      })
      assert.equal(rejected.status, 409, `Expected configuration to require a current catalog for ${runtimeId}`)
      assert.ok(
        rejected.data.code === 'MODEL_DISCOVERY_REQUIRED' || rejected.data.code === 'MODEL_CATALOG_STALE',
        `Unexpected ${runtimeId} configuration result: ${JSON.stringify(rejected.data)}`,
      )
    }

    // 5. LM Studio end-to-end execution through RunOrchestrator + RuntimePolicyBroker + real loopback HTTP
    const lmBotId = await createBot('LM Studio Bot', 'lmstudio', 'local-qwen-7b')
    const lmSessionId = await createSession(lmBotId)
    const lmRun1 = await startRun<{ run: { id: string } }>(port, lmSessionId, 'Hello LM Studio')
    assert.equal(lmRun1.status, 201)
    const lmRun1Done = await waitForRunTerminal(port, authToken, lmRun1.data.run.id)
    assert.equal(lmRun1Done.status, 'completed')

    const msgsAfterRun1 = await apiJson<{
      messages?: Array<{ role: string; text?: string; content?: { text?: string }; status: string }>
    }>(port, authToken, 'GET', `/sessions/${lmSessionId}/messages`)
    assert.equal(msgsAfterRun1.status, 200)
    const lmList = Array.isArray(msgsAfterRun1.data)
      ? msgsAfterRun1.data
      : (msgsAfterRun1.data.messages ?? [])
    const assistant1 = lmList.find((m) => m.role === 'assistant')
    assert.equal(assistant1?.content?.text ?? assistant1?.text, 'Unified LM Studio reply')
    assert.equal(assistant1?.status, 'complete')

    // 6. OpenRouter end-to-end execution once credential + explicit authorization are enabled
    const orCredRes = await apiJson(port, authToken, 'PUT', '/openrouter/credential', {
      apiKey: 'sk-or-v1-live-test-9999',
    })
    assert.equal(orCredRes.status, 200)
    const orAuthRes = await apiJson(port, authToken, 'PUT', '/openrouter/authorization', {
      authorized: true,
    })
    assert.equal(orAuthRes.status, 200)
    openRouterAuthorized = true

    const orBotId = await createBot('OpenRouter Bot', 'openrouter', 'openai/gpt-4o-mini')
    const orSessionId = await createSession(orBotId)
    const orRun = await startRun<{ run: { id: string } }>(port, orSessionId, 'Hello OpenRouter')
    assert.equal(orRun.status, 201)
    const orRunDone = await waitForRunTerminal(port, authToken, orRun.data.run.id)
    assert.equal(orRunDone.status, 'completed', JSON.stringify(orRunDone.error))
    assert.equal(openRouterAuthHeaderSeen, 'Bearer sk-or-v1-live-test-9999')

    const orMsgs = await apiJson<{
      messages?: Array<{ role: string; text?: string; content?: { text?: string }; status: string }>
    }>(port, authToken, 'GET', `/sessions/${orSessionId}/messages`)
    const orList = Array.isArray(orMsgs.data) ? orMsgs.data : (orMsgs.data.messages ?? [])
    const orAssistant = orList.find((m) => m.role === 'assistant')
    assert.equal(orAssistant?.content?.text ?? orAssistant?.text, 'OpenRouter cloud reply')

    // 7. Endpoint A -> B -> A transition invalidates prior session identity
    await apiJson(port, authToken, 'PUT', '/lmstudio/config', { baseUrl: lmBaseUrlB })
    await apiJson(port, authToken, 'PUT', '/lmstudio/config', { baseUrl: lmBaseUrl })
    await apiJson(port, authToken, 'PUT', '/lmstudio/config', {
      baseUrl: lmBaseUrl,
      executionAuthorized: true,
    })
    const mismatchRes = await startRun<{ code?: string }>(
      port,
      lmSessionId,
      'Should reject after endpoint switch',
    )
    assert.equal(mismatchRes.status, 409)
    assert.equal(mismatchRes.data.code, 'ACCOUNT_MISMATCH')

    // 8. Stalled stream cancellation through POST /runs/:id/cancel
    const lmCancelSessionId = await createSession(lmBotId)
    serverMode = 'stall'
    const stallRunRes = await startRun<{ run: { id: string } }>(
      port,
      lmCancelSessionId,
      'Stream and stall',
    )
    assert.equal(stallRunRes.status, 201)
    await new Promise((r) => setTimeout(r, 150))
    const cancelRes = await apiJson(
      port,
      authToken,
      'POST',
      `/runs/${stallRunRes.data.run.id}/cancel`,
      {},
    )
    assert.equal(cancelRes.status, 200)
    const cancelledDone = await waitForRunTerminal(port, authToken, stallRunRes.data.run.id)
    assert.equal(cancelledDone.status, 'cancelled')
    if (stalledRes) {
      stalledRes.end()
      stalledRes = null
    }

    // 9a. Create a session after endpoint switch to verify restart canonical-history reconstruction
    const lmResumeSessionId = await createSession(lmBotId)
    serverMode = 'normal'
    const resumeTurn1 = await startRun<{ run: { id: string } }>(
      port,
      lmResumeSessionId,
      'Turn 1 before restart',
    )
    assert.equal(
      (await waitForRunTerminal(port, authToken, resumeTurn1.data.run.id)).status,
      'completed',
    )

    // 9b. Incomplete stream without [DONE] -> RUNTIME_DISCONNECTED + quarantine (no auto replay)
    const lmIncompleteSessionId = await createSession(lmBotId)
    serverMode = 'normal'
    const okBeforeIncomplete = await startRun<{ run: { id: string } }>(
      port,
      lmIncompleteSessionId,
      'First turn succeeds',
    )
    assert.equal(
      (await waitForRunTerminal(port, authToken, okBeforeIncomplete.data.run.id)).status,
      'completed',
    )

    serverMode = 'incomplete'
    const incRun = await startRun<{ run: { id: string } }>(
      port,
      lmIncompleteSessionId,
      'Second turn drops mid-stream',
    )
    assert.equal(incRun.status, 201)
    const incDone = await waitForRunTerminal(port, authToken, incRun.data.run.id)
    assert.equal(incDone.status, 'failed')
    assert.equal(incDone.error?.code, 'OPENAI_COMPAT_UNKNOWN_TERMINATION')

    // Restart daemon and confirm no automatic replay of failed/quarantined run,
    // plus canonical history reconstruction on a fresh session after restart
    const requestsBeforeRestart = chatRequestsReceived
    await daemon.stop()

    const daemon2 = new GhostBotDaemon({
      authToken,
      port: 0,
      dataDir,
      runtimeMode: 'codex',
      codexVersion: '0.171.0',
      secretStore,
    })
    try {
      const info2 = await daemon2.start()
      const port2 = Number(new URL(info2.address).port)
      await apiJson(port2, authToken, 'PUT', '/lmstudio/config', {
        baseUrl: lmBaseUrl,
        executionAuthorized: true,
      })
      await new Promise((r) => setTimeout(r, 100))
      assert.equal(
        chatRequestsReceived,
        requestsBeforeRestart,
        'Daemon restart must not auto-replay failed/quarantined unified run',
      )

      // Resume lmResumeSessionId (which has turn 1 in canonical DB) after restart -> reconstructs history
      serverMode = 'normal'
      const inspectBeforeResume = await apiJson<{ externalSessionId?: string | null }>(
        port2,
        authToken,
        'GET',
        `/sessions/${lmResumeSessionId}/inspect`,
      )
      assert(inspectBeforeResume.data.externalSessionId, 'Expected persisted externalSessionId')
      const msgsBeforeResume = await apiJson(
        port2,
        authToken,
        'GET',
        `/sessions/${lmResumeSessionId}/messages`,
      )
      const resumedRun = await startRun<{ run: { id: string } }>(
        port2,
        lmResumeSessionId,
        'Turn 2 after daemon restart',
      )
      assert.equal(resumedRun.status, 201)
      const resumedDone = await waitForRunTerminal(port2, authToken, resumedRun.data.run.id)
      assert.equal(resumedDone.status, 'completed')
      const joinedContext = lastRequestMessages.map((m) => m.content).join('\n')
      assert.match(
        joinedContext,
        /Unified LM Studio reply/,
        `msgsBeforeResume=${JSON.stringify(msgsBeforeResume.data)} lastReq=${JSON.stringify(lastRequestMessages)}`,
      )
    } finally {
      await daemon2.stop()
    }
  } finally {
    await daemon.stop().catch(() => undefined)
    await new Promise<void>((resolve) => lmServer.close(() => resolve()))
    await new Promise<void>((resolve) => lmServerB.close(() => resolve()))
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
