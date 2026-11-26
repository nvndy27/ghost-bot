import assert from 'node:assert/strict'
import test from 'node:test'
import {
  KimiAcpAdapter,
  type KimiAcpTransport,
} from '../packages/runtime-adapters/kimi/kimi-acp.ts'
import { RuntimePolicyBroker } from '../apps/daemon/src/runtime/policy-broker.ts'
import { RuntimeRegistry } from '../apps/daemon/src/runtime/registry.ts'
import { KimiStatusDtoSchema } from '../packages/shared-types/ipc.ts'
import type { AgentEvent } from '@ghost-bot/shared-types/runtime'

function createFakeAcpTransport(opts: {
  protocolVersion?: number
  authenticated?: boolean
  loadSession?: boolean
  onPrompt?: (
    t: {
      emitNotif: (m: string, p: Record<string, unknown>) => void
      emitReq: (id: number, m: string, p: Record<string, unknown>) => void
      emitClose: (reason: string) => void
    },
    params: Record<string, unknown>,
  ) => Promise<unknown>
}): KimiAcpTransport & {
  agentResponses: Array<{ id: number | string; result?: unknown; error?: { code: number; message: string } }>
  notificationsSent: Array<{ method: string; params: Record<string, unknown> }>
} {
  const notifHandlers = new Set<(m: string, p: Record<string, unknown>) => void>()
  const reqHandlers = new Set<(id: number | string, m: string, p: Record<string, unknown>) => void>()
  const closeHandlers = new Set<(r: string) => void>()
  const agentResponses: Array<{
    id: number | string
    result?: unknown
    error?: { code: number; message: string }
  }> = []
  const notificationsSent: Array<{ method: string; params: Record<string, unknown> }> = []

  const emitNotif = (m: string, p: Record<string, unknown>) => {
    for (const h of notifHandlers) h(m, p)
  }
  const emitReq = (id: number, m: string, p: Record<string, unknown>) => {
    for (const h of reqHandlers) h(id, m, p)
  }
  const emitClose = (r: string) => {
    for (const h of closeHandlers) h(r)
  }

  return {
    agentResponses,
    notificationsSent,
    async sendRequest(method, params = {}) {
      if (method === 'initialize') {
        assert.equal((params.clientCapabilities as { terminal: boolean }).terminal, false)
        return {
          protocolVersion: opts.protocolVersion ?? 1,
          authenticated: opts.authenticated ?? true,
          agentCapabilities: { loadSession: opts.loadSession ?? true },
          models: [{ id: 'kimi-k2', label: 'Kimi K2' }],
        }
      }
      if (method === 'session/new') {
        return { sessionId: 'kimi-sess-1' }
      }
      if (method === 'session/load') {
        return {}
      }
      if (method === 'session/prompt') {
        return (await opts.onPrompt?.({ emitNotif, emitReq, emitClose }, params)) ?? { stopReason: 'end_turn' }
      }
      return {}
    },
    sendNotification(method, params = {}) {
      notificationsSent.push({ method, params })
    },
    respondToAgentRequest(id, result, error) {
      agentResponses.push({ id, result, error })
    },
    onNotification(h) {
      notifHandlers.add(h)
      return () => notifHandlers.delete(h)
    },
    onAgentRequest(h) {
      reqHandlers.add(h)
      return () => reqHandlers.delete(h)
    },
    onClose(h) {
      closeHandlers.add(h)
      return () => closeHandlers.delete(h)
    },
    async close() {
      return { confirmed: true }
    },
  }
}

test('KimiAcpAdapter handles missing CLI, unsupported protocol, unauthenticated state, and gated execution', async () => {
  const missing = new KimiAcpAdapter({ kimiCommand: '/nonexistent/kimi-cli-bin' })
  const info = await missing.inspectRuntime()
  assert.equal(info.cliAvailable, false)

  const badProto = new KimiAcpAdapter({
    transportFactory: () => createFakeAcpTransport({ protocolVersion: 99 }),
  })
  const badInfo = await badProto.inspectRuntime()
  assert.equal(badInfo.acpProtocolSupported, false)

  const unauth = new KimiAcpAdapter({
    transportFactory: () => createFakeAcpTransport({ authenticated: false }),
  })
  const authState = await unauth.getAuthStatus()
  assert.equal(authState.status, 'pending')
  await assert.rejects(
    () =>
      unauth.createSession({
        agentId: 'b1',
        accountId: 'local',
        modelId: 'kimi-k2',
        permission: 'read-only',
        workspace: '/tmp',
        instructions: '',
      }),
    /kimi login/i,
  )
})

test('KimiAcpAdapter enforces ACP streaming, thought suppression, fs/terminal rejection, single-use approvals, cancellation, and quarantine', async () => {
  let authorized = false
  let fakeTransport: ReturnType<typeof createFakeAcpTransport> | null = null
  let promptMode: 'normal' | 'cancel' | 'crash' = 'normal'

  const adapter = new KimiAcpAdapter({
    isExecutionAuthorized: () => authorized,
    transportFactory: () => {
      fakeTransport = createFakeAcpTransport({
        onPrompt: async ({ emitNotif, emitReq, emitClose }) => {
          // Unsupported fs/terminal callbacks must be rejected
          emitReq(9001, 'fs/read_text_file', { path: '/etc/passwd' })
          emitReq(9002, 'terminal/create', { command: 'id' })

          // Out-of-session update ignored & thought chunk suppressed
          emitNotif('session/update', {
            sessionId: 'wrong-session',
            update: { sessionUpdate: 'agent_message_chunk', content: { text: 'LEAK' } },
          })
          emitNotif('session/update', {
            sessionId: 'kimi-sess-1',
            update: { sessionUpdate: 'agent_thought_chunk', content: { text: 'secret reasoning' } },
          })

          if (promptMode === 'crash') {
            emitClose('SIGSEGV')
            await new Promise((r) => setTimeout(r, 20))
            return { stopReason: 'end_turn' }
          }

          emitNotif('session/update', {
            sessionId: 'kimi-sess-1',
            update: { sessionUpdate: 'agent_message_chunk', content: { text: 'Hello Kimi' } },
          })

          if (promptMode === 'cancel') {
            await new Promise((r) => setTimeout(r, 40))
            return { stopReason: 'cancelled' }
          }

          // Permission request: allow_always must be ignored, allow_once correlated
          emitReq(77, 'session/request_permission', {
            sessionId: 'kimi-sess-1',
            toolCall: { toolCallId: 'tc-1', title: 'Read file' },
            options: [
              { optionId: 'always-opt', kind: 'allow_always' },
              { optionId: 'once-opt', kind: 'allow_once' },
              { optionId: 'deny-opt', kind: 'reject_once' },
            ],
          })

          await new Promise((r) => setTimeout(r, 30))
          return {
            stopReason: 'end_turn',
            usage: { inputTokens: 15, outputTokens: 6 },
          }
        },
      })
      return fakeTransport
    },
  })

  const session = await adapter.createSession({
    agentId: 'b-k',
    accountId: 'local',
    modelId: 'kimi-k2',
    permission: 'ask-approval',
    workspace: '/tmp',
    instructions: '',
  })
  assert.equal(await adapter.getUsage(), null)

  // Gated by default
  const gatedEv: AgentEvent[] = []
  for await (const e of adapter.run({ runId: 'k-gated', session, text: 'hi' })) gatedEv.push(e)
  assert.equal((gatedEv.at(-1) as Extract<AgentEvent, { type: 'run.failed' }>).code, 'KIMI_EXECUTION_GATED')

  // Authorized run: verify thought suppressed, fs/terminal rejected, allow_once selected
  authorized = true
  const evOk: AgentEvent[] = []
  for await (const e of adapter.run({ runId: 'k-ok', session, text: 'read' })) {
    evOk.push(e)
    if (e.type === 'approval.requested') {
      await adapter.resolveApproval({
        approvalId: e.approvalId,
        runId: 'k-ok',
        argsHash: e.argsHash,
        decision: 'allow-once',
      })
    }
  }
  assert.ok(!evOk.some((e) => e.type === 'message.delta' && e.text.includes('secret reasoning')))
  assert.ok(!evOk.some((e) => e.type === 'message.delta' && e.text.includes('LEAK')))
  assert.equal(evOk.at(-1)?.type, 'run.completed')

  const fsResp = fakeTransport!.agentResponses.find((r) => r.id === 9001)
  const termResp = fakeTransport!.agentResponses.find((r) => r.id === 9002)
  assert.equal(fsResp?.error?.code, -32601)
  assert.equal(termResp?.error?.code, -32601)
  const permResp = fakeTransport!.agentResponses.find((r) => r.id === 77)
  assert.deepEqual(permResp?.result, { outcome: { outcome: 'selected', optionId: 'once-opt' } })

  // Cancellation sends session/cancel and emits run.cancelled
  promptMode = 'cancel'
  const evCancel: AgentEvent[] = []
  for await (const e of adapter.run({ runId: 'k-cancel', session, text: 'wait' })) {
    evCancel.push(e)
    if (e.type === 'message.delta') {
      await adapter.cancel('k-cancel')
    }
  }
  assert.equal(evCancel.at(-1)?.type, 'run.cancelled')
  assert.ok(fakeTransport!.notificationsSent.some((n) => n.method === 'session/cancel'))

  // Unexpected close quarantines session and prevents replay
  promptMode = 'crash'
  const evCrash: AgentEvent[] = []
  for await (const e of adapter.run({ runId: 'k-crash', session, text: 'boom' })) evCrash.push(e)
  assert.equal((evCrash.at(-1) as Extract<AgentEvent, { type: 'run.failed' }>).code, 'KIMI_UNKNOWN_TERMINATION')
  const inspected = await adapter.inspectSession(session.externalId)
  assert.equal(inspected.quarantined, true)
  await assert.rejects(() => adapter.resumeSession(session.externalId), /quarantined/i)

  // PolicyBroker & IPC DTO validation
  const broker = new RuntimePolicyBroker()
  assert.equal(
    broker.authorizeKimiAcpExecution({
      requestedPermission: 'read-only',
      canonicalWorkspace: '/tmp',
      kimiExecutionAuthorized: true,
      kimiCliAvailable: true,
      kimiAcpProtocolVerified: true,
      kimiAuthenticated: true,
      kimiContainmentVerified: false,
    }).allowed,
    false,
  )
  const registry = new RuntimeRegistry({ runtimeMode: 'mock', kimiAdapter: adapter })
  const dto = KimiStatusDtoSchema.parse(await registry.getKimiStatus())
  assert.equal(dto.capabilities.clientFsSupported, false)
  assert.equal(dto.capabilities.clientTerminalSupported, false)
  assert.equal(dto.policyCompatibility.readOnlyAllowed, false)
  await registry.stop()
  await adapter.disconnect()
})
