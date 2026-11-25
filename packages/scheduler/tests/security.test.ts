import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateDueOccurrences } from '../src/schedules/calculator.ts'
import {
  MAX_CATCHUP_RUNS,
  MAX_PROMPT_BYTES,
  redactSchedulerSecrets,
  validateCreateRoutineInput,
} from '../src/security/validation.ts'

test('security: rejects control chars, oversized payloads, full-access hints, and unbounded catch-up', () => {
  assert.throws(
    () =>
      validateCreateRoutineInput({
        name: 'Evil\x00Name',
        ownerId: 'u1',
        botId: 'chief',
        timezone: 'UTC',
        trigger: { kind: 'daily', hour: 9, minute: 0 },
        task: { prompt: 'hi', idempotent: true },
      }),
    /control characters/,
  )

  assert.throws(
    () =>
      validateCreateRoutineInput({
        name: 'Too Big',
        ownerId: 'u1',
        botId: 'chief',
        timezone: 'UTC',
        trigger: { kind: 'daily', hour: 9, minute: 0 },
        task: { prompt: 'x'.repeat(MAX_PROMPT_BYTES + 1), idempotent: true },
      }),
    /bytes limit/,
  )

  assert.throws(
    () =>
      validateCreateRoutineInput({
        name: 'Escalate',
        ownerId: 'u1',
        botId: 'chief',
        timezone: 'UTC',
        trigger: { kind: 'daily', hour: 9, minute: 0 },
        task: {
          prompt: 'hi',
          requestedPermissionHint: 'full-access' as unknown as 'read-only',
          idempotent: true,
        },
      }),
    /requestedPermissionHint/,
  )

  assert.throws(
    () =>
      validateCreateRoutineInput({
        name: 'Huge Catchup',
        ownerId: 'u1',
        botId: 'chief',
        timezone: 'UTC',
        trigger: { kind: 'daily', hour: 9, minute: 0 },
        task: { prompt: 'hi', idempotent: true },
        missedRunPolicy: 'bounded-catch-up',
        maxCatchUpRuns: MAX_CATCHUP_RUNS + 1,
      }),
    /maxCatchUpRuns/,
  )

  // Unbounded catch-up prevention over 1-year downtime
  const eval1Year = evaluateDueOccurrences(
    {
      id: 'rtn-huge',
      name: '1m interval',
      description: '',
      ownerId: 'u1',
      botId: 'chief',
      trigger: { kind: 'interval', intervalMs: 60_000, anchorAt: '2025-01-01T00:00:00.000Z' },
      timezone: 'UTC',
      task: { prompt: 'tick', idempotent: true },
      enabled: true,
      archivedAt: null,
      missedRunPolicy: 'bounded-catch-up',
      maxCatchUpRuns: MAX_CATCHUP_RUNS,
      concurrencyPolicy: 'forbid',
      maxConcurrentRuns: 1,
      retryPolicy: { maxAttempts: 1, backoffMs: 1000, retryNonIdempotent: false },
      expiresAt: null,
      nextRunAt: '2025-01-01T00:00:00.000Z',
      lastRunAt: null,
      lastEvaluatedAt: null,
      lastTaskStatus: null,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    },
    Date.parse('2026-01-01T00:00:00.000Z'),
  )
  assert.equal(eval1Year.dueOccurrences.length, MAX_CATCHUP_RUNS)

  const redacted = redactSchedulerSecrets('Failed with Bearer abc.def token=xyz sk-1234567890')
  assert.doesNotMatch(redacted, /abc\.def|xyz|sk-1234567890/)
})
