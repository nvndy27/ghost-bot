import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  DEFAULT_PREFERENCES,
  UiPreferencesSchema,
  loadUiPreferences,
} from '../apps/desktop/src/state/preferences.ts'

test('UiPreferencesSchema validates bounds and rejects invalid persisted payloads', () => {
  const valid = UiPreferencesSchema.parse({
    theme: 'light',
    leftWidth: 260,
    rightWidth: 300,
    leftCollapsed: true,
    rightCollapsed: false,
    reducedMotion: true,
  })
  assert.equal(valid.theme, 'light')
  assert.equal(valid.leftCollapsed, true)

  assert.equal(UiPreferencesSchema.safeParse({ leftWidth: 50 }).success, false)
  assert.equal(UiPreferencesSchema.safeParse({ rightWidth: 999 }).success, false)
  assert.equal(UiPreferencesSchema.safeParse({ theme: 'neon' }).success, false)
})

test('loadUiPreferences falls back safely when window/localStorage is unavailable or corrupt', () => {
  const prevWindow = (globalThis as Record<string, unknown>).window
  try {
    ;(globalThis as Record<string, unknown>).window = {
      localStorage: {
        getItem: () => '{not-valid-json',
      },
    }
    assert.deepEqual(loadUiPreferences(), DEFAULT_PREFERENCES)

    ;(globalThis as Record<string, unknown>).window = {
      localStorage: {
        getItem: () => {
          throw new Error('storage blocked')
        },
      },
    }
    assert.deepEqual(loadUiPreferences(), DEFAULT_PREFERENCES)
  } finally {
    if (prevWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window
    } else {
      ;(globalThis as Record<string, unknown>).window = prevWindow
    }
  }
})
