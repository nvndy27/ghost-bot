import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { BotRepository } from '../apps/daemon/src/bots/repository.ts'
import { openGhostBotDatabase } from '../apps/daemon/src/db/client.ts'
import { seedInitialBotsIfNeeded } from '../apps/daemon/src/db/seed.ts'
import { RunOrchestrator } from '../apps/daemon/src/execution/orchestrator.ts'
import { RuntimePolicyBroker } from '../apps/daemon/src/runtime/policy-broker.ts'
import { RuntimeRegistry } from '../apps/daemon/src/runtime/registry.ts'
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

async function setupHarness(runtimeMode: 'mock' | 'codex' = 'mock') {
  const dir = makeTempDir('ghost-4d3-accept-')
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
  const bridge = new TeamsExecutionBridge({
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
  const teams = new TeamsService(db, bots, bridge)
  const botList = bots.listBots().bots
  return { dir, db, bots, botList, sessionRepo, teams, bridge, orchestrator }
}

describe('Phase 4D.3 Final Teams Production Acceptance', () => {
  it('enforces cross-team isolation, explicit-only memory sharing, idempotency, and member removal', async () => {
    const { db, botList, teams, bridge } = await setupHarness('mock')
    try {
      const lead = botList[0]!
      const worker = botList[1] ?? lead
      const teamA = teams.createTeam({
        name: 'Team Alpha',
        leadBotId: lead.id,
        memberBotIds: [lead.id, worker.id],
      })
      const teamB = teams.createTeam({
        name: 'Team Beta',
        leadBotId: lead.id,
        memberBotIds: [lead.id],
      })
      assert.equal(teamA.memorySharingPolicy, 'explicit-only')
      assert.equal(teamB.memorySharingPolicy, 'explicit-only')

      // Duplicate idempotencyKey returns existing run without creating a duplicate
      const first = await teams.startTeamRun({
        teamId: teamA.id,
        goal: 'Idempotent run',
        idempotencyKey: 'idem-4d3-1',
      })
      const second = await teams.startTeamRun({
        teamId: teamA.id,
        goal: 'Idempotent run',
        idempotencyKey: 'idem-4d3-1',
      })
      assert.equal(second.created, false)
      assert.equal(second.run.id, first.run.id)

      // Cross-team message isolation: Team B cannot see Team A messages
      const msgsA = teams.listMessages(teamA.id, { teamRunId: first.run.id })
      const msgsB = teams.listMessages(teamB.id)
      assert.ok(msgsA.length > 0)
      assert.equal(msgsB.length, 0)

      // Member removal revalidation at dispatch boundary
      teams.updateTeamMembers(teamA.id, [lead.id])
      const outcome = await bridge.dispatch({
        teamId: teamA.id,
        teamRunId: first.run.id,
        taskId: 'task-removed-member',
        ownerId: 'local-user',
        assignedBotId: worker.id,
        prompt: 'Should be rejected',
        attempt: 1,
        depth: 1,
        remainingDurationMs: 5000,
        remainingTokenBudget: 500,
      })
      assert.equal(outcome.status, 'failed')
      assert.equal(outcome.code, 'MEMBER_REMOVED')
    } finally {
      db.close()
    }
  })

  it('enforces worker approval lifecycle: approve, deny, duplicate rejection, expiry, and cancellation', async () => {
    const { db, botList, sessionRepo, teams, orchestrator } = await setupHarness('mock')
    try {
      const lead = botList[0]!
      const worker = botList[1] ?? lead
      const team = teams.createTeam({
        name: 'Approval Squad',
        leadBotId: lead.id,
        memberBotIds: [lead.id, worker.id],
      })

      const started = await teams.startTeamRun({
        teamId: team.id,
        goal: 'Approval lifecycle test',
        idempotencyKey: 'approval-4d3-1',
        plan: {
          summary: 'Single worker task',
          tasks: [{ planKey: 'worker_op', assignedBotId: worker.id, prompt: 'Run gated op' }],
        },
      })
      const tasks = teams.listRunTasks(started.run.id)
      const workerTask = tasks.find((t) => t.planKey === 'worker_op')!
      const session = sessionRepo.createSession({
        agentId: worker.id,
        title: `team:${started.run.id}:${worker.id}`,
      })
      const childRun = await orchestrator.startRun({
        sessionId: session.id,
        text: 'Run gated op',
        idempotencyKey: `team:${workerTask.id}:attempt:1`,
      })
      db.sqlite
        .prepare(
          `INSERT INTO team_execution_links (
            id, team_run_id, team_task_id, agent_id, session_id, daemon_run_id,
            runtime_id, account_id, attempt, role, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'mock', 'local', 1, 'worker', ?)`,
        )
        .run(
          'texec_app_test',
          started.run.id,
          workerTask.id,
          worker.id,
          session.id,
          childRun.run.id,
          new Date().toISOString(),
        )

      // Wait for mock child run to settle, then put run in awaiting_approval for deterministic approval testing
      for (let i = 0; i < 30; i += 1) {
        const r = orchestrator.getRun(childRun.run.id)
        if (r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled') break
        await new Promise((res) => setTimeout(res, 20))
      }
      db.sqlite
        .prepare(`UPDATE runs SET status = 'awaiting_approval', ended_at = NULL WHERE id = ?`)
        .run(childRun.run.id)

      const now = new Date().toISOString()
      const future = new Date(Date.now() + 60_000).toISOString()
      const past = new Date(Date.now() - 60_000).toISOString()

      // Pending approval 1 (approve once + duplicate rejection)
      db.sqlite
        .prepare(
          `INSERT INTO approvals (
            id, run_id, session_id, agent_id, runtime_generation, account_id,
            action_type, action_summary, args_json, args_hash, permission_mode,
            status, created_at, expires_at
          ) VALUES (?, ?, ?, ?, 1, 'local', 'command', 'ls -la', '{}', 'hash1', 'ask-approval', 'pending', ?, ?)`,
        )
        .run('app_1', childRun.run.id, session.id, worker.id, now, future)

      // Pending approval 2 (expired)
      db.sqlite
        .prepare(
          `INSERT INTO approvals (
            id, run_id, session_id, agent_id, runtime_generation, account_id,
            action_type, action_summary, args_json, args_hash, permission_mode,
            status, created_at, expires_at
          ) VALUES (?, ?, ?, ?, 1, 'local', 'command', 'rm -rf /tmp/x', '{}', 'hash2', 'ask-approval', 'pending', ?, ?)`,
        )
        .run('app_exp', childRun.run.id, session.id, worker.id, now, past)

      const pending = teams.listPendingApprovalsForRun(started.run.id)
      assert.equal(pending.length, 2)
      assert.equal(pending[0]?.workerBotId, worker.id)
      assert.equal(pending[0]?.daemonRunId, childRun.run.id)

      // Approve once succeeds
      await orchestrator.resolveApproval(childRun.run.id, 'app_1', 'approved', 'hash1')
      // Duplicate approval submission fails closed
      await assert.rejects(() =>
        orchestrator.resolveApproval(childRun.run.id, 'app_1', 'approved', 'hash1'),
      )
      // Expired approval fails closed
      await assert.rejects(() =>
        orchestrator.resolveApproval(childRun.run.id, 'app_exp', 'approved', 'hash2'),
      )

      // Cancel team run preserves deterministic terminal state
      const cancelled = await teams.cancelTeamRun(started.run.id)
      assert.ok(cancelled.run.status === 'cancelled' || cancelled.run.status === 'cancelling')
    } finally {
      db.close()
    }
  })

  it('recovers crash-window orphan team_execution_links and reconciles restart idempotently without replay', async () => {
    const { dir, db, botList, sessionRepo, teams, orchestrator } = await setupHarness('mock')
    let teamRunId = ''
    let orphanDaemonRunId = ''
    try {
      const lead = botList[0]!
      const worker = botList[1] ?? lead
      const team = teams.createTeam({
        name: 'Crash Recovery Squad',
        leadBotId: lead.id,
        memberBotIds: [lead.id, worker.id],
      })
      const started = await teams.startTeamRun({
        teamId: team.id,
        goal: 'Simulate crash before link insert',
        idempotencyKey: 'crash-4d3-1',
        plan: {
          summary: 'Crash test',
          tasks: [{ planKey: 'crash_task', assignedBotId: worker.id, prompt: 'Do work' }],
        },
      })
      teamRunId = started.run.id
      const tasks = teams.listRunTasks(teamRunId)
      const crashTask = tasks.find((t) => t.planKey === 'crash_task')!

      // Simulate active task + active daemon run with MISSING team_execution_links row (crash window)
      db.sqlite
        .prepare(`UPDATE team_runs SET status = 'running' WHERE id = ?`)
        .run(teamRunId)
      db.sqlite
        .prepare(`UPDATE team_tasks SET status = 'running' WHERE id = ?`)
        .run(crashTask.id)

      const session = sessionRepo.createSession({
        agentId: worker.id,
        title: `team:${teamRunId}:${worker.id}`,
      })
      const child = await orchestrator.startRun({
        sessionId: session.id,
        text: 'Do work',
        idempotencyKey: `team:${crashTask.id}:attempt:1`,
      })
      orphanDaemonRunId = child.run.id
      for (let i = 0; i < 30; i += 1) {
        const r = orchestrator.getRun(orphanDaemonRunId)
        if (r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled') break
        await new Promise((res) => setTimeout(res, 20))
      }
      db.sqlite
        .prepare(`UPDATE runs SET status = 'running', ended_at = NULL WHERE id = ?`)
        .run(orphanDaemonRunId)
      // Ensure link is NOT present
      db.sqlite.prepare(`DELETE FROM team_execution_links WHERE daemon_run_id = ?`).run(orphanDaemonRunId)
    } finally {
      db.close()
    }

    // Reopen database & run startup reconciliation twice (repeated startup reconciliation)
    const db2 = await openGhostBotDatabase(dir)
    try {
      const bots2 = new BotRepository(db2)
      const settings2 = new SettingsRepository(db2)
      const sessions2 = new SessionRepository(db2)
      const orch2 = new RunOrchestrator(db2, {
        runtimeRegistry: new RuntimeRegistry('mock'),
        settingsRepo: settings2,
      })
      const bridge2 = new TeamsExecutionBridge({
        dbHandle: db2,
        botRepo: bots2,
        sessionRepo: sessions2,
        orchestrator: orch2,
        policyBroker: new RuntimePolicyBroker(),
        getRuntimeState: () => ({
          runtimeMode: 'mock',
          codexVersion: null,
          authMethod: 'none',
          accountId: null,
        }),
      })
      const teams2 = new TeamsService(db2, bots2, bridge2)

      const rec1 = teams2.reconcileOnStartup()
      assert.equal(rec1.recoveredLinks, 1)
      assert.ok(rec1.runsMarkedUncertain >= 1)
      assert.ok(rec1.tasksMarkedUncertain >= 1)

      const linkRow = db2.sqlite
        .prepare(`SELECT daemon_run_id FROM team_execution_links WHERE daemon_run_id = ?`)
        .get(orphanDaemonRunId) as { daemon_run_id: string } | undefined
      assert.equal(linkRow?.daemon_run_id, orphanDaemonRunId)

      const runAfter = teams2.getTeamRun(teamRunId)
      assert.equal(runAfter.status, 'uncertain')

      // Second startup reconciliation is idempotent (0 additional changes)
      const rec2 = teams2.reconcileOnStartup()
      assert.equal(rec2.recoveredLinks, 0)
      assert.equal(rec2.runsMarkedUncertain, 0)
      assert.equal(rec2.tasksMarkedUncertain, 0)
    } finally {
      db2.close()
    }
  })
})
