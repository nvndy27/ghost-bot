import type {
  ConcurrencyPolicy,
  CreateRoutineInput,
  MissedRunPolicy,
  RetryPolicy,
  RoutineOwnership,
  RoutineScope,
  RoutineTaskDefinition,
  TriggerConfig,
} from '../contracts/types.ts'
import { parseCronExpression } from '../schedules/cron.ts'
import { validateEventConditions } from '../schedules/event-matcher.ts'

export const MAX_NAME_LENGTH = 120
export const MAX_DESCRIPTION_LENGTH = 1000
export const MAX_PROMPT_BYTES = 16 * 1024
export const MAX_METADATA_KEYS = 16
export const MAX_METADATA_BYTES = 4 * 1024
export const MAX_CATCHUP_RUNS = 10
export const MAX_CONCURRENT_RUNS = 5
export const MAX_RETRY_ATTEMPTS = 5
export const MAX_RETRY_BACKOFF_MS = 3_600_000
export const MAX_INTERVAL_MS = 365 * 24 * 60 * 60 * 1000
export const MIN_INTERVAL_MS = 1000
export const DEFAULT_QUEUE_CAPACITY = 1000

export class SchedulerError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(redactSchedulerSecrets(message))
    this.name = 'SchedulerError'
    this.code = code
  }
}

export function redactSchedulerSecrets(input: string): string {
  return input
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/(token|password|secret|apiKey|api_key)\s*[=:]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
}

export function assertNoControlChars(value: string, label: string): string {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      throw new SchedulerError('INVALID_INPUT', `${label} contains disallowed control characters`)
    }
  }
  return value
}

export function assertNonEmptyBounded(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  if (typeof value !== 'string') {
    throw new SchedulerError('INVALID_INPUT', `${label} must be a string`)
  }
  assertNoControlChars(value, label)
  const trimmed = value.trim()
  if (!trimmed) {
    throw new SchedulerError('INVALID_INPUT', `${label} must not be empty`)
  }
  if (trimmed.length > maxLength) {
    throw new SchedulerError('INVALID_INPUT', `${label} exceeds max length (${maxLength})`)
  }
  return trimmed
}

export function assertValidTimezone(tz: unknown): string {
  const normalized = assertNonEmptyBounded(tz, 'timezone', 64)
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: normalized }).format(new Date(0))
  } catch {
    throw new SchedulerError('INVALID_TIMEZONE', `Unsupported IANA timezone "${normalized}"`)
  }
  return normalized
}

export function assertValidIsoTimestamp(raw: unknown, label: string): string {
  if (typeof raw !== 'string') {
    throw new SchedulerError('INVALID_INPUT', `${label} must be an ISO-8601 timestamp string`)
  }
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) {
    throw new SchedulerError('INVALID_INPUT', `${label} is not a valid timestamp`)
  }
  return new Date(ms).toISOString()
}

export function validateTriggerConfig(trigger: unknown): TriggerConfig {
  if (!trigger || typeof trigger !== 'object') {
    throw new SchedulerError('INVALID_SCHEDULE', 'Trigger configuration must be an object')
  }
  const t = trigger as Record<string, unknown>
  if (t.kind === 'one-time') {
    return { kind: 'one-time', runAt: assertValidIsoTimestamp(t.runAt, 'trigger.runAt') }
  }
  if (t.kind === 'interval') {
    if (
      typeof t.intervalMs !== 'number' ||
      !Number.isInteger(t.intervalMs) ||
      t.intervalMs < MIN_INTERVAL_MS ||
      t.intervalMs > MAX_INTERVAL_MS
    ) {
      throw new SchedulerError(
        'INVALID_SCHEDULE',
        `intervalMs must be an integer between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS}`,
      )
    }
    return {
      kind: 'interval',
      intervalMs: t.intervalMs,
      anchorAt: assertValidIsoTimestamp(t.anchorAt, 'trigger.anchorAt'),
    }
  }
  if (t.kind === 'daily' || t.kind === 'weekly') {
    const hour = t.hour
    const minute = t.minute
    const second = t.second ?? 0
    if (
      typeof hour !== 'number' ||
      !Number.isInteger(hour) ||
      hour < 0 ||
      hour > 23 ||
      typeof minute !== 'number' ||
      !Number.isInteger(minute) ||
      minute < 0 ||
      minute > 59 ||
      typeof second !== 'number' ||
      !Number.isInteger(second) ||
      second < 0 ||
      second > 59
    ) {
      throw new SchedulerError('INVALID_SCHEDULE', 'Invalid hour/minute/second in schedule')
    }
    if (t.kind === 'daily') {
      return { kind: 'daily', hour, minute, second }
    }
    if (!Array.isArray(t.daysOfWeek) || t.daysOfWeek.length === 0) {
      throw new SchedulerError('INVALID_SCHEDULE', 'weekly trigger requires non-empty daysOfWeek')
    }
    const dedup = new Set<number>()
    for (const d of t.daysOfWeek) {
      if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 6) {
        throw new SchedulerError('INVALID_SCHEDULE', 'daysOfWeek values must be integers 0..6')
      }
      dedup.add(d)
    }
    return {
      kind: 'weekly',
      daysOfWeek: [...dedup].sort((a, b) => a - b),
      hour,
      minute,
      second,
    }
  }
  if (t.kind === 'cron') {
    const parsed = parseCronExpression(t.expression as string)
    return { kind: 'cron', expression: parsed.expression }
  }
  if (t.kind === 'event') {
    const eventType = assertNonEmptyBounded(t.eventType, 'trigger.eventType', 128)
    const conditions =
      t.conditions !== undefined ? validateEventConditions(t.conditions) : undefined
    return { kind: 'event', eventType, ...(conditions ? { conditions } : {}) }
  }
  throw new SchedulerError('INVALID_SCHEDULE', 'Unsupported trigger kind')
}

export function validateUntrustedTask(task: unknown): RoutineTaskDefinition {
  if (!task || typeof task !== 'object') {
    throw new SchedulerError('INVALID_INPUT', 'task must be an object')
  }
  const t = task as Record<string, unknown>
  if (typeof t.prompt !== 'string') {
    throw new SchedulerError('INVALID_INPUT', 'task.prompt must be a string')
  }
  assertNoControlChars(t.prompt, 'task.prompt')
  const promptTrimmed = t.prompt.trim()
  if (!promptTrimmed) {
    throw new SchedulerError('INVALID_INPUT', 'task.prompt must not be empty')
  }
  if (Buffer.byteLength(promptTrimmed, 'utf8') > MAX_PROMPT_BYTES) {
    throw new SchedulerError(
      'INVALID_INPUT',
      `task.prompt exceeds ${MAX_PROMPT_BYTES} bytes limit`,
    )
  }

  let metadata: Record<string, string> | undefined
  if (t.metadata !== undefined) {
    if (!t.metadata || typeof t.metadata !== 'object' || Array.isArray(t.metadata)) {
      throw new SchedulerError('INVALID_INPUT', 'task.metadata must be a flat string map')
    }
    const entries = Object.entries(t.metadata as Record<string, unknown>)
    if (entries.length > MAX_METADATA_KEYS) {
      throw new SchedulerError('INVALID_INPUT', `task.metadata exceeds ${MAX_METADATA_KEYS} keys`)
    }
    const clean: Record<string, string> = {}
    for (const [k, v] of entries) {
      if (typeof v !== 'string') {
        throw new SchedulerError('INVALID_INPUT', `task.metadata["${k}"] must be a string`)
      }
      assertNoControlChars(k, 'task.metadata key')
      assertNoControlChars(v, 'task.metadata value')
      clean[k] = v
    }
    if (Buffer.byteLength(JSON.stringify(clean), 'utf8') > MAX_METADATA_BYTES) {
      throw new SchedulerError(
        'INVALID_INPUT',
        `task.metadata exceeds ${MAX_METADATA_BYTES} bytes limit`,
      )
    }
    metadata = clean
  }

  const hint = t.requestedPermissionHint
  if (hint !== undefined && hint !== 'read-only' && hint !== 'ask-approval' && hint !== 'workspace') {
    throw new SchedulerError(
      'INVALID_INPUT',
      'requestedPermissionHint may only be read-only, ask-approval, or workspace',
    )
  }

  return {
    prompt: promptTrimmed,
    ...(metadata ? { metadata } : {}),
    ...(hint ? { requestedPermissionHint: hint } : {}),
    idempotent: Boolean(t.idempotent),
  }
}

export function validateCreateRoutineInput(input: CreateRoutineInput) {
  const name = assertNonEmptyBounded(input.name, 'name', MAX_NAME_LENGTH)
  const descriptionRaw = input.description ?? ''
  if (typeof descriptionRaw !== 'string') {
    throw new SchedulerError('INVALID_INPUT', 'description must be a string')
  }
  assertNoControlChars(descriptionRaw, 'description')
  if (descriptionRaw.length > MAX_DESCRIPTION_LENGTH) {
    throw new SchedulerError(
      'INVALID_INPUT',
      `description exceeds ${MAX_DESCRIPTION_LENGTH} chars`,
    )
  }
  const ownerId = assertNonEmptyBounded(input.ownerId, 'ownerId', 128)
  const botId = assertNonEmptyBounded(input.botId, 'botId', 128)
  const ownership: RoutineOwnership = input.ownership ?? 'ghost-bot'
  if (
    ownership !== 'ghost-bot' &&
    ownership !== 'openclaw' &&
    ownership !== 'external-unknown'
  ) {
    throw new SchedulerError('INVALID_INPUT', 'Invalid routine ownership')
  }
  const timezone = assertValidTimezone(input.timezone)
  const trigger = validateTriggerConfig(input.trigger)
  const task = validateUntrustedTask(input.task)

  const missedRunPolicy: MissedRunPolicy = input.missedRunPolicy ?? 'skip'
  if (
    missedRunPolicy !== 'skip' &&
    missedRunPolicy !== 'run-once' &&
    missedRunPolicy !== 'bounded-catch-up'
  ) {
    throw new SchedulerError('INVALID_INPUT', 'Invalid missedRunPolicy')
  }

  const maxCatchUpRuns = input.maxCatchUpRuns ?? 3
  if (!Number.isInteger(maxCatchUpRuns) || maxCatchUpRuns < 1 || maxCatchUpRuns > MAX_CATCHUP_RUNS) {
    throw new SchedulerError(
      'INVALID_INPUT',
      `maxCatchUpRuns must be between 1 and ${MAX_CATCHUP_RUNS}`,
    )
  }

  const concurrencyPolicy: ConcurrencyPolicy = input.concurrencyPolicy ?? 'forbid'
  if (concurrencyPolicy !== 'forbid' && concurrencyPolicy !== 'allow-bounded') {
    throw new SchedulerError('INVALID_INPUT', 'Invalid concurrencyPolicy')
  }

  const maxConcurrentRuns =
    concurrencyPolicy === 'forbid' ? 1 : (input.maxConcurrentRuns ?? 2)
  if (
    !Number.isInteger(maxConcurrentRuns) ||
    maxConcurrentRuns < 1 ||
    maxConcurrentRuns > MAX_CONCURRENT_RUNS
  ) {
    throw new SchedulerError(
      'INVALID_INPUT',
      `maxConcurrentRuns must be between 1 and ${MAX_CONCURRENT_RUNS}`,
    )
  }

  const retryPolicy: RetryPolicy = input.retryPolicy ?? {
    maxAttempts: 1,
    backoffMs: 5000,
    retryNonIdempotent: false,
  }
  if (
    !Number.isInteger(retryPolicy.maxAttempts) ||
    retryPolicy.maxAttempts < 1 ||
    retryPolicy.maxAttempts > MAX_RETRY_ATTEMPTS ||
    !Number.isInteger(retryPolicy.backoffMs) ||
    retryPolicy.backoffMs < 0 ||
    retryPolicy.backoffMs > MAX_RETRY_BACKOFF_MS ||
    retryPolicy.retryNonIdempotent !== false
  ) {
    throw new SchedulerError('INVALID_INPUT', 'Invalid retryPolicy')
  }

  const expiresAt =
    input.expiresAt !== undefined && input.expiresAt !== null
      ? assertValidIsoTimestamp(input.expiresAt, 'expiresAt')
      : null

  return {
    name,
    description: descriptionRaw.trim(),
    ownerId,
    botId,
    ownership,
    timezone,
    trigger,
    task,
    enabled: input.enabled ?? true,
    missedRunPolicy,
    maxCatchUpRuns,
    concurrencyPolicy,
    maxConcurrentRuns,
    retryPolicy,
    expiresAt,
  }
}

export function assertScopeAccess(expected: RoutineScope, actual: RoutineScope): void {
  if (expected.ownerId !== actual.ownerId || expected.botId !== actual.botId) {
    throw new SchedulerError(
      'SCOPE_FORBIDDEN',
      'Routine or task access denied outside matching ownerId and botId scope',
    )
  }
}
