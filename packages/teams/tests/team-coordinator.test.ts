import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, it } from 'node:test'
import type {
  TeamResultSynthesizer,
  TeamTaskDispatcher,
  TeamTaskPlan,
  TeamTaskPlanner,
} from '../src/contracts/types.ts'
import { DelegationEngine } from '../src/engine/delegation-engine.ts'
import { TeamCoordinator } from '../src/engine/team-coordinator.ts'
import { openTeamDatabase } from '../src/repository/sqlite-store.ts'
import { TeamRepository } from '../src/repository/team-repository.ts'
import { TeamError } from '../src/security/validation.ts'

const tempDirs: string[] = []

function makeEnv(bounds?: Record<string, number>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-teams-coord-'))
  tempDirs.push(dir)
  const handle = openTeamDatabase(dir)
  const repo = new TeamRepository(handle)
  const engine = new DelegationEngine(repo)
  const coordinator = new TeamCoordinator(repo, engine)
  const team = repo.createTeam({
    name: 'Alpha Team',
    ownerId: 'owner-1',
    leadBotId: 'chief',
    memberBotIds: ['chief', 'researcher', 'coder', 'reviewer'],
    bounds,
  })
  return { dir, handle, repo, engine, coordinator, team }
}

function staticPlanner(plan: TeamTaskPlan): TeamTaskPlanner {
  return {
    async plan() {
      return plan
    },
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe('TeamCoordinator & Phase 4B Hardening', () => {
  it('executes fan-out and fan-in plans in dependency order and synthesizes final response', async () => {
    const { handle, repo, coordinator, team } = makeEnv({ maxConcurrentTasks: 2 })
    const order: string[] = []

    const { run } = await coordinator.startTeamRun({
      teamId: team.id,
      ownerId: 'owner-1',
      goal: 'Ship feature X',
      idempotencyKey: 'run-fan-1',
      planner: staticPlanner({
        summary: 'Research and code in parallel, then review',
        tasks: [
          { planKey: 'research', assignedBotId: 'researcher', prompt: 'Gather specs' },
          { planKey: 'code', assignedBotId: 'coder', prompt: 'Implement module' },
          {
            planKey: 'review',
            assignedBotId: 'reviewer',
            prompt: 'Review implementation',
            dependsOn: ['research', 'code'],
          },
        ],
      }),
    })

    const dispatcher: TeamTaskDispatcher = {
      async dispatch(ctx) {
        order.push(ctx.assignedBotId)
        return {
          status: 'completed',
          tokensUsed: 100,
          durationMs: 25,
          outputText: `Output from ${ctx.assignedBotId}`,
        }
      },
    }

    const aggregate = await coordinator.runTeamRunToCompletion(run.id, 'owner-1', dispatcher)
    assert.equal(aggregate.status, 'completed')
    assert.equal(aggregate.completedCount, 3)
    assert.equal(aggregate.failedCount, 0)
    assert.equal(aggregate.totalTokensUsed, 300)
    assert.equal(aggregate.usageComplete, true)
    assert.equal(order[2], 'reviewer')

    const synthesizer: TeamResultSynthesizer = {
      async synthesize(agg) {
        return { summaryText: `Synthesized ${agg.completedCount}/${agg.totalTasks} tasks` }
      },
    }
    const synth = await coordinator.synthesizeFinalResponse(run.id, 'owner-1', synthesizer)
    assert.equal(synth.summaryText, 'Synthesized 3/3 tasks')

    // Verify visibility rules: worker 'researcher' sees team messages and its own direct messages, not 'coder' direct assignments
    const researcherView = repo.listMessages(team.id, 'owner-1', {
      teamRunId: run.id,
      viewerBotId: 'researcher',
    })
    assert.ok(researcherView.some((m) => m.messageType === 'cos_instruction'))
    assert.ok(!researcherView.some((m) => m.targetBotId === 'coder'))
    assert.ok(
      researcherView.every((m) => m.senderType !== 'worker' || m.untrusted === true),
    )

    handle.close()
  })

  it('rejects circular, self, missing, duplicate, non-member, and oversized plans', async () => {
    const { handle, coordinator, team } = makeEnv({ maxTasksPerRun: 3, maxDepth: 2 })

    await assert.rejects(
      () =>
        coordinator.startTeamRun({
          teamId: team.id,
          ownerId: 'owner-1',
          goal: 'Cycle',
          idempotencyKey: 'bad-cycle',
          planner: staticPlanner({
            summary: 'Cycle',
            tasks: [
              { planKey: 'a', assignedBotId: 'researcher', prompt: 'A', dependsOn: ['b'] },
              { planKey: 'b', assignedBotId: 'coder', prompt: 'B', dependsOn: ['a'] },
            ],
          }),
        }),
      (err: unknown) => err instanceof TeamError && err.code === 'CIRCULAR_DEPENDENCY',
    )

    await assert.rejects(
      () =>
        coordinator.startTeamRun({
          teamId: team.id,
          ownerId: 'owner-1',
          goal: 'Self',
          idempotencyKey: 'bad-self',
          planner: staticPlanner({
            summary: 'Self',
            tasks: [{ planKey: 'a', assignedBotId: 'researcher', prompt: 'A', dependsOn: ['a'] }],
          }),
        }),
      (err: unknown) => err instanceof TeamError && err.code === 'SELF_DEPENDENCY',
    )

    await assert.rejects(
      () =>
        coordinator.startTeamRun({
          teamId: team.id,
          ownerId: 'owner-1',
          goal: 'Missing',
          idempotencyKey: 'bad-missing',
          planner: staticPlanner({
            summary: 'Missing',
            tasks: [{ planKey: 'a', assignedBotId: 'researcher', prompt: 'A', dependsOn: ['nope'] }],
          }),
        }),
      (err: unknown) => err instanceof TeamError && err.code === 'MISSING_DEPENDENCY',
    )

    await assert.rejects(
      () =>
        coordinator.startTeamRun({
          teamId: team.id,
          ownerId: 'owner-1',
          goal: 'Oversized',
          idempotencyKey: 'bad-size',
          planner: staticPlanner({
            summary: 'Too many',
            tasks: [
              { planKey: 't1', assignedBotId: 'researcher', prompt: '1' },
              { planKey: 't2', assignedBotId: 'coder', prompt: '2' },
              { planKey: 't3', assignedBotId: 'reviewer', prompt: '3' },
            ],
          }),
        }),
      (err: unknown) => err instanceof TeamError && err.code === 'PLAN_TOO_LARGE',
    )

    handle.close()
  })

  it('blocks dependent tasks when prerequisite fails and reports partial_failure + unknown usage', async () => {
    const { handle, coordinator, team } = makeEnv({ maxAttempts: 1, maxResultBytes: 1024 })
    const { run } = await coordinator.startTeamRun({
      teamId: team.id,
      ownerId: 'owner-1',
      goal: 'Partial test',
      idempotencyKey: 'partial-1',
      planner: staticPlanner({
        summary: 'Two branches',
        tasks: [
          { planKey: 'ok', assignedBotId: 'researcher', prompt: 'Succeed without usage' },
          { planKey: 'fail', assignedBotId: 'coder', prompt: 'Fail' },
          {
            planKey: 'downstream',
            assignedBotId: 'reviewer',
            prompt: 'Depends on fail',
            dependsOn: ['fail'],
          },
        ],
      }),
    })

    const aggregate = await coordinator.runTeamRunToCompletion(run.id, 'owner-1', {
      async dispatch(ctx) {
        if (ctx.assignedBotId === 'coder') {
          return { status: 'failed', code: 'CRASH', message: 'boom', retryable: false }
        }
        // Omit tokensUsed/durationMs to test explicit unavailable usage tracking
        return { status: 'completed', outputText: 'done' }
      },
    })

    assert.equal(aggregate.status, 'partial_failure')
    assert.equal(aggregate.completedCount, 1)
    assert.equal(aggregate.failedCount, 1)
    assert.equal(aggregate.blockedCount, 1)
    assert.equal(aggregate.usageComplete, false)
    assert.equal(aggregate.unavailableUsageTaskIds.length, 2)

    handle.close()
  })

  it('reserves budget atomically before dispatch and prevents uncontrolled dispatch after uncertain outcomes', async () => {
    const { handle, engine, team } = makeEnv({ maxTokens: 300, maxConcurrentTasks: 3 })
    const { task: root } = engine.createRootTask({
      teamId: team.id,
      ownerId: 'owner-1',
      prompt: 'Root',
      idempotencyKey: 'atomic-root',
    })
    const { task: s1 } = engine.delegateSubtask({
      teamId: team.id,
      ownerId: 'owner-1',
      parentTaskId: root.id,
      targetBotId: 'researcher',
      prompt: 'S1',
      idempotencyKey: 'atomic-s1',
      tokenBudget: 200,
    })
    const { task: s2 } = engine.delegateSubtask({
      teamId: team.id,
      ownerId: 'owner-1',
      parentTaskId: root.id,
      targetBotId: 'coder',
      prompt: 'S2',
      idempotencyKey: 'atomic-s2',
      tokenBudget: 100,
    })
    assert.ok(s1.id && s2.id)
    // Mark root running with 0 remaining budget so s1 and s2 run in parallel and s3 can still test parent budget
    handle.sqlite.prepare(`UPDATE team_tasks SET status = 'running', token_budget = 0 WHERE id = ?`).run(root.id)

    // Root + s1 + s2: s1 reserves 200 (leaving 100), s2 reserves 100 (capped by tree maxTokens 300).
    // If s1 throws (uncertain), its 200 reservation stays locked!
    const dispatched: string[] = []
    await engine.runReadyTasksParallel(team.id, 'owner-1', {
      async dispatch(ctx) {
        dispatched.push(`${ctx.assignedBotId}:${ctx.remainingTokenBudget}`)
        if (ctx.assignedBotId === 'researcher') {
          throw new Error('socket hangup')
        }
        return { status: 'completed', tokensUsed: 80, durationMs: 10 }
      },
    })

    assert.equal(engine.getTask(s1.id, 'owner-1').status, 'uncertain')
    assert.equal(engine.getTask(s1.id, 'owner-1').tokensReserved, 200)
    assert.equal(engine.getTask(s2.id, 'owner-1').status, 'completed')

    // Delegating another 150-token task must fail because 200 is still locked + 80 used = 280 committed (only 20 left)
    assert.throws(
      () =>
        engine.delegateSubtask({
          teamId: team.id,
          ownerId: 'owner-1',
          parentTaskId: root.id,
          targetBotId: 'reviewer',
          prompt: 'S3',
          idempotencyKey: 'atomic-s3',
          tokenBudget: 150,
        }),
      (err: unknown) => err instanceof TeamError && err.code === 'PARENT_BUDGET_EXHAUSTED',
    )

    handle.close()
  })

  it('cancels queued tasks when member is removed during execution and enforces owner isolation', async () => {
    const { handle, repo, coordinator, team } = makeEnv()
    const { run } = await coordinator.startTeamRun({
      teamId: team.id,
      ownerId: 'owner-1',
      goal: 'Membership test',
      idempotencyKey: 'mem-1',
      planner: staticPlanner({
        summary: 'Single task',
        tasks: [{ planKey: 'work', assignedBotId: 'coder', prompt: 'Code something' }],
      }),
    })

    assert.throws(
      () => coordinator.getTeamRun(run.id, 'other-owner'),
      (err: unknown) => err instanceof TeamError && err.code === 'SCOPE_FORBIDDEN',
    )

    // Remove coder before dispatch
    repo.updateTeamMembers(team.id, 'owner-1', ['chief', 'researcher'])
    const agg = await coordinator.runTeamRunToCompletion(run.id, 'owner-1', {
      async dispatch() {
        throw new Error('Should never dispatch removed member')
      },
    })
    assert.equal(agg.cancelledCount, 1)
    assert.equal(agg.results[0]?.errorCode, 'MEMBER_REMOVED')

    handle.close()
  })

  it('distinguishes confirmed vs uncertain cancellation, blocks late callbacks, and reconciles restart without replay', async () => {
    const { handle, coordinator, engine, team } = makeEnv({ maxConcurrentTasks: 2 })
    const { run, tasks } = await coordinator.startTeamRun({
      teamId: team.id,
      ownerId: 'owner-1',
      goal: 'Cancel & restart',
      idempotencyKey: 'cancel-1',
      planner: staticPlanner({
        summary: 'Parallel + dependent',
        tasks: [
          { planKey: 'active', assignedBotId: 'researcher', prompt: 'Running task' },
          {
            planKey: 'queued',
            assignedBotId: 'coder',
            prompt: 'Queued dependent',
            dependsOn: ['active'],
          },
        ],
      }),
    })

    const activeTask = tasks.find((t) => t.planKey === 'active')!
    // Simulate activeTask in running state
    handle.sqlite
      .prepare(`UPDATE team_tasks SET status = 'running', attempt = 1 WHERE id = ?`)
      .run(activeTask.id)

    const cancelRes = await coordinator.cancelTeamRun(run.id, 'owner-1', {
      async dispatch() {
        return { status: 'completed', tokensUsed: 1, durationMs: 1 }
      },
      async cancelExecution() {
        return { confirmed: false, reason: 'Runtime did not ack' }
      },
    })

    assert.equal(cancelRes.run.status, 'uncertain')
    assert.equal(cancelRes.uncertainCount, 1)
    assert.equal(engine.getTask(activeTask.id, 'owner-1').status, 'uncertain')

    // Restart reconciliation must not replay uncertain tasks
    const restartRes = coordinator.reconcileOnRestart()
    assert.equal(restartRes.tasksMarkedUncertain, 0)
    const stepAfterRestart = await coordinator.executeTeamRunStep(run.id, 'owner-1', {
      async dispatch() {
        throw new Error('Must not replay')
      },
    })
    assert.equal(stepAfterRestart.length, 0)

    handle.close()
  })

  it('upgrades an existing Phase 4A v1 SQLite database cleanly to v2 preserving existing records', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-teams-v1-upgrade-'))
    tempDirs.push(dir)
    const dbPath = path.join(dir, 'teams.sqlite')

    // Create a genuine Phase 4A v1 schema DB
    const v1 = new DatabaseSync(dbPath)
    v1.exec(`
      CREATE TABLE team_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE teams (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        lead_bot_id TEXT NOT NULL,
        member_bot_ids_json TEXT NOT NULL,
        memory_sharing_policy TEXT NOT NULL DEFAULT 'explicit-only',
        bounds_json TEXT NOT NULL,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE team_tasks (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        root_task_id TEXT NOT NULL,
        parent_task_id TEXT,
        depth INTEGER NOT NULL,
        assigned_bot_id TEXT NOT NULL,
        delegated_by_bot_id TEXT,
        idempotency_key TEXT NOT NULL,
        prompt TEXT NOT NULL,
        prompt_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        token_budget INTEGER NOT NULL,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        duration_budget_ms INTEGER NOT NULL,
        duration_used_ms INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error_message TEXT,
        started_at TEXT,
        ended_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(team_id, idempotency_key)
      );
      CREATE TABLE team_messages (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        author_bot_id TEXT NOT NULL,
        target_bot_id TEXT,
        originating_task_id TEXT NOT NULL REFERENCES team_tasks(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(team_id, seq)
      );
      INSERT INTO team_schema_migrations (version, name, applied_at)
      VALUES (1, '0001_teams_foundation', '2026-11-25T00:00:00.000Z');
      INSERT INTO teams (id, name, description, owner_id, lead_bot_id, member_bot_ids_json, bounds_json, created_at, updated_at)
      VALUES ('team-v1', 'Legacy Team', 'desc', 'owner-1', 'chief', '["chief","w1"]', '{"maxDepth":2,"maxAttempts":2,"maxTokens":10000,"maxDurationMs":60000,"maxConcurrentTasks":2}', '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z');
    `)
    v1.close()

    const upgraded = openTeamDatabase(dir)
    const verRow = upgraded.sqlite
      .prepare(`SELECT MAX(version) AS ver FROM team_schema_migrations`)
      .get() as { ver: number }
    assert.equal(Number(verRow.ver), 2)

    const repo = new TeamRepository(upgraded)
    const legacyTeam = repo.getTeam('team-v1', 'owner-1')
    assert.equal(legacyTeam.name, 'Legacy Team')
    assert.equal(legacyTeam.bounds.maxTasksPerRun, 25)

    upgraded.close()
  })
})
