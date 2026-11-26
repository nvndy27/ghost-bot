import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const tempRoot = mkdtempSync(join(tmpdir(), 'ghost-p6-e2e-'))
chmodSync(tempRoot, 0o700)
const dataDir = join(tempRoot, 'data')
const workspaceDir = join(tempRoot, 'workspace')
mkdirSync(workspaceDir, { recursive: true })
chmodSync(workspaceDir, 0o700)

const app = await electron.launch({
  args: [resolve('apps/desktop/dist-electron/main.js'), '--no-sandbox'],
  env: {
    ...process.env,
    GHOST_BOT_DATA_DIR: dataDir,
    GHOST_BOT_RUNTIME_MODE: 'mock',
    GHOST_SECRET_NAMESPACE: `p6-e2e-${randomUUID().slice(0, 8)}`,
  },
})

try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  // 1. Inspect LM Studio, llama.cpp, and OpenRouter cards in Settings
  await win.getByRole('button', { name: /Settings/i }).click()
  const settings = win.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: /Accounts & Providers/i }).click()
  await settings.getByTestId('lmstudio-status-card').waitFor({ timeout: 10_000 })
  await settings.getByTestId('llamacpp-status-card').waitFor({ timeout: 10_000 })
  await settings.getByTestId('openrouter-status-card').waitFor({ timeout: 10_000 })

  // 2. Reject non-loopback endpoint in LM Studio config
  await settings.getByTestId('lmstudio-url-input').fill('http://192.168.1.55:1234/v1')
  await settings.getByTestId('lmstudio-save-url-btn').click()
  await settings.getByRole('alert').waitFor({ timeout: 5_000 })

  // 3. Test OpenRouter masked key lifecycle when OS keyring is available
  const orStatus = await win.evaluate(async () => window.ghostBot.getOpenRouterStatus())
  assert.equal(orStatus.capabilities.fallbacksDisabled, true)
  assert.equal(orStatus.billingMode, 'api-key-billed')

  if (orStatus.keyringAvailable) {
    await settings.getByTestId('openrouter-api-key-input').fill('sk-or-v1-e2e-first-1111')
    await settings.getByTestId('openrouter-save-key-btn').click()
    await settings.getByText('sk-or-v1...1111').waitFor({ timeout: 10_000 })

    await settings.getByTestId('openrouter-toggle-auth-btn').click()
    const authOn = await win.evaluate(async () => window.ghostBot.getOpenRouterStatus())
    assert.equal(authOn.executionAuthorized, true)

    await settings.getByTestId('openrouter-delete-key-btn').click()
    const deleted = await win.evaluate(async () => window.ghostBot.getOpenRouterStatus())
    assert.equal(deleted.credentialConfigured, false)
  }

  await settings.getByRole('button', { name: /Close settings/i }).click()

  // 4. Create an OpenRouter bot via BotEditorModal
  await win
    .getByRole('button', { name: /\+ New bot/i })
    .or(win.getByTitle(/New bot/i))
    .or(win.locator('button', { hasText: '+' }).first())
    .click()
  const botDialog = win.getByRole('dialog', { name: /Create bot/i })
  await botDialog.waitFor({ timeout: 10_000 })
  await botDialog
    .getByPlaceholder(/Name/i)
    .or(botDialog.locator('input[type="text"]').first())
    .fill('OpenRouter Bot')
  await botDialog.getByTestId('bot-runtime-select').selectOption('openrouter')
  await botDialog.locator('input[type="text"]').last().fill(workspaceDir)
  await botDialog.getByRole('button', { name: /Create bot|Save/i }).click()

  await win.getByText('OpenRouter Bot').first().waitFor({ timeout: 10_000 })
  console.log('PROVIDER6_OPENAI_COMPAT_DESKTOP_E2E_PASSED')
} finally {
  await app.close()
  rmSync(tempRoot, { recursive: true, force: true })
}
