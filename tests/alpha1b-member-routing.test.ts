import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { BotRepository } from '../apps/daemon/src/bots/repository.ts'
import { openGhostBotDatabase } from '../apps/daemon/src/db/client.ts'
import { seedInitialBotsIfNeeded } from '../apps/daemon/src/db/seed.ts'
import { RunOrchestrator } from '../apps/daemon/src/execution/orchestrator.ts'
import { RuntimePolicyBroker } from '../apps/daemon/src/runtime/policy-broker.ts'
import { RuntimeRegistry } from '../apps/daemon/src/runtime/registry.ts'
import { SessionRepository } from '../apps/daemon/src/sessions/repository.ts'
import { TeamsExecutionBridge } from '../apps/daemon/src/teams/execution-bridge.ts'
import { TeamMemberRoutingService } from '../apps/daemon/src/teams/member-routing.ts'
import { TeamsService } from '../apps/daemon/src/teams/service.ts'

test('team member overrides persist in isolation and scoped dispatch freezes model and conversation identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ghost-alpha1b-'))
  const registry = new RuntimeRegistry({ runtimeMode: 'mock' })
  let db = await openGhostBotDatabase(dir)
  try {
    seedInitialBotsIfNeeded(db)
    let bots = new BotRepository(db)
    let sessions = new SessionRepository(db)
    let routing = new TeamMemberRoutingService(db, bots, () => registry.getTeamRoutingCatalogs())
    const policyBroker = new RuntimePolicyBroker()
    const buildTeamService = () => {
      const orchestrator = new RunOrchestrator(db, { runtimeRegistry: registry, policyBroker })
      const teams = new TeamsService(db, bots, new TeamsExecutionBridge({
        dbHandle: db, botRepo: bots, sessionRepo: sessions, orchestrator, policyBroker,
        memberRouting: routing, getRuntimeGeneration: () => registry.getGeneration(),
        getRuntimeState: () => ({ runtimeMode: 'mock', codexVersion: null, authMethod: 'none', accountId: null }),
      }))
      return { orchestrator, teams }
    }
    const { teams } = buildTeamService()
    const team = teams.createTeam({ name: 'Routing', leadBotId: 'chief', memberBotIds: ['chief', 'developer'] })
    const other = teams.createTeam({ name: 'Isolation', leadBotId: 'chief', memberBotIds: ['chief', 'developer'] })
    const key = { teamId: team.id, botId: 'developer' }
    const inherited = await routing.get(key)
    assert.equal(inherited.override, null)
    assert.equal(inherited.effective.modelId, 'codex-mock')
    assert.ok(inherited.supported)
    await assert.rejects(routing.set({ ...key, override: { modelId: 'made-up' } }), /compatible/)
    const changed = await routing.set({ ...key, override: { modelId: 'mock-model', effort: 'low' } })
    assert.equal(changed.effective.accountId, 'mock-account')
    assert.notEqual(changed.revision, inherited.revision)
    assert.throws(() => routing.revalidate(key, inherited), /changed/)
    assert.equal((await routing.get({ ...key, teamId: other.id })).effective.modelId, 'codex-mock')
    assert.equal(bots.getBot('developer')?.modelId, 'codex-mock')

    db.close()
    db = await openGhostBotDatabase(dir)
    bots = new BotRepository(db)
    sessions = new SessionRepository(db)
    routing = new TeamMemberRoutingService(db, bots, () => registry.getTeamRoutingCatalogs())
    assert.equal((await routing.get(key)).revision, changed.revision)
    const { teams: restarted, orchestrator } = buildTeamService()
    const personal = sessions.createSession({ agentId: 'developer', title: 'Personal fixture' })
    const run = await restarted.startTeamRun({
      teamId: team.id, goal: 'Routing fixture', idempotencyKey: 'alpha1b-fixture',
      plan: { summary: 'Two sequential workers', tasks: [
        { planKey: 'first', assignedBotId: 'developer', prompt: 'First offline fixture' },
        { planKey: 'second', assignedBotId: 'developer', prompt: 'Second offline fixture', dependsOn: ['first'] },
      ] },
    })
    assert.equal((await restarted.executeTeamRunToCompletion(run.run.id)).status, 'completed')
    const links = db.sqlite.prepare('SELECT daemon_run_id, session_id, account_id FROM team_execution_links WHERE team_run_id = ?')
      .all(run.run.id) as Array<{ daemon_run_id: string; session_id: string; account_id: string }>
    assert.equal(links.length, 2)
    assert.equal(links[0].session_id, links[1].session_id)
    assert.notEqual(links[0].session_id, personal.id)
    assert.equal(links[0].account_id, 'mock-account')
    assert.deepEqual(sessions.listSessions('developer').sessions.map((session) => session.id), [personal.id])
    await assert.rejects(orchestrator.startRun({ sessionId: links[0].session_id, idempotencyKey: 'unscoped', text: 'Denied' }), /different execution scope/)
    assert.equal(orchestrator.getRun(links[0].daemon_run_id).configSnapshot.modelId, 'mock-model')
    await routing.set({ ...key, override: null })
    assert.equal(orchestrator.getRun(links[0].daemon_run_id).configSnapshot.modelId, 'mock-model')

    const fixture = { identity: 'binding-compatibility-fixture', agentId: 'developer', runtimeId: 'mock-offline', accountId: 'mock-account' }
    const bound = sessions.getOrCreateTeamSession(fixture)
    assert.equal(sessions.getOrCreateTeamSession(fixture), bound)
    assert.notEqual(sessions.getOrCreateTeamSession({ ...fixture, runtimeId: 'mock' }), bound)
    assert.equal(sessions.getActiveSessionId('developer'), personal.id)

    await routing.set({ ...key, override: { effort: 'high' } })
    assert.throws(() => restarted.updateTeamMembers(team.id, ['developer']), /replacement lead/)
    restarted.updateTeamMembers(team.id, ['chief'])
    await assert.rejects(routing.get(key), /not an active team member/)
    restarted.updateTeamMembers(team.id, ['chief', 'developer'])
    assert.equal((await routing.get(key)).override, null)
    await orchestrator.stop()
  } finally {
    await registry.stop()
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})
