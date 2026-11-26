import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SchedulerEngine } from '../src/engine/scheduler-engine.ts'
import { ExecutionQueue } from '../src/queue/execution-queue.ts'
import { RoutineRepository } from '../src/repository/routine-repository.ts'
import { openSchedulerDatabase } from '../src/repository/sqlite-store.ts'

test('5A.2 hardening: atomic tick rollback, concurrent SQLite claims, retention, and routine revisions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ghost-sched-5a2-'))
  const scope = { ownerId: 'u1', botId: 'chief' }

  try {
    const db1 = openSchedulerDatabase(dir)
    const db2 = openSchedulerDatabase(dir)
    const repo1 = new RoutineRepository(db1)
    const queue1 = new ExecutionQueue(db1, { maxQueueCapacity: 2 })
    const queue2 = new ExecutionQueue(db2, { maxQueueCapacity: 2 })

    let fakeNow = Date.parse('2026-01-01T00:00:00.000Z')
    const engine1 = new SchedulerEngine({
      repository: repo1,
      queue: queue1,
      clock: { nowMs: () => fakeNow },
    })

    const r1 = repo1.create(
      {
        name: 'Atomic Job',
        ...scope,
        timezone: 'UTC',
        trigger: { kind: 'interval', intervalMs: 60_000, anchorAt: '2026-01-01T00:01:00.000Z' },
        task: { prompt: 'v1', idempotent: true },
        concurrencyPolicy: 'allow-bounded',
        maxConcurrentRuns: 3,
      },
      fakeNow,
    )

    // Fill queue capacity (max 2) -> tick() at 00:03:00 fails enqueue & MUST NOT advance nextRunAt
    queue1.enqueueOccurrence(r1, '2026-01-01T00:01:00.000Z', fakeNow)
    queue1.enqueueOccurrence(r1, '2026-01-01T00:02:00.000Z', fakeNow)
    fakeNow = Date.parse('2026-01-01T00:03:00.000Z')
    assert.throws(() => engine1.tick(), { code: 'QUEUE_CAPACITY_EXCEEDED' })
    assert.equal(repo1.getById(r1.id, scope).nextRunAt, '2026-01-01T00:01:00.000Z')

    // Concurrent SQLite connections claiming tasks never claim the same task
    const cA = queue1.claimNext('worker-A', 10_000, fakeNow)
    const cB = queue2.claimNext('worker-B', 10_000, fakeNow)
    assert.ok(cA && cB)
    assert.notEqual(cA.id, cB.id)
    queue1.markRunning(cA.id, 'worker-A', fakeNow)
    queue1.completeTask(cA.id, 'worker-A', fakeNow)

    // cB expires -> uncertainExecution = true
    queue2.expireStaleClaims(fakeNow + 15_000)

    // Retention prunes old completed task cA, NEVER deletes uncertain interrupted task cB
    const pruned = queue1.pruneCompletedHistory({
      olderThanIso: new Date(fakeNow + 1000).toISOString(),
    })
    assert.equal(pruned, 1)
    assert.throws(() => queue1.getTask(cA.id, scope), { code: 'TASK_NOT_FOUND' })
    assert.equal(queue1.getTask(cB.id, scope).uncertainExecution, true)

    // Routine revision update cancels stale queued tasks instead of executing obsolete prompt
    const queueLarge = new ExecutionQueue(db1, { maxQueueCapacity: 50 })
    const staleTask = queueLarge.enqueueOccurrence(r1, '2026-01-01T00:04:00.000Z', fakeNow).task
    assert.equal(staleTask.routineRevision, 1)
    const updated = repo1.update(r1.id, scope, { task: { prompt: 'v2', idempotent: true } }, fakeNow)
    assert.equal(updated.revision, 2)
    assert.equal(queueLarge.claimNext('worker-C', 10_000, fakeNow), null)
    assert.equal(queueLarge.getTask(staleTask.id, scope).status, 'cancelled')
    assert.equal(queueLarge.getTask(staleTask.id, scope).errorCode, 'STALE_ROUTINE_REVISION')

    db1.close()
    db2.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('5A.2 manual, event, and OpenClaw ownership boundaries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ghost-sched-triggers-'))
  const scope = { ownerId: 'u1', botId: 'chief' }
  const otherScope = { ownerId: 'u2', botId: 'chief' }

  try {
    const db = openSchedulerDatabase(dir)
    const repo = new RoutineRepository(db)
    const queue = new ExecutionQueue(db)
    const fakeNow = Date.parse('2026-01-01T12:00:00.000Z')
    const engine = new SchedulerEngine({
      repository: repo,
      queue,
      clock: { nowMs: () => fakeNow },
    })

    // External OpenClaw routine is never scheduled, manually triggered, or event-matched
    const ocRoutine = repo.create(
      {
        name: 'OpenClaw Owned',
        ...scope,
        ownership: 'openclaw',
        timezone: 'UTC',
        trigger: { kind: 'cron', expression: '* * * * *' },
        task: { prompt: 'External', idempotent: true },
      },
      fakeNow,
    )
    assert.equal(engine.tick().evaluatedRoutines, 0)
    assert.throws(
      () => engine.triggerManual({ routineId: ocRoutine.id, scope, idempotencyKey: 'm-1' }),
      { code: 'EXTERNAL_ROUTINE_OWNERSHIP' },
    )

    // Manual trigger: scope isolation + idempotency + disabled check
    const evtRoutine = repo.create(
      {
        name: 'PR Event Routine',
        ...scope,
        timezone: 'UTC',
        trigger: {
          kind: 'event',
          eventType: 'git.pr.opened',
          conditions: [
            { field: 'repo', op: 'prefix', value: 'ghost-' },
            { field: 'branch', op: 'in', value: ['main', 'release'] },
          ],
        },
        task: { prompt: 'Review PR', idempotent: true },
      },
      fakeNow,
    )

    assert.throws(
      () =>
        engine.triggerManual({ routineId: evtRoutine.id, scope: otherScope, idempotencyKey: 'k1' }),
      { code: 'SCOPE_FORBIDDEN' },
    )
    const m1 = engine.triggerManual({ routineId: evtRoutine.id, scope, idempotencyKey: 'k1' })
    const m2 = engine.triggerManual({ routineId: evtRoutine.id, scope, idempotencyKey: 'k1' })
    assert.equal(m1.created, true)
    assert.equal(m2.created, false)
    assert.equal(m1.task.triggerSource, 'manual')

    // Synthetic event matching & deduplication
    const evRes1 = engine.ingestSyntheticEvent({
      eventId: 'evt-100',
      trustedSource: 'local-git-hook',
      eventType: 'git.pr.opened',
      timestamp: '2026-01-01T12:01:00.000Z',
      scope,
      payload: { repo: 'ghost-bot', branch: 'main' },
    })
    assert.equal(evRes1.enqueuedTasks, 1)
    assert.equal(evRes1.tasks[0]?.triggerSource, 'event')

    const evResDup = engine.ingestSyntheticEvent({
      eventId: 'evt-100',
      trustedSource: 'local-git-hook',
      eventType: 'git.pr.opened',
      timestamp: '2026-01-01T12:01:00.000Z',
      scope,
      payload: { repo: 'ghost-bot', branch: 'main' },
    })
    assert.equal(evResDup.enqueuedTasks, 0)
    assert.equal(evResDup.duplicatesSuppressed, 1)

    // Unsupported operator rejected
    assert.throws(
      () =>
        repo.create({
          name: 'Bad Op',
          ...scope,
          timezone: 'UTC',
          trigger: {
            kind: 'event',
            eventType: 'x',
            conditions: [{ field: 'a', op: 'regex' as unknown as 'eq', value: '.*' }],
          },
          task: { prompt: 'hi', idempotent: true },
        }),
      { code: 'UNSUPPORTED_EVENT_OPERATOR' },
    )

    // Oversized event payload rejected
    assert.throws(
      () =>
        engine.ingestSyntheticEvent({
          eventId: 'evt-big',
          trustedSource: 'src',
          eventType: 'git.pr.opened',
          timestamp: '2026-01-01T12:01:00.000Z',
          scope,
          payload: { big: 'a'.repeat(5000) },
        }),
      { code: 'INVALID_EVENT' },
    )

    db.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
