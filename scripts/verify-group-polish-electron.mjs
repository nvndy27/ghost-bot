import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

const desktop = join(process.cwd(), 'apps', 'desktop')
const dir = await mkdtemp(join(tmpdir(), 'ghost-group-polish-'))
const screenshotDir = process.env.GROUP_SCREENSHOT_DIR
const launch = () => electron.launch({
  executablePath: join(desktop, 'node_modules/.bin/electron'),
  args: [join(desktop, 'dist-electron/main.js')],
  cwd: desktop,
  env: { ...process.env, GHOST_BOT_DATA_DIR: dir, GHOST_BOT_RUNTIME_MODE: 'mock', GHOST_BOT_SMOKE_EXIT: '0' },
})
let app
try {
  app = await launch()
  let page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  await page.locator('[data-bot-id="chief"]').waitFor()
  await page.getByRole('button', { name: 'Create team', exact: true }).click()
  await page.getByPlaceholder('e.g. Research & Verification Squad').fill('Group created in editor')
  await page.getByRole('dialog').getByRole('button', { name: 'Create Team', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.getByText('Group created in editor', { exact: true }).first().waitFor()
  const teams = await page.evaluate(async () => {
    const { bots } = await window.ghostBot.listBots()
    const ids = bots.map((bot) => bot.id)
    return Promise.all([2, 3, 4, 5].map((size) => window.ghostBot.createTeam({
      name: size === 5 ? 'Synthetic planning group with a deliberately long name for narrow panel validation' : 'Fixture group ' + size,
      leadBotId: ids[0], memberBotIds: ids.slice(0, size),
    })))
  })
  await page.reload({ waitUntil: 'commit' })
  const row = (team) => page.locator(`[data-team-id="${team.id}"] .gb-team-item`)
  const avatar = (team) => row(team).locator('.gb-team-avatar')
  for (const [index, team] of teams.entries()) {
    await avatar(team).waitFor()
    assert.equal(await avatar(team).getAttribute('data-avatar-tiles'), String(Math.min(index + 2, 4)))
    const rect = await avatar(team).boundingBox()
    assert.equal(rect.width, 32)
    assert.equal(rect.height, 32)
  }

  const [target, untouched] = teams
  const edit = async () => {
    await row(target).click()
    await page.getByRole('button', { name: 'Edit team', exact: true }).click()
  }
  const save = async () => {
    await page.getByRole('button', { name: 'Save Team', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
  }
  await edit()
  const originalOrder = target.memberBotIds
  await page.getByRole('button', { name: /Move .* later in group/ }).first().click()
  await page.getByLabel('Bot avatar snapshot').selectOption(originalOrder[1])
  await save()
  assert.equal(await avatar(target).getAttribute('data-avatar-mode'), 'bot')
  assert.equal((await page.evaluate(async (id) => (await window.ghostBot.listTeams()).teams.find((item) => item.id === id), target.id)).memberBotIds[0], originalOrder[1])
  assert.equal(await avatar(untouched).getAttribute('data-avatar-mode'), 'auto')

  for (const mime of ['png', 'jpeg', 'webp']) {
    const image = await page.evaluate((format) => {
      const canvas = document.createElement('canvas')
      canvas.width = 180
      canvas.height = 96
      const context = canvas.getContext('2d')
      context.fillStyle = '#267c6d'
      context.fillRect(0, 0, 180, 96)
      context.fillStyle = '#eab566'
      context.fillRect(0, 0, 80, 96)
      return canvas.toDataURL('image/' + format)
    }, mime)
    assert.ok(image.startsWith('data:image/' + mime))
    const file = join(dir, 'avatar.' + mime)
    await writeFile(file, Buffer.from(image.split(',')[1], 'base64'))
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, file)
    await edit()
    await page.getByRole('button', { name: 'Upload image' }).click()
    const crop = page.getByRole('slider', { name: 'Square crop position' })
    await crop.focus()
    await crop.press('Home')
    assert.equal(await crop.inputValue(), '0')
    await save()
    assert.equal(await avatar(target).getAttribute('data-avatar-mode'), 'upload')
  }

  const animated = join(dir, 'animated.png')
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    return canvas.toDataURL('image/png')
  })
  const pngBytes = Buffer.from(png.split(',')[1], 'base64')
  const animationMarker = Buffer.from('000000086163544c000000020000000000000000', 'hex')
  await writeFile(animated, Buffer.concat([pngBytes.subarray(0, 33), animationMarker, pngBytes.subarray(33)]))
  const invalid = join(dir, 'invalid.png')
  await writeFile(invalid, 'invalid image bytes')
  const oversized = join(dir, 'large.png')
  await writeFile(oversized, '')
  await truncate(oversized, 5 * 1024 * 1024)
  for (const file of [invalid, oversized, animated]) {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, file)
    await edit()
    await page.getByRole('button', { name: 'Upload image' }).click()
    await page.getByRole('alert').filter({ hasText: 'non-animated PNG' }).waitFor()
    await page.keyboard.press('Escape')
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
  }
  await assert.rejects(page.evaluate((id) => window.ghostBot.updateTeam({
    teamId: id, appearance: { mode: 'upload', dataUrl: 'data:image/png;base64,aGVsbG8=' },
  }), target.id), /Invalid normalized group avatar/)

  await app.close()
  app = await launch()
  page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  await avatar(target).waitFor()
  assert.equal(await avatar(target).getAttribute('data-avatar-mode'), 'upload')
  assert.equal(await avatar(untouched).getAttribute('data-avatar-mode'), 'auto')
  await edit()
  await page.getByRole('button', { name: 'Reset to Auto' }).click()
  await save()
  await avatar(target).locator('.gb-team-avatar-grid').waitFor()
  await page.getByRole('button', { name: 'Member model settings' }).focus()
  await page.keyboard.press('Enter')
  await page.getByLabel('Member', { exact: true }).waitFor()
  await page.getByLabel('Model', { exact: true }).selectOption('mock-model')
  await page.getByLabel('Reasoning effort').selectOption('low')
  await page.getByRole('button', { name: 'Save member settings' }).click()
  await page.getByText(/Effective:.*mock-model.*low/).waitFor()
  await page.getByRole('button', { name: 'Member model settings' }).click()
  await page.getByLabel('Group discussion message').fill('Synthetic brainstorming notes')
  await page.getByLabel('Insert member mention').selectOption('all')
  await page.getByLabel('Discussion rounds').selectOption('2')
  await page.getByRole('button', { name: 'Send to group' }).click()
  await page.locator('.gb-discussion-user').waitFor()
  await page.getByText(/Round 2/).first().waitFor()
  await page.getByRole('button', { name: 'Advanced tasks', exact: true }).click()
  await page.getByLabel('Team goal input').waitFor()
  await page.getByRole('button', { name: 'Back to discussion' }).click()

  await page.getByRole('button', { name: 'Delegate task' }).click()
  await page.getByLabel('Task objective').fill('Synthetic task summary')
  await page.getByRole('button', { name: 'Confirm task delegation' }).click()
  await page.locator('[data-task-summary]').waitFor()
  await page.getByRole('button', { name: 'View task chat' }).click()
  await page.getByTestId('private-task-header').waitFor()
  await row(target).click()

  await page.setViewportSize({ width: 1440, height: 900 })
  const headerBox = await page.locator('.gb-team-chat-header').boundingBox()
  const headerAvatar = await page.locator('.gb-team-chat-header .gb-team-avatar').boundingBox()
  assert.ok(headerAvatar.y >= headerBox.y && headerAvatar.y + headerAvatar.height <= headerBox.y + headerBox.height)
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  if (screenshotDir) {
    await mkdir(screenshotDir, { recursive: true })
    await page.screenshot({ path: join(screenshotDir, 'group-chat-dark.png') })
    await page.getByRole('button', { name: 'Open Settings' }).click()
    await page.getByRole('button', { name: 'Appearance' }).click()
    await page.getByLabel('Theme').selectOption('light')
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
    await page.getByRole('button', { name: 'Close settings' }).click()
    await page.screenshot({ path: join(screenshotDir, 'group-chat-light.png') })
  }
  await page.getByRole('button', { name: 'Delegate task' }).click()
  await page.getByLabel('Delegate member').selectOption('chief')
  await page.getByLabel('Task objective').fill('Mock approval fixture for cancellation')
  await page.getByRole('button', { name: 'Confirm task delegation' }).click()
  const pending = page.locator('[data-private-task-id]').filter({ hasText: 'Mock approval fixture for cancellation' })
  await pending.getByText('awaiting_approval', { exact: true }).waitFor()
  await pending.getByRole('button', { name: 'Open task chat' }).click()
  await page.getByRole('button', { name: 'Cancel task' }).click()
  await page.getByRole('button', { name: 'Back to group' }).click()
  await page.getByText(/Task (stopped_by_parent|cancelled|outcome uncertain)/).first().waitFor()

  await page.setViewportSize({ width: 900, height: 700 })
  await row(teams[3]).click()
  const name = page.locator('.gb-team-header-label strong')
  assert.ok(await name.evaluate((el) => el.scrollWidth > el.clientWidth))
  const tool = page.getByRole('button', { name: 'Edit team', exact: true })
  assert.equal(await tool.getAttribute('title'), 'Edit team')
  await page.getByRole('button', { name: 'Collapse workspace panel' }).click()
  await page.getByRole('button', { name: 'Show team panel' }).click()
  await page.getByLabel('Resize right workspace panel').press('ArrowRight')
  await page.waitForFunction(() => document.querySelector('[data-testid="workspace-panel-shell"]')?.getBoundingClientRect().width === 269)
  console.log('Group Chat offline Electron passed avatar modes, crop, restart, isolation, routing, discussion, summaries and responsive layout')
} finally {
  await app?.close()
  await rm(dir, { recursive: true, force: true })
}
