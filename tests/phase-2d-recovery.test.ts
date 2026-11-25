import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type {
  AgentEvent,
  AgentRequest,
  ModelInfo,
  Session,
  SessionConfig,
} from '@ghost-bot/shared-types/runtime'
import { openGhostBotDatabase } from '../apps/daemon/src/db/client.ts'
import { seedInitialBotsIfNeeded } from '../apps/daemon/src/db/seed.ts'
import { RunOrchestrator } from '../apps/daemon/src/execution/orchestrator.ts'
import { isTerminalStatus } from '../apps/daemon/src/execution/state-machine.ts'
import { RuntimeRegistry } from '../apps/daemon/src/runtime/registry.ts'
import type { CodexMetadataClient } from '../apps/daemon/src/runtime/registry.ts'
import { SessionRepository } from '../apps/daemon/src/sessions/repository.ts'

test('Phase 2D RuntimeRegistry lifecycle: reconnect deduplication, generation bump, and closeOwnedClient', async () => {
  let closeCalls = 0
  let authCount = 0
  const client: CodexMetadataClient = {
    async getAccountSummary() {
      authCount += 1
      return {
        accountPresent: true,
        accountType: 'chatgpt',
        email: 'u@example.invalid',
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
          efforts: ['medium'],
          permissionModes: ['read-only'],
          supportsTools: true,
          supportsAttachments: false,
        },
      ]
    },
    async getUsage() {
      return null
    },
    async close() {
      closeCalls += 1
    },
  }

  const registry = new RuntimeRegistry({
    runtimeMode: 'codex',
    codexVersionOverride: '0.172.0',
    codexClientFactory: () => client,
  })

  const s1 = await registry.getSnapshot(false)
  assert.equal(s1.lifecycleState, 'connected')
  const genBefore = registry.getGeneration()

  // Concurrent reconnect calls deduplicate cleanly
  const [r1, r2] = await Promise.all([registry.reconnect(), registry.reconnect()])
  assert.equal(r1.lifecycleState, 'connected')
  assert.equal(r2.lifecycleState, 'connected')
  assert.equal(closeCalls, 1)
  assert.ok(registry.getGeneration() > genBefore)
  assert.ok(authCount >= 2)

  await registry.stop()
  assert.equal(registry.getLifecycleState(), 'disconnected')
})

test('Phase 2D recovery: inspectSession, manual retry, and quarantine persistence across generation changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-2d-rec-'))
  try {
    const dbHandle = await openGhostBotDatabase(dir)
    seedInitialBotsIfNeeded(dbHandle)
    const sessionRepo = new SessionRepository(dbHandle)
    const fakeClient: CodexMetadataClient = {
      async getAccountSummary() {
        return {
          accountPresent: true,
          accountType: 'chatgpt',
          email: 'u@example.invalid',
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
            efforts: ['medium'],
            permissionModes: ['read-only'],
            supportsTools: true,
            supportsAttachments: false,
          },
        ]
      },
      async getUsage() {
        return null
      },
      async close() {},
      async createSession(_c: SessionConfig): Promise<Session> {
        return { id: 'thr-2d', externalId: 'thr-2d', runtimeId: 'codex' }
      },
      async resumeSession(t: string): Promise<Session> {
        return { id: t, externalId: t, runtimeId: 'codex' }
      },
      async *run(req: AgentRequest): AsyncIterable<AgentEvent> {
        yield {
          type: 'message.delta',
          runId: req.runId,
          seq: 1,
          timestamp: new Date().toISOString(),
          text: 'Recovered reply',
        }
        yield {
          type: 'run.completed',
          runId: req.runId,
          seq: 2,
          timestamp: new Date().toISOString(),
        }
      },
      async cancel() {},
    }

    const registry = new RuntimeRegistry({
      runtimeMode: 'codex',
      codexVersionOverride: '0.172.0',
      codexClientFactory: () => fakeClient,
    })
    const orchestrator = new RunOrchestrator(dbHandle, { runtimeRegistry: registry })

    const sess = sessionRepo.createSession({ agentId: 'chief', title: 'Recovery Test' })
    // Fail a mock run, then inspect and manually retry with a new idempotency key
    const failStart = await orchestrator.startRun({
      sessionId: sess.id,
      idempotencyKey: 'k-2d-fail',
      text: 'Trigger fail test',
    })
    for (let i = 0; i < 40 && !isTerminalStatus(orchestrator.getRun(failStart.run.id).status); i += 1) {
      await new Promise((r) => setTimeout(r, 20))
    }
    const insp1 = await orchestrator.inspectSession(sess.id)
    assert.equal(insp1.resumable, true)
    assert.equal(insp1.lastRun?.status, 'failed')

    // Manual retry creates a new run without auto-replaying (explicitly confirming tool activity)
    const retried = await orchestrator.retryRun({
      runId: failStart.run.id,
      idempotencyKey: 'k-2d-retry-1',
      confirmSideEffects: true,
    })
    assert.notEqual(retried.run.id, failStart.run.id)

    // Quarantine test: generation bump alone on registry does NOT clear quarantine;
    // only reconnectRuntime() (which closes owned client) clears it.
    ;(
      orchestrator as unknown as { sessionsWithUnconfirmedStop: Map<string, number> }
    ).sessionsWithUnconfirmedStop.set(sess.id, registry.getGeneration())
    await registry.closeOwnedClient()
    const inspQ = await orchestrator.inspectSession(sess.id)
    assert.equal(inspQ.quarantined, true)
    assert.equal(inspQ.resumable, false)

    await assert.rejects(
      () =>
        orchestrator.startRun({
          sessionId: sess.id,
          idempotencyKey: 'k-2d-blocked-q',
          text: 'blocked',
        }),
      /not been confirmed stopped/,
    )

    await orchestrator.reconnectRuntime()
    const inspAfterReconnect = await orchestrator.inspectSession(sess.id)
    assert.equal(inspAfterReconnect.quarantined, false)
    assert.equal(inspAfterReconnect.resumable, true)

    // Durable quarantine survives orchestrator/daemon restart
    ;(orchestrator as unknown as { addQuarantine: (sid: string) => void }).addQuarantine(sess.id)
    await orchestrator.stop()
    const orchestratorReloaded = new RunOrchestrator(dbHandle, { runtimeRegistry: registry })
    assert.equal((await orchestratorReloaded.inspectSession(sess.id)).quarantined, true)
    dbHandle.sqlite
      .prepare("UPDATE sessions SET runtime_id = 'codex', external_session_id = ? WHERE id = ?")
      .run('thread-not-verified', sess.id)
    assert.equal(registry.getLifecycleState(), 'connected')
    assert.equal((await orchestratorReloaded.inspectSession(sess.id)).providerThreadStatus, 'unknown')
    await orchestratorReloaded.stop()

    await registry.stop()
    dbHandle.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Phase 2D security: termination failure keeps quarantine, tool retry requires confirmation, and inspectSession checks account & thread', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ghost-bot-2d-sec-'))
  try {
    const dbHandle = await openGhostBotDatabase(dir)
    seedInitialBotsIfNeeded(dbHandle)
    const sessionRepo = new SessionRepository(dbHandle)
    let readThreadResult: { accessible: boolean; reason?: string } = { accessible: true }
    let closeShouldFail = true

    const fakeCodexClient = {
      id: 'codex',
      checkAvailability: async () => ({ available: true, detail: 'ok' }),
      getAccountSummary: async () => ({
        accountPresent: true,
        accountType: 'chatgpt' as const,
        email: 'owner@example.com',
        planType: 'plus',
        workspaceName: 'ws-1',
        requiresOpenaiAuth: false,
      }),
      listModels: async () => [],
      getUsageSummary: async () => ({ available: true, windows: [], detail: 'ok' }),
      createSession: async () => ({ id: 't1', externalId: 't1', runtimeId: 'codex' }),
      resumeSession: async (threadId: string) => ({
        id: threadId,
        externalId: threadId,
        runtimeId: 'codex',
      }),
      readThread: async () => readThreadResult,
      run: async function* () {},
      cancel: async () => undefined,
      close: async () => {
        if (closeShouldFail) {
          throw new Error('simulated SIGKILL failure')
        }
      },
    }

    const registry = new RuntimeRegistry({
      runtimeMode: 'codex',
      codexVersionOverride: '0.172.0',
      codexClientFactory: () => fakeCodexClient,
    })
    await registry.getSnapshot(true)

    const orchestrator = new RunOrchestrator(dbHandle, { runtimeRegistry: registry })
    const sess = sessionRepo.createSession({ agentId: 'chief', title: 'Security Test' })

    // 1. Failed runtime termination MUST NOT clear quarantine
    ;(orchestrator as unknown as { addQuarantine: (sid: string) => void }).addQuarantine(sess.id)
    await assert.rejects(() => orchestrator.reconnectRuntime(), /Failed to terminate owned runtime process/)
    assert.equal((await orchestrator.inspectSession(sess.id)).quarantined, true)

    // Once termination succeeds, quarantine clears
    closeShouldFail = false
    await orchestrator.reconnectRuntime()
    await registry.getSnapshot(true)
    assert.equal((await orchestrator.inspectSession(sess.id)).quarantined, false)

    // 2. Retry on an interrupted run with tool/approval activity requires explicit confirmSideEffects: true
    const runId = 'run-tool-interrupted'
    const now = new Date().toISOString()
    dbHandle.sqlite
      .prepare(
        `INSERT INTO runs (id, session_id, agent_id, idempotency_key, runtime_id, model_id, effort, permission_mode, config_snapshot_json, status, started_at, created_at)
         VALUES (?, ?, 'chief', 'k-tool-1', 'mock', 'mock-model', 'medium', 'read-only', '{}', 'interrupted', ?, ?)`,
      )
      .run(runId, sess.id, now, now)
    dbHandle.sqlite
      .prepare(
        `INSERT INTO messages (id, session_id, run_id, role, content_json, status, seq_order, created_at, updated_at)
         VALUES ('msg-u-1', ?, ?, 'user', '{"text":"Do risky tool"}', 'complete', 1, ?, ?)`,
      )
      .run(sess.id, runId, now, now)
    dbHandle.sqlite
      .prepare(
        `INSERT INTO run_events (id, run_id, seq, event_key, type, payload_json, timestamp)
         VALUES ('evt-tool-1', ?, 1, 'tool.started:1', 'tool.started', '{}', ?)`,
      )
      .run(runId, now)

    const inspTool = await orchestrator.inspectSession(sess.id)
    assert.equal(inspTool.hasToolActivity, true)
    await assert.rejects(
      () => orchestrator.retryRun({ runId, idempotencyKey: 'k-retry-no-confirm' }),
      /Explicit confirmation is required before retrying/,
    )
    const retriedConfirmed = await orchestrator.retryRun({
      runId,
      idempotencyKey: 'k-retry-confirmed',
      confirmSideEffects: true,
    })
    assert.notEqual(retriedConfirmed.run.id, runId)

    // 3. inspectSession verifies provider thread accessibility & account ownership
    dbHandle.sqlite
      .prepare("UPDATE sessions SET runtime_id = 'codex', account_id = 'chatgpt:plus:ws-1', external_session_id = 'thr-1' WHERE id = ?")
      .run(sess.id)
    readThreadResult = { accessible: true }
    const inspAccessible = await orchestrator.inspectSession(sess.id)
    assert.equal(inspAccessible.providerThreadStatus, 'accessible')

    readThreadResult = { accessible: false, reason: 'Thread archived on provider' }
    const inspUnavailable = await orchestrator.inspectSession(sess.id)
    assert.equal(inspUnavailable.providerThreadStatus, 'unavailable')
    assert.equal(inspUnavailable.resumable, false)

    dbHandle.sqlite
      .prepare("UPDATE sessions SET account_id = 'acct-other-2' WHERE id = ?")
      .run(sess.id)
    readThreadResult = { accessible: true }
    const inspMismatch = await orchestrator.inspectSession(sess.id)
    assert.equal(inspMismatch.providerThreadStatus, 'unavailable')
    assert.equal(inspMismatch.resumable, false)
    assert.match(inspMismatch.reason, /different account/i)

    await orchestrator.stop()
    await registry.stop()
    dbHandle.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
