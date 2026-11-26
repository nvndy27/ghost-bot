import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const tempRoot = mkdtempSync(join(tmpdir(), 'ghost-p3-e2e-'))
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
    GHOST_SECRET_NAMESPACE: `p3-e2e-${randomUUID().slice(0, 8)}`,
  },
})

try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  // 1. Open Settings -> Accounts & Providers and inspect Anthropic Claude API card
  await win.getByRole('button', { name: /Settings/i }).click()
  const settings = win.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: /Accounts & Providers/i }).click()
  await settings.getByTestId('claude-status-card').waitFor({ timeout: 10_000 })
  await settings.getByTestId('claude-gated-reason').waitFor({ timeout: 10_000 })

  // 2. Save, authorize, rotate, and delete API key if OS keyring is unlocked/available
  const initialStatus = await win.evaluate(async () => window.ghostBot.getClaudeStatus())
  assert.equal(initialStatus.billingMode, 'api-key-billed')
  assert.equal(initialStatus.capabilities.tools, false)
  assert.equal(initialStatus.capabilities.claudeCodeCli, false)

  if (initialStatus.keyringAvailable) {
    await settings.getByTestId('claude-api-key-input').fill('sk-ant-api03-e2e-first-key-1111')
    await settings.getByTestId('claude-save-key-btn').click()
    await settings.getByText('sk-ant-...1111').waitFor({ timeout: 10_000 })

    // Authorize API-billed execution
    await settings.getByTestId('claude-toggle-auth-btn').click()
    const authOn = await win.evaluate(async () => window.ghostBot.getClaudeStatus())
    assert.equal(authOn.executionAuthorized, true)

    // Rotate key -> resets executionAuthorized to false and increments generation
    await settings.getByTestId('claude-api-key-input').fill('sk-ant-api03-e2e-rotated-2222')
    await settings.getByTestId('claude-save-key-btn').click()
    await settings.getByText('sk-ant-...2222').waitFor({ timeout: 10_000 })
    const rotated = await win.evaluate(async () => window.ghostBot.getClaudeStatus())
    assert.equal(rotated.executionAuthorized, false)
    assert.ok(rotated.credentialGeneration > authOn.credentialGeneration)

    // Delete key
    await settings.getByTestId('claude-delete-key-btn').click()
    const deleted = await win.evaluate(async () => window.ghostBot.getClaudeStatus())
    assert.equal(deleted.credentialConfigured, false)
  }

  await settings.getByRole('button', { name: /Close settings/i }).click()

  // 3. Create a bot with Anthropic Claude API runtime
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
    .fill('Claude API Bot')
  await botDialog.getByTestId('bot-runtime-select').selectOption('claude-api')
  await botDialog.getByTestId('bot-model-select').waitFor({ timeout: 10_000 })
  await botDialog.locator('input[type="text"]').last().fill(workspaceDir)
  await botDialog.getByRole('button', { name: /Create bot|Save/i }).click()

  await win.getByText('Claude API Bot').first().waitFor({ timeout: 10_000 })
  console.log('PROVIDER3_CLAUDE_DESKTOP_E2E_PASSED')
} finally {
  await app.close()
  rmSync(tempRoot, { recursive: true, force: true })
}
