import {
  ComputerUseError,
  type ActionBatch,
  type ComputerUseAction,
  type DisplayGeometry,
  type ScreenshotMetadata,
} from '../contracts/types.ts'
import { assertFiniteNumber, validatePointerTarget } from './coordinates.ts'

export const MAX_BATCH_ACTIONS = 25
export const MAX_TEXT_ENTRY_BYTES = 1024
export const MAX_WAIT_MS = 10_000
export const MAX_KEY_COMBO_KEYS = 4
export const MAX_SCROLL_DELTA = 5000

const ALLOWED_KEYS = new Set([
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Control',
  'Alt',
  'Shift',
  'Super',
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12',
  ...'abcdefghijklmnopqrstuvwxyz0123456789'.split(''),
])

function assertNonEmptyId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) {
    throw new ComputerUseError('INVALID_ACTION', `${label} must be a non-empty string <= 128 chars`)
  }
  return value.trim()
}

function assertAllowedKey(key: unknown, label = 'key'): string {
  if (typeof key !== 'string' || !ALLOWED_KEYS.has(key)) {
    throw new ComputerUseError('INVALID_ACTION', `Unsupported or disallowed ${label}: "${String(key)}"`)
  }
  return key
}

function assertCleanTextEntry(text: unknown): string {
  if (typeof text !== 'string' || text.length === 0) {
    throw new ComputerUseError('INVALID_ACTION', 'text_entry.text must be a non-empty string')
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_ENTRY_BYTES) {
    throw new ComputerUseError(
      'INVALID_ACTION',
      `text_entry.text exceeds ${MAX_TEXT_ENTRY_BYTES} bytes limit`,
    )
  }
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0x7f) {
      throw new ComputerUseError('INVALID_ACTION', 'text_entry.text contains disallowed control characters')
    }
  }
  return text
}

export function validateAction(
  action: ComputerUseAction,
  displays: DisplayGeometry[],
  observationsById?: Map<string, ScreenshotMetadata>,
): void {
  if (!action || typeof action !== 'object') {
    throw new ComputerUseError('INVALID_ACTION', 'Action must be an object')
  }
  assertNonEmptyId(action.actionId, 'action.actionId')

  switch (action.kind) {
    case 'wait': {
      const dur = assertFiniteNumber(action.durationMs, 'wait.durationMs')
      if (!Number.isInteger(dur) || dur < 0 || dur > MAX_WAIT_MS) {
        throw new ComputerUseError('INVALID_ACTION', `wait.durationMs must be 0..${MAX_WAIT_MS}`)
      }
      return
    }
    case 'move':
    case 'click':
    case 'double_click': {
      const obs = action.observationId ? observationsById?.get(action.observationId) : undefined
      if (action.observationId && !obs) {
        throw new ComputerUseError(
          'STALE_OBSERVATION',
          `Referenced observationId "${action.observationId}" is missing or expired`,
        )
      }
      validatePointerTarget(displays, {
        displayId: action.displayId,
        x: action.x,
        y: action.y,
        coordinateSpace: action.coordinateSpace,
        observation: obs,
        expectedTopologyVersion: action.topologyVersion,
      })
      return
    }
    case 'drag': {
      const obs = action.observationId ? observationsById?.get(action.observationId) : undefined
      if (action.observationId && !obs) {
        throw new ComputerUseError(
          'STALE_OBSERVATION',
          `Referenced observationId "${action.observationId}" is missing or expired`,
        )
      }
      validatePointerTarget(displays, {
        displayId: action.displayId,
        x: action.fromX,
        y: action.fromY,
        coordinateSpace: action.coordinateSpace,
        observation: obs,
        expectedTopologyVersion: action.topologyVersion,
      })
      validatePointerTarget(displays, {
        displayId: action.displayId,
        x: action.toX,
        y: action.toY,
        coordinateSpace: action.coordinateSpace,
        observation: obs,
        expectedTopologyVersion: action.topologyVersion,
      })
      return
    }
    case 'scroll': {
      const obs = action.observationId ? observationsById?.get(action.observationId) : undefined
      if (action.observationId && !obs) {
        throw new ComputerUseError(
          'STALE_OBSERVATION',
          `Referenced observationId "${action.observationId}" is missing or expired`,
        )
      }
      validatePointerTarget(displays, {
        displayId: action.displayId,
        x: action.x,
        y: action.y,
        coordinateSpace: action.coordinateSpace,
        observation: obs,
        expectedTopologyVersion: action.topologyVersion,
      })
      const dx = assertFiniteNumber(action.deltaX, 'scroll.deltaX')
      const dy = assertFiniteNumber(action.deltaY, 'scroll.deltaY')
      if (Math.abs(dx) > MAX_SCROLL_DELTA || Math.abs(dy) > MAX_SCROLL_DELTA) {
        throw new ComputerUseError(
          'INVALID_ACTION',
          `Scroll delta exceeds +/-${MAX_SCROLL_DELTA}`,
        )
      }
      return
    }
    case 'key_press':
    case 'key_release': {
      if (!displays.some((d) => d.displayId === action.displayId)) {
        throw new ComputerUseError('INVALID_DISPLAY', `Unknown displayId "${action.displayId}"`)
      }
      assertAllowedKey(action.key, `${action.kind}.key`)
      return
    }
    case 'key_combo': {
      if (!displays.some((d) => d.displayId === action.displayId)) {
        throw new ComputerUseError('INVALID_DISPLAY', `Unknown displayId "${action.displayId}"`)
      }
      if (
        !Array.isArray(action.keys) ||
        action.keys.length === 0 ||
        action.keys.length > MAX_KEY_COMBO_KEYS
      ) {
        throw new ComputerUseError(
          'INVALID_ACTION',
          `key_combo.keys must have 1..${MAX_KEY_COMBO_KEYS} keys`,
        )
      }
      for (const k of action.keys) {
        assertAllowedKey(k, 'key_combo.key')
      }
      return
    }
    case 'text_entry': {
      if (!displays.some((d) => d.displayId === action.displayId)) {
        throw new ComputerUseError('INVALID_DISPLAY', `Unknown displayId "${action.displayId}"`)
      }
      assertCleanTextEntry(action.text)
      return
    }
    default: {
      throw new ComputerUseError('INVALID_ACTION', 'Unsupported action kind')
    }
  }
}

export function validateActionBatch(
  batch: ActionBatch,
  displays: DisplayGeometry[],
  observationsById?: Map<string, ScreenshotMetadata>,
): void {
  if (!batch || typeof batch !== 'object') {
    throw new ComputerUseError('INVALID_ACTION', 'ActionBatch must be an object')
  }
  assertNonEmptyId(batch.batchId, 'batch.batchId')
  assertNonEmptyId(batch.sessionId, 'batch.sessionId')
  assertNonEmptyId(batch.ownerId, 'batch.ownerId')
  assertNonEmptyId(batch.botId, 'batch.botId')
  if (!Array.isArray(batch.actions) || batch.actions.length === 0) {
    throw new ComputerUseError('INVALID_ACTION', 'ActionBatch.actions must be a non-empty array')
  }
  if (batch.actions.length > MAX_BATCH_ACTIONS) {
    throw new ComputerUseError(
      'BATCH_TOO_LARGE',
      `ActionBatch exceeds maximum of ${MAX_BATCH_ACTIONS} actions`,
    )
  }

  const seenIds = new Set<string>()
  for (const action of batch.actions) {
    if (seenIds.has(action.actionId)) {
      throw new ComputerUseError('DUPLICATE_ACTION', `Duplicate actionId "${action.actionId}" in batch`)
    }
    seenIds.add(action.actionId)
    validateAction(action, displays, observationsById)
  }
}
