import type { CreateRoutineInput, RoutineRecord } from '../contracts/types.ts'
import { computeNextRunMs, getZonedParts } from '../schedules/calculator.ts'
import { SchedulerError, validateCreateRoutineInput } from '../security/validation.ts'

export const MAX_PREVIEW_COUNT = 25

export interface PreviewOccurrence {
  scheduledAtUtc: string
  localDateTime: string
  timezone: string
  dstTransitionNote?: string
}

export interface SchedulePreviewResult {
  valid: boolean
  validationError: string | null
  status: 'ok' | 'event_driven' | 'invalid' | 'no_occurrences_in_horizon' | 'expired'
  timezone: string
  routineRevision: number
  requestedCount: number
  occurrences: PreviewOccurrence[]
  truncatedByExpiration: boolean
  truncatedByHorizon: boolean
}

function formatLocalDateTime(ms: number, timeZone: string): string {
  const p = getZonedParts(ms, timeZone)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`
}

/**
 * Pure, read-only schedule preview. Zero database writes, queue mutations, or dispatch.
 */
export function previewRoutineSchedule(
  routineOrInput: RoutineRecord | CreateRoutineInput,
  options: { startAtMs?: number; count?: number } = {},
): SchedulePreviewResult {
  const count = Math.min(Math.max(1, Math.floor(options.count ?? 5)), MAX_PREVIEW_COUNT)
  const startAtMs = options.startAtMs ?? Date.now()
  const revision = 'revision' in routineOrInput ? routineOrInput.revision : 1

  let validated
  try {
    validated = validateCreateRoutineInput(routineOrInput)
  } catch (err) {
    return {
      valid: false,
      validationError: err instanceof Error ? err.message : 'Invalid routine schedule',
      status: 'invalid',
      timezone: typeof routineOrInput.timezone === 'string' ? routineOrInput.timezone : 'UTC',
      routineRevision: revision,
      requestedCount: count,
      occurrences: [],
      truncatedByExpiration: false,
      truncatedByHorizon: false,
    }
  }

  if (validated.trigger.kind === 'event') {
    return {
      valid: true,
      validationError: null,
      status: 'event_driven',
      timezone: validated.timezone,
      routineRevision: revision,
      requestedCount: count,
      occurrences: [],
      truncatedByExpiration: false,
      truncatedByHorizon: false,
    }
  }

  const expiresMs = validated.expiresAt ? Date.parse(validated.expiresAt) : null
  if (expiresMs !== null && startAtMs >= expiresMs) {
    return {
      valid: true,
      validationError: null,
      status: 'expired',
      timezone: validated.timezone,
      routineRevision: revision,
      requestedCount: count,
      occurrences: [],
      truncatedByExpiration: true,
      truncatedByHorizon: false,
    }
  }

  const occurrences: PreviewOccurrence[] = []
  let cursorMs = startAtMs - 1
  let truncatedByExpiration = false
  let truncatedByHorizon = false

  for (let i = 0; i < count; i += 1) {
    const nextMs = computeNextRunMs(validated.trigger, validated.timezone, cursorMs)
    if (nextMs === null) {
      if (validated.trigger.kind === 'cron') {
        truncatedByHorizon = true
      }
      break
    }
    if (expiresMs !== null && nextMs >= expiresMs) {
      truncatedByExpiration = true
      break
    }

    const prevOffsetProbe = cursorMs >= 0 ? getZonedParts(nextMs - 3_600_000, validated.timezone) : null
    const currParts = getZonedParts(nextMs, validated.timezone)
    let dstNote: string | undefined
    if (prevOffsetProbe && currParts.hour - prevOffsetProbe.hour === 2) {
      dstNote = 'DST spring-forward transition nearby'
    } else if (prevOffsetProbe && currParts.hour === prevOffsetProbe.hour) {
      dstNote = 'DST fall-back repeated hour (resolved to first occurrence)'
    }

    occurrences.push({
      scheduledAtUtc: new Date(nextMs).toISOString(),
      localDateTime: formatLocalDateTime(nextMs, validated.timezone),
      timezone: validated.timezone,
      ...(dstNote ? { dstTransitionNote: dstNote } : {}),
    })
    cursorMs = nextMs
  }

  if (!Number.isFinite(startAtMs)) {
    throw new SchedulerError('INVALID_INPUT', 'startAtMs must be a finite epoch ms')
  }

  return {
    valid: true,
    validationError: null,
    status: occurrences.length === 0 && truncatedByHorizon ? 'no_occurrences_in_horizon' : 'ok',
    timezone: validated.timezone,
    routineRevision: revision,
    requestedCount: count,
    occurrences,
    truncatedByExpiration,
    truncatedByHorizon,
  }
}
