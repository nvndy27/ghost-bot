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
  UsageSnapshot,
} from '@ghost-bot/shared-types/runtime'
import { openGhostBotDatabase } from '../apps/daemon/src/db/client.ts'
import { seedInitialBotsIfNeeded } from '../apps/daemon/src/db/seed.ts'
import { RunOrchestrator } from '../apps/daemon/src/execution/orchestrator.ts'
import { isTerminalStatus } from '../apps/daemon/src/execution/state-machine.ts'
import { RuntimeRegistry } from '../apps/daemon/src/runtime/registry.ts'
import type { CodexMetadataClient } from '../apps/daemon/src/runtime/registry.ts'
import { SessionRepository } from '../apps/daemon/src/sessions/repository.ts'
import { SettingsRepository } from '../apps/daemon/src/settings/repository.ts'

function createFakeCodexClient(options?: {
  authType?: 'chatgpt' | 'apiKey' | null
  scenario?: 'normal' | 'approval' | 'disconnect' | 'slow-cancel' | 'cancel-timeout'
}) {
  const scenario = options?.scenario ?? 'normal'
  const authType = options?.authType === undefined ? 'chatgpt' : options.authType
  const createdSessions: SessionConfig[] = []
  const resumedThreads: string[] = []
  const cancelledRuns: string[] = []
  const resolvedApprovals: ApprovalDecision[] = []
  let threadCounter = 0

  const client: CodexMetadataClient = {
    async getAccountSummary() {
      if (authType === null) {
        return {
          accountPresent: false,
          accountType: null,
          email: null,
          planType: null,
          workspaceName: null,
          requiresOpenaiAuth: true,
        }
      }
      return {
        accountPresent: true,
        accountType: authType,
        email: 'user@example.invalid',
        planType: authType === 'chatgpt' ? 'plus' : null,
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
    async getUsage(): Promise<UsageSnapshot> {
      return {
        source: 'provider',
        observedAt: new Date().toISOString(),
        windows: [{ label: '5h', usedPercent: 10, resetAt: null }],
      }
    },
    async close() {},
    async createSession(config: SessionConfig): Promise<Session> {
      createdSessions.push(config)
      threadCounter += 1
      return {
        id: `thr-live-${threadCounter}`,
        externalId: `thr-live-${threadCounter}`,
        runtimeId: 'codex',
      }
    },
    async resumeSession(threadId: string, _config: SessionConfig): Promise<Session> {
      resumedThreads.push(threadId)
      return {
        id: threadId,
        externalId: threadId,
        runtimeId: 'codex',
      }
    },
    async *run(request: AgentRequest): AsyncIterable<AgentEvent> {
      let seq = 0
      const next = (ev: Omit<AgentEvent, 'runId' | 'seq' | 'timestamp'>): AgentEvent => {
        seq += 1
        return { ...ev, runId: request.runId, seq, timestamp: new Date().toISOString() } as AgentEvent
      }

      if (scenario === 'disconnect') {
        yield next({ type: 'message.delta', text: 'partial before drop' })
        return // ends without terminal event
      }

      if (scenario === 'approval') {
        yield next({ type: 'message.delta', text: 'Checking... ' })
        yield next({
          type: 'approval.requested',
          approvalId: 'app-live-1',
          tool: 'item/commandExecution/requestApproval',
          argsHash: 'hash-1',
          summary: 'Run command: rm -rf /tmp/x',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        })
        yield next({ type: 'message.delta', text: 'Completed after denial.' })
        yield next({ type: 'run.completed' })
        return
      }

      if (scenario === 'slow-cancel') {
        yield next({ type: 'message.delta', text: 'part-1 ' })
        await new Promise((r) => setTimeout(r, 80))
        if (cancelledRuns.includes(request.runId)) {
          yield next({ type: 'run.cancelled' })
          return
        }
        yield next({ type: 'run.completed' })
        return
      }

      yield next({ type: 'tool.started', tool: 'read_file', callId: 'c1', summary: 'read_file' })
      yield next({ type: 'message.delta', text: 'Hello ' })
      yield next({ type: 'message.delta', text: 'from Codex!' })
      yield next({ type: 'tool.completed', tool: 'read_file', callId: 'c1', summary: 'read_file' })
      yield next({
        type: 'usage.updated',
        usage: {
          source: 'provider',
          observedAt: new Date().toISOString(),
          windows: [],
          inputTokens: 15,
          outputTokens: 6,
        },
      })
      yield next({ type: 'run.completed' })
    },
    async cancel(runId: string) {
      cancelledRuns.push(runId)
    },
    async resolveApproval(decision: ApprovalDecision) {
      resolvedApprovals.push(decision)
    },
  }

  return { client, createdSessions, resumedThreads, cancelledRuns, resolvedApprovals }
}

async function waitTerminal(orchestrator: RunOrchestrator, runId: string) {
  for (let i = 0; i < 60; i += 1) {
    const run = orchestrator.getRun(runId)
    if (isTerminalStatus(run.status)) return run
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`Timed out waiting for ${runId}`)
}

test('Phase 2B live Codex orchestration: policy gates, thread continuity, instruction composition, and approval denial', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-2b-live-'))
  try {
    const dbHandle = await openGhostBotDatabase(dir)
    seedInitialBotsIfNeeded(dbHandle)
    const settingsRepo = new SettingsRepository(dbHandle)
    settingsRepo.updateSettings({
      personalization: { defaultInstructions: 'Be concise.', responseStyle: 'concise' },
    })

    const fake = createFakeCodexClient({ scenario: 'normal' })
    const registry = new RuntimeRegistry({
      runtimeMode: 'codex',
      codexVersionOverride: '0.172.0',
      codexClientFactory: () => fake.client,
    })
    const sessionRepo = new SessionRepository(dbHandle)
    const orchestrator = new RunOrchestrator(dbHandle, {
      runtimeRegistry: registry,
      settingsRepo,
    })

    // Configure chief bot for read-only Codex execution
    dbHandle.sqlite
      .prepare(
        `UPDATE agents SET runtime_id = 'codex', model_id = 'gpt-5-codex', effort = 'medium', permission_mode = 'read-only', workspace_path = ? WHERE id = 'chief'`,
      )
      .run(dir)

    // 1. Historical mock session cannot run live Codex
    const mockSession = sessionRepo.createSession({ agentId: 'chief', title: 'Old Mock' })
    dbHandle.sqlite.prepare(`UPDATE sessions SET runtime_id = 'mock' WHERE id = ?`).run(mockSession.id)
    await assert.rejects(
      () =>
        orchestrator.startRun({
          sessionId: mockSession.id,
          idempotencyKey: 'k-mock-mismatch',
          text: 'hi',
        }),
      /historical mock session/,
    )

    // 2. Unsupported permission modes in Phase 2B (ask-approval, workspace, full-access) are rejected
    dbHandle.sqlite.prepare(`UPDATE agents SET permission_mode = 'ask-approval' WHERE id = 'chief'`).run()
    const liveSession = sessionRepo.createSession({ agentId: 'chief', title: 'Live Codex Chat' })
    await assert.rejects(
      () =>
        orchestrator.startRun({
          sessionId: liveSession.id,
          idempotencyKey: 'k-perm-blocked',
          text: 'hi',
        }),
      /limited to read-only mode/,
    )
    dbHandle.sqlite.prepare(`UPDATE agents SET permission_mode = 'read-only' WHERE id = 'chief'`).run()

    // 3. Unavailable model is rejected without silent substitution
    dbHandle.sqlite.prepare(`UPDATE agents SET model_id = 'nonexistent-model' WHERE id = 'chief'`).run()
    await assert.rejects(
      () =>
        orchestrator.startRun({
          sessionId: liveSession.id,
          idempotencyKey: 'k-bad-model',
          text: 'hi',
        }),
      /not available in the discovered Codex catalog/,
    )
    dbHandle.sqlite.prepare(`UPDATE agents SET model_id = 'gpt-5-codex' WHERE id = 'chief'`).run()

    // 4. Turn 1: creates new thread, composes instructions, streams & persists
    const turn1 = await orchestrator.startRun({
      sessionId: liveSession.id,
      idempotencyKey: 'k-live-1',
      text: 'First live turn',
    })
    const done1 = await waitTerminal(orchestrator, turn1.run.id)
    assert.equal(done1.status, 'completed')
    assert.equal(fake.createdSessions.length, 1)
    assert.match(fake.createdSessions[0]?.instructions ?? '', /Be concise\./)
    const updatedSession = sessionRepo.getSession(liveSession.id)
    assert.equal(updatedSession.externalSessionId, 'thr-live-1')

    const msgs1 = sessionRepo.getSessionMessages(liveSession.id)
    assert.equal(msgs1.messages[1]?.text, 'Hello from Codex!')

    // 5. Turn 2: resumes existing thread without creating a second thread
    const turn2 = await orchestrator.startRun({
      sessionId: liveSession.id,
      idempotencyKey: 'k-live-2',
      text: 'Second live turn',
    })
    const done2 = await waitTerminal(orchestrator, turn2.run.id)
    assert.equal(done2.status, 'completed')
    assert.equal(fake.createdSessions.length, 1)
    assert.deepEqual(fake.resumedThreads, ['thr-live-1'])

    await orchestrator.stop()
    await registry.stop()
    dbHandle.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Phase 2B denies unexpected live approval requests, handles cancellation, and rejects unverified versions/auth', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-2b-safety-'))
  try {
    const dbHandle = await openGhostBotDatabase(dir)
    seedInitialBotsIfNeeded(dbHandle)
    dbHandle.sqlite
      .prepare(
        `UPDATE agents SET runtime_id = 'codex', model_id = 'gpt-5-codex', effort = 'medium', permission_mode = 'read-only', workspace_path = ? WHERE id = 'chief'`,
      )
      .run(dir)

    // 1. Approval denial in read-only mode
    const fakeApp = createFakeCodexClient({ scenario: 'approval' })
    const regApp = new RuntimeRegistry({
      runtimeMode: 'codex',
      codexVersionOverride: '0.172.0',
      codexClientFactory: () => fakeApp.client,
    })
    const sessionRepo = new SessionRepository(dbHandle)
    const orchApp = new RunOrchestrator(dbHandle, { runtimeRegistry: regApp })
    const sess = sessionRepo.createSession({ agentId: 'chief', title: 'Approval Deny' })
    const rApp = await orchApp.startRun({ sessionId: sess.id, idempotencyKey: 'k-app', text: 'hi' })
    const doneApp = await waitTerminal(orchApp, rApp.run.id)
    assert.equal(doneApp.status, 'completed')
    assert.equal(fakeApp.resolvedApprovals.length, 1)
    assert.equal(fakeApp.resolvedApprovals[0]?.decision, 'deny')
    const evtsApp = orchApp.getRunEvents(rApp.run.id, 0, 50)
    assert.ok(evtsApp.events.some((e) => e.type === 'approval.denied'))
    await orchApp.stop()
    await regApp.stop()

    // 2. End-to-end cancellation
    const fakeCancel = createFakeCodexClient({ scenario: 'slow-cancel' })
    const regCancel = new RuntimeRegistry({
      runtimeMode: 'codex',
      codexVersionOverride: '0.172.0',
      codexClientFactory: () => fakeCancel.client,
    })
    const orchCancel = new RunOrchestrator(dbHandle, { runtimeRegistry: regCancel })
    const rCancel = await orchCancel.startRun({
      sessionId: sess.id,
      idempotencyKey: 'k-cancel',
      text: 'slow',
    })
    await new Promise((r) => setTimeout(r, 25))
    orchCancel.cancelRun(rCancel.run.id)
    const doneCancel = await waitTerminal(orchCancel, rCancel.run.id)
    assert.equal(doneCancel.status, 'cancelled')
    assert.ok(fakeCancel.cancelledRuns.includes(rCancel.run.id))
    await orchCancel.stop()
    await regCancel.stop()

    // 3. Unverified Codex version fails closed
    const regBadVer = new RuntimeRegistry({
      runtimeMode: 'codex',
      codexVersionOverride: '0.173.0',
      codexClientFactory: () => fakeApp.client,
    })
    const orchBadVer = new RunOrchestrator(dbHandle, { runtimeRegistry: regBadVer })
    await assert.rejects(
      () => orchBadVer.startRun({ sessionId: sess.id, idempotencyKey: 'k-badver', text: 'hi' }),
      /verified.*0\.172\.0|unavailable|unsupported/i,
    )
    await regBadVer.stop()

    // 4. API-key auth fails closed
    const fakeApiKey = createFakeCodexClient({ authType: 'apiKey' })
    const regApiKey = new RuntimeRegistry({
      runtimeMode: 'codex',
      codexVersionOverride: '0.172.0',
      codexClientFactory: () => fakeApiKey.client,
    })
    const orchApiKey = new RunOrchestrator(dbHandle, { runtimeRegistry: regApiKey })
    await assert.rejects(
      () => orchApiKey.startRun({ sessionId: sess.id, idempotencyKey: 'k-apikey', text: 'hi' }),
      /API-key|ChatGPT/i,
    )
    await regApiKey.stop()

    dbHandle.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
