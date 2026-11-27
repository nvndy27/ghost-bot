import assert from 'node:assert/strict'
import test from 'node:test'
import {
  APPROVED_GEMINI_ORIGIN,
  GEMINI_MAX_STREAM_BYTES,
  GoogleGeminiApiAdapter,
  assertApprovedGeminiUrl,
  assertValidGeminiModelId,
  redactGeminiSecrets,
} from '../packages/runtime-adapters/gemini/google-gemini-api.ts'
import { InMemoryTestSecretStore } from '../apps/daemon/src/secrets/store.ts'
import { RuntimePolicyBroker } from '../apps/daemon/src/runtime/policy-broker.ts'
import { RuntimeRegistry } from '../apps/daemon/src/runtime/registry.ts'
import { GeminiStatusDtoSchema } from '../packages/shared-types/ipc.ts'
import type { AgentEvent } from '@ghost-bot/shared-types/runtime'

function sseResponse(frames: string[], status = 200): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) {
        controller.enqueue(encoder.encode(f))
      }
      controller.close()
    },
  })
  return new Response(stream, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  })
}

test('GoogleGeminiApiAdapter enforces official endpoint, x-goog-api-key header, redaction, and cross-provider isolation', () => {
  assert.throws(
    () => assertApprovedGeminiUrl('http://generativelanguage.googleapis.com/v1beta/models'),
    /https:/i,
  )
  assert.throws(
    () => assertApprovedGeminiUrl('https://evil.example.com/v1beta/models'),
    /generativelanguage\.googleapis\.com/i,
  )
  assert.throws(
    () =>
      assertApprovedGeminiUrl(
        'https://generativelanguage.googleapis.com/v1beta/models?key=AIzaSyDummySecret123456',
      ),
    /x-goog-api-key header/i,
  )
  assert.throws(
    () => assertValidGeminiModelId('gemini-2.5-flash/../evil'),
    /Invalid Google Gemini model/i,
  )
  assert.equal(
    redactGeminiSecrets('Error with AIzaSyDummySecret1234567890 and ?key=abc123'),
    'Error with [REDACTED] and [REDACTED]',
  )

  // Cross-provider isolation: Gemini, Claude, and MCP namespaces do not collide
  const store = new InMemoryTestSecretStore()
  store.storeProviderSecret(
    { ownerId: 'local-user', providerId: 'anthropic', accountRef: 'default' },
    'Claude',
    'sk-ant-api03-claude-only',
  )
  assert.equal(
    store.existsProviderSecret({
      ownerId: 'local-user',
      providerId: 'gemini',
      accountRef: 'default',
    }),
    false,
  )
  store.storeProviderSecret(
    { ownerId: 'local-user', providerId: 'gemini', accountRef: 'default' },
    'Gemini',
    'AIzaSyDummyGeminiKey123456',
  )
  assert.equal(
    store.resolveProviderSecret({
      ownerId: 'local-user',
      providerId: 'gemini',
      accountRef: 'default',
    }),
    'AIzaSyDummyGeminiKey123456',
  )
  assert.equal(
    store.resolveProviderSecret({
      ownerId: 'local-user',
      providerId: 'anthropic',
      accountRef: 'default',
    }),
    'sk-ant-api03-claude-only',
  )
})

test('GoogleGeminiApiAdapter handles paginated discovery, SSE streaming, non-cumulative usage, safety, MAX_TOKENS, rotation, and cancellation', async () => {
  let authorized = false
  let generation = 1
  let accountRef = 'default'
  const currentKey = 'AIzaSyDummyGeminiKey123456'
  let scenario:
    | 'valid'
    | 'malformed'
    | 'partial'
    | 'safety'
    | 'max_tokens'
    | 'function_call'
    | 'redirect'
    | 'oversized'
    | 'rotate_mid_stream'
    | 'slow' = 'valid'
  let requestCount = 0

  const adapter = new GoogleGeminiApiAdapter({
    resolveApiKey: () => currentKey,
    isExecutionAuthorized: () => authorized,
    getCredentialGeneration: () => generation,
    getAccountRef: () => accountRef,
    maxOutputTokens: 256,
    maxDurationMs: 1200,
    transport: async (url, init) => {
      requestCount += 1
      assert.ok(url.startsWith(APPROVED_GEMINI_ORIGIN))
      assert.equal(init.redirect, 'error')
      const headers = init.headers as Record<string, string>
      assert.equal(headers['x-goog-api-key'], currentKey)

      if (url.includes('/v1beta/models?')) {
        if (!url.includes('pageToken=page2')) {
          return new Response(
            JSON.stringify({
              models: [
                {
                  name: 'models/gemini-2.5-flash',
                  displayName: 'Gemini 2.5 Flash',
                  supportedGenerationMethods: ['generateContent'],
                },
                {
                  name: 'models/embedding-001',
                  displayName: 'Embedding 001',
                  supportedGenerationMethods: ['embedContent'],
                },
              ],
              nextPageToken: 'page2',
            }),
            { status: 200 },
          )
        }
        return new Response(
          JSON.stringify({
            models: [
              {
                name: 'models/gemini-2.5-pro',
                displayName: 'Gemini 2.5 Pro',
                supportedGenerationMethods: ['generateContent'],
              },
            ],
          }),
          { status: 200 },
        )
      }

      const body = JSON.parse(String(init.body)) as {
        generationConfig?: { maxOutputTokens?: number }
        tools?: unknown
      }
      assert.equal(body.generationConfig?.maxOutputTokens, 256)
      assert.equal(body.tools, undefined)

      if (scenario === 'redirect') {
        return new Response(null, { status: 302, headers: { location: 'https://evil.example' } })
      }
      if (scenario === 'malformed') {
        return sseResponse(['data: {broken_json\n\n'])
      }
      if (scenario === 'partial') {
        return sseResponse([
          'data: {"candidates":[{"content":{"parts":[{"text":"Partial"}]}}]}\n\n',
        ])
      }
      if (scenario === 'safety') {
        return sseResponse([
          'data: {"candidates":[{"finishReason":"SAFETY"}]}\n\n',
        ])
      }
      if (scenario === 'max_tokens') {
        return sseResponse([
          'data: {"candidates":[{"content":{"parts":[{"text":"Cut off"}]},"finishReason":"MAX_TOKENS"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":256}}\n\n',
        ])
      }
      if (scenario === 'function_call') {
        return sseResponse([
          'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"bash","args":{}}}]}}]}\n\n',
        ])
      }
      if (scenario === 'oversized') {
        const big = 'g'.repeat(GEMINI_MAX_STREAM_BYTES + 256)
        return sseResponse([
          `data: {"candidates":[{"content":{"parts":[{"text":"${big}"}]}}]}\n\n`,
        ])
      }
      if (scenario === 'rotate_mid_stream') {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"candidates":[{"content":{"parts":[{"text":"Before"}]}}]}\n\n',
              ),
            )
            generation += 1
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"candidates":[{"content":{"parts":[{"text":"After"}]},"finishReason":"STOP"}]}\n\n',
              ),
            )
            controller.close()
          },
        })
        return new Response(stream, { status: 200 })
      }
      if (scenario === 'slow') {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"candidates":[{"content":{"parts":[{"text":"Wait"}]}}]}\n\n',
              ),
            )
            init.signal?.addEventListener('abort', () => {
              controller.error(new Error('Aborted'))
            })
          },
        })
        return new Response(stream, { status: 200 })
      }

      // Valid multi-chunk SSE with cumulative usageMetadata (must emit usage.updated ONCE!)
      return sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"Hidden","thought":true},{"text":"Hello "}]}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2}}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"Gemini"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":6,"thoughtsTokenCount":3}}\n\n',
      ])
    },
  })

  // Offline gated by default: zero HTTP calls
  assert.deepEqual(await adapter.listModels(), [])
  assert.equal(requestCount, 0)
  assert.equal(await adapter.getUsage(), null)

  const session = await adapter.createSession({
    agentId: 'bot-g',
    accountId: 'default',
    modelId: 'gemini-2.5-flash',
    permission: 'read-only',
    workspace: '/tmp',
    instructions: 'Be concise.',
  })

  // Gated execution emits GEMINI_EXECUTION_GATED without hitting transport
  const gatedEv: AgentEvent[] = []
  for await (const e of adapter.run({ runId: 'g-gated', session, text: 'hi' })) gatedEv.push(e)
  assert.equal((gatedEv.at(-1) as Extract<AgentEvent, { type: 'run.failed' }>).code, 'GEMINI_EXECUTION_GATED')
  assert.equal(requestCount, 0)

  // Authorize -> paginated model discovery filters out embedContent-only models
  authorized = true
  const models = await adapter.listModels()
  assert.deepEqual(
    models.map((m) => m.id),
    ['gemini-2.5-flash', 'gemini-2.5-pro'],
  )

  // Valid SSE run: thought part suppressed, non-cumulative usageMetadata emitted once
  const evValid: AgentEvent[] = []
  for await (const e of adapter.run({ runId: 'g-ok', session, text: 'hi' })) evValid.push(e)
  assert.deepEqual(
    evValid.map((e) => e.type),
    ['message.delta', 'message.delta', 'usage.updated', 'run.completed'],
  )
  const usageEv = evValid.find((e) => e.type === 'usage.updated') as Extract<
    AgentEvent,
    { type: 'usage.updated' }
  >
  assert.equal(usageEv.usage.inputTokens, 10)
  assert.equal(usageEv.usage.outputTokens, 9) // 6 candidate + 3 thought tokens

  // Error & safety cases (zero automatic retries)
  const cases: Array<[typeof scenario, string]> = [
    ['redirect', 'GEMINI_REDIRECT_FORBIDDEN'],
    ['malformed', 'GEMINI_MALFORMED_SSE'],
    ['partial', 'GEMINI_UNKNOWN_TERMINATION'],
    ['safety', 'GEMINI_SAFETY_BLOCKED'],
    ['max_tokens', 'GEMINI_MAX_TOKENS'],
    ['function_call', 'GEMINI_UNSUPPORTED_PART'],
    ['oversized', 'GEMINI_RESPONSE_TOO_LARGE'],
  ]
  for (const [sc, expectedCode] of cases) {
    scenario = sc
    const before = requestCount
    const ev: AgentEvent[] = []
    for await (const e of adapter.run({ runId: `g-${sc}`, session, text: 'test' })) ev.push(e)
    assert.equal(ev.at(-1)?.type, 'run.failed')
    assert.equal((ev.at(-1) as Extract<AgentEvent, { type: 'run.failed' }>).code, expectedCode)
    assert.equal(requestCount, before + 1)
  }

  // Cancellation
  scenario = 'slow'
  const evCancel: AgentEvent[] = []
  for await (const e of adapter.run({ runId: 'g-cancel', session, text: 'slow' })) {
    evCancel.push(e)
    if (e.type === 'message.delta') {
      await adapter.cancel('g-cancel')
    }
  }
  assert.equal(evCancel.at(-1)?.type, 'run.cancelled')

  // Mid-stream credential rotation aborts active run
  scenario = 'rotate_mid_stream'
  const evMidRot: AgentEvent[] = []
  for await (const e of adapter.run({ runId: 'g-mid-rot', session, text: 'rot' })) evMidRot.push(e)
  assert.equal((evMidRot.at(-1) as Extract<AgentEvent, { type: 'run.failed' }>).code, 'GEMINI_CREDENTIAL_ROTATED')

  // Account change invalidates session
  accountRef = 'work'
  await assert.rejects(() => adapter.resumeSession(session.externalId), /invalidated/i)

  // PolicyBroker & IPC DTO validation
  const broker = new RuntimePolicyBroker()
  assert.equal(
    broker.authorizeGeminiApiExecution({
      requestedPermission: 'read-only',
      canonicalWorkspace: '/tmp',
      geminiExecutionAuthorized: true,
      geminiCredentialConfigured: true,
      geminiKeyringAvailable: false,
      geminiEndpointVerified: true,
    }).allowed,
    false,
  )
  assert.equal(
    broker.authorizeGeminiApiExecution({
      requestedPermission: 'read-only',
      canonicalWorkspace: '/tmp',
      geminiExecutionAuthorized: true,
      geminiCredentialConfigured: true,
      geminiKeyringAvailable: true,
      geminiEndpointVerified: true,
    }).allowed,
    true,
  )

  const registry = new RuntimeRegistry({ runtimeMode: 'mock', geminiAdapter: adapter })
  const dto = GeminiStatusDtoSchema.parse(
    await registry.getGeminiStatus({
      keyringAvailable: true,
      keyringLocked: false,
      keyringReason: null,
      credentialConfigured: true,
      accountRef: 'work',
      maskedKeyHint: 'AIzaSy...3456',
      credentialGeneration: generation,
      executionAuthorized: false,
    }),
  )
  assert.equal(dto.billingMode, 'api-key')
  assert.equal(dto.capabilities.tools, false)
  assert.equal(dto.capabilities.geminiCli, false)
  assert.equal(dto.policyCompatibility.readOnlyAllowed, false)
  await registry.stop()
  await adapter.disconnect()
})
