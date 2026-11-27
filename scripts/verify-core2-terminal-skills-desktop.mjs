import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const tempRoot = mkdtempSync(join(tmpdir(), 'ghost-core2-e2e-'))
chmodSync(tempRoot, 0o700)
const dataDir = join(tempRoot, 'data')
const skillsRoot = join(tempRoot, 'skills')
const skillDir = join(skillsRoot, 'core2-e2e-skill')
mkdirSync(skillDir, { recursive: true })
const skillFile = join(skillDir, 'SKILL.md')
writeFileSync(
  skillFile,
  `---\nname: core2-e2e-skill\ndescription: Harmless Core2 E2E skill\n---\n# Body\nSafe instructions.\n`,
  'utf8',
)

mkdirSync(resolve('design/reviews/core2'), { recursive: true })

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

  // 1. Skills UI workflow in Settings -> Tools & MCP
  await win.getByRole('button', { name: /Settings/i }).click()
  const settings = win.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: /^Tools & MCP$/i }).click()

  await settings.getByTestId('skills-root-input').fill(skillsRoot)
  await settings.getByTestId('skills-discover-btn').click()
  await settings.getByTestId('skill-card-core2-e2e-skill').waitFor({ timeout: 10_000 })

  await settings.getByTestId('skill-trust-core2-e2e-skill').click()
  await settings.getByTestId('skill-toggle-core2-e2e-skill').click()
  await settings.getByTestId('skill-card-core2-e2e-skill').getByText('enabled').waitFor({ timeout: 10_000 })
  await win.screenshot({ path: resolve('design/reviews/core2/skills-settings-light.png') })

  await settings.getByRole('button', { name: /Close settings/i }).click()

  // 2. Create a bot with a real canonical workspace directory, then run Scoped Terminal workflow
  const botWorkspace = join(tempRoot, 'bot-workspace')
  mkdirSync(botWorkspace, { recursive: true })
  const createdBot = await win.evaluate(async (ws) => {
    return window.ghostBot.createBot({
      name: 'Core2 E2E Bot',
      description: 'E2E terminal bot',
      instructions: 'Test',
      avatar: { shape: 'chief', color: '#4B5563', eyes: 'classic', rotation: 0, animation: true },
      runtimeId: 'codex',
      modelId: 'gpt-5.4-mini',
      effort: 'medium',
      workspacePath: ws,
      permission: 'ask-approval',
    })
  }, botWorkspace)

  await win.reload()
  await win.waitForLoadState('domcontentloaded')

  await win.getByTestId('open-scoped-terminal-btn').click()
  const termDialog = win.getByRole('dialog', { name: /Scoped Terminal/i })
  await termDialog.waitFor({ timeout: 10_000 })
  await termDialog.getByTestId('terminal-bot-select').selectOption(createdBot.id)

  await termDialog.getByTestId('terminal-exec-input').fill('/bin/echo')
  await termDialog.getByTestId('terminal-args-input').fill('hello-core2-e2e')
  await termDialog.getByTestId('terminal-request-btn').click()

  const approveBtn = termDialog.locator('[data-testid^="terminal-approve-"]').first()
  try {
    await approveBtn.waitFor({ timeout: 5_000 })
  } catch (err) {
    const banner = await termDialog.getByTestId('terminal-error-banner').innerText().catch(() => '(no error banner)')
    throw new Error(`Terminal approve button did not appear. Banner: ${banner}`, { cause: err })
  }
  await approveBtn.click()

  await termDialog.getByText('hello-core2-e2e').last().waitFor({ timeout: 10_000 })
  await termDialog.getByText('completed').first().waitFor({ timeout: 10_000 })
  await win.screenshot({ path: resolve('design/reviews/core2/terminal-modal-light.png') })

  console.log('CORE2_TERMINAL_SKILLS_E2E_PASSED')
} finally {
  await app.close()
  rmSync(tempRoot, { recursive: true, force: true })
}
