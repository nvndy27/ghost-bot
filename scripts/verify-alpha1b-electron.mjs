import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

const desktopDir = join(process.cwd(), 'apps', 'desktop')
const dataDir = await mkdtemp(join(tmpdir(), 'ghost-alpha1b-electron-'))
const launch = () => electron.launch({
  executablePath: join(desktopDir, 'node_modules', '.bin', 'electron'),
  args: [join(desktopDir, 'dist-electron', 'main.js')],
  cwd: desktopDir,
  env: { ...process.env, GHOST_BOT_DATA_DIR: dataDir, GHOST_BOT_RUNTIME_MODE: 'mock', GHOST_BOT_SMOKE_EXIT: '0' },
})
let app
try {
  app = await launch()
  let page = await app.firstWindow()
  await page.getByText('Chief of Staff', { exact: true }).first().waitFor()
  const teamId = await page.evaluate(async () => {
    const team = await window.ghostBot.createTeam({
      name: 'Alpha routing fixture',
      leadBotId: 'chief',
      memberBotIds: ['chief', 'developer'],
    })
    return team.id
  })
  const openRouting = async () => {
    await page.locator(`[data-team-id="${teamId}"] .gb-team-item`).click()
    await page.getByText('Member model settings', { exact: true }).click()
    await page.getByLabel('Member', { exact: true }).selectOption('developer')
    await page.getByLabel('Model', { exact: true }).waitFor()
  }
  await page.reload()
  await openRouting()
  await page.getByLabel('Model', { exact: true }).selectOption('mock-model')
  await page.getByLabel('Reasoning effort').selectOption('low')
  await page.getByRole('button', { name: 'Save member settings' }).click()
  await page.getByText('Effective: mock-offline · mock-model · low', { exact: true }).waitFor()
  const globalModel = await page.evaluate(async () => (await window.ghostBot.listBots()).bots.find((bot) => bot.id === 'developer').modelId)
  assert.equal(globalModel, 'codex-mock')
  await app.close()

  app = await launch()
  page = await app.firstWindow()
  await openRouting()
  assert.equal(await page.getByLabel('Model', { exact: true }).inputValue(), 'mock-model')
  await page.getByRole('button', { name: 'Reset to bot defaults' }).click()
  await page.getByText('Effective: mock-offline · codex-mock · medium', { exact: true }).waitFor()
  console.log('Alpha.1B offline Electron verified scoped override, global isolation, restart and reset')
} finally {
  await app?.close()
  await rm(dataDir, { recursive: true, force: true })
}
