import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AgentEvent, AgentRequest, AgentRuntime, Capabilities, Session, SessionConfig } from '@ghost-bot/shared-types/runtime'
import { openGhostBotDatabase } from '../apps/daemon/src/db/client.ts'
import { seedInitialBotsIfNeeded } from '../apps/daemon/src/db/seed.ts'
import { BotRepository } from '../apps/daemon/src/bots/repository.ts'
import { RuntimePolicyBroker } from '../apps/daemon/src/runtime/policy-broker.ts'
import { RuntimeRegistry } from '../apps/daemon/src/runtime/registry.ts'
import { SessionRepository } from '../apps/daemon/src/sessions/repository.ts'
import { TeamDiscussion } from '../apps/daemon/src/teams/discussion.ts'
import { TeamsExecutionBridge } from '../apps/daemon/src/teams/execution-bridge.ts'
import { TeamMemberRoutingService } from '../apps/daemon/src/teams/member-routing.ts'
import { TeamsService } from '../apps/daemon/src/teams/service.ts'

async function createFixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'ghost-bot-alpha1c-unit-'))
  const db = await openGhostBotDatabase(dataDir)
  seedInitialBotsIfNeeded(db)
  const botRepo = new BotRepository(db)
  const sessionRepo = new SessionRepository(db)
  const registry = new RuntimeRegistry({ runtimeMode: 'mock' })
  const teams = new TeamsService(
    db,
    botRepo,
    new TeamsExecutionBridge({
      dbHandle: db,
      botRepo,
      sessionRepo,
      orchestrator: {} as never,
      policyBroker: new RuntimePolicyBroker(),
      getRuntimeState: () => ({ runtimeMode: 'mock', codexVersion: null, authMethod: 'none', accountId: null }),
    }),
  )
  const routing = new TeamMemberRoutingService(db, botRepo, () => registry.getTeamRoutingCatalogs())
  const discussion = new TeamDiscussion(db, teams, routing, registry)
  const team = teams.createTeam({
    name: 'Discussion Unit Team',
    leadBotId: 'chief',
    memberBotIds: ['chief', 'developer'],
  })
  return { dataDir, db, sessionRepo, registry, teams, routing, discussion, team }
}

test('Alpha.1C supports 2-round bounded discussion, inherited routing, and leaves personal sessions isolated', async () => {
  const fx = await createFixture()
  try {
    const personalSess = fx.sessionRepo.createSession({ agentId: 'chief', title: 'Personal' })
    const turn = await fx.discussion.send({
      teamId: fx.team.id,
      operationId: '00000000-0000-4000-8000-000000000001',
      text: '@all review alpha1c',
      rounds: 2,
    })

    assert.equal(turn.replies.length, 4)
    assert.deepEqual(
      turn.replies.map((r) => [r.botId, r.round]),
      [
        ['chief', 1],
        ['developer', 1],
        ['chief', 2],
        ['developer', 2],
      ],
    )
    assert.equal(turn.replies[0].routing.modelId, 'mock-model')
    assert.equal(turn.replies[1].routing.modelId, 'mock-model')
    assert.equal(fx.sessionRepo.getSessionMessages(personalSess.id).total, 0)
  } finally {
    fx.db.close()
    await rm(fx.dataDir, { recursive: true, force: true })
  }
})

test('Alpha.1C rejects tool events and supports cancellation cleanly', async () => {
  const fx = await createFixture()
  try {
    const toolEmittingRuntime: AgentRuntime = {
      id: 'mock-offline',
      authenticate: async () => ({ status: 'connected' }),
      getAuthStatus: async () => ({ status: 'connected' }),
      disconnect: async () => {},
      capabilities: async (): Promise<Capabilities> => ({
        streaming: true, cancellation: true, resume: false, approvals: false, usage: false, sandbox: false, models: [],
      }),
      listModels: async () => [],
      getUsage: async () => null,
      createSession: async (cfg: SessionConfig): Promise<Session> => ({
        id: `s-${cfg.agentId}`, externalId: 'ext', runtimeId: 'mock-offline',
      }),
      async *run(req: AgentRequest): AsyncIterable<AgentEvent> {
        yield {
          runId: req.runId,
          seq: 1,
          timestamp: new Date().toISOString(),
          type: 'tool.started',
          tool: 'shell',
          callId: 'call-1',
          summary: 'Attempted tool',
        }
      },
      resolveApproval: async () => {},
      cancel: async () => {},
    }

    const fakeRegistry = {
      getOfflineDiscussionRuntime: () => toolEmittingRuntime,
      getGeneration: () => 1,
    } as unknown as RuntimeRegistry
    const guardedDiscussion = new TeamDiscussion(fx.db, fx.teams, fx.routing, fakeRegistry)

    await assert.rejects(
      guardedDiscussion.send({
        teamId: fx.team.id,
        operationId: '00000000-0000-4000-8000-000000000002',
        text: 'Try tool',
      }),
      /disallowed event/,
    )
    assert.equal(fx.discussion.list({ teamId: fx.team.id }).turns.length, 0)

    // Test cancellation of an in-flight slow runtime
    let releaseRun!: () => void
    const slowRuntime: AgentRuntime = {
      ...toolEmittingRuntime,
      async *run(req: AgentRequest): AsyncIterable<AgentEvent> {
        yield { runId: req.runId, seq: 1, timestamp: new Date().toISOString(), type: 'message.delta', text: 'partial' }
        await new Promise<void>((resolve) => {
          releaseRun = resolve
        })
        yield { runId: req.runId, seq: 2, timestamp: new Date().toISOString(), type: 'run.cancelled' }
      },
      cancel: async () => {
        releaseRun?.()
      },
    }
    const slowRegistry = {
      getOfflineDiscussionRuntime: () => slowRuntime,
      getGeneration: () => 1,
    } as unknown as RuntimeRegistry
    const cancellable = new TeamDiscussion(fx.db, fx.teams, fx.routing, slowRegistry)
    const opId = '00000000-0000-4000-8000-000000000003'
    const pending = cancellable.send({ teamId: fx.team.id, operationId: opId, text: '@chief slow' })
    await new Promise((r) => setTimeout(r, 20))
    const cancelRes = await cancellable.cancel({ teamId: fx.team.id, operationId: opId })
    assert.equal(cancelRes.cancelled, true)
    await assert.rejects(pending, /stopped/)

    // DISC-01: Concurrent workers share totalCharBudget atomically
    const tinyBudgetTeam = fx.teams.createTeam({
      name: 'Tiny Budget Team',
      leadBotId: 'chief',
      memberBotIds: ['chief', 'developer'],
      bounds: { maxTokens: 2048, maxConcurrentTasks: 2 },
    })
    const burstRuntime: AgentRuntime = {
      ...toolEmittingRuntime,
      async *run(req: AgentRequest): AsyncIterable<AgentEvent> {
        yield { runId: req.runId, seq: 1, timestamp: new Date().toISOString(), type: 'message.delta', text: 'x'.repeat(6000) }
        yield { runId: req.runId, seq: 2, timestamp: new Date().toISOString(), type: 'run.completed' }
      },
    }
    const burstDiscussion = new TeamDiscussion(
      fx.db,
      fx.teams,
      fx.routing,
      { getOfflineDiscussionRuntime: () => burstRuntime, getGeneration: () => 1 } as unknown as RuntimeRegistry,
    )
    const burstTurn = await burstDiscussion.send({
      teamId: tinyBudgetTeam.id,
      operationId: '00000000-0000-4000-8000-000000000004',
      text: '@all burst',
    })
    const totalOutChars = burstTurn.replies.reduce((sum, r) => sum + r.text.length, 0)
    assert.ok(totalOutChars <= 8192, `Expected <= 8192 shared chars, got ${totalOutChars}`)

    // DISC-02 & DISC-03: Sibling settles & cancellation during createSession prevents late run()
    let siblingSettled = false
    let lateRunCalled = false
    let releaseCreateSession!: () => void
    const raceRuntime: AgentRuntime = {
      ...toolEmittingRuntime,
      createSession: async (cfg: SessionConfig): Promise<Session> => {
        if (cfg.agentId === 'developer') {
          await new Promise<void>((resolve) => {
            releaseCreateSession = resolve
          })
        }
        return { id: `s-${cfg.agentId}`, externalId: 'ext', runtimeId: 'mock-offline' }
      },
      async *run(req: AgentRequest): AsyncIterable<AgentEvent> {
        if (req.session.agentId === 'developer') {
          lateRunCalled = true
        }
        await new Promise((r) => setTimeout(r, 15))
        siblingSettled = true
        yield { runId: req.runId, seq: 1, timestamp: new Date().toISOString(), type: 'tool.started', tool: 'x', callId: 'c', summary: 'x' }
      },
    }
    const raceDiscussion = new TeamDiscussion(
      fx.db,
      fx.teams,
      fx.routing,
      { getOfflineDiscussionRuntime: () => raceRuntime, getGeneration: () => 1 } as unknown as RuntimeRegistry,
    )
    const raceOp = '00000000-0000-4000-8000-000000000005'
    const racePromise = raceDiscussion.send({ teamId: fx.team.id, operationId: raceOp, text: '@all race' })
    await new Promise((r) => setTimeout(r, 30))
    releaseCreateSession?.()
    await assert.rejects(racePromise, /disallowed event|stopped/)
    assert.equal(siblingSettled, true)
    assert.equal(lateRunCalled, false)

    // Idempotency rejects same operationId with different rounds
    const round1Op = '00000000-0000-4000-8000-000000000006'
    await fx.discussion.send({ teamId: fx.team.id, operationId: round1Op, text: '@all rounds', rounds: 1 })
    await assert.rejects(
      fx.discussion.send({ teamId: fx.team.id, operationId: round1Op, text: '@all rounds', rounds: 2 }),
      /different text or round count/,
    )
  } finally {
    fx.db.close()
    await rm(fx.dataDir, { recursive: true, force: true })
  }
})
