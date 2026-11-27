import type {
  EventMatchCondition,
  EventMatchOperator,
  SyntheticEventEnvelope,
  TriggerConfig,
} from '../contracts/types.ts'
import {
  assertNoControlChars,
  assertNonEmptyBounded,
  assertValidIsoTimestamp,
  SchedulerError,
} from '../security/validation.ts'

export const MAX_EVENT_PAYLOAD_KEYS = 24
export const MAX_EVENT_PAYLOAD_BYTES = 4 * 1024
export const MAX_EVENT_CONDITIONS = 16

const ALLOWED_OPERATORS = new Set<EventMatchOperator>(['eq', 'neq', 'prefix', 'contains', 'in'])

export function validateEventConditions(raw: unknown): EventMatchCondition[] {
  if (!Array.isArray(raw)) {
    throw new SchedulerError('INVALID_EVENT_TRIGGER', 'event conditions must be an array')
  }
  if (raw.length > MAX_EVENT_CONDITIONS) {
    throw new SchedulerError(
      'INVALID_EVENT_TRIGGER',
      `event conditions exceed max ${MAX_EVENT_CONDITIONS}`,
    )
  }
  return raw.map((item) => {
    if (!item || typeof item !== 'object') {
      throw new SchedulerError('INVALID_EVENT_TRIGGER', 'condition must be an object')
    }
    const c = item as Record<string, unknown>
    const field = assertNonEmptyBounded(c.field, 'condition.field', 64)
    if (typeof c.op !== 'string' || !ALLOWED_OPERATORS.has(c.op as EventMatchOperator)) {
      throw new SchedulerError(
        'UNSUPPORTED_EVENT_OPERATOR',
        `Unsupported event match operator "${String(c.op)}"`,
      )
    }
    const op = c.op as EventMatchOperator
    if (op === 'in') {
      if (!Array.isArray(c.value) || c.value.length === 0 || c.value.length > 32) {
        throw new SchedulerError('INVALID_EVENT_TRIGGER', 'in operator requires 1..32 string values')
      }
      const cleanArr = c.value.map((v) => assertNonEmptyBounded(v, 'condition.value[]', 256))
      return { field, op, value: cleanArr }
    }
    if (typeof c.value !== 'string') {
      throw new SchedulerError('INVALID_EVENT_TRIGGER', 'condition.value must be a string')
    }
    assertNoControlChars(c.value, 'condition.value')
    if (c.value.length > 256) {
      throw new SchedulerError('INVALID_EVENT_TRIGGER', 'condition.value exceeds 256 chars')
    }
    return { field, op, value: c.value }
  })
}

export function validateEventEnvelope(raw: unknown): SyntheticEventEnvelope {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SchedulerError('INVALID_EVENT', 'Event envelope must be an object')
  }
  const e = raw as Record<string, unknown>
  const eventId = assertNonEmptyBounded(e.eventId, 'event.eventId', 128)
  const trustedSource = assertNonEmptyBounded(e.trustedSource, 'event.trustedSource', 64)
  const eventType = assertNonEmptyBounded(e.eventType, 'event.eventType', 128)
  const timestamp = assertValidIsoTimestamp(e.timestamp, 'event.timestamp')

  if (!e.scope || typeof e.scope !== 'object') {
    throw new SchedulerError('INVALID_EVENT', 'event.scope is required')
  }
  const s = e.scope as Record<string, unknown>
  const ownerId = assertNonEmptyBounded(s.ownerId, 'event.scope.ownerId', 128)
  const botId = assertNonEmptyBounded(s.botId, 'event.scope.botId', 128)

  if (!e.payload || typeof e.payload !== 'object' || Array.isArray(e.payload)) {
    throw new SchedulerError('INVALID_EVENT', 'event.payload must be a flat primitive map')
  }
  const entries = Object.entries(e.payload as Record<string, unknown>)
  if (entries.length > MAX_EVENT_PAYLOAD_KEYS) {
    throw new SchedulerError(
      'INVALID_EVENT',
      `event.payload exceeds ${MAX_EVENT_PAYLOAD_KEYS} keys`,
    )
  }
  const cleanPayload: Record<string, string | number | boolean> = {}
  for (const [k, v] of entries) {
    assertNoControlChars(k, 'event.payload key')
    if (typeof v === 'string') {
      assertNoControlChars(v, `event.payload["${k}"]`)
      cleanPayload[k] = v
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      cleanPayload[k] = v
    } else if (typeof v === 'boolean') {
      cleanPayload[k] = v
    } else {
      throw new SchedulerError(
        'INVALID_EVENT',
        `event.payload["${k}"] must be a finite string, number, or boolean`,
      )
    }
  }
  if (Buffer.byteLength(JSON.stringify(cleanPayload), 'utf8') > MAX_EVENT_PAYLOAD_BYTES) {
    throw new SchedulerError(
      'INVALID_EVENT',
      `event.payload exceeds ${MAX_EVENT_PAYLOAD_BYTES} bytes limit`,
    )
  }

  return {
    eventId,
    trustedSource,
    eventType,
    timestamp,
    scope: { ownerId, botId },
    payload: cleanPayload,
  }
}

export function matchesEventTrigger(
  trigger: TriggerConfig,
  envelope: SyntheticEventEnvelope,
): boolean {
  if (trigger.kind !== 'event') return false
  if (trigger.eventType !== envelope.eventType) return false

  for (const cond of trigger.conditions ?? []) {
    const rawVal = envelope.payload[cond.field]
    if (rawVal === undefined) return false
    const strVal = String(rawVal)
    switch (cond.op) {
      case 'eq':
        if (strVal !== cond.value) return false
        break
      case 'neq':
        if (strVal === cond.value) return false
        break
      case 'prefix':
        if (typeof cond.value !== 'string' || !strVal.startsWith(cond.value)) return false
        break
      case 'contains':
        if (typeof cond.value !== 'string' || !strVal.includes(cond.value)) return false
        break
      case 'in':
        if (!Array.isArray(cond.value) || !cond.value.includes(strVal)) return false
        break
      default:
        throw new SchedulerError('UNSUPPORTED_EVENT_OPERATOR', 'Unsupported event operator')
    }
  }
  return true
}
