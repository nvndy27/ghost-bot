import { SchedulerError } from '../security/validation.ts'
import { getZonedParts, zonedWallClockToUtcMs } from './calculator.ts'

export const MAX_CRON_EXPRESSION_LENGTH = 256
export const MAX_CRON_SEARCH_DAYS = 1466 // 4 years + leap margin

const MONTH_ALIASES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
}

const DOW_ALIASES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
}

const MAX_DAYS_PER_MONTH: Record<number, number> = {
  1: 31,
  2: 29, // leap-year max
  3: 31,
  4: 30,
  5: 31,
  6: 30,
  7: 31,
  8: 31,
  9: 30,
  10: 31,
  11: 30,
  12: 31,
}

export interface ParsedCron {
  expression: string
  minutes: number[]
  hours: number[]
  daysOfMonth: number[]
  months: number[]
  daysOfWeek: number[]
  domWildcard: boolean
  dowWildcard: boolean
}

function parseAtom(
  raw: string,
  min: number,
  max: number,
  aliases: Record<string, number> | null,
  normalizeValue?: (n: number) => number,
): number {
  const lower = raw.toLowerCase()
  let val: number
  if (aliases && lower in aliases) {
    val = aliases[lower]!
  } else if (/^\d+$/.test(lower)) {
    val = Number(lower)
  } else {
    throw new SchedulerError('INVALID_CRON', `Invalid cron token "${raw}"`)
  }
  if (val < min || val > max) {
    throw new SchedulerError('INVALID_CRON', `Cron value ${val} out of range ${min}..${max}`)
  }
  return normalizeValue ? normalizeValue(val) : val
}

function parseCronField(
  field: string,
  min: number,
  max: number,
  aliases: Record<string, number> | null,
  normalizeValue?: (n: number) => number,
): { values: number[]; isWildcard: boolean } {
  if (!field) {
    throw new SchedulerError('INVALID_CRON', 'Empty cron field')
  }
  if (/[LW#?@]/.test(field)) {
    throw new SchedulerError(
      'INVALID_CRON',
      `Unsupported cron extension token in "${field}" (L, W, #, ?, @ macros are not supported)`,
    )
  }

  const trimmed = field.trim()
  const isWildcard = trimmed === '*'
  const set = new Set<number>()

  for (const part of trimmed.split(',')) {
    if (!part) {
      throw new SchedulerError('INVALID_CRON', `Empty list element in cron field "${field}"`)
    }
    const slashParts = part.split('/')
    if (slashParts.length > 2) {
      throw new SchedulerError('INVALID_CRON', `Invalid step syntax "${part}"`)
    }
    const rangePart = slashParts[0]!
    let step = 1
    if (slashParts.length === 2) {
      if (!/^\d+$/.test(slashParts[1]!)) {
        throw new SchedulerError('INVALID_CRON', `Invalid step value "${slashParts[1]}"`)
      }
      step = Number(slashParts[1]!)
      if (step < 1 || step > max - min + 1) {
        throw new SchedulerError('INVALID_CRON', `Step ${step} out of range for "${field}"`)
      }
    }

    let start: number
    let end: number
    if (rangePart === '*') {
      start = min
      end = max
    } else if (rangePart.includes('-')) {
      const bounds = rangePart.split('-')
      if (bounds.length !== 2 || !bounds[0] || !bounds[1]) {
        throw new SchedulerError('INVALID_CRON', `Invalid range "${rangePart}"`)
      }
      start = parseAtom(bounds[0], min, max, aliases)
      end = parseAtom(bounds[1], min, max, aliases)
      if (start > end) {
        throw new SchedulerError('INVALID_CRON', `Reversed range "${rangePart}"`)
      }
    } else {
      const single = parseAtom(rangePart, min, max, aliases)
      if (slashParts.length === 2) {
        start = single
        end = max
      } else {
        set.add(normalizeValue ? normalizeValue(single) : single)
        continue
      }
    }

    for (let v = start; v <= end; v += step) {
      set.add(normalizeValue ? normalizeValue(v) : v)
    }
  }

  if (set.size === 0) {
    throw new SchedulerError('INVALID_CRON', `Cron field "${field}" matched no values`)
  }
  return {
    values: [...set].sort((a, b) => a - b),
    isWildcard,
  }
}

export function parseCronExpression(raw: string): ParsedCron {
  if (typeof raw !== 'string') {
    throw new SchedulerError('INVALID_CRON', 'Cron expression must be a string')
  }
  const normalized = raw.trim().replace(/\s+/g, ' ')
  if (!normalized || normalized.length > MAX_CRON_EXPRESSION_LENGTH) {
    throw new SchedulerError(
      'INVALID_CRON',
      `Cron expression must be 1..${MAX_CRON_EXPRESSION_LENGTH} characters`,
    )
  }
  if (normalized.startsWith('@')) {
    throw new SchedulerError('INVALID_CRON', 'Cron @macros are not supported; use 5-field syntax')
  }

  const parts = normalized.split(' ')
  if (parts.length !== 5) {
    throw new SchedulerError(
      'INVALID_CRON',
      `Cron expression must have exactly 5 fields (minute hour dom month dow), got ${parts.length}`,
    )
  }

  const minuteF = parseCronField(parts[0]!, 0, 59, null)
  const hourF = parseCronField(parts[1]!, 0, 23, null)
  const domF = parseCronField(parts[2]!, 1, 31, null)
  const monthF = parseCronField(parts[3]!, 1, 12, MONTH_ALIASES)
  const dowF = parseCronField(parts[4]!, 0, 7, DOW_ALIASES, (n) => (n === 7 ? 0 : n))

  // Reject impossible calendar month/day combinations when DOW is wildcard
  if (dowF.isWildcard && !domF.isWildcard) {
    let anyPossible = false
    for (const m of monthF.values) {
      const maxD = MAX_DAYS_PER_MONTH[m] ?? 31
      if (domF.values.some((d) => d <= maxD)) {
        anyPossible = true
        break
      }
    }
    if (!anyPossible) {
      throw new SchedulerError(
        'INVALID_CRON',
        `Cron expression "${normalized}" specifies impossible calendar date(s)`,
      )
    }
  }

  return {
    expression: normalized,
    minutes: minuteF.values,
    hours: hourF.values,
    daysOfMonth: domF.values,
    months: monthF.values,
    daysOfWeek: dowF.values,
    domWildcard: domF.isWildcard,
    dowWildcard: dowF.isWildcard,
  }
}

function addDays(
  year: number,
  month: number,
  day: number,
  delta: number,
): { year: number; month: number; day: number; weekday: number } {
  const d = new Date(Date.UTC(year, month - 1, day + delta))
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: d.getUTCDay(),
  }
}

/**
 * Bounded O(days) next-occurrence calculation for 5-field cron expressions.
 * Searches at most MAX_CRON_SEARCH_DAYS (1466 days = 4 years + leap margin),
 * never scanning minute-by-minute.
 */
export function computeNextCronRunMs(
  parsed: ParsedCron,
  timeZone: string,
  afterMs: number,
): number | null {
  const startParts = getZonedParts(afterMs, timeZone)
  const monthSet = new Set(parsed.months)
  const domSet = new Set(parsed.daysOfMonth)
  const dowSet = new Set(parsed.daysOfWeek)

  for (let dayOffset = 0; dayOffset <= MAX_CRON_SEARCH_DAYS; dayOffset += 1) {
    const cal = addDays(startParts.year, startParts.month, startParts.day, dayOffset)
    if (!monthSet.has(cal.month)) continue

    const domMatch = domSet.has(cal.day)
    const dowMatch = dowSet.has(cal.weekday)
    const dayMatches =
      !parsed.domWildcard && !parsed.dowWildcard ? domMatch || dowMatch : domMatch && dowMatch
    if (!dayMatches) continue

    for (const hour of parsed.hours) {
      if (dayOffset === 0 && hour < startParts.hour) continue
      for (const minute of parsed.minutes) {
        if (dayOffset === 0 && hour === startParts.hour && minute < startParts.minute) continue
        const candidateMs = zonedWallClockToUtcMs(
          {
            year: cal.year,
            month: cal.month,
            day: cal.day,
            hour,
            minute,
            second: 0,
          },
          timeZone,
        )
        if (candidateMs !== null && candidateMs > afterMs) {
          return candidateMs
        }
      }
    }
  }

  return null
}
