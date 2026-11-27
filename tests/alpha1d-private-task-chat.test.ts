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
import { TeamsExecutionBridge } from '../apps/daemon/src/teams/execution-bridge.ts'
import { TeamMemberRoutingService } from '../apps/daemon/src/teams/member-routing.ts'
import { PrivateTaskChatService } from '../apps/daemon/src/teams/private-tasks.ts'
import { TeamsService } from '../apps/daemon/src/teams/service.ts'

async function createFixture(runtimeMode: 'mock' | 'codex' = 'mock') {
  const dataDir = await mkdtemp(join(tmpdir(), 'ghost-bot-alpha1d-unit-'))
  const db = await openGhostBotDatabase(dataDir)
  seedInitialBotsIfNeeded(db)
  const botRepo = new BotRepository(db)
  const settingsRepo = new SettingsRepository(db)
  const sessionRepo = new SessionRepository(db)
  const registry = new RuntimeRegistry({ runtimeMode })
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
      runtimeMode,
      codexVersion: null,
      authMethod: 'none',
      accountId: null,
    }),
  })
  const teams = new TeamsService(db, botRepo, bridge)
  const privateTasks = new PrivateTaskChatService(
    db,
    teams,
    routing,
    sessionRepo,
    () => runtimeMode === 'mock',
  )
  const team = teams.createTeam({
    name: 'Private Task Team',
    leadBotId: 'chief',
    memberBotIds: ['chief', 'developer'],
  })
  return { dataDir, db, sessionRepo, teams, privateTasks, team }
}

test('Alpha.1D delegates private task, isolates personal sessions, prevents duplicates, and persists across restart', async () => {
  const fx = await createFixture('mock')
  try {
    const personalSess = fx.sessionRepo.createSession({ agentId: 'developer', title: 'Personal Dev' })
    const opId = '00000000-0000-4000-8000-000000000101'

    const delegated = await fx.privateTasks.delegate({
      teamId: fx.team.id,
      assignedBotId: 'developer',
      objective: 'Review isolated module',
      operationId: opId,
    })

    assert.ok(delegated.sessionId)
    assert.notEqual(delegated.sessionId, personalSess.id)

    // Duplicate operationId returns same record without creating a second task
    const dup = await fx.privateTasks.delegate({
      teamId: fx.team.id,
      assignedBotId: 'developer',
      objective: 'Review isolated module',
      operationId: opId,
    })
    assert.equal(dup.teamRunId, delegated.teamRunId)

    // Conflicting objective on same operationId throws 409
    await assert.rejects(
      fx.privateTasks.delegate({
        teamId: fx.team.id,
        assignedBotId: 'developer',
        objective: 'Different objective',
        operationId: opId,
      }),
      /IDEMPOTENCY_CONFLICT|different bot or objective/,
    )

    // Wait for mock team run + task to complete cleanly
    let finalTask = delegated
    for (let i = 0; i < 60; i++) {
      const list = fx.privateTasks.list({ teamId: fx.team.id })
      const found = list.tasks.find((t) => t.teamRunId === delegated.teamRunId)
      const run = fx.teams.getTeamRun(delegated.teamRunId)
      if (found && found.status === 'completed' && run.status === 'completed') {
        finalTask = found
        break
      }
      await new Promise((r) => setTimeout(r, 30))
    }
    assert.equal(finalTask.status, 'completed')

    // Personal sessions list remains completely isolated from private task session
    const personalList = fx.sessionRepo.listSessions('developer')
    assert.equal(personalList.sessions.some((s) => s.id === delegated.sessionId), false)
    assert.equal(fx.sessionRepo.getSessionMessages(personalSess.id).total, 0)
    assert.ok(fx.sessionRepo.getSessionMessages(delegated.sessionId!).total >= 2)

    // Member removal blocks new delegation to removed member
    fx.teams.updateTeamMembers(fx.team.id, ['chief'])
    await assert.rejects(
      fx.privateTasks.delegate({
        teamId: fx.team.id,
        assignedBotId: 'developer',
        objective: 'After removal',
        operationId: '00000000-0000-4000-8000-000000000102',
      }),
      /not a member/,
    )
  } finally {
    fx.db.close()
    await rm(fx.dataDir, { recursive: true, force: true })
  }
})

test('Alpha.1D gates live Teams and marks interrupted tasks uncertain on restart without silent replay', async () => {
  const liveFx = await createFixture('codex')
  try {
    await assert.rejects(
      liveFx.privateTasks.delegate({
        teamId: liveFx.team.id,
        assignedBotId: 'developer',
        objective: 'Live attempt',
        operationId: '00000000-0000-4000-8000-000000000103',
      }),
      /gated/,
    )
  } finally {
    liveFx.db.close()
    await rm(liveFx.dataDir, { recursive: true, force: true })
  }

  // Startup reconciliation marks running tasks uncertain (never silently replayed)
  const fx = await createFixture('mock')
  try {
    let dispatches = 0
    fx.teams.executeTeamRunToCompletion = async (runId) => {
      dispatches++
      return fx.teams.getAggregateUsage(runId)
    }
    const input = {
      teamId: fx.team.id, assignedBotId: 'developer', objective: 'In-flight before crash',
      operationId: '00000000-0000-4000-8000-000000000104',
    }
    const delegated = await fx.privateTasks.delegate(input)
    fx.db.sqlite.prepare("UPDATE team_tasks SET status = 'running' WHERE id = ?").run(delegated.taskId)
    const rec = fx.teams.reconcileOnStartup()
    assert.equal(rec.tasksMarkedUncertain, 1)
    assert.equal(rec.runsMarkedUncertain, 1)
    const recovered = await fx.privateTasks.delegate(input)
    assert.equal(recovered.status, 'uncertain')
    assert.equal(recovered.taskId, delegated.taskId)
    assert.equal(recovered.sessionId, delegated.sessionId)
    assert.equal(dispatches, 1)
    assert.equal(fx.db.sqlite.prepare('SELECT COUNT(*) AS count FROM runs').get()?.count, 0)
  } finally {
    fx.db.close()
    await rm(fx.dataDir, { recursive: true, force: true })
  }
})


test('overlapping private delegations with one operation ID preserve the winning assignee and dispatch once', { timeout: 5000 }, async () => {
  const fx = await createFixture()
  const plannersEntered = Promise.withResolvers<void>()
  const winnerGate = Promise.withResolvers<void>()
  const loserGate = Promise.withResolvers<void>()
  try {
    const start = fx.teams.startTeamRun.bind(fx.teams)
    let entered = 0
    fx.teams.startTeamRun = (input) => start({
      ...input,
      planner: {
        async plan() {
          const plan = input.plan!
          const gate = plan.tasks[0].assignedBotId === 'developer' ? winnerGate : loserGate
          if (++entered === 2) plannersEntered.resolve()
          await gate.promise
          return plan
        },
      },
    })
    const dispatched: string[] = []
    fx.teams.executeTeamRunToCompletion = async (id) => {
      dispatched.push(id)
      return fx.teams.getAggregateUsage(id)
    }
    const input = {
      teamId: fx.team.id, objective: 'Deterministic overlap',
      operationId: '00000000-0000-4000-8000-000000000105',
    }
    const winner = fx.privateTasks.delegate({ ...input, assignedBotId: 'developer' })
    const loser = assert.rejects(fx.privateTasks.delegate({ ...input, assignedBotId: 'chief' }), /different or interrupted task/)
    await plannersEntered.promise
    winnerGate.resolve()
    const record = await winner
    const metaKey = 'teams.private-task-meta:' + record.teamRunId
    const readMeta = () => fx.db.sqlite.prepare('SELECT value_json FROM settings WHERE key = ?').get(metaKey)?.value_json
    const original = readMeta()
    loserGate.resolve()
    await loser
    assert.equal(readMeta(), original)
    assert.equal(record.assignedBotId, 'developer')
    assert.equal(fx.sessionRepo.getSession(record.sessionId!).agentId, 'developer')
    assert.deepEqual(fx.privateTasks.list({ teamId: fx.team.id }).tasks.map((task) => task.taskId), [record.taskId])
    assert.deepEqual(dispatched, [record.teamRunId])
    assert.equal(fx.db.sqlite.prepare('SELECT COUNT(*) AS count FROM team_runs').get()?.count, 1)
    assert.equal(fx.db.sqlite.prepare('SELECT COUNT(*) AS count FROM sessions').get()?.count, 1)
  } finally {
    winnerGate.resolve()
    loserGate.resolve()
    fx.db.close()
    await rm(fx.dataDir, { recursive: true, force: true })
  }
})
