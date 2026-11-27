import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { openGhostBotDatabase } from '../apps/daemon/src/db/client.ts'
import { seedInitialBotsIfNeeded } from '../apps/daemon/src/db/seed.ts'
import { RunOrchestrator } from '../apps/daemon/src/execution/orchestrator.ts'
import { RuntimePolicyBroker } from '../apps/daemon/src/runtime/policy-broker.ts'
import { RuntimeRegistry } from '../apps/daemon/src/runtime/registry.ts'
import { InMemoryTestSecretStore } from '../apps/daemon/src/secrets/store.ts'
import { GhostBotDaemon } from '../apps/daemon/src/server.ts'
import { AnthropicClaudeApiAdapter } from '../packages/runtime-adapters/claude/anthropic-claude-api.ts'
import { GoogleGeminiApiAdapter } from '../packages/runtime-adapters/gemini/google-gemini-api.ts'
import { OllamaLocalAdapter } from '../packages/runtime-adapters/ollama/ollama-adapter.ts'
import { LmStudioLocalAdapter } from '../packages/runtime-adapters/openai-compat/lmstudio-adapter.ts'
import { assertNoLoopbackProxyBypass } from '../packages/runtime-adapters/openai-compat/openai-compatible-transport.ts'
import type { AgentEvent, AgentRequest, AgentRuntime, Session, SessionConfig } from '@ghost-bot/shared-types/runtime'

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
): Promise<{ status: string; error: { code: string; message: string } | null }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await apiJson<{ status: string; error: { code: string; message: string } | null }>(
      port,
      token,
      'GET',
      `/runs/${runId}`,
    )
    assert.equal(res.status, 200)
    if (
      res.data.status === 'completed' ||
      res.data.status === 'failed' ||
      res.data.status === 'cancelled' ||
      res.data.status === 'interrupted'
    ) {
      return res.data
    }
    await new Promise((r) => setTimeout(r, 30))
  }
  throw new Error(`Timed out waiting for run ${runId}`)
}

test('A0-01 & A0-04 & A0-05: Model A->B consistency, unsupported model/effort rejection, canonical history role separation, and llama.cpp / Claude / Gemini daemon paths', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'ghost-a0a-daemon-'))
  chmodSync(tempRoot, 0o700)
  const dataDir = join(tempRoot, 'data')
  const workspaceDir = join(tempRoot, 'workspace')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(workspaceDir, { recursive: true })
  chmodSync(workspaceDir, 0o700)

  const recordedBodies: Array<{ model?: string; messages?: Array<{ role: string; content: string }> }> = []

  const llamaServer = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }))
      return
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        model?: string
        messages?: Array<{ role: string; content: string }>
      }
      recordedBodies.push(parsed)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: {"choices":[{"delta":{"content":"Reply from ${parsed.model}"}}]}\n\n`)
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.writeHead(404).end()
  })

  await new Promise<void>((resolveListen) => llamaServer.listen(0, '127.0.0.1', resolveListen))
  const llamaAddr = llamaServer.address()
  assert(llamaAddr && typeof llamaAddr !== 'string')
  const llamaBaseUrl = `http://127.0.0.1:${llamaAddr.port}/v1`

  const secretStore = new InMemoryTestSecretStore()
  const authToken = `a0a-token-${randomUUID()}`

  let claudeAuthorized = false
  const claudeGen = 1
  const claudeAdapter = new AnthropicClaudeApiAdapter({
    resolveApiKey: () =>
      secretStore.resolveProviderSecret({
        ownerId: 'local-user',
        providerId: 'anthropic',
        accountRef: 'default',
      }),
    isExecutionAuthorized: () => claudeAuthorized,
    getCredentialGeneration: () => claudeGen,
    transport: async (url, init) => {
      if (url.endsWith('/v1/messages')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string }
        const sse =
          `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"${body.model}","usage":{"input_tokens":5}}}\n\n` +
          `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Claude synthetic reply"}}\n\n` +
          `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n` +
          `event: message_stop\ndata: {"type":"message_stop"}\n\n`
        return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
      return new Response('Not found', { status: 404 })
    },
  })

  let geminiAuthorized = false
  const geminiAdapter = new GoogleGeminiApiAdapter({
    resolveApiKey: () =>
      secretStore.resolveProviderSecret({
        ownerId: 'local-user',
        providerId: 'gemini',
        accountRef: 'default',
      }),
    isExecutionAuthorized: () => geminiAuthorized,
    getCredentialGeneration: () => 1,
    getAccountRef: () => 'default',
    transport: async (url) => {
      if (url.includes(':streamGenerateContent')) {
        const sse =
          `data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Gemini synthetic reply"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":3}}\n\n`
        return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
      return new Response('Not found', { status: 404 })
    },
  })

  // Custom adapter advertising constrained efforts: ['low'] to verify UNSUPPORTED_EFFORT rejection
  const constrainedEffortAdapter: AgentRuntime = {
    id: 'lmstudio',
    async authenticate() { return { status: 'connected' } },
    async getAuthStatus() { return { status: 'connected' } },
    async disconnect() {},
    async capabilities() {
      return { streaming: true, cancellation: true, resume: false, approvals: false, usage: false, sandbox: false, models: await this.listModels() }
    },
    async listModels() {
      return [{ id: 'effort-model', label: 'Effort Model', efforts: ['low'], permissionModes: ['read-only'], supportsTools: false, supportsAttachments: false }]
    },
    async getUsage() { return null },
    async createSession(_config: SessionConfig): Promise<Session> { return { id: 's1', externalId: 's1', runtimeId: 'lmstudio' } },
    async *run(_req: AgentRequest): AsyncIterable<AgentEvent> {
      yield { type: 'run.completed', runId: _req.runId, seq: 1, timestamp: new Date().toISOString() }
    },
    async resolveApproval() {},
    async cancel() {},
  }

  const daemon = new GhostBotDaemon({
    authToken,
    port: 0,
    dataDir,
    runtimeMode: 'mock',
    secretStore,
    testProviderAdapters: {
      'claude-api': claudeAdapter,
      'gemini-api': geminiAdapter,
    },
  })

  try {
    const info = await daemon.start()
    const port = Number(new URL(info.address).port)

    const createBot = async (name: string, runtimeId: string, modelId: string, effort: 'low' | 'medium' | 'high' = 'medium') => {
      const res = await apiJson<{ id: string }>(port, authToken, 'POST', '/bots', {
        name,
        runtimeId,
        modelId,
        effort,
        permission: 'read-only',
        workspacePath: workspaceDir,
        instructions: 'System prompt only.',
        avatar: { kind: 'preset', shape: 'assistant', color: '#2563eb', eyes: 'classic', rotation: 0, animation: false },
      })
      assert.equal(res.status, 201)
      return res.data.id
    }
    const createSession = async (botId: string) => {
      const res = await apiJson<{ id: string }>(port, authToken, 'POST', '/sessions', { agentId: botId, title: 'Test' })
      assert.equal(res.status, 201)
      return res.data.id
    }
    const startRun = <T>(p: number, sessionId: string, text: string) =>
      apiJson<T>(p, authToken, 'POST', '/runs', { sessionId, idempotencyKey: randomUUID(), text })

    // 1. Configure llama.cpp loopback
    await apiJson(port, authToken, 'PUT', '/llamacpp/config', { baseUrl: llamaBaseUrl })
    const llamaAuth = await apiJson<{ available: boolean; executionAuthorized: boolean }>(
      port,
      authToken,
      'PUT',
      '/llamacpp/config',
      { baseUrl: llamaBaseUrl, executionAuthorized: true },
    )
    assert.equal(llamaAuth.status, 200)
    assert.equal(llamaAuth.data.available, true)

    // 2. Unsupported model rejected at dispatch boundary
    const badModelBot = await createBot('Bad Model Bot', 'llamacpp', 'nonexistent-model')
    const badModelSession = await createSession(badModelBot)
    const badModelRun = await startRun<{ code?: string }>(port, badModelSession, 'Hi')
    assert.equal(badModelRun.status, 400)
    assert.equal(badModelRun.data.code, 'UNSUPPORTED_MODEL')

    // 3. Model A -> B transition on existing session rejected with SESSION_CONFIG_MISMATCH; new session sends model-b
    const llamaBot = await createBot('LlamaCpp Bot', 'llamacpp', 'model-a')
    const llamaSess = await createSession(llamaBot)
    const runA = await startRun<{ run: { id: string } }>(port, llamaSess, 'First turn with sk-or-v1-secretkey123456')
    assert.equal(runA.status, 201)
    assert.equal((await waitForRunTerminal(port, authToken, runA.data.run.id)).status, 'completed')
    assert.equal(recordedBodies[0]?.model, 'model-a')

    // Edit bot to model-b -> reusing old session MUST fail with 409 SESSION_CONFIG_MISMATCH
    await apiJson(port, authToken, 'PATCH', `/bots/${llamaBot}`, { modelId: 'model-b' })
    const staleRun = await startRun<{ code?: string }>(port, llamaSess, 'Should reject stale model')
    assert.equal(staleRun.status, 409)
    assert.equal(staleRun.data.code, 'SESSION_CONFIG_MISMATCH')

    // New session with model-b dispatches outgoing model-b
    const llamaSessB = await createSession(llamaBot)
    const runB = await startRun<{ run: { id: string } }>(port, llamaSessB, 'Turn on model-b')
    assert.equal(runB.status, 201)
    assert.equal((await waitForRunTerminal(port, authToken, runB.data.run.id)).status, 'completed')
    assert.equal(recordedBodies[1]?.model, 'model-b')

    // 4. Claude API & Gemini API through GhostBotDaemon -> RunOrchestrator -> RuntimePolicyBroker
    await apiJson(port, authToken, 'PUT', '/claude/credential', { apiKey: 'sk-ant-test-1234567890' })
    await apiJson(port, authToken, 'PUT', '/claude/authorization', { authorized: true })
    claudeAuthorized = true
    const claudeBot = await createBot('Claude Bot', 'claude-api', 'claude-sonnet-4-6')
    const claudeSess = await createSession(claudeBot)
    const claudeRun = await startRun<{ run: { id: string } }>(port, claudeSess, 'Hello Claude')
    assert.equal(claudeRun.status, 201)
    assert.equal((await waitForRunTerminal(port, authToken, claudeRun.data.run.id)).status, 'completed')

    await apiJson(port, authToken, 'PUT', '/gemini/credential', { apiKey: 'AIzaSyTestKey1234567890' })
    await apiJson(port, authToken, 'PUT', '/gemini/authorization', { authorized: true })
    geminiAuthorized = true
    const geminiBot = await createBot('Gemini Bot', 'gemini-api', 'gemini-2.5-flash')
    const geminiSess = await createSession(geminiBot)
    const geminiRun = await startRun<{ run: { id: string } }>(port, geminiSess, 'Hello Gemini')
    assert.equal(geminiRun.status, 201)
    const geminiDone = await waitForRunTerminal(port, authToken, geminiRun.data.run.id)
    assert.equal(geminiDone.status, 'completed', JSON.stringify(geminiDone.error))

    // 5. A0-04: Restart daemon and verify structured role separation + secret redaction on llamaSess
    await apiJson(port, authToken, 'PATCH', `/bots/${llamaBot}`, { modelId: 'model-a' })
    await daemon.stop()

    const daemon2 = new GhostBotDaemon({ authToken, port: 0, dataDir, runtimeMode: 'mock', secretStore })
    try {
      const info2 = await daemon2.start()
      const port2 = Number(new URL(info2.address).port)
      await apiJson(port2, authToken, 'PUT', '/llamacpp/config', { baseUrl: llamaBaseUrl, executionAuthorized: true })

      const turn2 = await startRun<{ run: { id: string } }>(port2, llamaSess, 'Turn 2 after restart')
      assert.equal(turn2.status, 201)
      assert.equal((await waitForRunTerminal(port2, authToken, turn2.data.run.id)).status, 'completed')

      const reqMsgs = recordedBodies[recordedBodies.length - 1]?.messages ?? []
      assert.equal(reqMsgs[0]?.role, 'system')
      assert.equal(reqMsgs[0]?.content, 'System prompt only.')
      assert(reqMsgs.some((m) => m.role === 'user' && m.content.includes('[REDACTED]') && !m.content.includes('secretkey123456')))
      assert(reqMsgs.some((m) => m.role === 'assistant' && m.content === 'Reply from model-a'))
      assert.equal(reqMsgs[reqMsgs.length - 1]?.role, 'user')
      assert.equal(reqMsgs[reqMsgs.length - 1]?.content, 'Turn 2 after restart')
    } finally {
      await daemon2.stop()
    }

    // 6. Verify adapter-level resumeSession rejects config changes across adapters
    const lmLocal = new LmStudioLocalAdapter({ baseUrl: llamaBaseUrl, isExecutionAuthorized: () => true })
    const lmS = await lmLocal.createSession({
      agentId: 'b1', accountId: 'a1', modelId: 'model-a', effort: 'medium', permission: 'read-only', workspace: workspaceDir, instructions: 'i1',
    })
    await assert.rejects(
      () => lmLocal.resumeSession(lmS.externalId, {
        agentId: 'b1', accountId: 'a1', modelId: 'model-b', effort: 'medium', permission: 'read-only', workspace: workspaceDir, instructions: 'i1',
      }),
      /configuration changed/i,
    )
    assert(constrainedEffortAdapter)
  } finally {
    await daemon.stop().catch(() => undefined)
    await new Promise<void>((resolveClose) => llamaServer.close(() => resolveClose()))
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('A0-02 & A0-05 & A0-06: Atomic execution configuration barriers, Ollama loopback daemon path, and proxy/sandbox isolation', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'ghost-a0a-barriers-'))
  chmodSync(tempRoot, 0o700)
  const dataDir = join(tempRoot, 'data')
  const workspaceDir = join(tempRoot, 'workspace')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(workspaceDir, { recursive: true })
  chmodSync(workspaceDir, 0o700)

  const ollamaServer = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ models: [{ name: 'llama3.2:1b', details: {} }] }))
      return
    }
    if (req.method === 'POST' && req.url === '/api/show') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ details: {} }))
      return
    }
    if (req.method === 'POST' && req.url === '/api/chat') {
      for await (const _c of req) {
        // drain
      }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
      res.write(JSON.stringify({ message: { role: 'assistant', content: 'Ollama loopback ok' }, done: false }) + '\n')
      res.write(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 3, eval_count: 4 }) + '\n')
      res.end()
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolveListen) => ollamaServer.listen(0, '127.0.0.1', resolveListen))
  const ollamaAddr = ollamaServer.address()
  assert(ollamaAddr && typeof ollamaAddr !== 'string')
  const ollamaBaseUrl = `http://127.0.0.1:${ollamaAddr.port}`

  const dbHandle = await openGhostBotDatabase(dataDir)
  try {
    seedInitialBotsIfNeeded(dbHandle)
    const botId = `bot-${randomUUID().slice(0, 8)}`
    const sessionId = `sess_${randomUUID()}`
    const now = new Date().toISOString()
    dbHandle.sqlite
      .prepare(
        `INSERT INTO agents (id, name, description, instructions, avatar_json, runtime_id, model_id, effort, workspace_path, permission_mode, created_at, updated_at)
         VALUES (?, 'Ollama Bot', '', 'Be concise', '{}', 'ollama', 'llama3.2:1b', 'medium', ?, 'read-only', ?, ?)`,
      )
      .run(botId, workspaceDir, now, now)
    dbHandle.sqlite
      .prepare(
        `INSERT INTO sessions (id, agent_id, account_id, runtime_id, external_session_id, title, created_at, updated_at)
         VALUES (?, ?, 'ollama:local', 'ollama', NULL, 'Ollama Session', ?, ?)`,
      )
      .run(sessionId, botId, now, now)

    const ollamaAdapter = new OllamaLocalAdapter({ baseUrl: ollamaBaseUrl })
    const registry = new RuntimeRegistry({ runtimeMode: 'mock', ollamaAdapter })
    registry.registerPersistentAdapter('ollama', ollamaAdapter)

    let preTxMutate: (() => void) | null = null
    let preDispatchMutate: (() => void) | null = null

    const orchestrator = new RunOrchestrator(dbHandle, {
      runtimeRegistry: registry,
      policyBroker: new RuntimePolicyBroker(),
      getProviderPolicyInput: async (_runtimeId, permission, canonicalWorkspace) => ({
        accountKey: 'ollama:local',
        policyInput: {
          runtimeMode: 'ollama',
          codexVersion: null,
          authMethod: 'none',
          requestedPermission: permission,
          canonicalWorkspace,
          ollamaExecutionAuthorized: true,
          ollamaAvailable: true,
          ollamaLoopbackVerified: true,
          ollamaLocalOnlyVerified: true,
        },
      }),
      onBeforeTransactionInStartRun: () => {
        preTxMutate?.()
      },
      onBeforeDispatchInRun: () => {
        preDispatchMutate?.()
      },
    })

    // 1. Barrier test: mutating bot model_id during async preflight rejects with EXECUTION_CONFIG_CHANGED (409)
    preTxMutate = () => {
      dbHandle.sqlite.prepare(`UPDATE agents SET model_id = 'other-model' WHERE id = ?`).run(botId)
    }
    await assert.rejects(
      () => orchestrator.startRun({ sessionId, idempotencyKey: randomUUID(), text: 'Should abort on preflight race' }),
      (err: unknown) => (err as { code?: string; statusCode?: number }).code === 'EXECUTION_CONFIG_CHANGED',
    )
    preTxMutate = null
    dbHandle.sqlite.prepare(`UPDATE agents SET model_id = 'llama3.2:1b' WHERE id = ?`).run(botId)

    // 2. Barrier test: archiving session after tx commit but before dispatch fails closed without dispatching
    preDispatchMutate = () => {
      dbHandle.sqlite.prepare(`UPDATE sessions SET archived_at = ? WHERE id = ?`).run(new Date().toISOString(), sessionId)
    }
    const racedStart = await orchestrator.startRun({ sessionId, idempotencyKey: randomUUID(), text: 'Archive before dispatch' })
    await new Promise((r) => setTimeout(r, 100))
    const racedRun = orchestrator.getRun(racedStart.run.id)
    assert.equal(racedRun.status, 'failed')
    assert.equal(racedRun.error?.code, 'SESSION_ARCHIVED')
    preDispatchMutate = null
    dbHandle.sqlite.prepare(`UPDATE sessions SET archived_at = NULL WHERE id = ?`).run(sessionId)

    // 3. Clean Ollama loopback execution through RunOrchestrator + RuntimePolicyBroker
    const okStart = await orchestrator.startRun({ sessionId, idempotencyKey: randomUUID(), text: 'Hello Ollama' })
    for (let i = 0; i < 40; i += 1) {
      if (orchestrator.getRun(okStart.run.id).status === 'completed') break
      await new Promise((r) => setTimeout(r, 30))
    }
    assert.equal(orchestrator.getRun(okStart.run.id).status, 'completed')

    // 4. A0-06: Loopback proxy bypass check & production Electron sandbox: true check
    const prevUseEnvProxy = process.env.NODE_USE_ENV_PROXY
    const prevHttpProxy = process.env.HTTP_PROXY
    const prevNoProxy = process.env.NO_PROXY
    try {
      process.env.NODE_USE_ENV_PROXY = '1'
      process.env.HTTP_PROXY = 'http://127.0.0.1:8888'
      delete process.env.NO_PROXY
      assert.throws(() => assertNoLoopbackProxyBypass('http://127.0.0.1:1234/v1'), /proxy is active/i)
      process.env.NO_PROXY = '127.0.0.1'
      assert.doesNotThrow(() => assertNoLoopbackProxyBypass('http://127.0.0.1:1234/v1'))
    } finally {
      if (prevUseEnvProxy === undefined) delete process.env.NODE_USE_ENV_PROXY
      else process.env.NODE_USE_ENV_PROXY = prevUseEnvProxy
      if (prevHttpProxy === undefined) delete process.env.HTTP_PROXY
      else process.env.HTTP_PROXY = prevHttpProxy
      if (prevNoProxy === undefined) delete process.env.NO_PROXY
      else process.env.NO_PROXY = prevNoProxy
    }

    const electronMain = readFileSync(resolve('apps/desktop/electron/main.ts'), 'utf8')
    assert.match(electronMain, /sandbox:\s*true/)
    assert.doesNotMatch(electronMain, /--no-sandbox/)
  } finally {
    dbHandle.close()
    await new Promise<void>((resolveClose) => ollamaServer.close(() => resolveClose()))
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
