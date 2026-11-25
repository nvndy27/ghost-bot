import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import {
  OllamaLocalAdapter,
  assertLoopbackOllamaUrl,
} from '../packages/runtime-adapters/ollama/ollama-adapter.ts'
import type { AgentEvent } from '@ghost-bot/shared-types/runtime'
import { RuntimePolicyBroker } from '../apps/daemon/src/runtime/policy-broker.ts'

test('OllamaLocalAdapter enforces loopback URL, read-only chat, streaming, usage, and cancellation', async () => {
  assert.throws(() => assertLoopbackOllamaUrl('http://192.168.1.50:11434'), /loopback only/i)
  assert.throws(() => assertLoopbackOllamaUrl('ws://127.0.0.1:11434'), /http:\/\/ or https:\/\//i)

  const broker = new RuntimePolicyBroker()
  const policy = broker.authorize({
    runtimeMode: 'ollama',
    codexVersion: null,
    authMethod: 'none',
    requestedPermission: 'read-only',
    canonicalWorkspace: '/tmp',
  })
  assert.equal(policy.allowed, false)

  let chatRequests = 0
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ version: '0.6.2' }))
      return
    }
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ models: [{ name: 'llama3.2:latest' }] }))
      return
    }
    if (req.method === 'POST' && req.url === '/api/chat') {
      chatRequests += 1
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
      if (chatRequests === 1) {
        res.write(JSON.stringify({ message: { content: 'Local ' }, done: false }) + '\n')
        res.write(
          JSON.stringify({
            message: { content: 'reply' },
            done: true,
            prompt_eval_count: 12,
            eval_count: 5,
          }) + '\n',
        )
        res.end()
      } else {
        res.write(JSON.stringify({ message: { content: 'Partial ' }, done: false }) + '\n')
        // Keep stream open until client aborts
      }
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
    const adapter = new OllamaLocalAdapter({ baseUrl, timeoutMs: 2000 })
    const avail = await adapter.checkAvailability()
    assert.equal(avail.available, true)
    assert.equal(avail.version, '0.6.2')

    const models = await adapter.listModels()
    assert.equal(models.length, 1)
    assert.equal(models[0]?.id, 'llama3.2:latest')
    assert.deepEqual(models[0]?.efforts, [])
    assert.deepEqual(models[0]?.permissionModes, ['read-only'])
    assert.equal(models[0]?.supportsTools, false)
    assert.equal(await adapter.getUsage(), null)

    await assert.rejects(
      () =>
        adapter.createSession({
          agentId: 'chief',
          accountId: 'local',
          modelId: 'llama3.2:latest',
          permission: 'workspace',
          workspace: '/tmp',
          instructions: '',
        }),
      /only supports 'read-only'/i,
    )

    const session = await adapter.createSession({
      agentId: 'chief',
      accountId: 'local',
      modelId: 'llama3.2:latest',
      permission: 'read-only',
      workspace: '/tmp',
      instructions: 'Be concise.',
    })

    const events1: AgentEvent[] = []
    for await (const evt of adapter.run({ runId: 'run-ol-1', session, text: 'Hi' })) {
      events1.push(evt)
    }
    assert.deepEqual(
      events1.map((e) => e.type),
      ['message.delta', 'message.delta', 'usage.updated', 'run.completed'],
    )
    const usageEvt = events1.find((e) => e.type === 'usage.updated')
    assert.ok(usageEvt && usageEvt.type === 'usage.updated')
    assert.equal(usageEvt.usage.source, 'local')
    assert.equal(usageEvt.usage.inputTokens, 12)
    assert.equal(usageEvt.usage.outputTokens, 5)

    // Cancellation test on streaming run 2
    const events2: AgentEvent[] = []
    for await (const evt of adapter.run({ runId: 'run-ol-2', session, text: 'Stream forever' })) {
      events2.push(evt)
      if (evt.type === 'message.delta') {
        await adapter.cancel('run-ol-2')
      }
    }
    assert.equal(events2.at(-1)?.type, 'run.cancelled')
    await adapter.disconnect()
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
