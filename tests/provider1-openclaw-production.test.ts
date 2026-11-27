import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  OpenClawGatewayAdapter,
  type OpenClawGatewayTransport,
  type OpenClawStreamChunk,
} from '../packages/runtime-adapters/openclaw/openclaw-gateway.ts'
import { RuntimePolicyBroker } from '../apps/daemon/src/runtime/policy-broker.ts'
import { RuntimeRegistry } from '../apps/daemon/src/runtime/registry.ts'

describe('Provider.1: OpenClaw Gateway Production Execution & Security', () => {
  it('enforces loopback URLs, version compatibility, auth failure redaction, and disconnect/reconnect', async () => {
    assert.throws(() => new OpenClawGatewayAdapter({ gatewayUrl: 'ws://192.168.1.10:18789' }))
    assert.throws(() => new OpenClawGatewayAdapter({ gatewayUrl: 'http://127.0.0.1:18789' }))

    // Auth failure redacts secret tokens
    const authFailTransport: OpenClawGatewayTransport = {
      async callRpc() {
        throw new Error('401 Unauthorized: Bearer sk-secret1234567890 token=mysecretpw')
      },
    }
    const authFailAdapter = new OpenClawGatewayAdapter({ transport: authFailTransport })
    const authFailStatus = await authFailAdapter.inspectGateway()
    assert.equal(authFailStatus.available, false)
    assert.equal(authFailStatus.authState.status, 'disconnected')
    assert.ok(!authFailStatus.authState.detail?.includes('sk-secret1234567890'))
    assert.ok(!authFailStatus.authState.detail?.includes('mysecretpw'))

    // Unsupported version rejected
    const badVerTransport: OpenClawGatewayTransport = {
      async callRpc(method) {
        if (method === 'health') return { ok: true, plugins: { loaded: [] } } as never
        if (method === 'status') return { runtimeVersion: '2025.01.0', hostDesktop: { enabled: false } } as never
        return {} as never
      },
    }
    const badVerAdapter = new OpenClawGatewayAdapter({ transport: badVerTransport })
    const badVerStatus = await badVerAdapter.inspectGateway()
    assert.equal(badVerStatus.supportedVersion, false)
    assert.equal(badVerStatus.authState.status, 'error')

    // Valid 2026.11.8 reconnect
    const okTransport: OpenClawGatewayTransport = {
      async callRpc(method) {
        if (method === 'health') return { ok: true, plugins: { loaded: ['openai'] } } as never
        if (method === 'status') return { runtimeVersion: '2026.11.8', hostDesktop: { enabled: false } } as never
        return {} as never
      },
    }
    const okAdapter = new OpenClawGatewayAdapter({ transport: okTransport })
    const okStatus = await okAdapter.reconnect()
    assert.equal(okStatus.available, true)
    assert.equal(okStatus.supportedVersion, true)
    assert.equal(okStatus.runtimeVersion, '2026.11.8')
    assert.equal(await okAdapter.getUsage(), null)
  })

  it('handles session lifecycle, resume, deduplication, usage accounting, malformed/oversized events, and cancellation', async () => {
    let cancelAck = true
    const chunks: OpenClawStreamChunk[] = [
      { type: 'delta', text: 'Hello ' },
      { type: 'tool.started', tool: 'read_file', callId: 'c1', summary: 'read a.txt' },
      { type: 'tool.started', tool: 'read_file', callId: 'c1', summary: 'duplicate ignored' },
      { type: 'approval.requested', approvalId: 'app1', tool: 'write_file', argsHash: 'abc', summary: 'write', expiresAt: '2026-12-01T00:00:00Z' },
      { type: 'approval.requested', approvalId: 'app1', tool: 'write_file', argsHash: 'abc', summary: 'dup', expiresAt: '2026-12-01T00:00:00Z' },
      { type: 'usage', inputTokens: 42, outputTokens: 17, source: 'provider' },
      { type: 'completed' },
      { type: 'delta', text: 'post-terminal ignored' },
    ]

    const transport: OpenClawGatewayTransport = {
      async callRpc(method) {
        if (method === 'health') return { ok: true } as never
        if (method === 'status') return { runtimeVersion: '2026.11.8' } as never
        if (method === 'models.list') return { models: [{ id: 'gpt-6-astra', name: 'GPT-6 Astra', thinkingLevels: [{ id: 'medium' }] }] } as never
        return {} as never
      },
      async *streamChat(params, signal) {
        assert.equal(params.maxAttempts, 1)
        if (params.text === 'malformed') {
          yield { type: 'unknown_bad' } as never
          return
        }
        if (params.text === 'oversized') {
          yield { type: 'delta', text: 'A'.repeat(2 * 1024 * 1024 + 100) }
          return
        }
        if (params.text === 'hang') {
          await new Promise<void>((res) => signal.addEventListener('abort', () => res(), { once: true }))
          return
        }
        for (const c of chunks) yield c
      },
      async cancelRun() {
        return { acknowledged: cancelAck }
      },
      async inspectSession(id) {
        return { exists: id.startsWith('openclaw-'), status: 'active' }
      },
      async resumeSession(_id) {
        return {
          agentId: 'bot-1',
          accountId: 'acc-1',
          modelId: 'gpt-6-astra',
          permission: 'read-only',
          workspace: '/tmp',
          instructions: 'hi',
        }
      },
    }

    const adapter = new OpenClawGatewayAdapter({ transport })
    const sess = await adapter.createSession({
      agentId: 'bot-1',
      accountId: 'acc-1',
      modelId: 'gpt-6-astra',
      permission: 'read-only',
      workspace: '/tmp',
      instructions: 'hi',
    })

    // Runtime mismatch rejected
    const badEvents: string[] = []
    await assert.rejects(async () => {
      for await (const ev of adapter.run({
        runId: 'r-bad',
        session: { ...sess, runtimeId: 'codex' },
        text: 'hi',
      })) {
        badEvents.push(ev.type)
      }
    })

    // Normal stream with dedup & usage
    const collected = []
    for await (const ev of adapter.run({ runId: 'r-1', session: sess, text: 'hi' })) {
      collected.push(ev)
    }
    assert.deepEqual(
      collected.map((e) => e.type),
      ['message.delta', 'tool.started', 'approval.requested', 'usage.updated', 'run.completed'],
    )
    assert.equal((collected[3] as { usage: { inputTokens: number } }).usage.inputTokens, 42)

    // Malformed & oversized events fail closed
    const mal = []
    for await (const ev of adapter.run({ runId: 'r-mal', session: sess, text: 'malformed' })) mal.push(ev)
    assert.equal(mal[0]?.type, 'run.failed')
    assert.equal((mal[0] as { code: string }).code, 'MALFORMED_GATEWAY_EVENT')

    const big = []
    for await (const ev of adapter.run({ runId: 'r-big', session: sess, text: 'oversized' })) big.push(ev)
    assert.equal(big[0]?.type, 'run.failed')
    assert.equal((big[0] as { code: string }).code, 'STREAM_LIMIT_EXCEEDED')

    // Cancellation & unacknowledged cancellation
    const hangPromise = (async () => {
      const evs = []
      for await (const ev of adapter.run({ runId: 'r-cancel', session: sess, text: 'hang' })) evs.push(ev)
      return evs
    })()
    await new Promise((r) => setTimeout(r, 20))
    await adapter.cancel('r-cancel')
    const cancelledEvs = await hangPromise
    assert.equal(cancelledEvs.at(-1)?.type, 'run.cancelled')

    cancelAck = false
    const hangPromise2 = (async () => {
      for await (const _ev of adapter.run({ runId: 'r-unack', session: sess, text: 'hang' })) {
        // drain
      }
    })()
    await new Promise((r) => setTimeout(r, 20))
    await assert.rejects(() => adapter.cancel('r-unack'), /not acknowledged/)
    await hangPromise2

    // Resume & inspect
    const resumed = await adapter.resumeSession(sess.externalId)
    assert.equal(resumed.externalId, sess.externalId)
    assert.equal((await adapter.inspectSession(sess.externalId)).exists, true)
  })

  it('enforces RuntimePolicyBroker OpenClaw gating and RuntimeRegistry.getOpenClawStatus()', async () => {
    const broker = new RuntimePolicyBroker()
    // Default gated
    assert.equal(
      broker.authorize({
        runtimeMode: 'openclaw',
        codexVersion: null,
        authMethod: 'none',
        requestedPermission: 'read-only',
        canonicalWorkspace: '/tmp',
      }).allowed,
      false,
    )
    // Tool mode blocked without verified sandbox
    assert.equal(
      broker.authorizeOpenClawExecution({
        requestedPermission: 'ask-approval',
        canonicalWorkspace: '/tmp',
        openClawVersion: '2026.11.8',
        openClawExecutionAuthorized: true,
        openClawLoopbackVerified: true,
        openClawSandboxVerified: false,
      }).allowed,
      false,
    )
    // Read-only permitted when explicitly authorized + verified version + loopback
    assert.equal(
      broker.authorizeOpenClawExecution({
        requestedPermission: 'read-only',
        canonicalWorkspace: '/tmp',
        openClawVersion: '2026.11.8',
        openClawExecutionAuthorized: true,
        openClawLoopbackVerified: true,
        openClawSandboxVerified: false,
      }).allowed,
      true,
    )

    const dir = mkdtempSync(join(tmpdir(), 'ghost-p1-reg-'))
    chmodSync(dir, 0o700)
    try {
      const registry = new RuntimeRegistry({
        runtimeMode: 'mock',
        openclawAdapter: new OpenClawGatewayAdapter({
          transport: {
            async callRpc(method) {
              if (method === 'health') return { ok: true, plugins: { loaded: ['openai'] } } as never
              if (method === 'status') return { runtimeVersion: '2026.11.8', hostDesktop: { enabled: false } } as never
              if (method === 'models.list') return { models: [{ id: 'gpt-6-astra', name: 'GPT-6 Astra', thinkingLevels: [] }] } as never
              return {} as never
            },
          },
        }),
      })
      const status = await registry.getOpenClawStatus()
      assert.equal(status.available, true)
      assert.equal(status.runtimeVersion, '2026.11.8')
      assert.equal(status.supportedVersion, true)
      assert.equal(status.models.length, 1)
      assert.equal(status.policyCompatibility.fullAccessAllowed, false)
      assert.ok(status.policyCompatibility.gatedReason)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
