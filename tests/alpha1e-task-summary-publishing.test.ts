import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openGhostBotDatabase } from '../apps/daemon/src/db/client.ts'
import { seedInitialBotsIfNeeded } from '../apps/daemon/src/db/seed.ts'
import { BotRepository } from '../apps/daemon/src/bots/repository.ts'
import { RunOrchestrator } from '../apps/daemon/src/execution/orchestrator.ts'
import { RuntimePolicyBroker } from '../apps/daemon/src/runtime/policy-broker.ts'
import { RuntimeRegistry } from '../apps/daemon/src/runtime/registry.ts'
import { SessionRepository } from '../apps/daemon/src/sessions/repository.ts'
import { SettingsRepository } from '../apps/daemon/src/settings/repository.ts'
import { TeamDiscussion } from '../apps/daemon/src/teams/discussion.ts'
import { TeamsExecutionBridge } from '../apps/daemon/src/teams/execution-bridge.ts'
import { TeamMemberRoutingService } from '../apps/daemon/src/teams/member-routing.ts'
import { PrivateTaskChatService } from '../apps/daemon/src/teams/private-tasks.ts'
import { TeamsService } from '../apps/daemon/src/teams/service.ts'

async function createFixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'ghost-bot-alpha1e-unit-'))
  const db = await openGhostBotDatabase(dataDir)
  seedInitialBotsIfNeeded(db)
  const botRepo = new BotRepository(db)
  const settingsRepo = new SettingsRepository(db)
  const sessionRepo = new SessionRepository(db)
  const registry = new RuntimeRegistry({ runtimeMode: 'mock' })
  const policyBroker = new RuntimePolicyBroker()
  const orchestrator = new RunOrchestrator(db, {
    runtimeRegistry: registry,
    settingsRepo,
  })
  const routing = new TeamMemberRoutingService(db, botRepo, () => registry.getTeamRoutingCatalogs())
  const bridge = new TeamsExecutionBridge({
    dbHandle: db,
    botRepo,
    sessionRepo,
    orchestrator,
    policyBroker,
    memberRouting: routing,
    getRuntimeGeneration: () => registry.getGeneration(),
    getRuntimeState: () => ({
      runtimeMode: 'mock',
      codexVersion: null,
      authMethod: 'none',
      accountId: null,
    }),
  })
  const teams = new TeamsService(db, botRepo, bridge)
  const discussion = new TeamDiscussion(db, teams, routing, registry)
  const privateTasks = new PrivateTaskChatService(
    db,
    teams,
    routing,
    sessionRepo,
    () => true,
  )
  const team = teams.createTeam({
    name: 'Summary Team',
    leadBotId: 'chief',
    memberBotIds: ['chief', 'developer'],
  })
  const otherTeam = teams.createTeam({
    name: 'Other Team',
    leadBotId: 'chief',
    memberBotIds: ['chief', 'researcher'],
  })
  return { dataDir, db, teams, discussion, privateTasks, team, otherTeam, routing }
}

test('Alpha.1E summary: durable idempotent summary, truthful status, secret redaction, and group scoping', async () => {
  const fx = await createFixture()
  try {
    const delegated = await fx.privateTasks.delegate({
      teamId: fx.team.id,
      assignedBotId: 'developer',
      objective: 'Check sk-secret1234567890abcdef1234567890abcd handling',
      operationId: '00000000-0000-4000-8000-000000000201',
    })

    // Wait for completion + durable summary publication
    for (let i = 0; i < 60; i++) {
      const run = fx.teams.getTeamRun(delegated.teamRunId)
      const turns = fx.discussion.list({ teamId: fx.team.id }).turns
      if (run.status === 'completed' && turns.some((t) => t.taskSummary?.teamRunId === delegated.teamRunId)) {
        break
      }
      await new Promise((r) => setTimeout(r, 30))
    }

    // Idempotent re-publish / reconcile never creates duplicate summaries
    assert.equal(fx.privateTasks.publishTerminalSummaryIfNeeded(delegated.teamRunId), false)
    assert.equal(fx.privateTasks.reconcileTerminalSummaries(), 0)

    const turns = fx.discussion.list({ teamId: fx.team.id }).turns
    const summaryTurns = turns.filter((t) => t.taskSummary?.teamRunId === delegated.teamRunId)
    assert.equal(summaryTurns.length, 1)
    const summary = summaryTurns[0]!
    assert.equal(summary.taskSummary?.status, 'completed')
    assert.equal(summary.taskSummary?.sessionId, delegated.sessionId)
    // Secret redacted & bounded
    assert.equal(summary.replies[0]!.text.includes('sk-secret1234567890'), false)
    assert.equal(summary.taskSummary?.objective.includes('sk-secret1234567890'), false)
    assert.ok(summary.replies[0]!.text.length <= 1200)
    // Scoped only to originating team
    assert.equal(fx.discussion.list({ teamId: fx.otherTeam.id }).turns.length, 0)

    // Uncertain task after restart reconciliation publishes truthful uncertain summary
    const inFlight = await fx.privateTasks.delegate({
      teamId: fx.team.id,
      assignedBotId: 'chief',
      objective: 'Interrupted job',
      operationId: '00000000-0000-4000-8000-000000000202',
    })
    for (let i = 0; i < 60; i++) {
      if (fx.teams.getTeamRun(inFlight.teamRunId).status === 'completed') break
      await new Promise((r) => setTimeout(r, 30))
    }
    fx.db.sqlite.prepare(`UPDATE team_tasks SET status = 'uncertain', error_message = 'Bearer tok_secret_xyz_123456' WHERE team_run_id = ?`).run(inFlight.teamRunId)
    assert.equal(fx.privateTasks.publishTerminalSummaryIfNeeded(inFlight.teamRunId), true)
    assert.equal(fx.privateTasks.publishTerminalSummaryIfNeeded(inFlight.teamRunId), false)

    const updatedTurns = fx.discussion.list({ teamId: fx.team.id }).turns
    const uncertainTurn = updatedTurns.find((t) => t.taskSummary?.teamRunId === inFlight.teamRunId && t.taskSummary?.status === 'uncertain')
    assert.ok(uncertainTurn)
    assert.ok(uncertainTurn.replies[0]!.text.includes('uncertain'))
    assert.equal(uncertainTurn.replies[0]!.text.includes('tok_secret_xyz_123456'), false)
  } finally {
    fx.db.close()
    await rm(fx.dataDir, { recursive: true, force: true })
  }
})

test('original TASK-01 and TASK-02 bind a delegation before dispatch and roll back interrupted creation', async () => {
  const fx = await createFixture()
  try {
    const input = {
      teamId: fx.team.id, assignedBotId: 'developer', objective: 'Approved private objective',
      operationId: '00000000-0000-4000-8000-000000000221',
    }
    const execute = fx.teams.executeTeamRunToCompletion.bind(fx.teams)
    let launchCount = 0
    fx.teams.executeTeamRunToCompletion = async (runId) => {
      launchCount++
      return fx.teams.getAggregateUsage(runId)
    }
    fx.db.sqlite.exec(`CREATE TRIGGER fail_private_meta BEFORE INSERT ON settings
      WHEN NEW.key LIKE 'teams.private-task-meta:%' BEGIN SELECT RAISE(ABORT, 'fixture interruption'); END`)
    await assert.rejects(fx.privateTasks.delegate(input), /fixture interruption/)
    assert.equal(launchCount, 0)
    for (const table of ['team_runs', 'team_tasks', 'sessions', 'runs']) {
      assert.equal(fx.db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n, 0)
    }
    fx.db.sqlite.exec('DROP TRIGGER fail_private_meta')
    const clean = await fx.privateTasks.delegate(input)
    assert.equal((await fx.privateTasks.delegate(input)).sessionId, clean.sessionId)
    assert.equal(launchCount, 1)

    await fx.routing.set({ teamId: fx.team.id, botId: 'developer', override: { modelId: 'codex-mock', effort: 'high' } })
    await execute(clean.teamRunId)
    const result = fx.privateTasks.list({ teamId: fx.team.id }).tasks[0]
    assert.equal(result.status, 'failed')
    assert.equal(result.sessionId, clean.sessionId)
    assert.equal(result.daemonRunId, null)
    assert.equal(fx.db.sqlite.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n, 0)

    const interrupted = await fx.privateTasks.delegate({
      ...input, operationId: '00000000-0000-4000-8000-000000000222',
    })
    fx.teams.reconcileOnStartup()
    assert.equal(fx.privateTasks.list({ teamId: fx.team.id }).tasks.find((row) => row.taskId === interrupted.taskId)?.status, 'uncertain')
    await fx.privateTasks.delegate({ ...input, operationId: '00000000-0000-4000-8000-000000000222' })
    assert.equal(launchCount, 2)
  } finally {
    fx.db.close()
    await rm(fx.dataDir, { recursive: true, force: true })
  }
})

test('original TASK-03 and TASK-04 require exact identity and never acknowledge uncertain termination', async () => {
  const fx = await createFixture()
  try {
    const ordinary = await fx.teams.startTeamRun({ teamId: fx.team.id, goal: 'Ordinary', idempotencyKey: 'ordinary' })
    await assert.rejects(fx.privateTasks.cancel({ teamId: fx.team.id, teamRunId: ordinary.run.id, taskId: ordinary.tasks[0].id }), /does not belong/)
    fx.teams.executeTeamRunToCompletion = async (id) => fx.teams.getAggregateUsage(id)
    const task = await fx.privateTasks.delegate({
      teamId: fx.team.id, assignedBotId: 'chief', objective: 'Cancel fixture',
      operationId: '00000000-0000-4000-8000-000000000223',
    })
    await assert.rejects(fx.privateTasks.cancel({ teamId: fx.team.id, teamRunId: task.teamRunId, taskId: ordinary.tasks[0].id }), /does not belong/)
    fx.teams.cancelTeamRun = async (id) => {
      fx.db.sqlite.prepare("UPDATE team_runs SET status = 'uncertain' WHERE id = ?").run(id)
      return { run: fx.teams.getTeamRun(id), stoppedChildrenCount: 0, uncertainCount: 1 }
    }
    const key = { teamId: task.teamId, teamRunId: task.teamRunId, taskId: task.taskId }
    assert.equal((await fx.privateTasks.cancel(key)).cancelled, false)
    assert.equal((await fx.privateTasks.cancel(key)).cancelled, false)
  } finally {
    fx.db.close()
    await rm(fx.dataDir, { recursive: true, force: true })
  }
})

test('summary omits unrelated output when the exact execution link is absent', async () => {
  const fx = await createFixture()
  try {
    fx.teams.executeTeamRunToCompletion = async (id) => fx.teams.getAggregateUsage(id)
    const task = await fx.privateTasks.delegate({
      teamId: fx.team.id, assignedBotId: 'chief', objective: 'Output fixture',
      operationId: '00000000-0000-4000-8000-000000000224',
    })
    fx.db.sqlite.prepare("UPDATE team_tasks SET status = 'completed' WHERE id = ?").run(task.taskId)
    fx.db.sqlite.prepare(`INSERT INTO messages(id, session_id, role, content_json, seq_order, status, created_at, updated_at)
      VALUES ('unrelated', ?, 'assistant', '{"text":"UNRELATED PRIVATE TEXT"}', 1, 'complete', 'now', 'now')`).run(task.sessionId)
    assert.equal(fx.privateTasks.publishTerminalSummaryIfNeeded(task.teamRunId), true)
    const summary = fx.discussion.list({ teamId: fx.team.id }).turns[0]
    assert.match(summary.replies[0].text, /no assistant text output/)
    assert.doesNotMatch(summary.replies[0].text, /UNRELATED PRIVATE TEXT/)
  } finally {
    fx.db.close()
    await rm(fx.dataDir, { recursive: true, force: true })
  }
})
