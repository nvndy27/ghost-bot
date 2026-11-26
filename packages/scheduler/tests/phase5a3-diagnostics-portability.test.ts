import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import test from 'node:test'
import { diagnoseRoutine } from '../src/diagnostics/diagnostics.ts'
import { MAX_PREVIEW_COUNT, previewRoutineSchedule } from '../src/diagnostics/preview.ts'
import { getRoutineStatistics } from '../src/diagnostics/statistics.ts'
import { SchedulerEngine } from '../src/engine/scheduler-engine.ts'
import {
  commitImportRoutines,
  exportRoutines,
  MAX_IMPORT_BYTES,
  previewImportRoutines,
} from '../src/portability/export-import.ts'
import { ExecutionQueue } from '../src/queue/execution-queue.ts'
import { RoutineRepository } from '../src/repository/routine-repository.ts'
import { openSchedulerDatabase } from '../src/repository/sqlite-store.ts'
import { computeNextCronRunMs, parseCronExpression } from '../src/schedules/cron.ts'
import { MAX_SIM_ROUTINES, runDryRunSimulation } from '../src/simulator/dry-run.ts'

test('5A.3 hardening: dedup survives history pruning, dispatch revalidates revision, manual idempotency conflict, and 2100 non-leap century', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ghost-sched-5a3-h-'))
  const scope = { ownerId: 'u1', botId: 'chief' }

  try {
    const db = openSchedulerDatabase(dir)
    const repo = new RoutineRepository(db)
    const queue = new ExecutionQueue(db)
    const nowMs = Date.parse('2026-01-01T00:00:00.000Z')
    const engine = new SchedulerEngine({ repository: repo, queue, clock: { nowMs: () => nowMs } })

    const r1 = repo.create(
      {
        name: 'Dedup & Race Routine',
        ...scope,
        timezone: 'UTC',
        trigger: { kind: 'interval', intervalMs: 60_000, anchorAt: '2026-01-01T00:00:00.000Z' },
        task: { prompt: 'Run v1', idempotent: true },
      },
      nowMs,
    )

    // 1. Enqueue, complete, prune history -> dedup ledger STILL blocks re-enqueueing same occurrence
    const enq = queue.enqueueOccurrence(r1, '2026-01-01T00:00:00.000Z', nowMs)
    const claimed = queue.claimNext('w1', 10_000, nowMs)
    assert.equal(claimed?.id, enq.task.id)
    queue.markRunning(claimed!.id, 'w1', nowMs)
    queue.completeTask(claimed!.id, 'w1', nowMs + 100)
    assert.equal(queue.pruneCompletedHistory({ olderThanIso: '2026-01-01T01:00:00.000Z' }), 1)
    assert.throws(
      () => queue.enqueueOccurrence(r1, '2026-01-01T00:00:00.000Z', nowMs + 200),
      { code: 'DUPLICATE_OCCURRENCE' },
    )

    // 2. Manual idempotency conflict when routine revision/task changes
    const m1 = engine.triggerManual({ routineId: r1.id, scope, idempotencyKey: 'manual-k1' })
    const m1Retry = engine.triggerManual({ routineId: r1.id, scope, idempotencyKey: 'manual-k1' })
    assert.equal(m1Retry.created, false)
    assert.equal(m1Retry.task.id, m1.task.id)

    repo.update(r1.id, scope, { task: { prompt: 'Run v2', idempotent: true } }, nowMs + 500)
    assert.throws(
      () => engine.triggerManual({ routineId: r1.id, scope, idempotencyKey: 'manual-k1' }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    )

    // Drain stale manual task m1 (auto-cancelled by claimNext due to revision bump)
    assert.equal(queue.claimNext('w-pre', 10_000, nowMs), null)
    assert.equal(queue.getTask(m1.task.id, scope).status, 'cancelled')

    // 3. Revision race between claimNext and dispatchNext:
    // Queue task at rev 1, update to rev 2 before dispatch -> dispatcher is NEVER invoked
    const r2 = repo.create(
      {
        name: 'Race Guard',
        ...scope,
        timezone: 'UTC',
        trigger: { kind: 'one-time', runAt: '2026-01-01T00:05:00.000Z' },
        task: { prompt: 'Before edit', idempotent: true },
      },
      nowMs,
    )
    queue.enqueueOccurrence(r2, '2026-01-01T00:05:00.000Z', nowMs)
    const origClaimNext = queue.claimNext.bind(queue)
    let dispatchedCalls = 0
    // Hook claimNext to simulate an external update between claim and dispatch
    queue.claimNext = (workerId: string, leaseMs: number, tMs?: number) => {
      const c = origClaimNext(workerId, leaseMs, tMs)
      if (c && c.routineId === r2.id) {
        repo.update(r2.id, scope, { task: { prompt: 'After edit', idempotent: true } }, nowMs + 1000)
      }
      return c
    }
    const raceResult = await engine.dispatchNext(
      {
        async dispatch() {
          dispatchedCalls += 1
          return { status: 'completed' }
        },
      },
      'w-race',
    )
    assert.equal(dispatchedCalls, 0)
    assert.equal(raceResult?.status, 'failed')
    assert.equal(raceResult?.errorCode, 'STALE_ROUTINE_REVISION')

    // 4. Cron non-leap century 2100 & Vixie DOM/DOW union with Feb 30 + Mon
    const feb29 = parseCronExpression('0 12 29 2 *')
    assert.equal(computeNextCronRunMs(feb29, 'UTC', Date.parse('2096-03-01T00:00:00Z')), null)
    const unionFeb30Mon = parseCronExpression('0 0 30 2 1')
    assert.ok(computeNextCronRunMs(unionFeb30Mon, 'UTC', Date.parse('2026-01-01T00:00:00Z')) !== null)

    db.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('5A.3 preview, diagnostics, statistics, dry-run simulator, and export/import security', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ghost-sched-5a3-f-'))
  const scope = { ownerId: 'u1', botId: 'chief' }
  const otherScope = { ownerId: 'u2', botId: 'other' }

  try {
    const db = openSchedulerDatabase(dir)
    const repo = new RoutineRepository(db)
    const queue = new ExecutionQueue(db)
    const startMs = Date.parse('2026-03-08T05:00:00.000Z')

    // Preview: bounded count, DST note, expiration truncation, event_driven
    const prev = previewRoutineSchedule(
      {
        name: 'NY Daily',
        ...scope,
        timezone: 'America/New_York',
        trigger: { kind: 'daily', hour: 3, minute: 30 },
        task: { prompt: 'Morning check', idempotent: true },
        expiresAt: '2026-03-10T10:00:00.000Z',
      },
      { startAtMs: startMs, count: 99 },
    )
    assert.equal(prev.valid, true)
    assert.equal(prev.requestedCount, MAX_PREVIEW_COUNT)
    assert.equal(prev.truncatedByExpiration, true)
    assert.equal(prev.occurrences.length, 3)

    const evPrev = previewRoutineSchedule(
      {
        name: 'Event',
        ...scope,
        timezone: 'UTC',
        trigger: { kind: 'event', eventType: 'file.changed' },
        task: { prompt: 'Inspect', idempotent: true },
      },
      { startAtMs: startMs, count: 5 },
    )
    assert.equal(evPrev.status, 'event_driven')
    assert.equal(evPrev.occurrences.length, 0)

    // Diagnostics & Statistics
    const r = repo.create(
      {
        name: 'Stats Routine',
        ...scope,
        timezone: 'UTC',
        trigger: { kind: 'interval', intervalMs: 60_000, anchorAt: '2026-03-08T05:00:00.000Z' },
        task: { prompt: 'Measure', idempotent: true },
      },
      startMs,
    )
    const diagDue = diagnoseRoutine(repo, r.id, scope, { nowMs: startMs })
    assert.equal(diagDue.eligibleForScheduling, true)
    assert.ok(diagDue.reasonCodes.includes('ELIGIBLE'))

    const emptyStats = getRoutineStatistics(repo, r.id, scope)
    assert.equal(emptyStats.successRate, null)
    assert.equal(emptyStats.averageDurationMs, null)

    queue.enqueueOccurrence(r, '2026-03-08T05:00:00.000Z', startMs)
    const c = queue.claimNext('w1', 10_000, startMs)
    queue.markRunning(c!.id, 'w1', startMs + 100)
    queue.completeTask(c!.id, 'w1', startMs + 350)
    const stats1 = getRoutineStatistics(repo, r.id, scope)
    assert.equal(stats1.completedTasks, 1)
    assert.equal(stats1.successRate, 1)
    assert.equal(stats1.averageDurationMs, 250)
    assert.throws(() => getRoutineStatistics(repo, r.id, otherScope), { code: 'SCOPE_FORBIDDEN' })

    // Dry-run simulator: isolated, deterministic, bounded
    const sim = runDryRunSimulation({
      routines: [
        {
          name: 'Sim Cron',
          ...scope,
          timezone: 'UTC',
          trigger: { kind: 'cron', expression: '*/5 * * * *' },
          task: { prompt: 'Sim prompt', idempotent: true },
        },
      ],
      startMs: Date.parse('2026-01-01T00:00:00.000Z'),
      endMs: Date.parse('2026-01-01T00:20:00.000Z'),
      tickIntervalMs: 5 * 60_000,
    })
    assert.equal(sim.simulatedOnly, true)
    assert.equal(sim.ticksExecuted, 5)
    assert.equal(sim.expectedOccurrences, 5)
    // Source DB untouched
    assert.equal(repo.list(scope).total, 1)
    assert.throws(
      () =>
        runDryRunSimulation({
          routines: Array.from({ length: MAX_SIM_ROUTINES + 1 }, (_, i) => ({
            name: `R${i}`,
            ...scope,
            timezone: 'UTC',
            trigger: { kind: 'daily', hour: 9, minute: 0 },
            task: { prompt: 'x', idempotent: true },
          })),
          startMs,
        }),
      { code: 'SIMULATION_LIMIT_EXCEEDED' },
    )

    // Export/Import: round-trip, disabled-by-default, spoofed ownership bound to receivingScope, secret/oversized rejection
    const bundle = exportRoutines(repo, [r.id], scope, startMs)
    const bundleJson = JSON.stringify(bundle)
    assert.doesNotMatch(bundleJson, /ownerId|botId/)

    const previewImp = previewImportRoutines(bundleJson, otherScope, repo, 'skip')
    assert.equal(previewImp.wouldCreate, 1)
    const committed = commitImportRoutines(bundleJson, otherScope, repo, 'skip', startMs)
    assert.equal(committed.imported.length, 1)
    assert.equal(committed.imported[0]?.enabled, false)
    assert.equal(committed.imported[0]?.ownerId, otherScope.ownerId)
    assert.equal(committed.imported[0]?.botId, otherScope.botId)
    assert.notEqual(committed.imported[0]?.id, r.id)

    // Reject unknown fields (spoofed ownerId), secrets, and oversized payloads
    const spoofed = JSON.stringify({
      ...bundle,
      routines: [{ ...bundle.routines[0], ownerId: 'evil-admin' }],
    })
    assert.throws(() => previewImportRoutines(spoofed, otherScope, repo), { code: 'INVALID_IMPORT' })

    const withSecret = JSON.stringify({
      ...bundle,
      routines: [
        { ...bundle.routines[0], task: { prompt: 'Use sk-ant-secret1234567890', idempotent: true } },
      ],
    })
    assert.throws(
      () => previewImportRoutines(withSecret, otherScope, repo),
      { code: 'CREDENTIAL_EXPOSURE_BLOCKED' },
    )
    assert.throws(
      () => previewImportRoutines('x'.repeat(MAX_IMPORT_BYTES + 1), otherScope, repo),
      { code: 'INVALID_IMPORT' },
    )

    // Dense cron multi-routine benchmark
    const tBench = performance.now()
    const denseSim = runDryRunSimulation({
      routines: Array.from({ length: 10 }, (_, i) => ({
        name: `Dense ${i}`,
        ...scope,
        timezone: 'UTC',
        trigger: { kind: 'cron', expression: '* * * * *' },
        task: { prompt: `Dense task ${i}`, idempotent: true },
      })),
      startMs: Date.parse('2026-01-01T00:00:00.000Z'),
      endMs: Date.parse('2026-01-01T00:10:00.000Z'),
      tickIntervalMs: 60_000,
    })
    const benchMs = performance.now() - tBench
    assert.equal(denseSim.expectedOccurrences, 110)
    assert.ok(benchMs < 2000, `Dense 10-routine simulation took ${benchMs.toFixed(1)}ms`)

    db.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
