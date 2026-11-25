import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openGhostBotDatabase } from '../apps/daemon/src/db/client.ts'
import { RuntimePolicyBroker } from '../apps/daemon/src/runtime/policy-broker.ts'
import { RuntimeRegistry } from '../apps/daemon/src/runtime/registry.ts'
import type { CodexMetadataClient } from '../apps/daemon/src/runtime/registry.ts'
import { DEFAULT_APP_SETTINGS, SettingsRepository } from '../apps/daemon/src/settings/repository.ts'

test('SettingsRepository persists updates, recovers from corrupt JSON, migrates legacy once, and resets', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ghost-bot-settings-'))
  try {
    const h1 = await openGhostBotDatabase(dataDir)
    const repo1 = new SettingsRepository(h1)

    assert.deepEqual(repo1.getSettings(), DEFAULT_APP_SETTINGS)

    // Migrate legacy appearance when DB has no app.settings.v1 yet
    const migrated = repo1.migrateLegacyAppearance({ theme: 'light', leftWidth: 264 })
    assert.equal(migrated.appearance.theme, 'light')
    assert.equal(migrated.appearance.leftWidth, 264)

    // Update settings atomically
    const updated = repo1.updateSettings({
      general: { launchBehavior: 'new-session' },
      privacy: { retentionDays: 60 },
    })
    assert.equal(updated.general.launchBehavior, 'new-session')
    assert.equal(updated.privacy.retentionDays, 60)

    // Calling migrateLegacyAppearance again must NOT overwrite newer SQLite values
    const afterReMigrate = repo1.migrateLegacyAppearance({ theme: 'dark', leftWidth: 200 })
    assert.equal(afterReMigrate.appearance.theme, 'light')
    assert.equal(afterReMigrate.appearance.leftWidth, 264)
    h1.close()

    // Reopen DB to verify restart persistence
    const h2 = await openGhostBotDatabase(dataDir)
    const repo2 = new SettingsRepository(h2)
    assert.equal(repo2.getSettings().general.launchBehavior, 'new-session')
    assert.equal(repo2.getSettings().privacy.retentionDays, 60)

    // Corrupt JSON recovers safely to defaults
    h2.sqlite
      .prepare('UPDATE settings SET value_json = ? WHERE key = ?')
      .run('{corrupt-json', 'app.settings.v1')
    assert.deepEqual(repo2.getSettings(), DEFAULT_APP_SETTINGS)

    // Reset restores defaults
    repo2.updateSettings({ appearance: { theme: 'light' } })
    const reset = repo2.resetSettings()
    assert.deepEqual(reset, DEFAULT_APP_SETTINGS)
    h2.close()
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('RuntimePolicyBroker enforces verified Codex version, ChatGPT auth, canonical workspace, and blocks Full Access', () => {
  const broker = new RuntimePolicyBroker()

  assert.equal(
    broker.authorize({
      runtimeMode: 'codex',
      codexVersion: '0.172.0',
      authMethod: 'chatgpt',
      requestedPermission: 'full-access',
      canonicalWorkspace: '/tmp',
    }).allowed,
    false,
  )

  assert.equal(
    broker.authorize({
      runtimeMode: 'mock',
      codexVersion: null,
      authMethod: 'mock',
      requestedPermission: 'read-only',
      canonicalWorkspace: '/tmp',
    }).allowed,
    false,
  )

  assert.equal(
    broker.authorize({
      runtimeMode: 'codex',
      codexVersion: '0.171.0',
      authMethod: 'chatgpt',
      requestedPermission: 'workspace',
      canonicalWorkspace: '/tmp',
    }).allowed,
    false,
  )

  assert.equal(
    broker.authorize({
      runtimeMode: 'codex',
      codexVersion: '0.172.0',
      authMethod: 'apiKey',
      requestedPermission: 'workspace',
      canonicalWorkspace: '/tmp',
    }).allowed,
    false,
  )

  assert.equal(
    broker.authorize({
      runtimeMode: 'codex',
      codexVersion: '0.172.0',
      authMethod: 'chatgpt',
      requestedPermission: 'workspace',
      canonicalWorkspace: '/home/user/ws',
    }).allowed,
    true,
  )
})

test('RuntimeRegistry handles unavailable, unsupported, auth-required, deduplication, and stale fallback', async () => {
  const unavail = new RuntimeRegistry({ runtimeMode: 'codex', codexVersionOverride: null })
  assert.equal((await unavail.getSnapshot()).status, 'unavailable')
  await unavail.stop()

  const unsupp = new RuntimeRegistry({ runtimeMode: 'codex', codexVersionOverride: '0.171.5' })
  assert.equal((await unsupp.getSnapshot()).status, 'unsupported')
  await unsupp.stop()

  let calls = 0
  let shouldFail = false
  const fakeClient: CodexMetadataClient = {
    async getAccountSummary() {
      calls += 1
      if (shouldFail) throw new Error('Connection lost Bearer secret_tok_1234567890')
      return {
        accountPresent: true,
        accountType: 'chatgpt',
        email: null,
        planType: 'plus',
        workspaceName: null,
        requiresOpenaiAuth: true,
      }
    },
    async listModels() {
      return [
        {
          id: 'gpt-5-codex',
          label: 'GPT-5 Codex',
          efforts: ['low', 'medium'],
          permissionModes: ['read-only', 'ask-approval', 'workspace'],
          supportsTools: true,
          supportsAttachments: false,
        },
      ]
    },
    async getUsage() {
      return {
        source: 'provider',
        observedAt: '2026-11-25T00:00:00.000Z',
        windows: [{ label: '300m', usedPercent: 10, resetAt: null }],
      }
    },
    async close() {},
  }

  const reg = new RuntimeRegistry({
    runtimeMode: 'codex',
    codexVersionOverride: '0.172.0',
    codexClientFactory: () => fakeClient,
    cacheTtlMs: 10_000,
  })

  // Concurrent requests are deduplicated into a single client call
  const [s1, s2] = await Promise.all([reg.getSnapshot(true), reg.getSnapshot(true)])
  assert.equal(calls, 1)
  assert.equal(s1.status, 'available')
  assert.equal(s2.planType, 'plus')
  assert.equal(s1.usageWindows[0]?.usedPercent, 10)

  // Cached hit does not call client again
  const s3 = await reg.getSnapshot(false)
  assert.equal(s3.cached, true)
  assert.equal(calls, 1)

  // Wait past cooldown, simulate failure -> returns stale cached metadata with redacted error
  await new Promise((r) => setTimeout(r, 2100))
  shouldFail = true
  const reg2 = new RuntimeRegistry({
    runtimeMode: 'codex',
    codexVersionOverride: '0.172.0',
    codexClientFactory: () => fakeClient,
    cacheTtlMs: 1,
  })
  shouldFail = false
  await reg2.getSnapshot(true)
  await new Promise((r) => setTimeout(r, 2100))
  shouldFail = true
  const stale = await reg2.getSnapshot(true)
  assert.equal(stale.status, 'stale')
  assert.equal(stale.detail.includes('secret_tok'), false)

  await reg.stop()
  await reg2.stop()
})
