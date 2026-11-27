import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const tempRoot = mkdtempSync(join(tmpdir(), 'ghost-p2-e2e-'))
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
  },
})

try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  // 1. Inspect Ollama Local status card in Settings -> Accounts & Providers & Models
  await win.getByRole('button', { name: /Settings/i }).click()
  const settings = win.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: /Accounts & Providers/i }).click()
  await settings.getByTestId('ollama-status-card').waitFor({ timeout: 10_000 })
  await settings.getByTestId('ollama-gated-reason').waitFor({ timeout: 10_000 })
  await settings.getByRole('button', { name: /Models/i }).click()
  await settings.getByTestId('ollama-models-section').waitFor({ timeout: 10_000 })
  await settings.getByRole('button', { name: /Close settings/i }).click()

  // 2. Select Ollama Local runtime when creating a bot
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
    .fill('Ollama Local Bot')
  await botDialog.getByTestId('bot-runtime-select').selectOption('ollama')
  await botDialog.getByTestId('bot-model-select').waitFor({ timeout: 10_000 })
  await botDialog.locator('input[type="text"]').last().fill(workspaceDir)
  await botDialog.getByRole('button', { name: /Create bot|Save/i }).click()

  await win.getByText('Ollama Local Bot').first().waitFor({ timeout: 10_000 })

  // 3. Verify IPC contract directly via preload bridge
  const status = await win.evaluate(async () => window.ghostBot.getOllamaStatus())
  assert.equal(status.baseUrl, 'http://127.0.0.1:11434')
  assert.equal(status.policyCompatibility.askApprovalAllowed, false)
  assert.equal(status.policyCompatibility.workspaceAllowed, false)
  assert.equal(status.policyCompatibility.fullAccessAllowed, false)

  console.log('PROVIDER2_OLLAMA_DESKTOP_E2E_PASSED')
} finally {
  await app.close()
  rmSync(tempRoot, { recursive: true, force: true })
}
