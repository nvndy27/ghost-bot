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
    const insp1 = orchestrator.inspectSession(sess.id)
    assert.equal(insp1.resumable, true)
    assert.equal(insp1.lastRun?.status, 'failed')

    // Manual retry creates a new run without auto-replaying
    const retried = await orchestrator.retryRun({
      runId: failStart.run.id,
      idempotencyKey: 'k-2d-retry-1',
    })
    assert.notEqual(retried.run.id, failStart.run.id)

    // Quarantine test: generation bump alone on registry does NOT clear quarantine;
    // only reconnectRuntime() (which closes owned client) clears it.
    ;(
      orchestrator as unknown as { sessionsWithUnconfirmedStop: Map<string, number> }
    ).sessionsWithUnconfirmedStop.set(sess.id, registry.getGeneration())
    await registry.closeOwnedClient()
    const inspQ = orchestrator.inspectSession(sess.id)
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
    const inspAfterReconnect = orchestrator.inspectSession(sess.id)
    assert.equal(inspAfterReconnect.quarantined, false)
    assert.equal(inspAfterReconnect.resumable, true)

    await orchestrator.stop()
    await registry.stop()
    dbHandle.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
