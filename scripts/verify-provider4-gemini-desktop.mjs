import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const tempRoot = mkdtempSync(join(tmpdir(), 'ghost-p4-e2e-'))
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
    GHOST_SECRET_NAMESPACE: `p4-e2e-${randomUUID().slice(0, 8)}`,
  },
})

try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  // 1. Open Settings -> Accounts & Providers and inspect Google Gemini API card
  await win.getByRole('button', { name: /Settings/i }).click()
  const settings = win.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: /Accounts & Providers/i }).click()
  await settings.getByTestId('gemini-status-card').waitFor({ timeout: 10_000 })
  await settings.getByTestId('gemini-gated-reason').waitFor({ timeout: 10_000 })

  const initialStatus = await win.evaluate(async () => window.ghostBot.getGeminiStatus())
  assert.equal(initialStatus.billingMode, 'api-key')
  assert.equal(initialStatus.capabilities.tools, false)
  assert.equal(initialStatus.capabilities.geminiCli, false)

  if (initialStatus.keyringAvailable) {
    await settings.getByTestId('gemini-api-key-input').fill('AIzaSyDummyE2EKey11111111')
    await settings.getByTestId('gemini-save-key-btn').click()
    await settings.getByText('AIzaSy...1111').waitFor({ timeout: 10_000 })

    // Authorize Gemini API
    await settings.getByTestId('gemini-toggle-auth-btn').click()
    const authOn = await win.evaluate(async () => window.ghostBot.getGeminiStatus())
    assert.equal(authOn.executionAuthorized, true)

    // Rotate key -> resets executionAuthorized to false and increments generation
    await settings.getByTestId('gemini-api-key-input').fill('AIzaSyDummyE2EKey22222222')
    await settings.getByTestId('gemini-save-key-btn').click()
    await settings.getByText('AIzaSy...2222').waitFor({ timeout: 10_000 })
    const rotated = await win.evaluate(async () => window.ghostBot.getGeminiStatus())
    assert.equal(rotated.executionAuthorized, false)
    assert.ok(rotated.credentialGeneration > authOn.credentialGeneration)

    // Delete key
    await settings.getByTestId('gemini-delete-key-btn').click()
    const deleted = await win.evaluate(async () => window.ghostBot.getGeminiStatus())
    assert.equal(deleted.credentialConfigured, false)
  }

  await settings.getByRole('button', { name: /Close settings/i }).click()

  // 2. Create a bot with Google Gemini API runtime
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
    .fill('Gemini API Bot')
  await botDialog.getByTestId('bot-runtime-select').selectOption('gemini-api')
  await botDialog.getByTestId('bot-model-select').waitFor({ timeout: 10_000 })
  await botDialog.locator('input[type="text"]').last().fill(workspaceDir)
  await botDialog.getByRole('button', { name: /Create bot|Save/i }).click()

  await win.getByText('Gemini API Bot').first().waitFor({ timeout: 10_000 })
  console.log('PROVIDER4_GEMINI_DESKTOP_E2E_PASSED')
} finally {
  await app.close()
  rmSync(tempRoot, { recursive: true, force: true })
}
