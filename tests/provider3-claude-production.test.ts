import assert from 'node:assert/strict'
import test from 'node:test'
import {
  APPROVED_ANTHROPIC_ORIGIN,
  AnthropicClaudeApiAdapter,
  CLAUDE_MAX_STREAM_BYTES,
  assertApprovedAnthropicUrl,
  redactAnthropicSecrets,
} from '../packages/runtime-adapters/claude/anthropic-claude-api.ts'
import { InMemoryTestSecretStore } from '../apps/daemon/src/secrets/store.ts'
import { RuntimePolicyBroker } from '../apps/daemon/src/runtime/policy-broker.ts'
import { RuntimeRegistry } from '../apps/daemon/src/runtime/registry.ts'
import { ClaudeStatusDtoSchema } from '../packages/shared-types/ipc.ts'
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

test('AnthropicClaudeApiAdapter enforces official endpoint, secret redaction, and credential isolation', async () => {
  assert.throws(() => assertApprovedAnthropicUrl('http://api.anthropic.com/v1/messages'), /https:/i)
  assert.throws(() => assertApprovedAnthropicUrl('https://evil.example.com/v1/messages'), /api\.anthropic\.com/i)
  assert.throws(() => assertApprovedAnthropicUrl('https://user:pass@api.anthropic.com/v1/messages'), /credentials/i)
  assert.equal(
    assertApprovedAnthropicUrl('https://api.anthropic.com/v1/messages/'),
    'https://api.anthropic.com/v1/messages',
  )
  assert.equal(
    redactAnthropicSecrets('Auth failed for sk-ant-api03-secret123456'),
    'Auth failed for [REDACTED]',
  )

  // Provider credential namespace is isolated from MCP credentials and fails closed when locked/unavailable
  const store = new InMemoryTestSecretStore()
  store.store(
    { ownerId: 'local-user', serverId: 'mcp-1', refId: 'api_token' },
    'MCP Token',
    'mcp-secret-value',
  )
  assert.equal(
    store.existsProviderSecret({ ownerId: 'local-user', providerId: 'anthropic', accountRef: 'default' }),
    false,
  )
  store.storeProviderSecret(
    { ownerId: 'local-user', providerId: 'anthropic', accountRef: 'default' },
    'Anthropic Key',
    'sk-ant-api03-user-key-9999',
  )
  assert.equal(
    store.resolveProviderSecret({ ownerId: 'local-user', providerId: 'anthropic', accountRef: 'default' }),
    'sk-ant-api03-user-key-9999',
  )

  store.setLocked(true)
  assert.throws(
    () =>
      store.resolveProviderSecret({
        ownerId: 'local-user',
        providerId: 'anthropic',
        accountRef: 'default',
      }),
    /locked/i,
  )
  store.setLocked(false)
  store.setAvailable(false)
  assert.equal(
    store.existsProviderSecret({ ownerId: 'local-user', providerId: 'anthropic', accountRef: 'default' }),
    false,
  )
})

test('AnthropicClaudeApiAdapter handles SSE streaming, usage, errors, bounds, cancellation, and rotation', async () => {
  let authorized = false
  let generation = 1
  let currentKey: string | null = 'sk-ant-api03-test-key-1234'
  let scenario:
    | 'valid'
    | 'malformed_sse'
    | 'partial'
    | 'auth_error'
    | 'rate_limit'
    | 'overload'
    | 'redirect'
    | 'tool_use'
    | 'oversized'
    | 'slow' = 'valid'
  let requestCount = 0

  const adapter = new AnthropicClaudeApiAdapter({
    resolveApiKey: () => currentKey,
    isExecutionAuthorized: () => authorized,
    getCredentialGeneration: () => generation,
    maxOutputTokens: 512,
    maxDurationMs: 1200,
    transport: async (url, init) => {
      requestCount += 1
      assert.ok(url.startsWith(APPROVED_ANTHROPIC_ORIGIN))
      assert.equal(init.redirect, 'error')

      if (url.endsWith('/v1/models')) {
        return new Response(
          JSON.stringify({ data: [{ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }

      const body = JSON.parse(String(init.body)) as { max_tokens?: number; tools?: unknown }
      assert.equal(body.max_tokens, 512)
      assert.equal(body.tools, undefined)

      if (scenario === 'redirect') {
        return new Response(null, { status: 302, headers: { location: 'https://evil.example' } })
      }
      if (scenario === 'auth_error') {
        return new Response(JSON.stringify({ error: { type: 'authentication_error' } }), { status: 401 })
      }
      if (scenario === 'rate_limit') {
        return new Response(JSON.stringify({ error: { type: 'rate_limit_error' } }), { status: 429 })
      }
      if (scenario === 'overload') {
        return new Response(JSON.stringify({ error: { type: 'overloaded_error' } }), { status: 529 })
      }
      if (scenario === 'malformed_sse') {
        return sseResponse(['event: content_block_delta\ndata: {bad-json\n\n'])
      }
      if (scenario === 'partial') {
        return sseResponse([
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Half"}}\n\n',
        ])
      }
      if (scenario === 'tool_use') {
        return sseResponse([
          'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","id":"t1","name":"bash"}}\n\n',
        ])
      }
      if (scenario === 'oversized') {
        const big = 'a'.repeat(CLAUDE_MAX_STREAM_BYTES + 256)
        return sseResponse([
          `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"${big}"}}\n\n`,
        ])
      }
      if (scenario === 'slow') {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Wait"}}\n\n',
              ),
            )
            init.signal?.addEventListener('abort', () => {
              controller.error(new Error('Aborted'))
            })
          },
        })
        return new Response(stream, { status: 200 })
      }

      return sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":14}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Claude"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ])
    },
  })

  // Offline gated by default: listModels makes zero HTTP calls
  assert.deepEqual(await adapter.listModels(), [])
  assert.equal(requestCount, 0)
  assert.equal(await adapter.getUsage(), null)

  // Non-read-only rejected
  await assert.rejects(
    () =>
      adapter.createSession({
        agentId: 'bot-c',
        accountId: 'default',
        modelId: 'claude-sonnet-5-5',
        permission: 'workspace',
        workspace: '/tmp',
        instructions: '',
      }),
    /read-only/i,
  )

  const session = await adapter.createSession({
    agentId: 'bot-c',
    accountId: 'default',
    modelId: 'claude-sonnet-5-5',
    permission: 'read-only',
    workspace: '/tmp',
    instructions: 'Be concise.',
  })

  // Gated execution emits CLAUDE_EXECUTION_GATED without hitting transport
  const gatedEvents: AgentEvent[] = []
  for await (const e of adapter.run({ runId: 'run-gated', session, text: 'hi' })) gatedEvents.push(e)
  assert.equal((gatedEvents.at(-1) as Extract<AgentEvent, { type: 'run.failed' }>).code, 'CLAUDE_EXECUTION_GATED')
  assert.equal(requestCount, 0)

  // Enable explicit opt-in -> valid SSE run
  authorized = true
  const models = await adapter.listModels()
  assert.equal(models.length, 1)
  assert.equal(models[0]?.id, 'claude-sonnet-5-5')
  assert.equal(models[0]?.supportsTools, false)

  const ev1: AgentEvent[] = []
  for await (const e of adapter.run({ runId: 'run-ok', session, text: 'hi' })) ev1.push(e)
  assert.deepEqual(
    ev1.map((e) => e.type),
    ['message.delta', 'message.delta', 'usage.updated', 'run.completed'],
  )
  const usageEv = ev1.find((e) => e.type === 'usage.updated') as Extract<AgentEvent, { type: 'usage.updated' }>
  assert.equal(usageEv.usage.source, 'provider')
  assert.equal(usageEv.usage.inputTokens, 14)
  assert.equal(usageEv.usage.outputTokens, 7)

  // Error & boundary scenarios (zero automatic retries)
  const cases: Array<[typeof scenario, string]> = [
    ['redirect', 'CLAUDE_REDIRECT_FORBIDDEN'],
    ['auth_error', 'CLAUDE_AUTH_ERROR'],
    ['rate_limit', 'CLAUDE_RATE_LIMITED'],
    ['overload', 'CLAUDE_OVERLOADED'],
    ['malformed_sse', 'CLAUDE_MALFORMED_SSE'],
    ['partial', 'CLAUDE_UNKNOWN_TERMINATION'],
    ['tool_use', 'CLAUDE_TOOLS_UNSUPPORTED'],
    ['oversized', 'CLAUDE_RESPONSE_TOO_LARGE'],
  ]
  for (const [sc, expectedCode] of cases) {
    scenario = sc
    const beforeReqs = requestCount
    const ev: AgentEvent[] = []
    for await (const e of adapter.run({ runId: `run-${sc}`, session, text: 'test' })) ev.push(e)
    assert.equal(ev.at(-1)?.type, 'run.failed')
    assert.equal((ev.at(-1) as Extract<AgentEvent, { type: 'run.failed' }>).code, expectedCode)
    assert.equal(requestCount, beforeReqs + 1)
  }

  // Cancellation
  scenario = 'slow'
  const evCancel: AgentEvent[] = []
  for await (const e of adapter.run({ runId: 'run-cancel', session, text: 'slow' })) {
    evCancel.push(e)
    if (e.type === 'message.delta') {
      await adapter.cancel('run-cancel')
    }
  }
  assert.equal(evCancel.at(-1)?.type, 'run.cancelled')

  // Credential rotation invalidates existing session
  generation = 2
  const evRotated: AgentEvent[] = []
  for await (const e of adapter.run({ runId: 'run-rot', session, text: 'after rotation' })) {
    evRotated.push(e)
  }
  assert.equal((evRotated.at(-1) as Extract<AgentEvent, { type: 'run.failed' }>).code, 'CLAUDE_CREDENTIAL_ROTATED')

  // PolicyBroker & IPC DTO validation
  const broker = new RuntimePolicyBroker()
  assert.equal(
    broker.authorizeClaudeApiExecution({
      requestedPermission: 'read-only',
      canonicalWorkspace: '/tmp',
      claudeExecutionAuthorized: true,
      claudeCredentialConfigured: true,
      claudeKeyringAvailable: false,
      claudeEndpointVerified: true,
    }).allowed,
    false,
  )
  assert.equal(
    broker.authorizeClaudeApiExecution({
      requestedPermission: 'read-only',
      canonicalWorkspace: '/tmp',
      claudeExecutionAuthorized: true,
      claudeCredentialConfigured: true,
      claudeKeyringAvailable: true,
      claudeEndpointVerified: true,
    }).allowed,
    true,
  )

  const registry = new RuntimeRegistry({ runtimeMode: 'mock', claudeAdapter: adapter })
  const dto = ClaudeStatusDtoSchema.parse(
    await registry.getClaudeStatus({
      keyringAvailable: true,
      keyringLocked: false,
      keyringReason: null,
      credentialConfigured: true,
      accountRef: 'default',
      maskedKeyHint: 'sk-ant-...1234',
      credentialGeneration: 2,
      executionAuthorized: false,
    }),
  )
  assert.equal(dto.billingMode, 'api-key-billed')
  assert.equal(dto.capabilities.tools, false)
  assert.equal(dto.capabilities.claudeCodeCli, false)
  assert.equal(dto.policyCompatibility.readOnlyAllowed, false)
  await registry.stop()
  await adapter.disconnect()
  currentKey = null
})
