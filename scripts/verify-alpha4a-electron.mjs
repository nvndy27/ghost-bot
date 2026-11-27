import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

const desktop = join(process.cwd(), 'apps/desktop')
const dataDir = await mkdtemp(join(tmpdir(), 'ghost-alpha4a-'))
const screenshots = process.env.ALPHA4A_SCREENSHOT_DIR
if (screenshots) await mkdir(screenshots, { recursive: true })
const launch = () => electron.launch({
  executablePath: join(desktop, 'node_modules/.bin/electron'),
  args: [join(desktop, 'dist-electron/main.js')], cwd: desktop,
  env: { ...process.env, GHOST_BOT_RUNTIME_MODE: 'mock', GHOST_BOT_DATA_DIR: dataDir, GHOST_BOT_SMOKE_EXIT: '0' },
})
let app
try {
  app = await launch()
  let page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.locator('[data-bot-id="chief"]').waitFor()
  const capture = async (name) => { if (screenshots) await page.screenshot({ path: join(screenshots, name + '.png') }) }
  await page.setViewportSize({ width: 1440, height: 900 })
  const draft = page.getByPlaceholder('Message Chief of Staff...')
  await draft.fill('Synthetic V03.2 acceptance message')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await page.getByText(/Received your request:/).first().waitFor()
  await draft.fill('Unsent personal draft')
  const emptyHeight = (await draft.boundingBox()).height
  await draft.fill('Line one\nLine two\nLine three\nLine four\nLine five')
  assert.ok((await draft.boundingBox()).height > emptyHeight)
  await draft.fill('Unsent personal draft')
  await page.getByRole('button', { name: 'Provider usage', exact: true }).click()
  await page.getByRole('dialog', { name: 'Provider usage', exact: true }).waitFor()
  await page.getByText('Quota unavailable', { exact: true }).waitFor()
  await capture('usage-dark')
  await page.getByRole('button', { name: 'Manage providers in Settings' }).click()
  await page.getByRole('button', { name: 'Accounts & Providers', exact: true }).waitFor()
  await capture('accounts-dark')
  await page.getByRole('button', { name: 'Appearance', exact: true }).click()
  await capture('settings-dark')
  await page.getByRole('button', { name: 'Close settings' }).click()
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.gb-left-sidebar')?.getBoundingClientRect().width === 56)
  await capture('compact-dark')
  await page.getByRole('button', { name: 'Search bots and groups' }).click()
  await page.getByLabel('Search bots', { exact: true }).fill('Researcher')
  assert.equal(await page.locator('.gb-bot-list [role="option"]').count(), 1)
  await page.getByLabel('Search bots', { exact: true }).fill('')
  assert.equal(await draft.inputValue(), 'Unsent personal draft')
  await capture('personal-dark')
  for (const theme of ['light', 'dark']) {
    await page.getByRole('button', { name: 'Open Settings' }).click()
    await page.getByRole('button', { name: 'Appearance', exact: true }).click()
    await page.getByLabel('Theme', { exact: true }).selectOption(theme)
    await page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, theme)
    await page.getByRole('button', { name: 'Close settings' }).click()
    await page.getByRole('button', { name: 'Provider usage', exact: true }).click()
    await capture('usage-' + theme)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Open Settings' }).click()
    await page.getByRole('button', { name: 'Appearance', exact: true }).click()
    await capture('settings-' + theme)
    await page.getByRole('button', { name: 'Accounts & Providers', exact: true }).click()
    await capture('accounts-' + theme)
    await page.getByRole('button', { name: 'Close settings' }).click()
    for (const [width, height] of [[1440, 900], [1280, 720], [1920, 1080], [900, 700]]) {
      await page.setViewportSize({ width, height })
      await capture('personal-' + theme + '-' + width)
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.setViewportSize({ width: 740, height: 700 })
  await page.waitForFunction(() => document.querySelector('.gb-left-sidebar')?.getBoundingClientRect().width === 56)
  await capture('responsive-rail-dark')
  await page.getByRole('button', { name: 'Search bots and groups' }).click()
  await page.getByLabel('Search bots', { exact: true }).waitFor()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: 'Edit bot', exact: true }).click()
  assert.equal(await page.locator('[aria-label^="Shape "]').count(), 12)
  await capture('bot-editor-dark')
  await page.keyboard.press('Escape')
  const team = await page.evaluate(() => window.ghostBot.createTeam({
    name: 'Synthetic V03.2 team', leadBotId: 'chief', memberBotIds: ['chief', 'developer'],
  }))
  await page.reload()
  await page.locator('[data-team-id="' + team.id + '"] .gb-team-item').click()
  const composer = page.getByLabel('Group discussion message')
  await composer.fill('Synthetic team discussion')
  await page.getByRole('button', { name: 'Send to group' }).click()
  await page.locator('.gb-discussion-reply').first().waitFor()
  await capture('group-dark')
  await page.getByRole('button', { name: 'Open Settings' }).click()
  await page.getByRole('button', { name: 'Appearance', exact: true }).click()
  await page.getByLabel('Theme', { exact: true }).selectOption('light')
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  await page.getByRole('button', { name: 'Close settings' }).click()
  await capture('group-light')
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
  await page.waitForFunction(async () => (await window.ghostBot.getSettings()).appearance.leftCollapsed)
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('ghost:runtime:snapshot')
    ipcMain.handle('ghost:runtime:snapshot', () => { throw new Error('Synthetic offline usage refresh failure') })
  })
  await page.getByRole('button', { name: 'Provider usage', exact: true }).click()
  await page.getByRole('button', { name: 'Refresh provider usage' }).click()
  await page.getByRole('alert').filter({ hasText: 'Synthetic offline usage refresh failure' }).waitFor()
  await capture('usage-refresh-error')
  await page.keyboard.press('Escape')
  await app.close()
  app = await launch()
  page = await app.firstWindow()
  await page.waitForFunction(() => document.querySelector('.gb-left-sidebar')?.getBoundingClientRect().width === 56)
  assert.deepEqual(errors, [])
  console.log('Alpha.4A offline Electron passed compact persistence, search, drafts, grow, usage, Accounts, themes, 12 avatars and Group discussion')
} finally {
  await app?.close()
  await rm(dataDir, { recursive: true, force: true })
}
