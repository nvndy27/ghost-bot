import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  RoutineNotificationDtoSchema,
  RoutineRecordDtoSchema,
  RoutineSimulationDtoSchema,
  RoutineTaskDtoSchema,
} from '../packages/shared-types/ipc.ts'
import { BotRepository } from '../apps/daemon/src/bots/repository.ts'
import { openGhostBotDatabase } from '../apps/daemon/src/db/client.ts'
import { seedInitialBotsIfNeeded } from '../apps/daemon/src/db/seed.ts'
import { RunOrchestrator } from '../apps/daemon/src/execution/orchestrator.ts'
import { RuntimePolicyBroker } from '../apps/daemon/src/runtime/policy-broker.ts'
import { RuntimeRegistry } from '../apps/daemon/src/runtime/registry.ts'
import { DaemonRoutineDispatcher } from '../apps/daemon/src/scheduler/execution-bridge.ts'
import { SchedulerService } from '../apps/daemon/src/scheduler/service.ts'
import { SessionRepository } from '../apps/daemon/src/sessions/repository.ts'
import { SettingsRepository } from '../apps/daemon/src/settings/repository.ts'
import { TeamsExecutionBridge } from '../apps/daemon/src/teams/execution-bridge.ts'
import { TeamsService } from '../apps/daemon/src/teams/service.ts'

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fs.chmodSync(dir, 0o700)
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

async function setupHarness(dispatchTimeoutMs = 15_000) {
  const dir = makeTempDir('ghost-5c-hardening-')
  const db = await openGhostBotDatabase(dir)
  seedInitialBotsIfNeeded(db)
  const bots = new BotRepository(db)
  const settingsRepo = new SettingsRepository(db)
  const sessionRepo = new SessionRepository(db)
  const runtimeRegistry = new RuntimeRegistry('mock')
  const policyBroker = new RuntimePolicyBroker()
  const orchestrator = new RunOrchestrator(db, {
    runtimeRegistry,
    settingsRepo,
  })
  const teamsBridge = new TeamsExecutionBridge({
    dbHandle: db,
    botRepo: bots,
    sessionRepo,
    orchestrator,
    policyBroker,
    getRuntimeState: () => ({
      runtimeMode: 'mock',
      codexVersion: null,
      authMethod: 'none',
      accountId: null,
    }),
    pollIntervalMs: 15,
  })
  const teamsService = new TeamsService(db, bots, teamsBridge)
  const scheduler = new SchedulerService(db, bots, teamsService, { tickIntervalMs: 200 })
  const dispatcher = new DaemonRoutineDispatcher({
    dbHandle: db,
    botRepo: bots,
    sessionRepo,
    orchestrator,
    policyBroker,
    teamsService,
    approvalCoordinator: scheduler.approvals,
    getRuntimeState: () => ({
      runtimeMode: 'mock',
      codexVersion: null,
      authMethod: 'none',
      accountId: null,
    }),
    pollIntervalMs: 15,
    dispatchTimeoutMs,
  })
  scheduler.attachDispatcher(dispatcher)
  const botList = bots.listBots().bots
  return { db, botList, sessionRepo, orchestrator, scheduler, dispatcher }
}

describe('Phase 5C Routines Desktop & Hardening Regressions', () => {
  it('prevents false cancellation confirmation during in-flight child run creation and handles timeout cancellation', async () => {
    const { db, botList, orchestrator, scheduler, dispatcher } = await setupHarness(50)
    try {
      const lead = botList[0]!
      const routine = scheduler.createRoutine({
        name: 'In-flight Cancel Routine',
        botId: lead.id,
        trigger: { kind: 'daily', hour: 9, minute: 0 },
        timezone: 'UTC',
        task: { prompt: 'In-flight check', idempotent: false },
        enabled: true,
      })
      const trig = scheduler.triggerManual(routine.id, lead.id, '5c-inflight-1')
      db.sqlite
        .prepare(`UPDATE scheduler_tasks SET status = 'running', attempt = 1 WHERE id = ?`)
        .run(trig.task.id)

      const origStartRun = orchestrator.startRun.bind(orchestrator)
      let releaseStart!: () => void
      const startBarrier = new Promise<void>((r) => {
        releaseStart = r
      })
      orchestrator.startRun = (async (input: Parameters<typeof origStartRun>[0]) => {
        await startBarrier
        return origStartRun(input)
      }) as typeof origStartRun

      const dispatchPromise = dispatcher.dispatch({
        routineId: routine.id,
        routineRevision: routine.revision,
        triggerSource: 'manual',
        taskId: trig.task.id,
        occurrenceKey: trig.task.occurrenceKey,
        ownerId: trig.task.ownerId,
        botId: lead.id,
        untrustedTask: routine.task,
        requirePolicyRevalidation: true,
        reusePriorApprovals: false,
      })

      await new Promise((r) => setTimeout(r, 10))
      const cancelRes = await dispatcher.cancelTaskExecution(trig.task.id, {
        ownerId: trig.task.ownerId,
        botId: lead.id,
      })
      assert.equal(cancelRes.confirmed, false, 'Must NOT falsely confirm while startRun is in flight')

      releaseStart()
      const outcome = await dispatchPromise
      assert.equal(outcome.status, 'failed')
      assert.equal(outcome.code, 'ROUTINE_TASK_CANCELLED')
      orchestrator.startRun = origStartRun
      await new Promise((r) => setTimeout(r, 40))
    } finally {
      db.close()
    }
  })

  it('correlates daemon approval resolution to scheduler_approval_links without prompt replay and validates strict DTOs', async () => {
    const { db, botList, sessionRepo, orchestrator, scheduler } = await setupHarness()
    try {
      const lead = botList[0]!
      const routine = scheduler.createRoutine({
        name: 'Approval Linked Routine',
        botId: lead.id,
        trigger: { kind: 'daily', hour: 10, minute: 0 },
        timezone: 'UTC',
        task: { prompt: 'Need approval', idempotent: false },
        enabled: true,
      })
      assert.equal(RoutineRecordDtoSchema.safeParse(routine).success, true)

      const sim = scheduler.simulateRoutine(routine.id, lead.id, 3)
      assert.equal(RoutineSimulationDtoSchema.safeParse(sim).success, true)

      const trig = scheduler.triggerManual(routine.id, lead.id, '5c-approval-1')
      assert.equal(RoutineTaskDtoSchema.safeParse(trig.task).success, true)

      db.sqlite
        .prepare(`UPDATE scheduler_tasks SET status = 'running', attempt = 1 WHERE id = ?`)
        .run(trig.task.id)
      const session = sessionRepo.createSession({
        agentId: lead.id,
        title: `routine:${routine.id}:${lead.id}`,
      })
      const child = await orchestrator.startRun({
        sessionId: session.id,
        text: 'Need approval',
        idempotencyKey: `sched:${trig.task.id}:attempt:1`,
      })
      for (let i = 0; i < 30; i += 1) {
        const r = orchestrator.getRun(child.run.id)
        if (r.status === 'completed') break
        await new Promise((res) => setTimeout(res, 15))
      }

      const nowIso = new Date().toISOString()
      const futureIso = new Date(Date.now() + 60_000).toISOString()
      db.sqlite
        .prepare(
          `INSERT INTO approvals (
            id, run_id, session_id, agent_id, runtime_generation, account_id,
            action_type, action_summary, args_json, args_hash, permission_mode,
            status, created_at, expires_at
          ) VALUES ('app_5c_1', ?, ?, ?, 1, 'local', 'command', 'echo ok', '{}', 'h5c', 'ask-approval', 'pending', ?, ?)`,
        )
        .run(child.run.id, session.id, lead.id, nowIso, futureIso)

      scheduler.approvals.bindApprovalRequest({
        routineId: routine.id,
        routineRevision: routine.revision,
        occurrenceKey: trig.task.occurrenceKey,
        taskId: trig.task.id,
        scope: { ownerId: trig.task.ownerId, botId: lead.id },
        daemonRunId: child.run.id,
        daemonApprovalId: 'app_5c_1',
        expiresAt: futureIso,
        requirePolicyRevalidation: true,
        sanitizedActionSummary: 'command: echo ok',
      })
      db.sqlite
        .prepare(
          `INSERT INTO scheduler_approval_links (
            id, scheduler_task_id, routine_id, routine_revision, occurrence_key,
            daemon_run_id, daemon_approval_id, state, expires_at, created_at, updated_at
          ) VALUES ('sapp_5c_1', ?, ?, ?, ?, ?, 'app_5c_1', 'approval.pending', ?, ?, ?)`,
        )
        .run(
          trig.task.id,
          routine.id,
          routine.revision,
          trig.task.occurrenceKey,
          child.run.id,
          futureIso,
          nowIso,
          nowIso,
        )

      scheduler.handleDaemonApprovalResolved(child.run.id, 'app_5c_1', 'approved')
      const details = scheduler.getTask(trig.task.id, lead.id)
      assert.equal(details.approvalLink?.state, 'authorized.continuation')
      assert.equal(RoutineTaskDtoSchema.safeParse(details).success, true)

      const notifs = scheduler.listNotifications(lead.id)
      for (const n of notifs) {
        assert.equal(RoutineNotificationDtoSchema.safeParse(n).success, true)
      }
    } finally {
      db.close()
    }
  })
})
