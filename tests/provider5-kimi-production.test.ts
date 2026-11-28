import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  KimiAcpAdapter,
  KimiAcpRpcError,
  type KimiAcpTransport,
} from '../packages/runtime-adapters/kimi/kimi-acp.ts'
import { RuntimePolicyBroker } from '../apps/daemon/src/runtime/policy-broker.ts'
import { RuntimeRegistry } from '../apps/daemon/src/runtime/registry.ts'
import { KimiStatusDtoSchema } from '../packages/shared-types/ipc.ts'
import type { AgentEvent } from '@ghost-bot/shared-types/runtime'

function createFakeAcpTransport(opts: {
  protocolVersion?: number
  authenticated?: unknown
  authMethods?: unknown
  loadSession?: boolean
  sessionNewError?: Error
  promptError?: Error
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
  closeConnection: (reason?: string) => void
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
    closeConnection: (reason = 'fixture closed') => emitClose(reason),
    async sendRequest(method, params = {}) {
      if (method === 'initialize') {
        assert.equal((params.clientCapabilities as { terminal: boolean }).terminal, false)
        const result: Record<string, unknown> = {
          protocolVersion: opts.protocolVersion ?? 1,
          agentCapabilities: { loadSession: opts.loadSession ?? true },
          models: [{ id: 'kimi-k2', label: 'Kimi K2' }],
        }
        if (Object.hasOwn(opts, 'authenticated')) result.authenticated = opts.authenticated
        if (opts.authMethods !== undefined) result.authMethods = opts.authMethods
        return result
      }
      if (method === 'session/new') {
        if (opts.sessionNewError) throw opts.sessionNewError
        return { sessionId: 'kimi-sess-1' }
      }
      if (method === 'session/load') {
        return {}
      }
      if (method === 'session/prompt') {
        if (opts.promptError) throw opts.promptError
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
    transportFactory: () => createFakeAcpTransport({
      authenticated: false,
      sessionNewError: new KimiAcpRpcError(-32000, 'auth_required'),
    }),
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
  const rejectedStatus = await unauth.getAuthStatus()
  assert.equal(rejectedStatus.status, 'pending')
  assert.match(rejectedStatus.detail ?? '', /requires authentication/i)
})

test('Kimi authentication remains unverified for standard or malformed ACP initialization fields', async () => {
  const cases: Array<{ label: string; options: Parameters<typeof createFakeAcpTransport>[0] }> = [
    { label: 'standard ACP authMethods only', options: { authMethods: [{ id: 'kimi-login' }] } },
    { label: 'omitted field', options: {} },
    { label: 'null field', options: { authenticated: null } },
    { label: 'malformed field', options: { authenticated: 'true' } },
    { label: 'explicit unauthenticated', options: { authenticated: false } },
    { label: 'undocumented positive field', options: { authenticated: true } },
  ]

  for (const item of cases) {
    const adapter = new KimiAcpAdapter({
      transportFactory: () => createFakeAcpTransport(item.options),
    })
    const status = await adapter.getAuthStatus()
    assert.equal(status.status, 'pending', item.label)
    assert.match(status.detail ?? '', /unverified/i, item.label)
    assert.equal((await adapter.inspectRuntime()).authenticated, false, item.label)
    if (item.label === 'explicit unauthenticated') {
      await adapter.createSession({
        agentId: 'b-auth', accountId: 'local', modelId: 'kimi-k2', permission: 'read-only',
        workspace: '/tmp', instructions: '',
      })
      assert.equal((await adapter.getAuthStatus()).status, 'connected')
    }
    await adapter.disconnect()
  }
  const standardAcp = new KimiAcpAdapter({
    transportFactory: () => createFakeAcpTransport({ authMethods: [{ id: 'kimi-login' }] }),
  })
  const registry = new RuntimeRegistry({ runtimeMode: 'mock', kimiAdapter: standardAcp })
  const statusDto = KimiStatusDtoSchema.parse(await registry.getKimiStatus())
  assert.equal(statusDto.authenticated, false)
  assert.equal(statusDto.authStatus, 'pending')
  assert.match(statusDto.detail, /unverified/i)
  await registry.stop()
  await standardAcp.disconnect()
})

test('successful protected session creation confirms auth; auth_required prompt clears it', async () => {
  const adapter = new KimiAcpAdapter({
    isExecutionAuthorized: () => true,
    transportFactory: () => createFakeAcpTransport({
      promptError: new KimiAcpRpcError(-32000, 'auth_required'),
    }),
  })

  assert.equal((await adapter.getAuthStatus()).status, 'pending')
  const session = await adapter.createSession({
    agentId: 'b-auth',
    accountId: 'local',
    modelId: 'kimi-k2',
    permission: 'read-only',
    workspace: '/tmp',
    instructions: '',
  })
  assert.equal((await adapter.getAuthStatus()).status, 'connected')

  const events: AgentEvent[] = []
  for await (const event of adapter.run({ runId: 'auth-required-prompt', session, text: 'synthetic fixture request' })) {
    events.push(event)
  }
  assert.equal((events.at(-1) as Extract<AgentEvent, { type: 'run.failed' }>).code, 'KIMI_AUTH_REQUIRED')
  const statusAfterRejection = await adapter.getAuthStatus()
  assert.equal(statusAfterRejection.status, 'pending')
  assert.match(statusAfterRejection.detail ?? '', /requires authentication/i)
  await adapter.disconnect()
})

test('Kimi connection loss clears confirmed auth and unrelated RPC failures do not imply auth denial', async () => {
  let fake: ReturnType<typeof createFakeAcpTransport> | null = null
  let connections = 0
  const adapter = new KimiAcpAdapter({
    transportFactory: () => {
      connections += 1
      fake = createFakeAcpTransport(connections === 1 ? { authenticated: true } : {})
      return fake
    },
  })

  assert.equal((await adapter.getAuthStatus()).status, 'pending')
  await adapter.createSession({
    agentId: 'b-auth', accountId: 'local', modelId: 'kimi-k2', permission: 'read-only',
    workspace: '/tmp', instructions: '',
  })
  assert.equal((await adapter.getAuthStatus()).status, 'connected')
  fake!.closeConnection('fixture process exited')
  const afterReconnect = await adapter.getAuthStatus()
  assert.equal(afterReconnect.status, 'pending')
  assert.match(afterReconnect.detail ?? '', /unverified/i)
  await adapter.disconnect()

  const unrelatedFailure = new KimiAcpAdapter({
    transportFactory: () => createFakeAcpTransport({
      sessionNewError: new KimiAcpRpcError(-32000, 'workspace unavailable'),
    }),
  })
  await assert.rejects(() => unrelatedFailure.createSession({
    agentId: 'b-auth', accountId: 'local', modelId: 'kimi-k2', permission: 'read-only',
    workspace: '/tmp', instructions: '',
  }), /workspace unavailable/)
  assert.match((await unrelatedFailure.getAuthStatus()).detail ?? '', /unverified/i)
  await unrelatedFailure.disconnect()
})

test('stdio ACP transport preserves the Kimi auth_required RPC code through session creation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ghost-kimi-auth-fixture-'))
  const executable = join(directory, 'kimi')
  const source = `#!/usr/bin/env node
const readline = require('node:readline');
if (process.argv[2] === '--version') { console.log('Kimi Code 1.2.3'); process.exit(0); }
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, authMethods: [{ id: 'kimi-login' }] } }) + '\\n');
  } else if (request.method === 'session/new') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'auth_required' } }) + '\\n');
  }
});
`
  await writeFile(executable, source, { mode: 0o700 })
  await chmod(executable, 0o700)
  const adapter = new KimiAcpAdapter({ kimiCommand: executable })

  try {
    await assert.rejects(() => adapter.createSession({
      agentId: 'b-auth', accountId: 'local', modelId: 'kimi-k2', permission: 'read-only',
      workspace: '/tmp', instructions: '',
    }), /kimi login/i)
    const status = await adapter.getAuthStatus()
    assert.equal(status.status, 'pending')
    assert.match(status.detail ?? '', /requires authentication/i)
  } finally {
    await adapter.disconnect()
    await rm(directory, { recursive: true, force: true })
  }
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
