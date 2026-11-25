import assert from 'node:assert/strict'
import test from 'node:test'
import type { RoutineRecord } from '../src/contracts/types.ts'
import { computeNextRunMs, evaluateDueOccurrences } from '../src/schedules/calculator.ts'
import { validateCreateRoutineInput } from '../src/security/validation.ts'

function makeRoutine(overrides: Partial<RoutineRecord> = {}): RoutineRecord {
  const now = '2026-01-01T00:00:00.000Z'
  return {
    id: 'rtn-1',
    name: 'Test Routine',
    description: 'desc',
    ownerId: 'owner-1',
    botId: 'chief',
    ownership: 'ghost-bot',
    revision: 1,
    trigger: { kind: 'daily', hour: 9, minute: 0, second: 0 },
    timezone: 'UTC',
    task: { prompt: 'Summarize', idempotent: true },
    enabled: true,
    archivedAt: null,
    missedRunPolicy: 'skip',
    maxCatchUpRuns: 3,
    concurrencyPolicy: 'forbid',
    maxConcurrentRuns: 1,
    retryPolicy: { maxAttempts: 2, backoffMs: 1000, retryNonIdempotent: false },
    expiresAt: null,
    nextRunAt: '2026-01-01T09:00:00.000Z',
    lastRunAt: null,
    lastEvaluatedAt: null,
    lastTaskStatus: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

test('schedules: one-time, interval, daily, and weekly deterministic calculations', () => {
  const t0 = Date.parse('2026-01-05T08:00:00.000Z') // Monday
  assert.equal(
    computeNextRunMs({ kind: 'one-time', runAt: '2026-01-05T10:00:00.000Z' }, 'UTC', t0),
    Date.parse('2026-01-05T10:00:00.000Z'),
  )
  assert.equal(
    computeNextRunMs({ kind: 'one-time', runAt: '2026-01-05T07:00:00.000Z' }, 'UTC', t0),
    null,
  )

  assert.equal(
    computeNextRunMs(
      { kind: 'interval', intervalMs: 60_000, anchorAt: '2026-01-05T08:00:00.000Z' },
      'UTC',
      t0,
    ),
    Date.parse('2026-01-05T08:01:00.000Z'),
  )

  assert.equal(
    computeNextRunMs({ kind: 'daily', hour: 9, minute: 30, second: 0 }, 'Asia/Tokyo', t0),
    // 08:00 UTC = 17:00 JST, so next 09:30 JST is 2026-01-06 00:30 UTC
    Date.parse('2026-01-06T00:30:00.000Z'),
  )

  // Weekly: Wednesday (3) at 09:00 UTC from Monday 08:00 UTC
  assert.equal(
    computeNextRunMs({ kind: 'weekly', daysOfWeek: [3], hour: 9, minute: 0, second: 0 }, 'UTC', t0),
    Date.parse('2026-01-07T09:00:00.000Z'),
  )
})

test('schedules: DST spring-forward skips non-existent hour and fall-back never fires twice', () => {
  // 2026-03-08 America/New_York springs forward at 02:00 -> 03:00 (02:30 does not exist)
  const beforeSpring = Date.parse('2026-03-08T06:00:00.000Z') // 01:00 EST
  const nextSpring = computeNextRunMs(
    { kind: 'daily', hour: 2, minute: 30, second: 0 },
    'America/New_York',
    beforeSpring,
  )
  // Advances cleanly to 2026-03-09 02:30 EDT (06:30 UTC) without infinite loop
  assert.equal(nextSpring, Date.parse('2026-03-09T06:30:00.000Z'))

  // 2026-11-01 America/New_York falls back at 02:00 -> 01:00 (01:30 happens twice: 05:30Z EDT, 06:30Z EST)
  const beforeFall = Date.parse('2026-11-01T05:00:00.000Z') // 01:00 EDT
  const firstFall = computeNextRunMs(
    { kind: 'daily', hour: 1, minute: 30, second: 0 },
    'America/New_York',
    beforeFall,
  )
  assert.equal(firstFall, Date.parse('2026-11-01T05:30:00.000Z'))

  // Immediately after first 01:30 EDT, next run must be 2026-11-02 01:30 EST (06:30Z), NOT repeated same-day 01:30 EST
  const afterFirst = computeNextRunMs(
    { kind: 'daily', hour: 1, minute: 30, second: 0 },
    'America/New_York',
    firstFall!,
  )
  assert.equal(afterFirst, Date.parse('2026-11-02T06:30:00.000Z'))
})

test('schedules: invalid schedules rejected, clock rollback safe, disabled/expired excluded, missed-run policies bounded', () => {
  assert.throws(
    () =>
      validateCreateRoutineInput({
        name: 'Bad TZ',
        ownerId: 'o1',
        botId: 'b1',
        timezone: 'Mars/Olympus',
        trigger: { kind: 'daily', hour: 9, minute: 0 },
        task: { prompt: 'hi', idempotent: true },
      }),
    /Unsupported IANA timezone/,
  )
  assert.throws(
    () =>
      validateCreateRoutineInput({
        name: 'Bad Interval',
        ownerId: 'o1',
        botId: 'b1',
        timezone: 'UTC',
        trigger: { kind: 'interval', intervalMs: 50, anchorAt: '2026-01-01T00:00:00Z' },
        task: { prompt: 'hi', idempotent: true },
      }),
    /intervalMs/,
  )

  // Disabled & expired
  const disabled = makeRoutine({ enabled: false })
  assert.deepEqual(evaluateDueOccurrences(disabled, Date.parse('2026-01-02T00:00:00Z')).dueOccurrences, [])

  const expired = makeRoutine({ expiresAt: '2026-01-01T08:00:00.000Z' })
  const expEval = evaluateDueOccurrences(expired, Date.parse('2026-01-01T09:00:00.000Z'))
  assert.deepEqual(expEval.dueOccurrences, [])
  assert.equal(expEval.nextRunAt, null)

  // Clock rollback: nowMs < lastEvaluatedAt emits nothing
  const rolledBack = makeRoutine({ lastEvaluatedAt: '2026-01-01T10:00:00.000Z' })
  assert.deepEqual(
    evaluateDueOccurrences(rolledBack, Date.parse('2026-01-01T09:30:00.000Z')).dueOccurrences,
    [],
  )

  // Forward jump with bounded-catch-up vs run-once vs skip
  const intervalRoutine = makeRoutine({
    trigger: { kind: 'interval', intervalMs: 60_000, anchorAt: '2026-01-01T00:00:00.000Z' },
    nextRunAt: '2026-01-01T00:00:00.000Z',
    missedRunPolicy: 'bounded-catch-up',
    maxCatchUpRuns: 3,
  })
  const jumpNow = Date.parse('2026-01-01T00:10:30.000Z')
  const catchUp = evaluateDueOccurrences(intervalRoutine, jumpNow)
  assert.equal(catchUp.dueOccurrences.length, 3)
  assert.equal(catchUp.nextRunAt, '2026-01-01T00:11:00.000Z')

  const runOnce = evaluateDueOccurrences({ ...intervalRoutine, missedRunPolicy: 'run-once' }, jumpNow)
  assert.equal(runOnce.dueOccurrences.length, 1)

  const skipOld = evaluateDueOccurrences({ ...intervalRoutine, missedRunPolicy: 'skip' }, jumpNow, 5000)
  assert.equal(skipOld.dueOccurrences.length, 0)
  assert.equal(skipOld.nextRunAt, '2026-01-01T00:11:00.000Z')
})
