import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { DelegationEngine } from '../src/engine/delegation-engine.ts'
import { openTeamDatabase } from '../src/repository/sqlite-store.ts'
import { TeamRepository } from '../src/repository/team-repository.ts'
import type { TeamDispatchContext, TeamTaskDispatcher } from '../src/contracts/types.ts'
import { TeamError } from '../src/security/validation.ts'

const tempDirs: string[] = []

function makeSetup(bounds?: {
  maxDepth?: number
  maxAttempts?: number
  maxTokens?: number
  maxDurationMs?: number
  maxConcurrentTasks?: number
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-teams-engine-'))
  tempDirs.push(dir)
  const handle = openTeamDatabase(dir)
  const repo = new TeamRepository(handle)
  const engine = new DelegationEngine(repo)
  const team = repo.createTeam({
    name: 'Chief of Staff Team',
    ownerId: 'owner-1',
    leadBotId: 'chief',
    memberBotIds: ['chief', 'researcher', 'coder', 'reviewer'],
    bounds,
  })
  return { handle, repo, engine, team }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe('DelegationEngine', () => {
  it('creates Chief of Staff root tasks idempotently and rejects conflicting idempotency keys', () => {
    const { handle, engine, team } = makeSetup()
    const first = engine.createRootTask({
      teamId: team.id,
      ownerId: 'owner-1',
      prompt: 'Plan the release',
      idempotencyKey: 'root-1',
    })
    assert.equal(first.created, true)
    assert.equal(first.task.assignedBotId, 'chief')
    assert.equal(first.task.depth, 0)

    const replay = engine.createRootTask({
      teamId: team.id,
      ownerId: 'owner-1',
      prompt: 'Plan the release',
      idempotencyKey: 'root-1',
    })
    assert.equal(replay.created, false)
    assert.equal(replay.task.id, first.task.id)

    assert.throws(
      () =>
        engine.createRootTask({
          teamId: team.id,
          ownerId: 'owner-1',
          prompt: 'Different prompt',
          idempotencyKey: 'root-1',
        }),
      (err: unknown) => err instanceof TeamError && err.code === 'IDEMPOTENCY_CONFLICT'
    )

    handle.close()
  })

  it('enforces maxDepth and parent budget limits when delegating subtasks', () => {
    const { handle, engine, team } = makeSetup({ maxDepth: 1, maxTokens: 1000 })
    const { task: root } = engine.createRootTask({
      teamId: team.id,
      ownerId: 'owner-1',
      prompt: 'Coordinate',
      idempotencyKey: 'r1',
    })

    const { task: child } = engine.delegateSubtask({
      teamId: team.id,
      ownerId: 'owner-1',
      parentTaskId: root.id,
      targetBotId: 'researcher',
      prompt: 'Research topic',
      idempotencyKey: 'c1',
      tokenBudget: 400,
    })
    assert.equal(child.depth, 1)
    assert.equal(child.rootTaskId, root.id)
    assert.equal(child.delegatedByBotId, 'chief')

    assert.throws(
      () =>
        engine.delegateSubtask({
          teamId: team.id,
          ownerId: 'owner-1',
          parentTaskId: child.id,
          targetBotId: 'coder',
          prompt: 'Too deep',
          idempotencyKey: 'gc1',
        }),
      (err: unknown) => err instanceof TeamError && err.code === 'MAX_DEPTH_EXCEEDED'
    )

    assert.throws(
      () =>
        engine.delegateSubtask({
          teamId: team.id,
          ownerId: 'owner-1',
          parentTaskId: root.id,
          targetBotId: 'coder',
          prompt: 'Exceeds remaining parent tokens',
          idempotencyKey: 'c2',
          tokenBudget: 1100,
        }),
      (err: unknown) => err instanceof TeamError && err.code === 'PARENT_BUDGET_EXHAUSTED'
    )

    handle.close()
  })

  it('executes ready tasks in parallel bounded by maxConcurrentTasks and passes non-escalation flags', async () => {
    const { handle, engine, team } = makeSetup({ maxConcurrentTasks: 2 })
    const { task: root } = engine.createRootTask({
      teamId: team.id,
      ownerId: 'owner-1',
      prompt: 'Root',
      idempotencyKey: 'r1',
    })
    engine.delegateSubtask({
      teamId: team.id,
      ownerId: 'owner-1',
      parentTaskId: root.id,
      targetBotId: 'researcher',
      prompt: 'Sub 1',
      idempotencyKey: 's1',
      tokenBudget: 1000,
    })
    engine.delegateSubtask({
      teamId: team.id,
      ownerId: 'owner-1',
      parentTaskId: root.id,
      targetBotId: 'coder',
      prompt: 'Sub 2',
      idempotencyKey: 's2',
      tokenBudget: 1000,
    })
    engine.delegateSubtask({
      teamId: team.id,
      ownerId: 'owner-1',
      parentTaskId: root.id,
      targetBotId: 'reviewer',
      prompt: 'Sub 3',
      idempotencyKey: 's3',
      tokenBudget: 1000,
    })

    let active = 0
    let maxObservedConcurrency = 0
    const seenContexts: TeamDispatchContext[] = []

    const dispatcher: TeamTaskDispatcher = {
      async dispatch(ctx) {
        seenContexts.push(ctx)
        active += 1
        if (active > maxObservedConcurrency) maxObservedConcurrency = active
        await new Promise((resolve) => setTimeout(resolve, 15))
        active -= 1
        return { status: 'completed', tokensUsed: 120, durationMs: 15 }
      },
    }

    const firstWave = await engine.runReadyTasksParallel(team.id, 'owner-1', dispatcher)
    assert.equal(firstWave.length, 2)
    assert.equal(maxObservedConcurrency, 2)

    const secondWave = await engine.runReadyTasksParallel(team.id, 'owner-1', dispatcher)
    assert.equal(secondWave.length, 2)

    for (const ctx of seenContexts) {
      assert.equal(ctx.requirePolicyRevalidation, true)
      assert.equal(ctx.noPermissionEscalation, true)
      assert.equal(ctx.noImplicitMemorySharing, true)
      assert.equal(ctx.reusePriorApprovals, false)
    }

    const usage = engine.getAggregateUsage(root.id, 'owner-1')
    assert.equal(usage.totalTasks, 4)
    assert.equal(usage.totalTokensUsed, 480)
    assert.equal(usage.byStatus.completed, 4)

    handle.close()
  })

  it('retries up to maxAttempts and transitions to budget_exhausted when token or duration budget is exceeded', async () => {
    const { handle, engine, team } = makeSetup({ maxAttempts: 2, maxTokens: 200 })
    engine.createRootTask({
      teamId: team.id,
      ownerId: 'owner-1',
      prompt: 'Retryable root',
      idempotencyKey: 'retry-root',
    })

    let calls = 0
    const retryDispatcher: TeamTaskDispatcher = {
      async dispatch() {
        calls += 1
        if (calls === 1) {
          return {
            status: 'failed',
            code: 'TRANSIENT',
            message: 'try again',
            retryable: true,
            tokensUsed: 50,
            durationMs: 10,
          }
        }
        return { status: 'completed', tokensUsed: 60, durationMs: 10 }
      },
    }

    const wave1 = await engine.runReadyTasksParallel(team.id, 'owner-1', retryDispatcher)
    assert.equal(wave1[0]?.status, 'queued')
    assert.equal(wave1[0]?.attempt, 1)

    const wave2 = await engine.runReadyTasksParallel(team.id, 'owner-1', retryDispatcher)
    assert.equal(wave2[0]?.status, 'completed')
    assert.equal(wave2[0]?.attempt, 2)
    assert.equal(wave2[0]?.tokensUsed, 110)

    const { task: overrunTask } = engine.createRootTask({
      teamId: team.id,
      ownerId: 'owner-1',
      prompt: 'Overrun',
      idempotencyKey: 'overrun-root',
    })
    await engine.runReadyTasksParallel(team.id, 'owner-1', {
      async dispatch() {
        return { status: 'completed', tokensUsed: 250, durationMs: 10 }
      },
    })
    assert.equal(engine.getTask(overrunTask.id, 'owner-1').status, 'budget_exhausted')

    handle.close()
  })

  it('propagates cancellation to descendants and fails in-flight tasks on restart without auto-replay', async () => {
    const { handle, engine, team } = makeSetup()
    const { task: root } = engine.createRootTask({
      teamId: team.id,
      ownerId: 'owner-1',
      prompt: 'Root',
      idempotencyKey: 'stop-root',
    })
    const { task: child } = engine.delegateSubtask({
      teamId: team.id,
      ownerId: 'owner-1',
      parentTaskId: root.id,
      targetBotId: 'researcher',
      prompt: 'Child',
      idempotencyKey: 'stop-child',
    })
    const { task: grandchild } = engine.delegateSubtask({
      teamId: team.id,
      ownerId: 'owner-1',
      parentTaskId: child.id,
      targetBotId: 'coder',
      prompt: 'Grandchild',
      idempotencyKey: 'stop-grandchild',
    })

    const cancelResult = engine.cancelTaskWithPropagation(root.id, 'owner-1')
    assert.equal(cancelResult.cancelledTask.status, 'cancelled')
    assert.equal(cancelResult.stoppedChildrenCount, 2)
    assert.equal(engine.getTask(child.id, 'owner-1').status, 'stopped_by_parent')
    assert.equal(engine.getTask(grandchild.id, 'owner-1').status, 'stopped_by_parent')

    // Simulate crash with an in-flight running task
    const { task: crashTask } = engine.createRootTask({
      teamId: team.id,
      ownerId: 'owner-1',
      prompt: 'Crashed task',
      idempotencyKey: 'crash-root',
    })
    handle.sqlite.prepare(`UPDATE team_tasks SET status = 'running' WHERE id = ?`).run(crashTask.id)

    const reconciled = engine.reconcileOnRestart()
    assert.equal(reconciled, 1)
    const afterCrash = engine.getTask(crashTask.id, 'owner-1')
    assert.equal(afterCrash.status, 'uncertain')
    assert.equal(afterCrash.terminationConfirmed, false)
    assert.equal(afterCrash.errorCode, 'DAEMON_RESTARTED')

    handle.close()
  })
})
