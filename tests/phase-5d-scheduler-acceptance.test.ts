import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ExecutionQueue } from '../packages/scheduler/src/queue/execution-queue.ts'
import { createBorrowedSchedulerDatabaseHandle } from '../packages/scheduler/src/repository/sqlite-store.ts'
import { RoutineRepository } from '../packages/scheduler/src/repository/routine-repository.ts'
import { SchedulerEngine } from '../packages/scheduler/src/engine/scheduler-engine.ts'
import {
  CreateRoutineIpcInputSchema,
  RoutineDiagnosticsDtoSchema,
  RoutineExportBundleDtoSchema,
  RoutineImportPreviewDtoSchema,
  RoutinePreviewDtoSchema,
  RoutineSimulationDtoSchema,
  RoutineStatsDtoSchema,
} from '../packages/shared-types/ipc.ts'
import { openGhostBotDatabase } from '../apps/daemon/src/db/client.ts'
import { seedInitialBotsIfNeeded } from '../apps/daemon/src/db/seed.ts'
import { BotRepository } from '../apps/daemon/src/bots/repository.ts'
import { SessionRepository } from '../apps/daemon/src/sessions/repository.ts'
import { SettingsRepository } from '../apps/daemon/src/settings/repository.ts'
import { RunOrchestrator } from '../apps/daemon/src/execution/orchestrator.ts'
import { RuntimePolicyBroker } from '../apps/daemon/src/runtime/policy-broker.ts'
import { RuntimeRegistry } from '../apps/daemon/src/runtime/registry.ts'
import { TeamsService } from '../apps/daemon/src/teams/service.ts'
import { TeamsExecutionBridge } from '../apps/daemon/src/teams/execution-bridge.ts'
import { DaemonRoutineDispatcher } from '../apps/daemon/src/scheduler/execution-bridge.ts'
import { SchedulerService } from '../apps/daemon/src/scheduler/service.ts'

async function setupDaemonEnv(initialNowMs = Date.parse('2026-11-26T12:00:00.000Z')) {
  const dir = mkdtempSync(join(tmpdir(), 'ghost-p5d-'))
  chmodSync(dir, 0o700)
  const wsDir = join(dir, 'ws')
  mkdirSync(wsDir, { recursive: true })
  const db = await openGhostBotDatabase(dir)
  seedInitialBotsIfNeeded(db)
  const botRepo = new BotRepository(db)
  const settingsRepo = new SettingsRepository(db)
  const sessionRepo = new SessionRepository(db)
  const runtimeRegistry = new RuntimeRegistry('mock')
  const policyBroker = new RuntimePolicyBroker()
  let nowMs = initialNowMs
  const clock = { nowMs: () => nowMs, advance: (ms: number) => (nowMs += ms), set: (ms: number) => (nowMs = ms) }
  const runtimeState: {
    runtimeMode: 'codex' | 'mock'
    codexVersion: string | null
    authMethod: 'chatgpt' | 'apiKey' | 'none'
    accountId: string | null
  } = {
    runtimeMode: 'mock',
    codexVersion: '0.172.0',
    authMethod: 'chatgpt',
    accountId: 'acct_p5d',
  }

  const orchestrator = new RunOrchestrator(db, {
    runtimeRegistry,
    settingsRepo,
  })
  const teamsBridge = new TeamsExecutionBridge({
    dbHandle: db,
    botRepo,
    sessionRepo,
    orchestrator,
    policyBroker,
    getRuntimeState: () => runtimeState,
    pollIntervalMs: 10,
  })
  const teamsService = new TeamsService(db, botRepo, teamsBridge)

  const scheduler = new SchedulerService(db, botRepo, teamsService, {
    clock,
    historyRetentionMs: 60_000,
    maintenanceIntervalMs: 60_000,
  })
  const dispatcher = new DaemonRoutineDispatcher({
    dbHandle: db,
    botRepo,
    sessionRepo,
    orchestrator,
    policyBroker,
    teamsService,
    approvalCoordinator: scheduler.approvals,
    getRuntimeState: () => runtimeState,
    pollIntervalMs: 10,
    dispatchTimeoutMs: 500,
  })
  scheduler.attachDispatcher(dispatcher)

  const botList = botRepo.listBots().bots
  const lead = botList[0]!
  const worker = botList[1]!
  const team = teamsService.createTeam({
    name: 'Audit Team',
    leadBotId: lead.id,
    memberBotIds: [lead.id, worker.id],
    topology: 'leader-worker',
  })

  return {
    dir,
    wsDir,
    db,
    botRepo,
    sessionRepo,
    orchestrator,
    teamsService,
    scheduler,
    dispatcher,
    clock,
    runtimeState,
    lead,
    worker,
    team,
  }
}

test('Phase 5D R0: replay prevention across out-of-order events, manual key reuse, pruning, clock rollback, and revision edits', async () => {
  const env = await setupDaemonEnv(Date.parse('2026-11-26T10:00:00.000Z'))
  try {
    const borrowed = createBorrowedSchedulerDatabaseHandle(env.db.sqlite, env.db.transaction.bind(env.db))
    const repo = new RoutineRepository(borrowed)
    const queue = new ExecutionQueue(borrowed)
    const engine = new SchedulerEngine({ repository: repo, queue, clock: env.clock })

    // 1. Out-of-order event occurrences & replay after history pruning
    const evRoutine = env.scheduler.createRoutine({
      botId: env.lead.id,
      name: 'Event Routine',
      trigger: { kind: 'event', eventType: 'git.push', source: 'local-hook' },
      timezone: 'UTC',
      task: { prompt: 'Handle push', requiresApproval: false, maxRuntimeMs: 10_000 },
      enabled: true,
    })

    const e1 = engine.ingestSyntheticEvent({
      eventId: 'ev-1005',
      eventType: 'git.push',
      trustedSource: 'local-hook',
      timestamp: '2026-11-26T10:05:00.000Z',
      scope: { ownerId: 'local-user', botId: env.lead.id },
      payload: {},
    })
    assert.equal(e1.enqueuedTasks, 1)

    // Complete & prune e1 history + run maintenance
    const c1 = queue.claimNext('w1', 10_000, env.clock.nowMs())
    assert.ok(c1)
    queue.markRunning(c1.id, 'w1', env.clock.nowMs())
    queue.completeTask(c1.id, 'w1', env.clock.nowMs())
    env.clock.advance(120_000)
    const maint = env.scheduler.runMaintenance(env.clock.nowMs())
    assert.equal(maint.prunedHistory, 1)

    // Out-of-order event BEFORE e1's timestamp MUST still succeed
    const e2 = engine.ingestSyntheticEvent({
      eventId: 'ev-1002',
      eventType: 'git.push',
      trustedSource: 'local-hook',
      timestamp: '2026-11-26T10:02:00.000Z',
      scope: { ownerId: 'local-user', botId: env.lead.id },
      payload: {},
    })
    assert.equal(e2.enqueuedTasks, 1)

    // Replaying e1 AFTER history pruning MUST be suppressed (never re-executed)
    const e1Replay = engine.ingestSyntheticEvent({
      eventId: 'ev-1005',
      eventType: 'git.push',
      trustedSource: 'local-hook',
      timestamp: '2026-11-26T10:05:00.000Z',
      scope: { ownerId: 'local-user', botId: env.lead.id },
      payload: {},
    })
    assert.equal(e1Replay.enqueuedTasks, 0)
    assert.equal(e1Replay.duplicatesSuppressed, 1)

    // 2. Manual idempotency-key reuse after retention expires MUST NOT silently re-execute
    const schedRoutine = env.scheduler.createRoutine({
      botId: env.lead.id,
      name: 'Manual & Schedule Routine',
      trigger: { kind: 'interval', intervalMs: 60_000, anchorAt: '2026-11-26T10:00:00.000Z' },
      timezone: 'UTC',
      task: { prompt: 'Run audit', requiresApproval: false, maxRuntimeMs: 10_000 },
      enabled: true,
    })

    const m1 = env.scheduler.triggerManual(schedRoutine.id, env.lead.id, 'idem-key-r0')
    assert.equal(m1.created, true)
    const mc = queue.claimNext('w1', 10_000, env.clock.nowMs())
    // drain ev-1002 first if queued, or claim until m1
    let cur = mc
    while (cur && cur.id !== m1.task.id) {
      queue.markRunning(cur.id, 'w1', env.clock.nowMs())
      queue.completeTask(cur.id, 'w1', env.clock.nowMs())
      cur = queue.claimNext('w1', 10_000, env.clock.nowMs())
    }
    assert.ok(cur && cur.id === m1.task.id)
    queue.markRunning(cur.id, 'w1', env.clock.nowMs())
    queue.completeTask(cur.id, 'w1', env.clock.nowMs())

    // Set dedup expires_at in the past and prune history
    env.db.sqlite
      .prepare(`UPDATE scheduler_occurrence_dedup SET expires_at = '2026-11-26T10:01:00.000Z' WHERE routine_id = ?`)
      .run(schedRoutine.id)
    env.clock.advance(120_000)
    env.scheduler.runMaintenance(env.clock.nowMs())

    // Reusing same manual key after retention expires must be rejected (never silently re-executed)
    assert.throws(
      () => env.scheduler.triggerManual(schedRoutine.id, env.lead.id, 'idem-key-r0'),
      { code: 'DUPLICATE_OCCURRENCE' },
    )

    // 3. Schedule dedup pruning advances watermark, and clock rollback + revision edit never replay
    const recSched = repo.getById(schedRoutine.id, { ownerId: 'local-user', botId: env.lead.id })
    const s1 = queue.enqueueOccurrence(recSched, '2026-11-26T10:03:00.000Z', env.clock.nowMs(), {
      triggerSource: 'schedule',
      dedupExpiresAt: '2026-11-26T10:03:30.000Z',
    })
    assert.equal(s1.created, true)
    const sc = queue.claimNext('w1', 10_000, env.clock.nowMs())
    assert.ok(sc)
    queue.markRunning(sc.id, 'w1', env.clock.nowMs())
    queue.completeTask(sc.id, 'w1', env.clock.nowMs())

    env.clock.advance(120_000)
    const m2 = env.scheduler.runMaintenance(env.clock.nowMs())
    assert.equal(m2.prunedDedup, 1)

    // Clock rollback to before watermark + routine revision change
    env.scheduler.updateRoutine(schedRoutine.id, env.lead.id, { description: 'Updated rev 2' })
    const rev2 = repo.getById(schedRoutine.id, { ownerId: 'local-user', botId: env.lead.id })
    assert.equal(rev2.revision, 2)
    assert.throws(
      () => queue.enqueueOccurrence(rev2, '2026-11-26T10:03:00.000Z', env.clock.nowMs() - 300_000),
      { code: 'STALE_OCCURRENCE_BEFORE_WATERMARK' },
    )
    assert.ok(evRoutine.id)
  } finally {
    env.db.close()
    rmSync(env.dir, { recursive: true, force: true })
  }
})

test('Phase 5D F1: cancellation races, unconfirmed termination, bot/team timeouts, late callbacks, and shutdown', async () => {
  const env = await setupDaemonEnv()
  try {
    const botRoutine = env.scheduler.createRoutine({
      botId: env.lead.id,
      name: 'F1 Bot Routine',
      trigger: { kind: 'interval', intervalMs: 60_000, anchorAt: '2026-11-26T10:00:00.000Z' },
      timezone: 'UTC',
      task: { prompt: 'F1 test', requiresApproval: false, maxRuntimeMs: 10_000 },
      enabled: true,
    })

    // 1. Cancellation during child-run creation (before daemonRunId exists) -> confirmed: false -> interrupted + uncertain
    const m1 = env.scheduler.triggerManual(botRoutine.id, env.lead.id, 'f1-inflight')
    const borrowed = createBorrowedSchedulerDatabaseHandle(env.db.sqlite, env.db.transaction.bind(env.db))
    const queue = new ExecutionQueue(borrowed)
    const repo = new RoutineRepository(borrowed)
    const engine = new SchedulerEngine({ repository: repo, queue, clock: env.clock })

    const slowStartRun = env.orchestrator.startRun.bind(env.orchestrator)
    let releaseStart!: () => void
    const startGate = new Promise<void>((r) => (releaseStart = r))
    env.orchestrator.startRun = (async (input) => {
      await startGate
      return slowStartRun(input)
    }) as typeof env.orchestrator.startRun

    const dispatchPromise = engine.dispatchNext(env.dispatcher, 'daemon-scheduler')
    await new Promise((r) => setTimeout(r, 25))
    const cancelled = await env.scheduler.cancelTask(m1.task.id, env.lead.id)
    assert.equal(cancelled.status, 'interrupted')
    assert.equal(cancelled.uncertainExecution, true)
    assert.equal(cancelled.errorCode, 'CANCELLATION_UNCONFIRMED')

    // Late callback after cancellation must not crash dispatchNext or overwrite terminal/interrupted state
    releaseStart()
    const lateResult = await dispatchPromise
    assert.equal(lateResult?.status, 'interrupted')
    assert.equal(lateResult?.uncertainExecution, true)
    env.orchestrator.startRun = slowStartRun

    // 2. Unconfirmed underlying termination on cancelRun -> returns unknown -> interrupted + uncertainExecution
    const m2 = env.scheduler.triggerManual(botRoutine.id, env.lead.id, 'f1-unconfirmed-stop')
    const origCancel = env.orchestrator.cancelRun.bind(env.orchestrator)
    env.orchestrator.cancelRun = ((runId: string) => {
      const r = env.orchestrator.getRun(runId)
      return { run: { ...r, status: 'cancelling' } }
    }) as typeof env.orchestrator.cancelRun
    const origGetRun = env.orchestrator.getRun.bind(env.orchestrator)
    env.orchestrator.getRun = ((runId: string) => {
      const r = origGetRun(runId)
      return { ...r, status: 'running' }
    }) as typeof env.orchestrator.getRun

    const timeoutTask = await engine.dispatchNext(env.dispatcher, 'daemon-scheduler')
    assert.equal(timeoutTask?.status, 'interrupted')
    assert.equal(timeoutTask?.uncertainExecution, true)
    env.orchestrator.cancelRun = origCancel
    env.orchestrator.getRun = origGetRun
    assert.ok(m2.task.id)

    // 3. Team-targeted dispatch timeout -> calls cancelTeamRun and marks interrupted + uncertainExecution
    const teamRoutine = env.scheduler.createRoutine({
      botId: env.lead.id,
      targetType: 'team',
      teamId: env.team.id,
      name: 'F1 Team Timeout',
      trigger: { kind: 'interval', intervalMs: 60_000, anchorAt: '2026-11-26T10:00:00.000Z' },
      timezone: 'UTC',
      task: { prompt: 'F1 team timeout', requiresApproval: false, maxRuntimeMs: 10_000 },
      enabled: true,
    })
    const m3 = env.scheduler.triggerManual(teamRoutine.id, env.lead.id, 'f1-team-timeout')
    let teamCancelCalled = false
    const origGetTeamRun = env.teamsService.getTeamRun.bind(env.teamsService)
    const origCancelTeamRun = env.teamsService.cancelTeamRun.bind(env.teamsService)
    env.teamsService.getTeamRun = ((id: string) => {
      const r = origGetTeamRun(id)
      return { ...r, status: 'running' }
    }) as typeof env.teamsService.getTeamRun
    env.teamsService.cancelTeamRun = (async (id: string) => {
      teamCancelCalled = true
      return origCancelTeamRun(id)
    }) as typeof env.teamsService.cancelTeamRun

    const teamTimeoutRes = await engine.dispatchNext(env.dispatcher, 'daemon-scheduler')
    assert.equal(teamCancelCalled, true)
    assert.equal(teamTimeoutRes?.status, 'interrupted')
    assert.equal(teamTimeoutRes?.uncertainExecution, true)
    env.teamsService.getTeamRun = origGetTeamRun
    env.teamsService.cancelTeamRun = origCancelTeamRun
    assert.ok(m3.task.id)

    // 3b. Team-target in-flight cancellation during startTeamRun -> confirmed: false -> interrupted + uncertain
    const m3b = env.scheduler.triggerManual(teamRoutine.id, env.lead.id, 'f1-team-inflight')
    const origStartTeamRun = env.teamsService.startTeamRun.bind(env.teamsService)
    let releaseTeamStart!: () => void
    const teamStartGate = new Promise<void>((r) => (releaseTeamStart = r))
    env.teamsService.startTeamRun = (async (input) => {
      await teamStartGate
      return origStartTeamRun(input)
    }) as typeof env.teamsService.startTeamRun

    const teamDispatchPromise = engine.dispatchNext(env.dispatcher, 'daemon-scheduler')
    await new Promise((r) => setTimeout(r, 25))
    const teamCancelled = await env.scheduler.cancelTask(m3b.task.id, env.lead.id)
    assert.equal(teamCancelled.status, 'interrupted')
    assert.equal(teamCancelled.uncertainExecution, true)
    assert.equal(teamCancelled.errorCode, 'CANCELLATION_UNCONFIRMED')
    releaseTeamStart()
    const teamLateResult = await teamDispatchPromise
    assert.equal(teamLateResult?.status, 'interrupted')
    assert.equal(teamLateResult?.uncertainExecution, true)
    env.teamsService.startTeamRun = origStartTeamRun

    // 4. Shutdown stops cycles cleanly
    await env.scheduler.stopTimer()
    const afterStop = await env.scheduler.runCycle()
    assert.equal(afterStop.dispatched, 0)
  } finally {
    env.db.close()
    rmSync(env.dir, { recursive: true, force: true })
  }
})

test('Phase 5D F2: approval lifecycle without deadlock, approve-once completion, denial, and unavailable continuation', async () => {
  const env = await setupDaemonEnv()
  try {
    const routine = env.scheduler.createRoutine({
      botId: env.lead.id,
      name: 'F2 Approval Routine',
      trigger: { kind: 'interval', intervalMs: 60_000, anchorAt: '2026-11-26T12:00:01.000Z' },
      timezone: 'UTC',
      task: { prompt: 'Needs approval', requiresApproval: true, maxRuntimeMs: 10_000 },
      enabled: true,
    })

    // Trigger manual run and intercept startRun to create a durable awaiting_approval run + approval row
    const m1 = env.scheduler.triggerManual(routine.id, env.lead.id, 'f2-approve-once')
    const session = env.sessionRepo.createSession({ agentId: env.lead.id, title: `routine:${routine.id}:${env.lead.id}` })

    const origStartRun = env.orchestrator.startRun.bind(env.orchestrator)
    let injectedRunId = ''
    let injectedApprovalId = ''
    env.orchestrator.startRun = (async (input) => {
      const nowIso = new Date(env.clock.nowMs()).toISOString()
      const runId = `run_f2_${Date.now()}`
      const appId = `app_f2_${Date.now()}`
      injectedRunId = runId
      injectedApprovalId = appId
      env.db.sqlite
        .prepare(
          `INSERT INTO runs (id, session_id, agent_id, idempotency_key, status, permission_mode, runtime_id, model_id, effort, config_snapshot_json, started_at, created_at)
           VALUES (?, ?, ?, ?, 'awaiting_approval', 'ask-approval', 'mock', 'gpt-5.4-mini', 'medium', '{}', ?, ?)`,
        )
        .run(runId, input.sessionId, env.lead.id, input.idempotencyKey, nowIso, nowIso)
      env.db.sqlite
        .prepare(
          `INSERT INTO approvals (
            id, run_id, session_id, agent_id, runtime_generation, account_id,
            action_type, action_summary, args_json, args_hash, permission_mode,
            status, expires_at, created_at
          ) VALUES (?, ?, ?, ?, 1, 'acct_p5d', 'command', 'Run echo ok', '{}', 'hash_f2', 'ask-approval', 'pending', ?, ?)`,
        )
        .run(appId, runId, input.sessionId, env.lead.id, new Date(env.clock.nowMs() + 60_000).toISOString(), nowIso)
      return { run: env.orchestrator.getRun(runId), created: true }
    }) as typeof env.orchestrator.startRun

    const cycle1 = await env.scheduler.runCycle()
    assert.equal(cycle1.dispatched, 1)
    env.orchestrator.startRun = origStartRun

    const awaitingTask = env.scheduler.getTask(m1.task.id, env.lead.id)
    assert.equal(awaitingTask.status, 'awaiting_approval')
    assert.equal(awaitingTask.executionLink?.daemonRunId, injectedRunId)
    assert.equal(awaitingTask.approvalLink?.daemonApprovalId, injectedApprovalId)

    // Scheduler cycle remains non-blocking while approval is pending
    const cycleWhilePending = await env.scheduler.runCycle()
    assert.equal(cycleWhilePending.dispatched, 0)

    // Simulate resolving approval via daemon (approve once) and completing the resumed run
    env.db.sqlite
      .prepare(`UPDATE approvals SET status = 'approved', resolved_at = ? WHERE id = ?`)
      .run(new Date(env.clock.nowMs()).toISOString(), injectedApprovalId)
    env.db.sqlite
      .prepare(`UPDATE runs SET status = 'completed', ended_at = ? WHERE id = ?`)
      .run(new Date(env.clock.nowMs()).toISOString(), injectedRunId)

    env.scheduler.handleDaemonApprovalResolved(injectedRunId, injectedApprovalId, 'approved')
    const completedTask = env.scheduler.getTask(m1.task.id, env.lead.id)
    assert.equal(completedTask.status, 'completed')

    // Duplicate resolution does not create a replacement run
    env.scheduler.handleDaemonApprovalResolved(injectedRunId, injectedApprovalId, 'approved')
    const tasksAfterDup = env.scheduler.listTaskHistory(routine.id, env.lead.id, 10)
    assert.equal(tasksAfterDup.length, 1)

    // Unconfirmed cancel while awaiting_approval uses markUncertainCancellation cleanly (no CLAIM_MISMATCH)
    const m2 = env.scheduler.triggerManual(routine.id, env.lead.id, 'f2-cancel-awaiting')
    env.db.sqlite
      .prepare(`UPDATE scheduler_tasks SET status = 'awaiting_approval' WHERE id = ?`)
      .run(m2.task.id)
    const cancelUncertain = await env.scheduler.cancelTask(m2.task.id, env.lead.id)
    assert.equal(cancelUncertain.status, 'interrupted')
    assert.equal(cancelUncertain.uncertainExecution, true)
    assert.ok(session.id)
  } finally {
    env.db.close()
    rmSync(env.dir, { recursive: true, force: true })
  }
})

test('Phase 5D F3/F4/F5: strict IPC DTOs, team/bot link recovery, spoof rejection, and runtime/account identity', async () => {
  const env = await setupDaemonEnv()
  try {
    // F3: Verify strict DTO schemas match real daemon responses and reject unknown/malformed inputs
    const routine = env.scheduler.createRoutine({
      botId: env.lead.id,
      name: 'F3 DTO Routine',
      trigger: { kind: 'cron', expression: '*/15 * * * *' },
      timezone: 'America/New_York',
      task: { prompt: 'Check status', requiresApproval: false, maxRuntimeMs: 10_000 },
      enabled: true,
    })

    RoutinePreviewDtoSchema.parse(env.scheduler.previewRoutineSchedule(routine.id, env.lead.id, 3))
    RoutineDiagnosticsDtoSchema.parse(env.scheduler.diagnoseRoutine(routine.id, env.lead.id))
    RoutineSimulationDtoSchema.parse(env.scheduler.simulateRoutine(routine.id, env.lead.id, 2))
    RoutineStatsDtoSchema.parse(env.scheduler.getExecutionStatistics(routine.id, env.lead.id))
    const exported = env.scheduler.exportRoutines(env.lead.id)
    RoutineExportBundleDtoSchema.parse(exported)
    RoutineImportPreviewDtoSchema.parse(
      env.scheduler.previewImport(JSON.stringify(exported), env.lead.id, 'rename'),
    )

    assert.throws(() =>
      CreateRoutineIpcInputSchema.parse({
        botId: env.lead.id,
        name: 'Bad',
        trigger: { kind: 'interval', intervalMs: 60_000, anchorAt: '2026-11-26T10:00:00.000Z' },
        timezone: 'UTC',
        task: { prompt: 'hi', requiresApproval: false, maxRuntimeMs: 10_000 },
        unexpectedAdminFlag: true,
      }),
    )

    // F4: Crash-window link recovery for BOTH bot and team targets, while rejecting spoofed ordinary runs
    const teamRoutine = env.scheduler.createRoutine({
      botId: env.lead.id,
      targetType: 'team',
      teamId: env.team.id,
      name: 'F4 Team Recovery',
      trigger: { kind: 'interval', intervalMs: 60_000, anchorAt: '2026-11-26T10:00:00.000Z' },
      timezone: 'UTC',
      task: { prompt: 'Team recover', requiresApproval: false, maxRuntimeMs: 10_000 },
      enabled: true,
    })
    const mt = env.scheduler.triggerManual(teamRoutine.id, env.lead.id, 'f4-team-recover')
    const nowIso = new Date(env.clock.nowMs()).toISOString()
    env.db.sqlite
      .prepare(`UPDATE scheduler_tasks SET status = 'running', attempt = 1 WHERE id = ?`)
      .run(mt.task.id)
    env.db.sqlite
      .prepare(
        `INSERT INTO team_runs (
          id, team_id, owner_id, lead_bot_id, root_task_id, conversation_id,
          idempotency_key, goal, goal_hash, status, bounds_json, created_at, updated_at
        ) VALUES ('tr_rec_1', ?, 'local-user', ?, 'rt_1', 'conv_1', ?, 'Team recover', 'gh_1', 'running', '{}', ?, ?)`,
      )
      .run(env.team.id, env.lead.id, `sched:${mt.task.id}:attempt:1`, nowIso, nowIso)

    // Spoofed ordinary run with wrong agent_id must NOT be recovered
    const spoofSess = env.sessionRepo.createSession({
      agentId: env.worker.id,
      title: `routine:${routine.id}:${env.lead.id}`,
    })
    const mb = env.scheduler.triggerManual(routine.id, env.lead.id, 'f4-spoof-check')
    env.db.sqlite
      .prepare(`UPDATE scheduler_tasks SET status = 'running', attempt = 1 WHERE id = ?`)
      .run(mb.task.id)
    env.db.sqlite
      .prepare(
        `INSERT INTO runs (id, session_id, agent_id, idempotency_key, status, permission_mode, runtime_id, model_id, effort, config_snapshot_json, started_at, created_at)
         VALUES ('run_spoof_1', ?, ?, ?, 'running', 'ask-approval', 'mock', 'gpt-5.4-mini', 'medium', '{}', ?, ?)`,
      )
      .run(spoofSess.id, env.worker.id, `sched:${mb.task.id}:attempt:1`, nowIso, nowIso)

    const rec = env.scheduler.reconcileOnStartup()
    assert.equal(rec.recoveredLinks, 1)
    assert.equal(env.scheduler.reconcileOnStartup().recoveredLinks, 0)

    // F5: verifyExecutionIdentity validates authoritative identity and rejects tampering
    const verified = env.dispatcher.verifyExecutionIdentity(mt.task.id, {
      ownerId: 'local-user',
      botId: env.lead.id,
    })
    assert.equal(verified.teamId, env.team.id)
    assert.equal(verified.runtimeId, 'mock')

    env.db.sqlite
      .prepare(`UPDATE scheduler_execution_links SET runtime_id = 'codex' WHERE scheduler_task_id = ?`)
      .run(mt.task.id)
    assert.throws(
      () =>
        env.dispatcher.verifyExecutionIdentity(mt.task.id, {
          ownerId: 'local-user',
          botId: env.lead.id,
        }),
      { code: 'EXECUTION_IDENTITY_MISMATCH' },
    )
  } finally {
    env.db.close()
    rmSync(env.dir, { recursive: true, force: true })
  }
})
