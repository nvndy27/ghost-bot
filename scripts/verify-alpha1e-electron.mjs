import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

const desktop = join(process.cwd(), 'apps', 'desktop')
const dataDir = await mkdtemp(join(tmpdir(), 'ghost-task-summary-electron-'))
const launch = () => electron.launch({
  executablePath: join(desktop, 'node_modules', '.bin', 'electron'),
  args: [join(desktop, 'dist-electron/main.js')],
  cwd: desktop,
  env: { ...process.env, GHOST_BOT_DATA_DIR: dataDir, GHOST_BOT_RUNTIME_MODE: 'mock', GHOST_BOT_SMOKE_EXIT: '0' },
})

let app
try {
  app = await launch()
  let page = await app.firstWindow()
  await page.getByText('Chief of Staff', { exact: true }).first().waitFor()

  const teamId = await page.evaluate(async () => (await window.ghostBot.createTeam({
    name: 'Summary Group', leadBotId: 'chief', memberBotIds: ['chief', 'developer'],
  })).id)
  await page.reload()

  await page.locator(`[data-team-id="${teamId}"] .gb-team-item`).click()
  await page.getByRole('button', { name: 'Delegate task' }).click()
  await page.getByLabel('Delegate member').selectOption('developer')
  await page.getByLabel('Task objective').fill('Summarize alpha1e verification')
  await page.getByRole('button', { name: 'Confirm task delegation' }).click()

  // Durable Task Summary card appears automatically in Group Chat
  await page.locator('[data-task-summary]').first().waitFor()
  await page.getByText('Task Summary', { exact: true }).waitFor()
  await page.getByText(/Task completed:.*Summarize alpha1e verification/).waitFor()
  assert.equal(await page.locator('[data-task-summary]').count(), 1)

  // Click View task chat link -> opens dedicated Private Task Chat
  await page.getByRole('button', { name: 'View task chat' }).first().click()
  await page.getByTestId('private-task-header').waitFor()
  await page.getByText(/\[Mock Developer\] Received your request: "Summarize alpha1e verification"/).waitFor()
  await app.close()

  // Launch 2: Restart persistence with zero duplicate summaries
  app = await launch()
  page = await app.firstWindow()
  await page.getByText('Chief of Staff', { exact: true }).first().waitFor()
  await page.locator(`[data-team-id="${teamId}"] .gb-team-item`).click()
  await page.locator('[data-task-summary]').first().waitFor()
  assert.equal(await page.locator('[data-task-summary]').count(), 1)
  console.log('Alpha.1E offline Electron verified durable task summary publishing, link navigation and restart idempotency')
} finally {
  await app?.close()
  await rm(dataDir, { recursive: true, force: true })
}
