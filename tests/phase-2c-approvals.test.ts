import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type {
  AgentEvent,
  AgentRequest,
  ApprovalDecision,
  ModelInfo,
  Session,
  SessionConfig,
} from '@ghost-bot/shared-types/runtime'
import {
  buildCodexSandboxPolicy,
  mapPermissionToCodex,
} from '../packages/runtime-adapters/codex/codex-app-server.ts'
import { openGhostBotDatabase } from '../apps/daemon/src/db/client.ts'
import { seedInitialBotsIfNeeded } from '../apps/daemon/src/db/seed.ts'
import { RunOrchestrator } from '../apps/daemon/src/execution/orchestrator.ts'
import { isTerminalStatus } from '../apps/daemon/src/execution/state-machine.ts'
import { RuntimeRegistry } from '../apps/daemon/src/runtime/registry.ts'
import type { CodexMetadataClient } from '../apps/daemon/src/runtime/registry.ts'
import { SessionRepository } from '../apps/daemon/src/sessions/repository.ts'

function createInteractiveCodexClient(options?: {
  failDelivery?: boolean
  expiresInMs?: number
}) {
  const resolved: ApprovalDecision[] = []
  let waiter: ((d: ApprovalDecision) => void) | null = null

  const client: CodexMetadataClient = {
    async getAccountSummary() {
      return {
        accountPresent: true,
        accountType: 'chatgpt',
        email: 'user@example.invalid',
        planType: 'plus',
        workspaceName: 'TestWS',
        requiresOpenaiAuth: true,
      }
    },
    async listModels(): Promise<ModelInfo[]> {
      return [
        {
          id: 'gpt-5-codex',
          label: 'GPT-5 Codex',
          efforts: ['low', 'medium', 'high'],
          permissionModes: ['read-only', 'ask-approval', 'workspace'],
          supportsTools: true,
          supportsAttachments: false,
        },
      ]
    },
    async getUsage() {
      return null
    },
    async close() {},
    async createSession(_config: SessionConfig): Promise<Session> {
      return { id: 'thr-2c', externalId: 'thr-2c', runtimeId: 'codex' }
    },
    async resumeSession(threadId: string): Promise<Session> {
      return { id: threadId, externalId: threadId, runtimeId: 'codex' }
    },
    async *run(request: AgentRequest): AsyncIterable<AgentEvent> {
      const expiresAt = new Date(Date.now() + (options?.expiresInMs ?? 60_000)).toISOString()
      yield {
        type: 'approval.requested',
        runId: request.runId,
        seq: 1,
        timestamp: new Date().toISOString(),
        approvalId: `app_${request.runId}`,
        tool: 'item/fileChange/requestApproval',
        argsHash: 'sha256-test-args',
        summary: 'Modify file: notes.md',
        expiresAt,
      }
      const decision = await new Promise<ApprovalDecision>((resolve) => {
        waiter = resolve
      })
      if (decision.decision === 'allow-once') {
        yield {
          type: 'message.delta',
          runId: request.runId,
          seq: 2,
          timestamp: new Date().toISOString(),
          text: 'Applied approved edit.',
        }
        yield {
          type: 'run.completed',
          runId: request.runId,
          seq: 3,
          timestamp: new Date().toISOString(),
        }
      } else {
        yield {
          type: 'message.delta',
          runId: request.runId,
          seq: 2,
          timestamp: new Date().toISOString(),
          text: 'Edit denied by user.',
        }
        yield {
          type: 'run.completed',
          runId: request.runId,
          seq: 3,
          timestamp: new Date().toISOString(),
        }
      }
    },
    async cancel() {
      if (waiter) {
        const w = waiter
        waiter = null
        w({ approvalId: 'cancelled', runId: 'cancelled', argsHash: 'x', decision: 'deny' })
      }
    },
    async resolveApproval(decision: ApprovalDecision) {
      if (options?.failDelivery) {
        throw new Error('RPC connection lost during approval delivery')
      }
      resolved.push(decision)
      if (waiter) {
        const w = waiter
        waiter = null
        w(decision)
      }
    },
  }

  return { client, resolved }
}

async function waitTerminal(orchestrator: RunOrchestrator, runId: string) {
  for (let i = 0; i < 60; i += 1) {
    const run = orchestrator.getRun(runId)
    if (isTerminalStatus(run.status)) return run
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`Timed out waiting for ${runId}`)
}

test('Phase 2C permission mapping enforces sandbox boundaries and disables network in workspace mode', () => {
  assert.deepEqual(mapPermissionToCodex('read-only'), {
    sandbox: 'read-only',
    approvalPolicy: 'on-request',
  })
  assert.deepEqual(mapPermissionToCodex('ask-approval'), {
    sandbox: 'workspace-write',
    approvalPolicy: 'untrusted',
  })
  assert.deepEqual(mapPermissionToCodex('workspace'), {
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
  })
  const wsPolicy = buildCodexSandboxPolicy('workspace', '/tmp/example-ws')
  assert.equal(wsPolicy.type, 'workspaceWrite')
  assert.equal(wsPolicy.networkAccess, false)
  assert.equal(wsPolicy.excludeSlashTmp, true)
  assert.equal(wsPolicy.excludeTmpdirEnvVar, true)
})

test('Phase 2C durable approval lifecycle: approve once, duplicate rejection, argsHash mismatch, expiration, delivery failure, and startup revocation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-2c-app-'))
  try {
    const dbHandle = await openGhostBotDatabase(dir)
    seedInitialBotsIfNeeded(dbHandle)
    dbHandle.sqlite
      .prepare(
        `UPDATE agents SET runtime_id = 'codex', model_id = 'gpt-5-codex', effort = 'medium', permission_mode = 'ask-approval', workspace_path = ? WHERE id = 'chief'`,
      )
      .run(dir)

    const sessionRepo = new SessionRepository(dbHandle)
    const sess = sessionRepo.createSession({ agentId: 'chief', title: 'Interactive Approval' })

    // 1. Happy path: approve once + duplicate rejection
    const fake1 = createInteractiveCodexClient()
    const reg1 = new RuntimeRegistry({
      runtimeMode: 'codex',
      codexVersionOverride: '0.172.0',
      codexClientFactory: () => fake1.client,
    })
    const orch1 = new RunOrchestrator(dbHandle, { runtimeRegistry: reg1 })
    const start1 = await orch1.startRun({
      sessionId: sess.id,
      idempotencyKey: 'k-2c-approve',
      text: 'Edit notes.md',
    })
    let awaiting = orch1.getRun(start1.run.id)
    for (let i = 0; i < 40 && awaiting.status !== 'awaiting_approval'; i += 1) {
      await new Promise((r) => setTimeout(r, 20))
      awaiting = orch1.getRun(start1.run.id)
    }
    assert.equal(awaiting.status, 'awaiting_approval')
    const appId1 = awaiting.pendingApproval!.approvalId

    // Modified argsHash must be rejected
    await assert.rejects(
      () => orch1.resolveApproval(start1.run.id, appId1, 'approved', 'tampered-hash'),
      /hash mismatch/i,
    )

    // Valid approve-once succeeds
    await orch1.resolveApproval(start1.run.id, appId1, 'approved', 'sha256-test-args')
    assert.equal(fake1.resolved[0]?.decision, 'allow-once')

    // Duplicate resolution must fail
    await assert.rejects(
      () => orch1.resolveApproval(start1.run.id, appId1, 'approved', 'sha256-test-args'),
      /already in state/i,
    )

    const done1 = await waitTerminal(orch1, start1.run.id)
    assert.equal(done1.status, 'completed')
    const appRow1 = dbHandle.sqlite
      .prepare('SELECT status, args_hash FROM approvals WHERE id = ?')
      .get(appId1) as { status: string; args_hash: string }
    assert.equal(appRow1.status, 'approved')
    assert.equal(appRow1.args_hash, 'sha256-test-args')
    await orch1.stop()
    await reg1.stop()

    // 2. Delivery failure marks approval as resolution_failed
    const fakeFail = createInteractiveCodexClient({ failDelivery: true })
    const regFail = new RuntimeRegistry({
      runtimeMode: 'codex',
      codexVersionOverride: '0.172.0',
      codexClientFactory: () => fakeFail.client,
    })
    const orchFail = new RunOrchestrator(dbHandle, { runtimeRegistry: regFail })
    const start2 = await orchFail.startRun({
      sessionId: sess.id,
      idempotencyKey: 'k-2c-fail-delivery',
      text: 'Trigger delivery fail',
    })
    let aw2 = orchFail.getRun(start2.run.id)
    for (let i = 0; i < 40 && aw2.status !== 'awaiting_approval'; i += 1) {
      await new Promise((r) => setTimeout(r, 20))
      aw2 = orchFail.getRun(start2.run.id)
    }
    const appId2 = aw2.pendingApproval!.approvalId
    await assert.rejects(
      () => orchFail.resolveApproval(start2.run.id, appId2, 'approved', 'sha256-test-args'),
      /RPC connection lost/,
    )
    const appRow2 = dbHandle.sqlite
      .prepare('SELECT status FROM approvals WHERE id = ?')
      .get(appId2) as { status: string }
    assert.equal(appRow2.status, 'resolution_failed')
    orchFail.cancelRun(start2.run.id)
    await waitTerminal(orchFail, start2.run.id)
    await orchFail.stop()
    await regFail.stop()

    // 3. Expired approval is rejected and marked expired
    const fakeExp = createInteractiveCodexClient({ expiresInMs: -1000 })
    const regExp = new RuntimeRegistry({
      runtimeMode: 'codex',
      codexVersionOverride: '0.172.0',
      codexClientFactory: () => fakeExp.client,
    })
    const orchExp = new RunOrchestrator(dbHandle, { runtimeRegistry: regExp })
    const start3 = await orchExp.startRun({
      sessionId: sess.id,
      idempotencyKey: 'k-2c-expired',
      text: 'Trigger expired approval',
    })
    let aw3 = orchExp.getRun(start3.run.id)
    for (let i = 0; i < 40 && aw3.status !== 'awaiting_approval'; i += 1) {
      await new Promise((r) => setTimeout(r, 20))
      aw3 = orchExp.getRun(start3.run.id)
    }
    const appId3 = aw3.pendingApproval!.approvalId
    await assert.rejects(
      () => orchExp.resolveApproval(start3.run.id, appId3, 'approved', 'sha256-test-args'),
      /expired/i,
    )
    const appRow3 = dbHandle.sqlite
      .prepare('SELECT status FROM approvals WHERE id = ?')
      .get(appId3) as { status: string }
    assert.equal(appRow3.status, 'expired')

    // 4. Startup reconciliation revokes any lingering pending/resolving approvals
    dbHandle.sqlite
      .prepare(
        `INSERT INTO approvals (id, run_id, session_id, agent_id, runtime_generation, account_id, thread_id, turn_id, provider_request_id, action_type, action_summary, args_json, args_hash, permission_mode, status, decision_meta_json, created_at, expires_at, resolved_at)
         VALUES ('app-lingering', ?, ?, 'chief', 0, 'chatgpt', 'thr', NULL, 'req', 'cmd', 'sum', '{}', 'h', 'ask-approval', 'pending', NULL, '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z', NULL)`,
      )
      .run(start3.run.id, sess.id)
    orchExp.reconcileOnStartup()
    const revRow = dbHandle.sqlite
      .prepare('SELECT status FROM approvals WHERE id = ?')
      .get('app-lingering') as { status: string }
    assert.equal(revRow.status, 'revoked')

    await orchExp.stop()
    await regExp.stop()
    dbHandle.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Phase 2C declines privilege/network escalation requests and binds turnId in CodexAppServerAdapter', async () => {
  const { CodexAppServerAdapter } = await import(
    '../packages/runtime-adapters/codex/codex-app-server.ts'
  )
  const { resolveCodexVerifiedEvidence } = await import(
    '../apps/daemon/src/runtime/policy-broker.ts'
  )
  const escalationScript = `
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin });
    let decided = null;
    rl.on('line', (line) => {
      const msg = JSON.parse(line);
      if (msg.method === 'initialize') {
        process.stdout.write(JSON.stringify({ id: msg.id, result: { userAgent: 'codex-mock/0.172.0' } }) + '\\n');
      } else if (msg.method === 'account/read') {
        process.stdout.write(JSON.stringify({ id: msg.id, result: { account: { type: 'chatgpt', email: 'u@example.invalid', planType: 'plus' }, requiresOpenaiAuth: true } }) + '\\n');
      } else if (msg.method === 'thread/start') {
        process.stdout.write(JSON.stringify({ id: msg.id, result: { thread: { id: 'thr-esc' } } }) + '\\n');
      } else if (msg.method === 'turn/start') {
        process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: 'turn-esc-1' } } }) + '\\n');
        // Send an escalated approval request (withEscalatedPermissions: true)
        process.stdout.write(JSON.stringify({ id: 'srv-esc', method: 'item/commandExecution/requestApproval', params: { itemId: 'i1', threadId: 'thr-esc', turnId: 'turn-esc-1', command: 'curl https://evil.invalid', withEscalatedPermissions: true } }) + '\\n');
      } else if (msg.id === 'srv-esc') {
        decided = msg.result.decision;
        process.stdout.write(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'thr-esc', turnId: 'turn-esc-1', itemId: 'i2', delta: 'decision:' + decided } }) + '\\n');
        process.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thr-esc', turn: { id: 'turn-esc-1', status: 'completed' } } }) + '\\n');
      }
    });
  `
  const profileDir = await mkdtemp(join(tmpdir(), 'gb-2c-esc-'))
  const adapter = new CodexAppServerAdapter({
    profileDir,
    command: process.execPath,
    args: ['-e', escalationScript],
    permissionEvidence: resolveCodexVerifiedEvidence('0.172.0'),
  })
  try {
    const session = await adapter.createSession({
      agentId: 'a1',
      accountId: 'acc1',
      modelId: 'gpt-5-codex',
      permission: 'ask-approval',
      workspace: profileDir,
      instructions: '',
    })
    const events: AgentEvent[] = []
    for await (const ev of adapter.run({ runId: 'run-esc', session, text: 'hi' })) {
      events.push(ev)
    }
    assert.equal(events.some((e) => e.type === 'approval.requested'), false)
    assert.equal(events.some((e) => e.type === 'message.delta' && e.text === 'decision:decline'), true)
  } finally {
    await adapter.close()
    await rm(profileDir, { recursive: true, force: true })
  }
})
