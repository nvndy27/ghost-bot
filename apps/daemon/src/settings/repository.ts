import { randomUUID } from 'node:crypto'
import {
  AppearanceSettingsSchema,
  AppSettingsPatchSchema,
  AppSettingsSchema,
} from '@ghost-bot/shared-types/ipc'
import type {
  AppearanceSettingsInput,
  AppSettings,
  AppSettingsPatch,
} from '@ghost-bot/shared-types/ipc'
import type { DatabaseHandle } from '../db/client.ts'
import { DaemonError } from '../errors.ts'

const APP_SETTINGS_KEY = 'app.settings.v1'

export const DEFAULT_APP_SETTINGS: AppSettings = AppSettingsSchema.parse({})

export class SettingsRepository {
  private readonly handle: DatabaseHandle

  constructor(handle: DatabaseHandle) {
    this.handle = handle
  }

  getSettings(): AppSettings {
    const row = this.handle.sqlite
      .prepare('SELECT value_json FROM settings WHERE key = ?')
      .get(APP_SETTINGS_KEY) as { value_json: string } | undefined

    if (!row) return DEFAULT_APP_SETTINGS

    try {
      const parsed = JSON.parse(row.value_json) as unknown
      const checked = AppSettingsSchema.safeParse(parsed)
      return checked.success ? checked.data : DEFAULT_APP_SETTINGS
    } catch {
      return DEFAULT_APP_SETTINGS
    }
  }

  updateSettings(rawPatch: AppSettingsPatch): AppSettings {
    const parsedPatch = AppSettingsPatchSchema.safeParse(rawPatch)
    if (!parsedPatch.success) {
      throw new DaemonError(
        'VALIDATION_ERROR',
        parsedPatch.error.issues[0]?.message ?? 'Invalid settings patch',
        { statusCode: 400 },
      )
    }

    const patch = parsedPatch.data
    const now = new Date().toISOString()

    return this.handle.transaction(() => {
      const current = this.getSettings()
      const merged = AppSettingsSchema.parse({
        general: { ...current.general, ...(patch.general ?? {}) },
        appearance: { ...current.appearance, ...(patch.appearance ?? {}) },
        personalization: { ...current.personalization, ...(patch.personalization ?? {}) },
        permissions: { ...current.permissions, ...(patch.permissions ?? {}) },
        privacy: { ...current.privacy, ...(patch.privacy ?? {}) },
        memory: { ...current.memory, ...(patch.memory ?? {}) },
      })

      this.handle.sqlite
        .prepare('INSERT OR REPLACE INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)')
        .run(APP_SETTINGS_KEY, JSON.stringify(merged), now)

      this.writeAudit(
        'user',
        'settings.update',
        APP_SETTINGS_KEY,
        'ok',
        { sections: Object.keys(patch) },
        now,
      )
      return merged
    })
  }

  resetSettings(): AppSettings {
    const now = new Date().toISOString()
    return this.handle.transaction(() => {
      this.handle.sqlite
        .prepare('INSERT OR REPLACE INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)')
        .run(APP_SETTINGS_KEY, JSON.stringify(DEFAULT_APP_SETTINGS), now)

      this.writeAudit('user', 'settings.reset', APP_SETTINGS_KEY, 'ok', {}, now)
      return DEFAULT_APP_SETTINGS
    })
  }

  /**
   * Idempotently migrates legacy Phase 1B localStorage appearance preferences into SQLite
   * ONLY when `app.settings.v1` does not already exist. Never overwrites newer SQLite values.
   */
  migrateLegacyAppearance(rawLegacy: Partial<AppearanceSettingsInput>): AppSettings {
    const existing = this.handle.sqlite
      .prepare('SELECT key FROM settings WHERE key = ?')
      .get(APP_SETTINGS_KEY)
    if (existing) {
      return this.getSettings()
    }

    const parsedAppearance = AppearanceSettingsSchema.partial().safeParse(rawLegacy)
    if (!parsedAppearance.success) {
      return this.getSettings()
    }

    const now = new Date().toISOString()
    return this.handle.transaction(() => {
      const stillMissing = this.handle.sqlite
        .prepare('SELECT key FROM settings WHERE key = ?')
        .get(APP_SETTINGS_KEY)
      if (stillMissing) {
        return this.getSettings()
      }

      const initial = AppSettingsSchema.parse({
        ...DEFAULT_APP_SETTINGS,
        appearance: {
          ...DEFAULT_APP_SETTINGS.appearance,
          ...parsedAppearance.data,
        },
      })

      this.handle.sqlite
        .prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)')
        .run(APP_SETTINGS_KEY, JSON.stringify(initial), now)

      this.writeAudit('system', 'settings.migrate_local', APP_SETTINGS_KEY, 'ok', {}, now)
      return initial
    })
  }

  private writeAudit(
    actor: string,
    action: string,
    target: string,
    outcome: string,
    meta: Record<string, unknown>,
    timestamp: string,
  ): void {
    this.handle.sqlite
      .prepare(
        `INSERT INTO audit_logs (id, actor, action, target, outcome, redacted_json, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), actor, action, target, outcome, JSON.stringify(meta), timestamp)
  }
}
