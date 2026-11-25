import { z } from 'zod'
import type { UiPreferences } from '../types/workspace.ts'

const STORAGE_KEY = 'ghost-bot.ui-preferences.v1'

export const UiPreferencesSchema = z.object({
  theme: z.enum(['system', 'dark', 'light']).default('dark'),
  leftWidth: z.number().min(180).max(380).default(240),
  rightWidth: z.number().min(220).max(420).default(285),
  leftCollapsed: z.boolean().default(false),
  rightCollapsed: z.boolean().default(false),
  reducedMotion: z.boolean().default(false),
})

export const DEFAULT_PREFERENCES: UiPreferences = UiPreferencesSchema.parse({})

export function loadUiPreferences(): UiPreferences {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_PREFERENCES
    const parsed = JSON.parse(raw) as unknown
    const res = UiPreferencesSchema.safeParse(parsed)
    return res.success ? res.data : DEFAULT_PREFERENCES
  } catch {
    return DEFAULT_PREFERENCES
  }
}

export function saveUiPreferences(prefs: UiPreferences): void {
  try {
    const validated = UiPreferencesSchema.parse(prefs)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(validated))
  } catch {
    // Ignore storage errors in restricted contexts.
  }
}

export function resolveEffectiveTheme(pref: UiPreferences['theme']): 'dark' | 'light' {
  if (pref === 'dark' || pref === 'light') return pref
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  }
  return 'dark'
}
