import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import test from 'node:test'
import type { RoutineRecord } from '../src/contracts/types.ts'
import { computeNextRunMs, evaluateDueOccurrences } from '../src/schedules/calculator.ts'
import { computeNextCronRunMs, parseCronExpression } from '../src/schedules/cron.ts'

test('cron: parses valid 5-field expressions, aliases, Sunday 0/7, and rejects invalid/unsupported syntax', () => {
  const p1 = parseCronExpression('*/15 9-17 1,15 JAN-MAR MON-FRI')
  assert.deepEqual(p1.minutes, [0, 15, 30, 45])
  assert.deepEqual(p1.months, [1, 2, 3])
  assert.deepEqual(p1.daysOfWeek, [1, 2, 3, 4, 5])

  const sun0 = parseCronExpression('30 14 * * 0')
  const sun7 = parseCronExpression('30 14 * * 7')
  assert.deepEqual(sun0.daysOfWeek, [0])
  assert.deepEqual(sun7.daysOfWeek, [0])

  for (const bad of [
    '* * * *',
    '0 * * * * *',
    '0 0 5-2 * *',
    '*/0 * * * *',
    '0 0 30 2 *',
    '0 0 31 4 *',
    '@daily',
    '0 0 L * *',
    '0 0 15W * *',
    '0 0 * * 1#1',
    '0 0 ? * *',
  ]) {
    assert.throws(() => parseCronExpression(bad), { code: 'INVALID_CRON' }, `Expected ${bad} to fail`)
  }
})

test('cron: leap years, month/year boundaries, DOM/DOW union, timezones, DST, and worst-case bound', () => {
  // Leap year Feb 29
  const leap = parseCronExpression('0 12 29 2 *')
  const from2025 = Date.parse('2025-03-01T00:00:00.000Z')
  assert.equal(
    computeNextCronRunMs(leap, 'UTC', from2025),
    Date.parse('2028-02-29T12:00:00.000Z'),
  )

  // Month & year boundary (Dec 31 23:55 -> Jan 1 00:00)
  const dailyMidnight = parseCronExpression('0 0 * * *')
  assert.equal(
    computeNextCronRunMs(dailyMidnight, 'Asia/Ho_Chi_Minh', Date.parse('2026-12-31T16:55:00.000Z')),
    // 16:55 UTC = 23:55 ICT -> next 00:00 ICT is 17:00 UTC
    Date.parse('2026-12-31T17:00:00.000Z'),
  )

  // DOM + DOW union semantics: 15th OR Monday
  const union = parseCronExpression('0 9 15 * 1')
  // 2026-06-14 is Sunday; 2026-06-15 is Monday (both match), 2026-06-22 is Monday (matches DOW)
  assert.equal(
    computeNextCronRunMs(union, 'UTC', Date.parse('2026-06-15T09:00:00.000Z')),
    Date.parse('2026-06-22T09:00:00.000Z'),
  )

  // DST spring-forward (2026-03-08 America/New_York 02:30 skipped -> advances to Mar 9)
  const dstCron = parseCronExpression('30 2 * * *')
  assert.equal(
    computeNextCronRunMs(dstCron, 'America/New_York', Date.parse('2026-03-08T06:00:00.000Z')),
    Date.parse('2026-03-09T06:30:00.000Z'),
  )

  // DST fall-back (2026-11-01 America/New_York 01:30 repeated -> fires once at EDT, next is Nov 2 EST)
  const fallCron = parseCronExpression('30 1 * * *')
  const firstFall = computeNextCronRunMs(
    fallCron,
    'America/New_York',
    Date.parse('2026-11-01T05:00:00.000Z'),
  )
  assert.equal(firstFall, Date.parse('2026-11-01T05:30:00.000Z'))
  assert.equal(
    computeNextCronRunMs(fallCron, 'America/New_York', firstFall!),
    Date.parse('2026-11-02T06:30:00.000Z'),
  )

  // Worst-case 4-year horizon measurement (impossible in 2025-2027, Feb 29 only in 2028)
  const t0 = performance.now()
  const nextLeap = computeNextCronRunMs(leap, 'UTC', Date.parse('2025-01-01T00:00:00.000Z'))
  const elapsedMs = performance.now() - t0
  assert.equal(nextLeap, Date.parse('2028-02-29T12:00:00.000Z'))
  assert.ok(elapsedMs < 100, `Worst-case cron search took ${elapsedMs.toFixed(2)}ms`)
})

test('cron: missed-run policies (skip, run-once, bounded-catch-up) and clock rollback', () => {
  const base: RoutineRecord = {
    id: 'rtn-cron',
    name: 'Hourly Cron',
    description: '',
    ownerId: 'u1',
    botId: 'chief',
    ownership: 'ghost-bot',
    revision: 1,
    trigger: { kind: 'cron', expression: '0 * * * *' },
    timezone: 'UTC',
    task: { prompt: 'Check', idempotent: true },
    enabled: true,
    archivedAt: null,
    missedRunPolicy: 'bounded-catch-up',
    maxCatchUpRuns: 3,
    concurrencyPolicy: 'forbid',
    maxConcurrentRuns: 1,
    retryPolicy: { maxAttempts: 1, backoffMs: 1000, retryNonIdempotent: false },
    expiresAt: null,
    nextRunAt: '2026-01-01T00:00:00.000Z',
    lastRunAt: null,
    lastEvaluatedAt: null,
    lastTaskStatus: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }

  // 10 hours downtime -> bounded to 3
  const nowMs = Date.parse('2026-01-01T10:05:00.000Z')
  const catchUp = evaluateDueOccurrences(base, nowMs)
  assert.deepEqual(catchUp.dueOccurrences, [
    '2026-01-01T08:00:00.000Z',
    '2026-01-01T09:00:00.000Z',
    '2026-01-01T10:00:00.000Z',
  ])
  assert.equal(catchUp.nextRunAt, '2026-01-01T11:00:00.000Z')

  assert.equal(
    evaluateDueOccurrences({ ...base, missedRunPolicy: 'run-once' }, nowMs).dueOccurrences.length,
    1,
  )
  assert.equal(
    evaluateDueOccurrences({ ...base, missedRunPolicy: 'skip' }, nowMs, 5000).dueOccurrences.length,
    0,
  )

  // Clock rollback
  assert.equal(
    evaluateDueOccurrences({ ...base, lastEvaluatedAt: '2026-01-01T11:00:00.000Z' }, nowMs)
      .dueOccurrences.length,
    0,
  )
  assert.equal(
    computeNextRunMs({ kind: 'cron', expression: '0 9 * * *' }, 'UTC', Date.parse('2026-01-01T08:00:00Z')),
    Date.parse('2026-01-01T09:00:00Z'),
  )
})
