import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, it } from 'node:test'
import {
  CreateRoutineIpcInputSchema,
  ListRoutinesIpcInputSchema,
} from '../packages/shared-types/ipc.ts'
import { ExecutionQueue } from '../packages/scheduler/src/queue/execution-queue.ts'
import { createBorrowedSchedulerDatabaseHandle } from '../packages/scheduler/src/repository/sqlite-store.ts'
import { BotRepository } from '../apps/daemon/src/bots/repository.ts'
import { openGhostBotDatabase } from '../apps/daemon/src/db/client.ts'
import { MIGRATIONS, runMigrations } from '../apps/daemon/src/db/migrations.ts'
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

async function setupHarness(options: { runtimeMode?: 'mock' | 'codex'; nowMs?: number } = {}) {
  const runtimeMode = options.runtimeMode ?? 'mock'
  let currentNowMs = options.nowMs ?? Date.parse('2026-11-26T12:00:00.000Z')
  const clock = {
    nowMs: () => currentNowMs,
    advance: (ms: number) => {
      currentNowMs += ms
    },
    set: (ms: number) => {
      currentNowMs = ms
    },
  }

  const dir = makeTempDir('ghost-5b-sched-')
  const db = await openGhostBotDatabase(dir)
  seedInitialBotsIfNeeded(db)
  const bots = new BotRepository(db)
  const settingsRepo = new SettingsRepository(db)
  const sessionRepo = new SessionRepository(db)
  const runtimeRegistry = new RuntimeRegistry(runtimeMode)
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
      runtimeMode,
      codexVersion: null,
      authMethod: 'none',
      accountId: null,
    }),
    pollIntervalMs: 15,
  })
  const teamsService = new TeamsService(db, bots, teamsBridge)
  const scheduler = new SchedulerService(db, bots, teamsService, {
    clock,
    tickIntervalMs: 100,
  })
  const dispatcher = new DaemonRoutineDispatcher({
    dbHandle: db,
    botRepo: bots,
    sessionRepo,
    orchestrator,
    policyBroker,
    teamsService,
    approvalCoordinator: scheduler.approvals,
    getRuntimeState: () => ({
      runtimeMode,
      codexVersion: null,
      authMethod: 'none',
      accountId: null,
    }),
    pollIntervalMs: 15,
  })
  scheduler.attachDispatcher(dispatcher)
  const botList = bots.listBots().bots
  return {
    dir,
    db,
    clock,
    bots,
    botList,
    sessionRepo,
    orchestrator,
    teamsService,
    scheduler,
    dispatcher,
  }
}

describe('Phase 5B Production Scheduler & Routines Daemon Integration', () => {
  it('upgrades a v9 database to 0010_scheduler_routines preserving legacy data and FK integrity', async () => {
    const dir = makeTempDir('ghost-5b-v9-')
    const dbPath = path.join(dir, 'ghost-bot.sqlite')
    const raw = new DatabaseSync(dbPath)
    raw.exec('PRAGMA foreign_keys = ON;')
    raw.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);`,
    )
    for (const m of MIGRATIONS.filter((x) => x.version <= 9)) {
      if (m.version === 2) raw.exec('PRAGMA foreign_keys = OFF;')
      raw.exec(m.sql)
      if (m.version === 2) raw.exec('PRAGMA foreign_keys = ON;')
      raw.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        '2026-11-26T00:00:00.000Z',
      )
    }
    const now = '2026-11-26T00:00:00.000Z'
    raw
      .prepare(
        `INSERT INTO agents (id, name, description, avatar_json, instructions, runtime_id, model_id, effort, workspace_path, permission_mode, created_at, updated_at)
         VALUES ('bot_v9', 'Legacy Bot', '', '{}', '', 'mock', 'mock-model', 'medium', ?, 'read-only', ?, ?)`,
      )
      .run(dir, now, now)
    raw.close()

    const dbHandle = await openGhostBotDatabase(dir)
    try {
      const ver = dbHandle.sqlite
        .prepare('SELECT MAX(version) AS ver FROM schema_migrations')
        .get() as { ver: number }
      assert.equal(Number(ver.ver), 10)
      assert.equal(runMigrations(dbHandle.sqlite), 0)
      const fkViolations = dbHandle.sqlite.prepare('PRAGMA foreign_key_check').all()
      assert.equal(fkViolations.length, 0)
      const botRow = dbHandle.sqlite.prepare(`SELECT id FROM agents WHERE id = 'bot_v9'`).get() as
        | { id: string }
        | undefined
      assert.equal(botRow?.id, 'bot_v9')
    } finally {
      dbHandle.close()
    }
  })

  it('executes bot-targeted and team-targeted routines in mock mode, emits notifications, and excludes OpenClaw', async () => {
    const { db, clock, botList, teamsService, scheduler } = await setupHarness({
      runtimeMode: 'mock',
      nowMs: Date.parse('2026-11-26T12:00:00.000Z'),
    })
    try {
      const lead = botList[0]!
      const worker = botList[1] ?? lead
      const team = teamsService.createTeam({
        name: 'Sched Team',
        leadBotId: lead.id,
        memberBotIds: [lead.id, worker.id],
      })

      // 1. Bot-targeted interval routine
      const botRoutine = scheduler.createRoutine({
        name: 'Bot Interval Check',
        botId: lead.id,
        targetType: 'bot',
        trigger: { kind: 'interval', intervalMs: 60_000 },
        timezone: 'UTC',
        task: { prompt: 'Check daily notes' },
        enabled: true,
      })

      // 2. Team-targeted routine
      const teamRoutine = scheduler.createRoutine({
        name: 'Team Goal Routine',
        botId: lead.id,
        targetType: 'team',
        teamId: team.id,
        trigger: { kind: 'interval', intervalMs: 60_000 },
        timezone: 'UTC',
        task: { prompt: 'Coordinate team summary', kind: 'team_goal' },
        enabled: true,
      })

      // 3. OpenClaw-owned routine must be excluded
      const openclawRoutine = scheduler.createRoutine({
        name: 'OpenClaw External',
        botId: lead.id,
        ownership: 'openclaw',
        trigger: { kind: 'interval', intervalMs: 60_000 },
        timezone: 'UTC',
        task: { prompt: 'Should never run in ghost-bot' },
        enabled: true,
      })

      // Advance clock past first interval and run cycle
      clock.advance(65_000)
      const cycle = await scheduler.runCycle()
      assert.equal(cycle.tick.enqueuedTasks, 2)
      assert.equal(cycle.dispatched, 2)

      const botHistory = scheduler.listTaskHistory(botRoutine.id, lead.id)
      assert.equal(botHistory.length, 1)
      assert.equal(botHistory[0]?.status, 'completed')

      const teamHistory = scheduler.listTaskHistory(teamRoutine.id, lead.id)
      assert.equal(teamHistory.length, 1)
      assert.equal(teamHistory[0]?.status, 'completed')

      const ocHistory = scheduler.listTaskHistory(openclawRoutine.id, lead.id)
      assert.equal(ocHistory.length, 0)

      // Verify notifications persisted and unread count works
      const notifs = scheduler.listNotifications(lead.id)
      assert.ok(notifs.length >= 2)
      assert.ok(scheduler.getUnreadNotificationCount(lead.id) >= 2)
      scheduler.markNotificationRead(notifs[0]!.id, lead.id)
      scheduler.dismissNotification(notifs[0]!.id, lead.id)

      // Clock rollback protection: moving clock backwards skips cycle cleanly
      clock.set(Date.parse('2026-11-26T11:00:00.000Z'))
      const rollbackCycle = await scheduler.runCycle()
      assert.equal(rollbackCycle.tick.evaluatedRoutines, 0)
      assert.equal(rollbackCycle.dispatched, 0)

      await scheduler.stopTimer()
    } finally {
      db.close()
    }
  })

  it('fails closed in live mode, enforces manual idempotency, revision races, and watermark occurrence semantics', async () => {
    const { db, clock, botList, scheduler, dispatcher } = await setupHarness({
      runtimeMode: 'codex',
      nowMs: Date.parse('2026-11-26T12:00:00.000Z'),
    })
    try {
      const lead = botList[0]!
      const routine = scheduler.createRoutine({
        name: 'Live Gated Routine',
        botId: lead.id,
        trigger: { kind: 'cron', expression: '*/5 * * * *' },
        timezone: 'America/New_York',
        task: { prompt: 'Run live check' },
        enabled: true,
      })

      // Manual trigger + idempotency
      const m1 = scheduler.triggerManual(routine.id, lead.id, 'idem-key-1')
      const m2 = scheduler.triggerManual(routine.id, lead.id, 'idem-key-1')
      assert.equal(m1.created, true)
      assert.equal(m2.created, false)
      assert.equal(m2.task.id, m1.task.id)

      // Revision change before manual key reuse causes IDEMPOTENCY_CONFLICT
      scheduler.updateRoutine(routine.id, lead.id, { description: 'rev 2' })
      assert.throws(() => scheduler.triggerManual(routine.id, lead.id, 'idem-key-1'))

      // Run cycle dispatches m1, detects STALE_ROUTINE_REVISION because routine updated after enqueue!
      await scheduler.runCycle()
      const t1 = scheduler.getTask(m1.task.id, lead.id)
      assert.equal(t1.status, 'failed')
      assert.equal(t1.errorCode, 'STALE_ROUTINE_REVISION')

      // Trigger at rev 2 and verify live mode fails closed with AUTONOMOUS_LIVE_EXECUTION_GATED
      const m3 = scheduler.triggerManual(routine.id, lead.id, 'idem-key-2')
      await scheduler.runCycle()
      const t3 = scheduler.getTask(m3.task.id, lead.id)
      assert.equal(t3.status, 'failed')
      assert.equal(t3.errorCode, 'AUTONOMOUS_LIVE_EXECUTION_GATED')

      // Verify pruneExpiredDedup uses scheduled_for for schedule/event and ignores manual keys
      const borrowed = createBorrowedSchedulerDatabaseHandle(db.sqlite, db.transaction.bind(db))
      const q = new ExecutionQueue(borrowed)
      db.sqlite
        .prepare(
          `INSERT INTO scheduler_occurrence_dedup (
            occurrence_key, routine_id, trigger_source, scheduled_for, payload_hash, created_at, expires_at
          ) VALUES ('occ_sched_1', ?, 'schedule', '2026-11-26T12:15:00.000Z', 'h1', '2026-11-26T12:00:00.000Z', '2026-11-26T12:05:00.000Z'),
                   ('occ_manual_1', ?, 'manual', '2026-11-26T13:00:00.000Z', 'h2', '2026-11-26T12:00:00.000Z', '2026-11-26T12:05:00.000Z')`,
        )
        .run(routine.id, routine.id)
      const pruned = q.pruneExpiredDedup({ nowIso: '2026-11-26T12:10:00.000Z' })
      assert.equal(pruned, 2)
      const wmRow = db.sqlite
        .prepare(`SELECT dedup_watermark_at FROM scheduler_routines WHERE id = ?`)
        .get(routine.id) as { dedup_watermark_at: string | null }
      assert.equal(wmRow.dedup_watermark_at, '2026-11-26T12:15:00.000Z')

      // Suppress unused warning
      assert.ok(clock.nowMs() > 0 && dispatcher)
    } finally {
      db.close()
    }
  })

  it('recovers crash-window scheduler_execution_links and rejects spoofed user sessions in both Teams & Scheduler', async () => {
    const { db, botList, sessionRepo, orchestrator, teamsService, scheduler, dispatcher } =
      await setupHarness({ runtimeMode: 'mock' })
    try {
      const lead = botList[0]!
      const routine = scheduler.createRoutine({
        name: 'Crash Recovery Routine',
        botId: lead.id,
        trigger: { kind: 'interval', intervalMs: 60_000 },
        timezone: 'UTC',
        task: { prompt: 'Run crash test' },
        enabled: true,
      })
      const trig = scheduler.triggerManual(routine.id, lead.id, 'crash-sched-1')
      // Simulate claimed/running task + child run before link insert
      db.sqlite
        .prepare(`UPDATE scheduler_tasks SET status = 'running', attempt = 1 WHERE id = ?`)
        .run(trig.task.id)
      const schedSession = sessionRepo.createSession({
        agentId: lead.id,
        title: `routine:${routine.id}:${lead.id}`,
      })
      const schedRun = await orchestrator.startRun({
        sessionId: schedSession.id,
        text: 'Run crash test',
        idempotencyKey: `sched:${trig.task.id}:attempt:1`,
      })
      for (let i = 0; i < 30; i += 1) {
        const r = orchestrator.getRun(schedRun.run.id)
        if (r.status === 'completed') break
        await new Promise((res) => setTimeout(res, 15))
      }
      db.sqlite
        .prepare(`UPDATE runs SET status = 'running', ended_at = NULL WHERE id = ?`)
        .run(schedRun.run.id)

      // Also create a SPOOFED user session/run trying to hijack a team task via prefix
      const team = teamsService.createTeam({
        name: 'Target Team',
        leadBotId: lead.id,
        memberBotIds: [lead.id],
      })
      const trun = await teamsService.startTeamRun({
        teamId: team.id,
        goal: 'Team task',
        idempotencyKey: 'spoof-check-1',
      })
      const tasks = teamsService.listRunTasks(trun.run.id)
      const spoofSess = sessionRepo.createSession({
        agentId: lead.id,
        title: `team:${trun.run.id}:${lead.id}`,
      })
      // Note: team task is in 'pending' (NOT running/queued/cancelling) and attempt 0 != 1
      const spoofRun = await orchestrator.startRun({
        sessionId: spoofSess.id,
        text: 'User spoof attempt',
        idempotencyKey: `team:${tasks[0]!.id}:attempt:1`,
      })
      for (let i = 0; i < 30; i += 1) {
        const r = orchestrator.getRun(spoofRun.run.id)
        if (r.status === 'completed') break
        await new Promise((res) => setTimeout(res, 15))
      }

      const teamRec = teamsService.reconcileOnStartup()
      assert.equal(teamRec.recoveredLinks, 0, 'Spoofed user run must NOT be linked to team task')

      const schedRec = scheduler.reconcileOnStartup()
      assert.equal(schedRec.recoveredLinks, 1)
      assert.equal(schedRec.interruptedTasks, 1)
      const linkRow = db.sqlite
        .prepare(`SELECT daemon_run_id FROM scheduler_execution_links WHERE scheduler_task_id = ?`)
        .get(trig.task.id) as { daemon_run_id: string } | undefined
      assert.equal(linkRow?.daemon_run_id, schedRun.run.id)
      assert.ok(dispatcher)
    } finally {
      db.close()
    }
  })

  it('enforces strict Zod IPC contracts on routine schemas', () => {
    const valid = CreateRoutineIpcInputSchema.safeParse({
      name: 'Valid Routine',
      botId: 'bot_chief_of_staff',
      trigger: { kind: 'daily', hour: 9, minute: 0 },
      task: { prompt: 'Summarize updates' },
    })
    assert.equal(valid.success, true)

    const unknownField = ListRoutinesIpcInputSchema.safeParse({
      botId: 'bot_chief_of_staff',
      unexpected: true,
    })
    assert.equal(unknownField.success, false)
  })
})
