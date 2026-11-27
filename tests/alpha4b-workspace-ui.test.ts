import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { launchWorkspaceElectron } from './helpers/workspace-electron.ts'

test('Alpha.4B Electron Explorer layout, narrow overlay, keyboard resize and reference screenshots', async () => {
  const data = await mkdtemp(join(tmpdir(), 'ghost-alpha4b-'))
  const workspace = join(data, 'workspace')
  const screenshots = process.env.GHOST_BOT_WORKSPACE_SCREENSHOT_DIR
  await mkdir(workspace)
  await writeFile(join(workspace, 'workspace.ts'), '// Synthetic UI acceptance fixture\nexport const workspace = "Ghost Bot"\n')
  await writeFile(join(workspace, 'notes.md'), '# Workspace review\nLocal fixture content.\n')
  if (screenshots) await mkdir(screenshots, { recursive: true })
  const app = await launchWorkspaceElectron(data)
  try {
    const page = await app.firstWindow()
    await page.setViewportSize({ width: 1440, height: 900 })
    const setViewport = async (width: number, height: number) => {
      await page.setViewportSize({ width, height })
      await page.waitForFunction((expected) => window.innerWidth === expected, width)
      await page.evaluate(() => new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ))
    }
    await page.getByRole('option').filter({ hasText: 'Developer' }).click()
    await page.evaluate(async (root) => {
      const bridge = window.ghostBot!
      const { activeBotId } = await bridge.listBots()
      if (!activeBotId) throw new Error('Missing fixture bot')
      await bridge.updateBot({ id: activeBotId!, patch: { workspacePath: root, permission: 'workspace' } })
    }, workspace)
    await page.reload()
    await page.getByRole('option').filter({ hasText: 'Developer' }).waitFor()
    const shell = page.getByTestId('workspace-panel-shell')
    const resize = page.getByRole('separator', { name: 'Resize right workspace panel' })
    assert.equal(await shell.evaluate((element) => element.getBoundingClientRect().width), 400)
    const toolsLink = page.getByRole('button', { name: 'Connected tools' })
    assert.equal(await toolsLink.isEnabled(), true)
    await toolsLink.click()
    await page.getByTestId('mcp-settings-section').waitFor()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Provider usage' }).click()
    await page.getByRole('dialog', { name: 'Provider usage' }).waitFor()
    assert.equal(await shell.getByText('Account usage', { exact: true }).count(), 0)
    await page.getByRole('button', { name: 'Close provider usage' }).click()
    const setWidth = async (width: number) => {
      const current = await shell.evaluate((element) => element.getBoundingClientRect().width)
      if (current === width) return
      const handle = await resize.boundingBox()
      assert.ok(handle)
      await page.mouse.move(handle.x + handle.width / 2, 400)
      await page.mouse.down()
      await page.mouse.move(handle.x + handle.width / 2 + current - width, 400)
      await page.mouse.up()
      await page.waitForFunction((expected) =>
        document.querySelector('[data-testid="workspace-panel-shell"]')?.getBoundingClientRect().width === expected, width)
    }
    await setWidth(400)
    await page.getByTestId('workspace-tab-files').click()
    await app.evaluate(({ dialog }, root) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] })
    }, workspace)
    await page.getByRole('button', { name: 'Allow read access' }).click()
    await page.getByTestId('workspace-tree-entry-workspace.ts').click()
    await page.getByTestId('workspace-editor-textarea').waitFor()
    const tree = page.getByTestId('workspace-file-tree')
    const editor = page.getByTestId('workspace-editor-textarea')
    const treeBounds = await tree.boundingBox()
    const editorBounds = await editor.boundingBox()
    assert.ok(treeBounds && editorBounds)
    assert.ok(treeBounds.x + treeBounds.width <= editorBounds.x)
    assert.ok(Math.abs(treeBounds.y - editorBounds.y) < 140)
    const treeResize = page.getByRole('separator', { name: 'Resize file explorer' })
    await treeResize.focus()
    await treeResize.press('ArrowRight')
    assert.equal(await treeResize.getAttribute('aria-valuenow'), '155')
    await treeResize.press('ArrowLeft')
    assert.equal(await treeResize.getAttribute('aria-valuenow'), '145')
    assert.equal(await shell.locator('.gb-workspace-header').evaluate((element) => element.getBoundingClientRect().height), 58)

    const capture = async (name: string) => {
      if (screenshots) await page.screenshot({ path: join(screenshots, name + '.png') })
    }
    for (const theme of ['dark', 'light', 'system']) {
      await page.getByRole('button', { name: 'Open Settings' }).click()
      await page.getByLabel('Theme').selectOption(theme)
      await page.waitForFunction((expected) => document.documentElement.dataset.theme ===
        (expected === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : expected), theme)
      await page.keyboard.press('Escape')
      for (const tab of ['overview', 'files', 'changes', 'browser', 'output']) {
        await page.getByTestId('workspace-tab-' + tab).click()
        await page.getByTestId('workspace-tabpanel-' + tab).waitFor()
        if (tab === 'changes') await page.getByText('Loading Git changes…').waitFor({ state: 'hidden' })
        await capture(tab + '-' + theme + '-1440x900')
      }
    }
    await page.getByTestId('workspace-tab-files').click()
    for (const viewport of [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
      await setViewport(viewport.width, viewport.height)
      await capture('files-system-' + viewport.width + 'x' + viewport.height)
    }
    await setViewport(1440, 900)
    const narrowUsage = page.getByRole('button', { name: 'Provider usage' })
    await setWidth(850)
    const preferenceAtWide = await page.evaluate(() => window.ghostBot!.getSettings())
    assert.equal(preferenceAtWide.appearance.rightWidth, 850)
    await setViewport(1280, 720)
    await page.waitForFunction(() => document.querySelector('[data-testid="workspace-panel-shell"]')?.getBoundingClientRect().width === 832)
    await setViewport(720, 900)
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="workspace-panel-shell"]')!).position === 'absolute')
    const narrowPanel = await shell.boundingBox()
    assert.ok(narrowPanel && narrowPanel.width <= 648)
    assert.equal(await resize.isVisible(), false)
    assert.equal((await page.evaluate(() => window.ghostBot!.getSettings())).appearance.rightWidth, 850)
    await capture('workspace-overlay-narrow')
    await setViewport(1440, 900)
    await setWidth(400)
    assert.equal(await narrowUsage.isVisible(), true)
    await setWidth(220)
    await tree.waitFor({ state: 'hidden' })
    const toggle = page.getByTestId('workspace-explorer-toggle')
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
    await capture('files-minimum-220')
    await toggle.click()
    await tree.waitFor()
    const overlay = await tree.boundingBox()
    const panel = await shell.boundingBox()
    assert.ok(overlay && panel && overlay.x >= panel.x && overlay.x + overlay.width <= panel.x + panel.width)
    await capture('files-explorer-overlay-220')
    await page.getByTestId('workspace-tree-entry-notes.md').click()
    await tree.waitFor({ state: 'hidden' })
    await shell.getByRole('tab', { name: 'workspace.ts', exact: true }).waitFor()
    await shell.getByRole('tab', { name: 'notes.md', exact: true }).waitFor()
    assert.equal(await shell.getByRole('tab', { name: 'workspace.ts', exact: true }).count(), 1)
    assert.equal(await shell.getByRole('tab', { name: 'notes.md', exact: true }).count(), 1)
    assert.equal(await editor.inputValue(), '# Workspace review\nLocal fixture content.\n')
    await page.getByTestId('workspace-maximize-btn').click()
    await tree.waitFor()
    assert.equal(await page.locator('.gb-center').isVisible(), false)
    await capture('files-maximized')
    await page.getByTestId('workspace-maximize-btn').click()
    assert.equal(await page.locator('.gb-center').isVisible(), true)
    await page.evaluate(async () => {
      const bridge = window.ghostBot!
      const { bots } = await bridge.listBots()
      await bridge.createTeam({ name: 'Workspace UI fixture team', leadBotId: bots[0].id,
        memberBotIds: [bots[0].id, bots[1].id] })
    })
    await page.reload()
    await page.locator('[data-team-id] .gb-team-item').filter({ hasText: 'Workspace UI fixture team' }).click()
    await setWidth(400)
    await page.getByTestId('workspace-tab-overview').click()
    await page.getByLabel('Team activity panel').waitFor()
    const diagnostics = page.getByLabel('Team activity panel').locator('details')
    await diagnostics.locator('summary').click()
    await diagnostics.getByText('Concurrency limit', { exact: true }).waitFor()
    await diagnostics.getByText('Uncertain', { exact: true }).waitFor()
    await diagnostics.locator('summary').click()
    for (const theme of ['dark', 'light']) {
      await page.getByRole('button', { name: 'Open Settings' }).click()
      await page.getByLabel('Theme').selectOption(theme)
      await page.waitForFunction((expected) => document.documentElement.dataset.theme ===
        (expected === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : expected), theme)
      await page.keyboard.press('Escape')
      await capture('team-overview-' + theme + '-1440x900')
    }
    await page.getByTestId('workspace-tab-files').click()
    await page.getByText('Group workspace requires an authorized task scope', { exact: false }).waitFor()
    await setViewport(720, 900)
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="workspace-panel-shell"]')!).position === 'absolute')
    await capture('team-workspace-overlay-narrow')
  } finally {
    await app.close()
    await rm(data, { recursive: true, force: true })
  }
})
