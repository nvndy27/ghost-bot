import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SchedulerEngine } from '../src/engine/scheduler-engine.ts'
import { ExecutionQueue } from '../src/queue/execution-queue.ts'
import { RoutineRepository } from '../src/repository/routine-repository.ts'
import { openSchedulerDatabase } from '../src/repository/sqlite-store.ts'

test('queue & engine: duplicate suppression, concurrency, leases, terminal immutability, restart reconciliation, capacity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ghost-sched-queue-'))
  const scope = { ownerId: 'u1', botId: 'chief' }

  try {
    const db = openSchedulerDatabase(dir)
    const repo = new RoutineRepository(db)
    const queue = new ExecutionQueue(db, { maxQueueCapacity: 3 })

    let fakeNow = Date.parse('2026-01-01T00:00:00.000Z')
    const engine = new SchedulerEngine({
      repository: repo,
      queue,
      clock: { nowMs: () => fakeNow },
    })

    const r1 = repo.create(
      {
        name: 'Interval Job',
        ...scope,
        timezone: 'UTC',
        trigger: { kind: 'interval', intervalMs: 60_000, anchorAt: '2026-01-01T00:01:00.000Z' },
        task: { prompt: 'Run check', idempotent: true },
        concurrencyPolicy: 'forbid',
        retryPolicy: { maxAttempts: 2, backoffMs: 1000, retryNonIdempotent: false },
      },
      fakeNow,
    )

    // Advance clock to 00:01:05 and tick twice -> only 1 task created
    fakeNow = Date.parse('2026-01-01T00:01:05.000Z')
    const tick1 = engine.tick()
    const tick2 = engine.tick()
    assert.equal(tick1.enqueuedTasks, 1)
    assert.equal(tick2.enqueuedTasks, 0)

    // Concurrency forbid: worker-1 claims, worker-2 gets null even if another task is queued
    queue.enqueueOccurrence(r1, '2026-01-01T00:02:00.000Z', fakeNow)
    const c1 = queue.claimNext('worker-1', 5000, fakeNow)
    if (!c1) assert.fail('Expected c1 to be claimed')
    assert.equal(queue.claimNext('worker-2', 5000, fakeNow), null)

    // Claim expiration -> interrupted + uncertainExecution = true
    fakeNow += 6000
    assert.equal(queue.expireStaleClaims(fakeNow), 1)
    const expiredTask = queue.getTask(c1.id, scope)
    assert.equal(expiredTask.status, 'interrupted')
    assert.equal(expiredTask.uncertainExecution, true)

    // Retry uncertain requires explicit confirmation
    assert.throws(() => queue.retryTask(expiredTask.id, scope, fakeNow), {
      code: 'RETRY_CONFIRMATION_REQUIRED',
    })
    const retried = queue.retryTask(expiredTask.id, scope, fakeNow, { confirmUncertain: true })
    assert.equal(retried.status, 'queued')

    // Complete t2 and verify terminal immutability
    const c2 = queue.claimNext('worker-2', 5000, fakeNow)
    if (!c2) assert.fail('Expected c2 to be claimed')
    queue.markRunning(c2.id, 'worker-2', fakeNow)
    const done = queue.completeTask(c2.id, 'worker-2', fakeNow)
    assert.equal(done.status, 'completed')
    assert.throws(() => queue.cancelTask(done.id, scope, fakeNow), {
      code: 'TERMINAL_STATE_IMMUTABLE',
    })

    // Dispatch awaiting_approval & restart reconciliation
    const dispatched = await engine.dispatchNext(
      {
        async dispatch(ctx) {
          assert.equal(ctx.requirePolicyRevalidation, true)
          assert.equal(ctx.reusePriorApprovals, false)
          return { status: 'awaiting_approval', reason: 'Needs user approval' }
        },
      },
      'worker-3',
    )
    assert.equal(dispatched?.status, 'awaiting_approval')
    assert.equal(dispatched?.approvalRequired, true)

    // Restart reconciliation marks awaiting_approval/running/claimed interrupted + uncertain
    assert.equal(queue.reconcileOnRestart(fakeNow), 1)
    assert.equal(queue.getTask(dispatched!.id, scope).status, 'interrupted')
    assert.equal(queue.getTask(dispatched!.id, scope).uncertainExecution, true)

    // Queue capacity limit (maxQueueCapacity = 3, currently 1 interrupted active)
    queue.enqueueOccurrence(r1, '2026-01-01T00:03:00.000Z', fakeNow)
    queue.enqueueOccurrence(r1, '2026-01-01T00:04:00.000Z', fakeNow)
    assert.throws(
      () => queue.enqueueOccurrence(r1, '2026-01-01T00:05:00.000Z', fakeNow),
      { code: 'QUEUE_CAPACITY_EXCEEDED' },
    )

    // Non-idempotent uncertain task cannot be retried even with confirmUncertain
    const nonIdemp = repo.create(
      {
        name: 'Non-Idempotent',
        ...scope,
        timezone: 'UTC',
        trigger: { kind: 'one-time', runAt: '2026-01-01T00:00:30.000Z' },
        task: { prompt: 'Send email', idempotent: false },
        retryPolicy: { maxAttempts: 2, backoffMs: 1000, retryNonIdempotent: false },
      },
      Date.parse('2026-01-01T00:00:00.000Z'),
    )
    const queueLarge = new ExecutionQueue(db, { maxQueueCapacity: 50 })
    const tNon = queueLarge.enqueueOccurrence(nonIdemp, '2026-01-01T00:00:30.000Z', fakeNow).task
    const cNon = queueLarge.claimNext('worker-4', 5000, fakeNow)
    assert.equal(cNon?.id, tNon.id)
    queueLarge.expireStaleClaims(fakeNow + 10_000)
    assert.throws(
      () => queueLarge.retryTask(tNon.id, scope, fakeNow + 10_000, { confirmUncertain: true }),
      { code: 'NON_IDEMPOTENT_UNCERTAIN' },
    )

    db.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
