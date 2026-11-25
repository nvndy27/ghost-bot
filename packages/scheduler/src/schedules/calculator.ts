import type { RoutineRecord, TriggerConfig } from '../contracts/types.ts'
import { MAX_CATCHUP_RUNS, SchedulerError } from '../security/validation.ts'
import { computeNextCronRunMs, parseCronExpression } from './cron.ts'

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    })
    formatterCache.set(timeZone, fmt)
  }
  return fmt
}

export interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  weekday: number
}

export function getZonedParts(ms: number, timeZone: string): ZonedParts {
  const parts = getFormatter(timeZone).formatToParts(new Date(ms))
  const map: Record<string, string> = {}
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value
  }
  const weekday = WEEKDAY_MAP[map.weekday ?? '']
  if (weekday === undefined) {
    throw new SchedulerError('INVALID_TIMEZONE', `Unable to resolve weekday for "${timeZone}"`)
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    second: Number(map.second),
    weekday,
  }
}

/**
 * Resolves a local wall-clock date/time in `timeZone` to a UTC epoch ms.
 * Returns `null` if the wall-clock time does not exist (e.g. skipped during DST spring-forward).
 * During DST fall-back (ambiguous hour), deterministically resolves to the earlier (first) instant.
 */
export function zonedWallClockToUtcMs(
  target: { year: number; month: number; day: number; hour: number; minute: number; second: number },
  timeZone: string,
): number | null {
  const targetUtcAsWall = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
    target.second,
  )

  let guess = targetUtcAsWall
  for (let i = 0; i < 3; i += 1) {
    const observed = getZonedParts(guess, timeZone)
    const observedUtcAsWall = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    )
    const diff = targetUtcAsWall - observedUtcAsWall
    if (diff === 0) break
    guess += diff
  }

  const verified = getZonedParts(guess, timeZone)
  if (
    verified.year !== target.year ||
    verified.month !== target.month ||
    verified.day !== target.day ||
    verified.hour !== target.hour ||
    verified.minute !== target.minute ||
    verified.second !== target.second
  ) {
    return null
  }

  // Prefer the earlier (first) instant if ambiguous during DST fall-back.
  const oneHourEarlier = guess - 3_600_000
  const earlierParts = getZonedParts(oneHourEarlier, timeZone)
  if (
    earlierParts.year === target.year &&
    earlierParts.month === target.month &&
    earlierParts.day === target.day &&
    earlierParts.hour === target.hour &&
    earlierParts.minute === target.minute &&
    earlierParts.second === target.second
  ) {
    return oneHourEarlier
  }

  return guess
}

function addCalendarDays(
  year: number,
  month: number,
  day: number,
  deltaDays: number,
): { year: number; month: number; day: number } {
  const dt = new Date(Date.UTC(year, month - 1, day + deltaDays))
  return {
    year: dt.getUTCFullYear(),
    month: dt.getUTCMonth() + 1,
    day: dt.getUTCDate(),
  }
}

/**
 * Computes the next scheduled occurrence strictly after `afterMs` (in UTC epoch ms).
 * Bounded O(1) / <= 14 day search; never loops infinitely.
 */
export function computeNextRunMs(
  trigger: TriggerConfig,
  timeZone: string,
  afterMs: number,
): number | null {
  if (trigger.kind === 'event') {
    return null
  }

  if (trigger.kind === 'cron') {
    const parsed = parseCronExpression(trigger.expression)
    return computeNextCronRunMs(parsed, timeZone, afterMs)
  }

  if (trigger.kind === 'one-time') {
    const runAtMs = Date.parse(trigger.runAt)
    return runAtMs > afterMs ? runAtMs : null
  }

  if (trigger.kind === 'interval') {
    const anchorMs = Date.parse(trigger.anchorAt)
    if (afterMs < anchorMs) return anchorMs
    const steps = Math.floor((afterMs - anchorMs) / trigger.intervalMs) + 1
    return anchorMs + steps * trigger.intervalMs
  }

  const second = trigger.second ?? 0
  const baseParts = getZonedParts(afterMs, timeZone)
  const allowedDays = trigger.kind === 'weekly' ? new Set(trigger.daysOfWeek) : null

  for (let dayOffset = 0; dayOffset <= 14; dayOffset += 1) {
    const cal = addCalendarDays(baseParts.year, baseParts.month, baseParts.day, dayOffset)
    const candidateMs = zonedWallClockToUtcMs(
      {
        year: cal.year,
        month: cal.month,
        day: cal.day,
        hour: trigger.hour,
        minute: trigger.minute,
        second,
      },
      timeZone,
    )
    if (candidateMs === null || candidateMs <= afterMs) continue
    if (allowedDays) {
      const candidateDay = getZonedParts(candidateMs, timeZone).weekday
      if (!allowedDays.has(candidateDay)) continue
    }
    return candidateMs
  }

  return null
}

export interface DueEvaluationResult {
  dueOccurrences: string[]
  nextRunAt: string | null
  missedCount: number
}

/**
 * Deterministically evaluates due occurrences for a routine at `nowMs`.
 * Handles disabled/archived/expired routines, clock rollback, and missed-run policies
 * without ever emitting an unbounded backlog.
 */
export function evaluateDueOccurrences(
  routine: RoutineRecord,
  nowMs: number,
  graceWindowMs = 60_000,
): DueEvaluationResult {
  if (!routine.enabled || routine.archivedAt !== null) {
    return { dueOccurrences: [], nextRunAt: routine.nextRunAt, missedCount: 0 }
  }

  if (routine.expiresAt !== null && nowMs >= Date.parse(routine.expiresAt)) {
    return { dueOccurrences: [], nextRunAt: null, missedCount: 0 }
  }

  // Handle clock rollback safely: if clock moved backwards before lastEvaluatedAt,
  // do not re-emit already-evaluated slots.
  const lastEvalMs = routine.lastEvaluatedAt ? Date.parse(routine.lastEvaluatedAt) : null
  if (lastEvalMs !== null && nowMs < lastEvalMs) {
    return { dueOccurrences: [], nextRunAt: routine.nextRunAt, missedCount: 0 }
  }

  const nextMs = routine.nextRunAt ? Date.parse(routine.nextRunAt) : null
  if (nextMs === null || nextMs > nowMs) {
    return { dueOccurrences: [], nextRunAt: routine.nextRunAt, missedCount: 0 }
  }

  const expiresMs = routine.expiresAt ? Date.parse(routine.expiresAt) : null
  const cap = Math.min(routine.maxCatchUpRuns, MAX_CATCHUP_RUNS)
  const collected: number[] = []
  let missedCount = 0
  let cursorMs: number | null = nextMs

  // Collect due slots up to a safe hard bound (MAX_CATCHUP_RUNS * 10) to detect missedCount,
  // then jump O(1) to > nowMs for interval triggers or bounded walk for calendar triggers.
  const maxScan = 200
  while (cursorMs !== null && cursorMs <= nowMs && missedCount < maxScan) {
    if (expiresMs !== null && cursorMs >= expiresMs) {
      cursorMs = null
      break
    }
    missedCount += 1
    collected.push(cursorMs)
    if (collected.length > cap) {
      collected.shift()
    }
    if (routine.trigger.kind === 'interval' && missedCount >= cap && nowMs - cursorMs > routine.trigger.intervalMs * 20) {
      // Jump straight near nowMs in O(1) so huge downtime never loops.
      const jumped = computeNextRunMs(routine.trigger, routine.timezone, nowMs)
      cursorMs = jumped
      break
    }
    cursorMs = computeNextRunMs(routine.trigger, routine.timezone, cursorMs)
  }

  if (cursorMs !== null && cursorMs <= nowMs) {
    cursorMs = computeNextRunMs(routine.trigger, routine.timezone, nowMs)
  }
  if (cursorMs !== null && expiresMs !== null && cursorMs >= expiresMs) {
    cursorMs = null
  }

  let dueMs: number[] = []
  if (routine.missedRunPolicy === 'skip') {
    const latest = collected[collected.length - 1]
    if (latest !== undefined && nowMs - latest <= graceWindowMs) {
      dueMs = [latest]
    }
  } else if (routine.missedRunPolicy === 'run-once') {
    const latest = collected[collected.length - 1]
    if (latest !== undefined) {
      dueMs = [latest]
    }
  } else {
    dueMs = collected
  }

  return {
    dueOccurrences: dueMs.map((ms) => new Date(ms).toISOString()),
    nextRunAt: cursorMs !== null ? new Date(cursorMs).toISOString() : null,
    missedCount,
  }
}
