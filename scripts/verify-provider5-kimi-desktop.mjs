import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const tempRoot = mkdtempSync(join(tmpdir(), 'ghost-p5-e2e-'))
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

  // 1. Inspect Kimi Code ACP card in Settings -> Accounts & Providers
  await win.getByRole('button', { name: /Settings/i }).click()
  const settings = win.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: /Accounts & Providers/i }).click()
  await settings.getByTestId('kimi-status-card').waitFor({ timeout: 10_000 })
  await settings.getByTestId('kimi-gated-reason').waitFor({ timeout: 10_000 })
  await settings.getByRole('button', { name: /Close settings/i }).click()

  // 2. Verify IPC contract directly
  const status = await win.evaluate(async () => window.ghostBot.getKimiStatus())
  assert.equal(status.capabilities.clientFsSupported, false)
  assert.equal(status.capabilities.clientTerminalSupported, false)
  assert.equal(status.policyCompatibility.fullAccessAllowed, false)

  // 3. Create a bot with Kimi Code ACP runtime
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
    .fill('Kimi ACP Bot')
  await botDialog.getByTestId('bot-runtime-select').selectOption('kimi-acp')
  await botDialog.locator('input[type="text"]').last().fill(workspaceDir)
  await botDialog.getByRole('button', { name: /Create bot|Save/i }).click()

  await win.getByText('Kimi ACP Bot').first().waitFor({ timeout: 10_000 })
  console.log('PROVIDER5_KIMI_DESKTOP_E2E_PASSED')
} finally {
  await app.close()
  rmSync(tempRoot, { recursive: true, force: true })
}
