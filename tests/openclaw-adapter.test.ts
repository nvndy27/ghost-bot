import assert from 'node:assert/strict'
import test from 'node:test'
import {
  OpenClawGatewayAdapter,
  assertLoopbackGatewayUrl,
  type OpenClawGatewayTransport,
  type OpenClawStreamChunk,
} from '../packages/runtime-adapters/openclaw/openclaw-gateway.ts'
import type { AgentEvent } from '@ghost-bot/shared-types/runtime'
import { RuntimePolicyBroker } from '../apps/daemon/src/runtime/policy-broker.ts'

test('OpenClawGatewayAdapter rejects non-loopback URLs and gates unverified execution', async () => {
  assert.throws(() => assertLoopbackGatewayUrl('ws://192.168.1.10:18789'), /loopback only/i)
  assert.throws(() => assertLoopbackGatewayUrl('http://127.0.0.1:18789'), /ws:\/\/ or wss:\/\//i)
  assert.equal(assertLoopbackGatewayUrl('ws://127.0.0.1:18789/'), 'ws://127.0.0.1:18789')

  const broker = new RuntimePolicyBroker()
  const decision = broker.authorize({
    runtimeMode: 'openclaw',
    codexVersion: null,
    authMethod: 'none',
    requestedPermission: 'read-only',
    canonicalWorkspace: '/tmp',
  })
  assert.equal(decision.allowed, false)
  assert.match(decision.reason, /OpenClaw live execution is gated/i)

  const metadataOnly = new OpenClawGatewayAdapter({
    transport: {
      async callRpc<T>(method: string): Promise<T> {
        if (method === 'health') return { ok: true } as T
        if (method === 'status') return { runtimeVersion: '2026.11.8' } as T
        if (method === 'models.list') {
          return {
            models: [
              {
                id: 'gpt-6-astra',
                name: 'GPT-6 Astra',
                thinkingLevels: [{ id: 'low' }, { id: 'medium' }, { id: 'low' }],
              },
            ],
          } as T
        }
        throw new Error(`Unexpected RPC ${method}`)
      },
    },
  })

  const info = await metadataOnly.inspectGateway()
  assert.equal(info.available, true)
  assert.equal(info.runtimeVersion, '2026.11.8')
  assert.deepEqual(info.verifiedModes, [])

  const models = await metadataOnly.listModels()
  assert.equal(models.length, 1)
  assert.deepEqual(models[0]?.efforts, ['low', 'medium'])
  assert.deepEqual(models[0]?.permissionModes, [])
  assert.equal(await metadataOnly.getUsage(), null)

  await assert.rejects(
    () =>
      metadataOnly.createSession({
        agentId: 'chief',
        accountId: 'openclaw-local',
        modelId: 'gpt-6-astra',
        permission: 'read-only',
        workspace: '/tmp',
        instructions: '',
      }),
    /live execution is gated/i,
  )
})

test('OpenClawGatewayAdapter normalizes streaming, tool/approval events, and cancellation via protocol fixture', async () => {
  const resolvedApprovals: string[] = []
  const transport: OpenClawGatewayTransport = {
    async callRpc<T>(method: string): Promise<T> {
      if (method === 'health') return { ok: true } as T
      if (method === 'status') return { runtimeVersion: '2026.11.8' } as T
      return { models: [] } as T
    },
    async *streamChat(_params, signal): AsyncIterable<OpenClawStreamChunk> {
      yield { type: 'delta', text: 'Hello ' }
      yield { type: 'tool.started', tool: 'read_file', callId: 'c1', summary: 'Read README.md' }
      yield {
        type: 'approval.requested',
        approvalId: 'appr-oc-1',
        tool: 'write_file',
        argsHash: 'hash-1',
        summary: 'Write note',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }
      if (signal.aborted) return
      yield { type: 'completed' }
    },
    async resolveApproval(decision) {
      resolvedApprovals.push(`${decision.approvalId}:${decision.decision}`)
    },
  }

  const adapter = new OpenClawGatewayAdapter({ transport })
  const session = await adapter.createSession({
    agentId: 'chief',
    accountId: 'openclaw-local',
    modelId: 'gpt-6-astra',
    permission: 'read-only',
    workspace: '/tmp',
    instructions: '',
  })

  const events: AgentEvent[] = []
  for await (const evt of adapter.run({
    runId: 'run-oc-1',
    session,
    text: 'Test stream',
  })) {
    events.push(evt)
  }

  assert.deepEqual(
    events.map((e) => e.type),
    ['message.delta', 'tool.started', 'approval.requested', 'run.completed'],
  )
  await adapter.resolveApproval({
    approvalId: 'appr-oc-1',
    runId: 'run-oc-1',
    argsHash: 'hash-1',
    decision: 'deny',
  })
  assert.deepEqual(resolvedApprovals, ['appr-oc-1:deny'])
  await adapter.disconnect()
})
