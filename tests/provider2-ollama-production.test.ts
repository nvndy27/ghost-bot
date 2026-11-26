import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import {
  OllamaLocalAdapter,
  OLLAMA_MAX_STREAM_BYTES,
  assertLoopbackOllamaUrl,
  assertValidLocalOllamaModelId,
} from '../packages/runtime-adapters/ollama/ollama-adapter.ts'
import { RuntimePolicyBroker } from '../apps/daemon/src/runtime/policy-broker.ts'
import { RuntimeRegistry } from '../apps/daemon/src/runtime/registry.ts'
import { OllamaStatusDtoSchema } from '../packages/shared-types/ipc.ts'
import type { AgentEvent } from '@ghost-bot/shared-types/runtime'

test('OllamaLocalAdapter rejects non-loopback URLs, credentials, and cloud model identities', () => {
  assert.throws(() => assertLoopbackOllamaUrl('http://192.168.1.50:11434'), /loopback only/i)
  assert.throws(() => assertLoopbackOllamaUrl('https://ollama.example.com'), /loopback only/i)
  assert.throws(() => assertLoopbackOllamaUrl('ws://127.0.0.1:11434'), /http:\/\/ or https:\/\//i)
  assert.throws(() => assertLoopbackOllamaUrl('http://user:pass@127.0.0.1:11434'), /credentials/i)
  assert.equal(assertLoopbackOllamaUrl('http://[::1]:11434/'), 'http://[::1]:11434')

  assert.throws(() => assertValidLocalOllamaModelId(''), /Invalid Ollama model/i)
  assert.throws(() => assertValidLocalOllamaModelId('llama3.2 :latest'), /Invalid Ollama model/i)
  assert.throws(() => assertValidLocalOllamaModelId('gpt-oss:120b-cloud'), /local-only policy/i)
  assert.throws(() => assertValidLocalOllamaModelId('qwen3:cloud'), /local-only policy/i)
})

test('OllamaLocalAdapter handles unavailable runtime, redirects, malformed metadata, missing models, and cloud models', async () => {
  const unavailable = new OllamaLocalAdapter({
    baseUrl: 'http://127.0.0.1:59998',
    timeoutMs: 400,
  })
  const avail = await unavailable.checkAvailability()
  assert.equal(avail.available, false)
  assert.equal(avail.version, null)

  let mode: 'redirect' | 'malformed' | 'normal' = 'redirect'
  const server = createServer((req, res) => {
    if (mode === 'redirect') {
      res.writeHead(302, { Location: 'http://example.com/evil' })
      res.end()
      return
    }
    if (mode === 'malformed') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{not-valid-json')
      return
    }
    if (req.method === 'GET' && req.url === '/api/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ version: '0.6.8' }))
      return
    }
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          models: [
            {
              name: 'qwen2.5:1.5b',
              size: 1_048_576_000,
              digest: 'sha256:abc123',
              details: {
                parameter_size: '1.5B',
                quantization_level: 'Q4_K_M',
                family: 'qwen2',
              },
            },
            {
              name: 'remote-proxy:latest',
              remote_host: 'https://cloud.ollama.example',
              remote_model: 'llama3.3:70b',
            },
          ],
        }),
      )
      return
    }
    if (req.method === 'GET' && req.url === '/api/ps') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          models: [
            {
              name: 'qwen2.5:1.5b',
              size: 1_048_576_000,
              size_vram: 900_000_000,
              expires_at: '2026-11-27T02:00:00Z',
            },
          ],
        }),
      )
      return
    }
    if (req.method === 'POST' && req.url === '/api/show') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          details: { parameter_size: '1.5B', quantization_level: 'Q4_K_M', family: 'qwen2' },
          model_info: { 'qwen2.context_length': 32768 },
        }),
      )
      return
    }
    res.writeHead(404)
    res.end()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address()
  assert.ok(addr && typeof addr === 'object')
  const baseUrl = `http://127.0.0.1:${addr.port}`

  try {
    const adapter = new OllamaLocalAdapter({ baseUrl, timeoutMs: 1500 })

    // Redirect rejected
    mode = 'redirect'
    const redirAvail = await adapter.checkAvailability()
    assert.equal(redirAvail.available, false)

    // Malformed metadata rejected
    mode = 'malformed'
    const malAvail = await adapter.checkAvailability()
    assert.equal(malAvail.available, false)
    await assert.rejects(() => adapter.listModels(), /malformed JSON/i)

    // Normal discovery filters cloud model & enriches local model
    mode = 'normal'
    const summary = await adapter.inspectLocalRuntime()
    assert.equal(summary.available, true)
    assert.equal(summary.version, '0.6.8')
    assert.equal(summary.localOnlyVerified, true)
    assert.equal(summary.models.length, 1)
    assert.equal(summary.models[0]?.id, 'qwen2.5:1.5b')
    assert.equal(summary.models[0]?.contextLength, 32768)
    assert.equal(summary.runningModels.length, 1)
    assert.ok(summary.diagnostics.some((d) => /Filtered 1 cloud-backed model/i.test(d)))

    // Missing model & cloud model rejected on createSession
    await assert.rejects(
      () =>
        adapter.createSession({
          agentId: 'bot-1',
          accountId: 'local',
          modelId: 'missing-model:latest',
          permission: 'read-only',
          workspace: '/tmp',
          instructions: '',
        }),
      /not installed locally/i,
    )
    await assert.rejects(
      () =>
        adapter.createSession({
          agentId: 'bot-1',
          accountId: 'local',
          modelId: 'remote-proxy:latest',
          permission: 'read-only',
          workspace: '/tmp',
          instructions: '',
        }),
      /not installed locally|local-only policy/i,
    )
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('OllamaLocalAdapter enforces streaming bounds, malformed NDJSON, unknown termination, concurrency, and no retries', async () => {
  let scenario: 'normal' | 'malformed' | 'oversized' | 'unterminated' | 'tool_calls' | 'slow' =
    'normal'
  let chatCount = 0

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ version: '0.6.8' }))
      return
    }
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ models: [{ name: 'llama3.2:1b' }] }))
      return
    }
    if (req.method === 'GET' && req.url === '/api/ps') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ models: [] }))
      return
    }
    if (req.method === 'POST' && req.url === '/api/show') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ details: { parameter_size: '1B', quantization_level: 'Q4_K_M' } }))
      return
    }
    if (req.method === 'POST' && req.url === '/api/chat') {
      chatCount += 1
      let body = ''
      req.on('data', (c) => {
        body += c.toString()
      })
      req.on('end', () => {
        const parsed = JSON.parse(body) as { options?: { num_predict?: number } }
        assert.equal(parsed.options?.num_predict, 512)
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
        if (scenario === 'normal') {
          res.write(JSON.stringify({ message: { content: 'Hello ' }, done: false }) + '\n')
          res.write(
            JSON.stringify({
              message: { content: 'local' },
              done: true,
              prompt_eval_count: 8,
              eval_count: 3,
            }) + '\n',
          )
          res.end()
        } else if (scenario === 'malformed') {
          res.write('{broken_json\n')
          res.end()
        } else if (scenario === 'oversized') {
          const big = 'x'.repeat(OLLAMA_MAX_STREAM_BYTES + 1024)
          res.write(JSON.stringify({ message: { content: big }, done: false }) + '\n')
          res.end()
        } else if (scenario === 'unterminated') {
          res.write(JSON.stringify({ message: { content: 'partial' }, done: false }) + '\n')
          res.end()
        } else if (scenario === 'tool_calls') {
          res.write(
            JSON.stringify({
              message: { content: '', tool_calls: [{ function: { name: 'bash' } }] },
              done: false,
            }) + '\n',
          )
          res.end()
        } else if (scenario === 'slow') {
          res.write(JSON.stringify({ message: { content: 'waiting' }, done: false }) + '\n')
        }
      })
      return
    }
    res.writeHead(404)
    res.end()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address()
  assert.ok(addr && typeof addr === 'object')
  const baseUrl = `http://127.0.0.1:${addr.port}`

  try {
    const adapter = new OllamaLocalAdapter({
      baseUrl,
      timeoutMs: 2000,
      maxConcurrentRuns: 1,
      maxOutputTokens: 512,
      maxDurationMs: 1200,
    })

    const session = await adapter.createSession({
      agentId: 'bot-ol',
      accountId: 'local',
      modelId: 'llama3.2:1b',
      permission: 'read-only',
      workspace: '/tmp',
      instructions: 'Be brief',
    })

    // 1. Normal bounded run
    const ev1: AgentEvent[] = []
    for await (const e of adapter.run({ runId: 'r1', session, text: 'hi' })) ev1.push(e)
    assert.equal(ev1.at(-1)?.type, 'run.completed')
    assert.equal(chatCount, 1)

    // 2. Malformed NDJSON -> OLLAMA_MALFORMED_RESPONSE, no hidden retry
    scenario = 'malformed'
    const ev2: AgentEvent[] = []
    for await (const e of adapter.run({ runId: 'r2', session, text: 'bad' })) ev2.push(e)
    assert.equal(ev2.at(-1)?.type, 'run.failed')
    assert.equal((ev2.at(-1) as Extract<AgentEvent, { type: 'run.failed' }>).code, 'OLLAMA_MALFORMED_RESPONSE')
    assert.equal(chatCount, 2)

    // 3. Oversized stream -> OLLAMA_RESPONSE_TOO_LARGE
    scenario = 'oversized'
    const ev3: AgentEvent[] = []
    for await (const e of adapter.run({ runId: 'r3', session, text: 'big' })) ev3.push(e)
    assert.equal(ev3.at(-1)?.type, 'run.failed')
    assert.equal((ev3.at(-1) as Extract<AgentEvent, { type: 'run.failed' }>).code, 'OLLAMA_RESPONSE_TOO_LARGE')

    // 4. Unterminated stream -> OLLAMA_UNKNOWN_TERMINATION and uncertainLastRun recorded
    scenario = 'unterminated'
    const ev4: AgentEvent[] = []
    for await (const e of adapter.run({ runId: 'r4', session, text: 'eof' })) ev4.push(e)
    assert.equal(ev4.at(-1)?.type, 'run.failed')
    assert.equal((ev4.at(-1) as Extract<AgentEvent, { type: 'run.failed' }>).code, 'OLLAMA_UNKNOWN_TERMINATION')
    const inspected = await adapter.inspectSession(session.externalId)
    assert.equal(inspected.uncertainLastRun, true)
    assert.equal(inspected.historyTurns, 2) // Only r1 persisted; failed r2-r4 not added

    // 5. Tool call attempt rejected in read-only mode
    scenario = 'tool_calls'
    const ev5: AgentEvent[] = []
    for await (const e of adapter.run({ runId: 'r5', session, text: 'tool' })) ev5.push(e)
    assert.equal(ev5.at(-1)?.type, 'run.failed')
    assert.equal((ev5.at(-1) as Extract<AgentEvent, { type: 'run.failed' }>).code, 'OLLAMA_TOOLS_UNSUPPORTED')

    // 6. Attachments rejected
    await assert.rejects(
      async () => {
        for await (const _ of adapter.run({
          runId: 'r-att',
          session,
          text: 'hi',
          attachments: ['/tmp/a.txt'],
        })) {
          // noop
        }
      },
      /does not support file attachments/i,
    )

    // 7. Reconnect & session isolation
    const resumed = await adapter.resumeSession(session.externalId)
    assert.equal(resumed.externalId, session.externalId)
    await assert.rejects(() => adapter.resumeSession('nonexistent-id'), /Unknown Ollama session/i)

    // 8. Policy broker & RuntimeRegistry IPC DTO validation
    const broker = new RuntimePolicyBroker()
    assert.equal(
      broker.authorizeOllamaExecution({
        requestedPermission: 'workspace',
        canonicalWorkspace: '/tmp',
        ollamaExecutionAuthorized: true,
        ollamaAvailable: true,
        ollamaLoopbackVerified: true,
        ollamaLocalOnlyVerified: true,
      }).allowed,
      false,
    )
    assert.equal(
      broker.authorizeOllamaExecution({
        requestedPermission: 'read-only',
        canonicalWorkspace: '/tmp',
        ollamaExecutionAuthorized: true,
        ollamaAvailable: true,
        ollamaLoopbackVerified: true,
        ollamaLocalOnlyVerified: true,
      }).allowed,
      true,
    )

    const registry = new RuntimeRegistry({
      runtimeMode: 'mock',
      ollamaAdapter: adapter,
    })
    const statusDto = OllamaStatusDtoSchema.parse(await registry.getOllamaStatus())
    assert.equal(statusDto.available, true)
    assert.equal(statusDto.models[0]?.id, 'llama3.2:1b')
    assert.equal(statusDto.policyCompatibility.readOnlyAllowed, false)
    await registry.stop()
    await adapter.disconnect()
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
