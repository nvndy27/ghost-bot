import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

const desktop = join(process.cwd(), 'apps', 'desktop')
const dataDir = await mkdtemp(join(tmpdir(), 'ghost-private-task-electron-'))
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
    name: 'Task Delegation Group', leadBotId: 'chief', memberBotIds: ['chief', 'developer'],
  })).id)
  await page.reload()

  await page.locator(`[data-team-id="${teamId}"] .gb-team-item`).click()
  await page.getByRole('button', { name: 'Delegate task' }).click()
  await page.getByLabel('Delegate member').selectOption('developer')
  await page.getByLabel('Task objective').fill('Audit mock isolation')
  await page.getByRole('button', { name: 'Confirm task delegation' }).click()

  await page.getByText('Private Task Chats (1)', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Open task chat' }).first().click()
  await page.getByTestId('private-task-header').waitFor()
  await page.getByText('Group Task · Task Delegation Group', { exact: true }).waitFor()
  await page.getByText(/\[Mock Developer\] Received your request: "Audit mock isolation"/).waitFor()

  // Navigate back to group and verify group discussion still works
  await page.getByRole('button', { name: 'Back to group' }).click()
  await page.getByLabel('Group discussion message').fill('@chief status check')
  await page.getByRole('button', { name: 'Send to group' }).click()
  await page.getByText('[Mock response] @chief status check', { exact: true }).waitFor()

  // Verify personal developer conversation remains isolated
  await page.locator('.gb-bot-list [data-bot-id="developer"] [role="option"]').click()
  await page.waitForSelector('header >> text=Developer')
  assert.equal(await page.locator('.gb-messages').getByText('Audit mock isolation').count(), 0)

  await app.close()

  // Launch 2: Restart persistence of Private Task Chat
  app = await launch()
  page = await app.firstWindow()
  await page.getByText('Chief of Staff', { exact: true }).first().waitFor()
  await page.locator('[data-sidebar-private-task]').first().click()
  await page.getByTestId('private-task-header').waitFor()
  await page.getByText(/\[Mock Developer\] Received your request: "Audit mock isolation"/).waitFor()
  console.log('Alpha.1D offline Electron verified delegation, Private Task Chat isolation, group responsiveness and restart')
} finally {
  await app?.close()
  await rm(dataDir, { recursive: true, force: true })
}
