import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import {
  assertLoopbackOpenAiCompatBaseUrl,
  assertPinnedHttpsOriginUrl,
  redactOpenAiCompatSecrets,
} from '../packages/runtime-adapters/openai-compat/openai-compatible-transport.ts'
import { LmStudioLocalAdapter } from '../packages/runtime-adapters/openai-compat/lmstudio-adapter.ts'
import { LlamaCppLocalAdapter } from '../packages/runtime-adapters/openai-compat/llamacpp-adapter.ts'
import {
  APPROVED_OPENROUTER_BASE_URL,
  APPROVED_OPENROUTER_ORIGIN,
  OpenRouterApiAdapter,
} from '../packages/runtime-adapters/openai-compat/openrouter-adapter.ts'
import { InMemoryTestSecretStore } from '../apps/daemon/src/secrets/store.ts'
import { RuntimePolicyBroker } from '../apps/daemon/src/runtime/policy-broker.ts'
import { RuntimeRegistry } from '../apps/daemon/src/runtime/registry.ts'
import {
  LocalOpenAiCompatStatusDtoSchema,
  OpenRouterStatusDtoSchema,
} from '../packages/shared-types/ipc.ts'
import type { AgentEvent } from '@ghost-bot/shared-types/runtime'

test('OpenAI-compatible endpoint validators reject SSRF, non-loopback, credentials, query params, and secrets', () => {
  assert.throws(() => assertLoopbackOpenAiCompatBaseUrl('http://192.168.1.10:1234/v1'), /loopback only/i)
  assert.throws(() => assertLoopbackOpenAiCompatBaseUrl('http://127.0.0.1:1234/evil'), /path must be "\/v1"/i)
  assert.throws(() => assertLoopbackOpenAiCompatBaseUrl('http://user:pass@127.0.0.1:1234/v1'), /credentials/i)
  assert.equal(assertLoopbackOpenAiCompatBaseUrl('http://127.0.0.1:1234/v1/'), 'http://127.0.0.1:1234/v1')

  assert.throws(
    () => assertPinnedHttpsOriginUrl('http://openrouter.ai/api/v1/models', APPROVED_OPENROUTER_ORIGIN, '/api/v1'),
    /https:/i,
  )
  assert.throws(
    () => assertPinnedHttpsOriginUrl('https://evil.example/api/v1/models', APPROVED_OPENROUTER_ORIGIN, '/api/v1'),
    /pinned origin/i,
  )
  assert.equal(
    redactOpenAiCompatSecrets('Failed with sk-or-v1-secretkey123456'),
    'Failed with [REDACTED]',
  )
})

test('LM Studio & llama.cpp adapters verify real loopback HTTP servers, fragmented UTF-8 SSE, tool rejection, reasoning suppression, and cancellation', async () => {
  let mode: 'normal' | 'redirect' | 'malformed' | 'tool_calls' | 'length' | 'incomplete' | 'stall' = 'normal'
  let authorized = false

  const server = createServer((req, res) => {
    if (mode === 'redirect') {
      res.writeHead(302, { Location: 'http://example.com/evil' })
      res.end()
      return
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'local-qwen-7b' }] }))
      return
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (mode === 'malformed') {
        res.write('data: {bad-json\n\n')
        res.end()
        return
      }
      if (mode === 'tool_calls') {
        res.write('data: {"choices":[{"delta":{"tool_calls":[{"id":"c1"}]}}]}\n\n')
        res.end()
        return
      }
      if (mode === 'length') {
        res.write('data: {"choices":[{"delta":{"content":"Cut"},"finish_reason":"length"}]}\n\n')
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      if (mode === 'incomplete') {
        res.write('data: {"choices":[{"delta":{"content":"Half"}}]}\n\n')
        res.end()
        return
      }
      if (mode === 'stall') {
        res.write('data: {"choices":[{"delta":{"content":"Wait"}}]}\n\n')
        return
      }

      // Normal fragmented UTF-8 SSE + private reasoning suppression + non-cumulative usage
      const fullChunk =
        'data: {"choices":[{"delta":{"reasoning":"secret thought","content":"Xin chào "}}]}\n\n'
      const bytes = Buffer.from(fullChunk, 'utf8')
      res.write(bytes.subarray(0, 52))
      setTimeout(() => {
        res.write(bytes.subarray(52))
        res.write(
          'data: {"choices":[{"delta":{"content":"Ghost"},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":4}}\n\n',
        )
        res.write('data: [DONE]\n\n')
        res.end()
      }, 15)
      return
    }
    res.writeHead(404)
    res.end()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address()
  assert.ok(addr && typeof addr === 'object')
  const baseUrl = `http://127.0.0.1:${addr.port}/v1`

  try {
    const lm = new LmStudioLocalAdapter({
      baseUrl,
      isExecutionAuthorized: () => authorized,
      timeoutMs: 2000,
    })
    const llama = new LlamaCppLocalAdapter({
      baseUrl,
      isExecutionAuthorized: () => authorized,
      timeoutMs: 2000,
    })

    const avail = await lm.checkAvailability()
    assert.equal(avail.available, true)
    assert.equal(avail.models[0]?.id, 'local-qwen-7b')
    assert.equal(await lm.getUsage(), null)

    const session = await lm.createSession({
      agentId: 'b-lm',
      accountId: 'local',
      modelId: 'local-qwen-7b',
      permission: 'read-only',
      workspace: '/tmp',
      instructions: '',
    })

    // Gated by default
    const gatedEv: AgentEvent[] = []
    for await (const e of lm.run({ runId: 'lm-gated', session, text: 'hi' })) gatedEv.push(e)
    assert.equal((gatedEv.at(-1) as Extract<AgentEvent, { type: 'run.failed' }>).code, 'OPENAI_COMPAT_EXECUTION_GATED')

    // Authorized fragmented UTF-8 run
    authorized = true
    const okEv: AgentEvent[] = []
    for await (const e of lm.run({ runId: 'lm-ok', session, text: 'hi' })) okEv.push(e)
    assert.ok(!okEv.some((e) => e.type === 'message.delta' && e.text.includes('secret thought')))
    assert.equal(
      okEv
        .filter((e): e is Extract<AgentEvent, { type: 'message.delta' }> => e.type === 'message.delta')
        .map((e) => e.text)
        .join(''),
      'Xin chào Ghost',
    )
    assert.equal(okEv.at(-1)?.type, 'run.completed')

    // Error & completion cases
    for (const [m, code] of [
      ['redirect', 'OPENAI_COMPAT_REDIRECT_FORBIDDEN'],
      ['malformed', 'OPENAI_COMPAT_MALFORMED_SSE'],
      ['tool_calls', 'OPENAI_COMPAT_TOOLS_UNSUPPORTED'],
      ['length', 'OPENAI_COMPAT_MAX_TOKENS'],
      ['incomplete', 'OPENAI_COMPAT_UNKNOWN_TERMINATION'],
    ] as const) {
      mode = m
      const ev: AgentEvent[] = []
      for await (const e of lm.run({ runId: `lm-${m}`, session, text: 't' })) ev.push(e)
      assert.equal(ev.at(-1)?.type, 'run.failed')
      assert.equal((ev.at(-1) as Extract<AgentEvent, { type: 'run.failed' }>).code, code)
    }

    // Stalled stream cancellation
    mode = 'stall'
    const cancelEv: AgentEvent[] = []
    for await (const e of lm.run({ runId: 'lm-stall', session, text: 'wait' })) {
      cancelEv.push(e)
      if (e.type === 'message.delta') {
        await lm.cancel('lm-stall')
      }
    }
    assert.equal(cancelEv.at(-1)?.type, 'run.cancelled')

    // Endpoint change invalidates session binding
    lm.updateBaseUrl('http://127.0.0.1:59997/v1')
    await assert.rejects(() => lm.resumeSession(session.externalId), /invalidated/i)

    // IPC DTO validation
    const registry = new RuntimeRegistry({
      runtimeMode: 'mock',
      lmstudioAdapter: lm,
      llamacppAdapter: llama,
    })
    const dto = LocalOpenAiCompatStatusDtoSchema.parse(
      await registry.getLocalOpenAiCompatStatus({ id: 'llamacpp', executionAuthorized: false }),
    )
    assert.equal(dto.capabilities.tools, false)
    assert.equal(dto.policyCompatibility.readOnlyAllowed, false)
    await registry.stop()
    await lm.disconnect()
    await llama.disconnect()
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('OpenRouterApiAdapter enforces allow_fallbacks=false, credential isolation, rotation abort, and strict IPC DTOs', async () => {
  let authorized = false
  let generation = 1
  let requestCount = 0

  const store = new InMemoryTestSecretStore()
  store.storeProviderSecret(
    { ownerId: 'local-user', providerId: 'openrouter', accountRef: 'default' },
    'OpenRouter',
    'sk-or-v1-test-key-1234',
  )
  assert.equal(
    store.existsProviderSecret({ ownerId: 'local-user', providerId: 'anthropic', accountRef: 'default' }),
    false,
  )

  const adapter = new OpenRouterApiAdapter({
    resolveApiKey: () =>
      store.resolveProviderSecret({ ownerId: 'local-user', providerId: 'openrouter', accountRef: 'default' }),
    isExecutionAuthorized: () => authorized,
    getCredentialGeneration: () => generation,
    transport: async (url, init) => {
      requestCount += 1
      assert.ok(url.startsWith(APPROVED_OPENROUTER_BASE_URL))
      assert.equal(init.redirect, 'error')
      const body = JSON.parse(String(init.body)) as { provider?: { allow_fallbacks?: boolean } }
      assert.equal(body.provider?.allow_fallbacks, false)

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"delta":{"content":"Hi from OpenRouter"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":4}}\n\n',
            ),
          )
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
          controller.close()
        },
      })
      return new Response(stream, { status: 200 })
    },
  })

  // Gated by default -> 0 HTTP requests
  assert.deepEqual(await adapter.listModels(), [])
  assert.equal(requestCount, 0)

  const session = await adapter.createSession({
    agentId: 'b-or',
    accountId: 'default',
    modelId: 'anthropic/claude-sonnet-5-5',
    permission: 'read-only',
    workspace: '/tmp',
    instructions: '',
  })

  authorized = true
  const ev: AgentEvent[] = []
  for await (const e of adapter.run({ runId: 'or-1', session, text: 'hi' })) ev.push(e)
  assert.equal(ev.at(-1)?.type, 'run.completed')

  // Rotation invalidates session
  generation += 1
  const evRot: AgentEvent[] = []
  for await (const e of adapter.run({ runId: 'or-2', session, text: 'hi' })) evRot.push(e)
  assert.equal((evRot.at(-1) as Extract<AgentEvent, { type: 'run.failed' }>).code, 'OPENAI_COMPAT_BINDING_STALE')

  const broker = new RuntimePolicyBroker()
  assert.equal(
    broker.authorizeOpenRouterExecution({
      requestedPermission: 'read-only',
      canonicalWorkspace: '/tmp',
      openRouterExecutionAuthorized: false,
      openRouterCredentialConfigured: true,
      openRouterKeyringAvailable: true,
      openRouterEndpointVerified: true,
    }).allowed,
    false,
  )

  const registry = new RuntimeRegistry({ runtimeMode: 'mock', openrouterAdapter: adapter })
  const dto = OpenRouterStatusDtoSchema.parse(
    await registry.getOpenRouterStatus({
      keyringAvailable: true,
      keyringLocked: false,
      keyringReason: null,
      credentialConfigured: true,
      accountRef: 'default',
      maskedKeyHint: 'sk-or-v1...1234',
      credentialGeneration: generation,
      executionAuthorized: false,
    }),
  )
  assert.equal(dto.capabilities.fallbacksDisabled, true)
  assert.equal(dto.billingMode, 'api-key-billed')
  await registry.stop()
  await adapter.disconnect()
})
