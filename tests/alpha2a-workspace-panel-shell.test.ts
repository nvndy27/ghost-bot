import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { launchWorkspaceElectron } from './helpers/workspace-electron.ts'
import { avatarPresets } from '../packages/avatar/presets.ts'
import {
  WORKSPACE_TABS,
  getNextWorkspaceTab,
} from '../apps/desktop/src/components/workspace/workspaceTabs.ts'
import {
  DEFAULT_PREFERENCES,
  UiPreferencesSchema,
  resolveEffectiveTheme,
} from '../apps/desktop/src/state/preferences.ts'

test('Alpha.2A workspace tab definitions and keyboard navigation contract', () => {
  assert.deepEqual(
    WORKSPACE_TABS.map((t) => t.id),
    ['overview', 'files', 'changes', 'browser', 'output'],
  )
  for (const tab of WORKSPACE_TABS) {
    assert.equal(tab.implemented, true, `${tab.id} is part of the integrated Workspace`)
  }

  assert.equal(getNextWorkspaceTab('overview', 'ArrowRight'), 'files')
  assert.equal(getNextWorkspaceTab('output', 'ArrowRight'), 'overview')
  assert.equal(getNextWorkspaceTab('overview', 'ArrowLeft'), 'output')
  assert.equal(getNextWorkspaceTab('browser', 'Home'), 'overview')
  assert.equal(getNextWorkspaceTab('overview', 'End'), 'output')
})

test('Alpha.2A preserves UiPreferences compatibility and 12 avatar presets', () => {
  assert.equal(avatarPresets.length, 12)
  assert.equal(DEFAULT_PREFERENCES.rightWidth, 400)
  assert.equal(DEFAULT_PREFERENCES.rightCollapsed, false)

  const parsed = UiPreferencesSchema.parse({
    theme: 'system',
    leftWidth: 240,
    rightWidth: 340,
    leftCollapsed: false,
    rightCollapsed: false,
    reducedMotion: true,
  })
  assert.equal(parsed.rightWidth, 340)
  assert.equal(resolveEffectiveTheme('dark'), 'dark')
  assert.equal(resolveEffectiveTheme('light'), 'light')
})

test('Alpha.2A Electron E2E: Workspace Panel Shell, themes, resize, collapse, maximize, keyboard & bot identity', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ghost-bot-alpha2a-'))
  const screenshotDir = join(dataDir, 'screenshots')
  await mkdir(screenshotDir, { recursive: true })

  const launch = () => launchWorkspaceElectron(dataDir)

  let app = await launch()
  try {
    let page = await app.firstWindow()
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.waitForSelector('[data-testid="workspace-panel-shell"]')

    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    page.on('pageerror', (err) => consoleErrors.push(err.message))

    // 1. Approved Overview retains production actions and collapsed runtime details
    const shell = page.getByTestId('workspace-panel-shell')
    assert.equal(await shell.getAttribute('data-active-tab'), 'overview')
    assert.equal(await shell.getAttribute('data-maximized'), 'false')
    await page.getByRole('button', { name: 'Open Live Viewer', exact: true }).waitFor()
    await page.waitForSelector('text=Current activity')
    await page.waitForSelector('text=Routines')
    await page.waitForSelector('text=Connected tools')
    await page.waitForFunction(() =>
      document.querySelector('[role="listbox"][aria-label="Bots"] [aria-selected="true"] .gb-bot-readiness')
        ?.textContent?.trim() === 'Offline Demo',
    )
    const runtimeDetails = page.locator('.gb-overview-runtime')
    await runtimeDetails.locator('summary').click()
    await page.waitForFunction(() => {
      const details = document.querySelector('.gb-overview-runtime')
      return details instanceof HTMLDetailsElement && details.open
    })
    await runtimeDetails.getByText(/Connection:/).waitFor()
    assert.equal(await runtimeDetails.getByText('Account usage', { exact: true }).count(), 0)
    await runtimeDetails.locator('summary').click()
    await page.getByRole('button', { name: 'Provider usage' }).click()
    await page.getByRole('dialog', { name: 'Provider usage' }).waitFor()
    await page.getByRole('button', { name: 'Close provider usage' }).click()
    await page.screenshot({ path: join(screenshotDir, 'alpha2a-overview-dark-1440x900.png') })

    // 2. Sidebar Bot Identity UI contract: avatar + bot name + provider label only (no model/effort)
    const botOptions = page.locator('[role="listbox"][aria-label="Bots"] [role="option"]')
    const botCount = await botOptions.count()
    assert.ok(botCount >= 2, 'Expected at least 2 seeded bots in sidebar')
    const firstBotText = (await botOptions.first().innerText()).trim()
    assert.ok(!/gpt-|claude-|gemini-|kimi-|high|medium|low/i.test(firstBotText), `Unexpected model/effort in sidebar: ${firstBotText}`)

    // 3. Keyboard-accessible tab navigation and scoped capability states
    const overviewTab = page.getByTestId('workspace-tab-overview')
    await overviewTab.focus()
    await page.keyboard.press('ArrowRight')
    await page.waitForSelector('[data-active-tab="files"]')
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'workspace-tab-files')
    await page.waitForSelector('[data-testid="workspace-files-unavailable"]')
    await page.screenshot({ path: join(screenshotDir, 'alpha2a-files-placeholder-dark.png') })

    await page.keyboard.press('ArrowRight')
    await page.waitForSelector('[data-active-tab="changes"]')
    await page.waitForSelector('[data-testid="workspace-git-changes"]')

    await page.keyboard.press('ArrowRight')
    await page.waitForSelector('[data-active-tab="browser"]')
    await page.waitForSelector('[data-testid="workspace-browser-tab"]')

    await page.keyboard.press('End')
    await page.waitForSelector('[data-active-tab="output"]')
    await page.waitForSelector('[data-testid="workspace-output-tab"]')

    // 4. The selected section persists across bots while the workspace context switches.
    await botOptions.nth(1).click()
    assert.equal(await shell.getAttribute('data-active-tab'), 'output')
    await page.getByTestId('workspace-tab-overview').click()
    await page.waitForSelector('[data-active-tab="overview"]')

    // 5. Panel resizing via keyboard on resize handle
    const initialWidth = await shell.evaluate((el) => el.getBoundingClientRect().width)
    const resizeHandle = page.getByRole('separator', { name: 'Resize right workspace panel' })
    await resizeHandle.focus()
    for (const steps of [1, 2]) {
      await resizeHandle.press('ArrowLeft')
      const expectedWidth = initialWidth + 16 * steps
      await page.waitForFunction((width) => {
        const panel = document.querySelector('[data-testid="workspace-panel-shell"]')
        return panel?.getBoundingClientRect().width === width
      }, expectedWidth)
    }
    const resizedWidth = await shell.evaluate((el) => el.getBoundingClientRect().width)

    // 6. Maximize and restore (button + Escape)
    const maxBtn = page.getByTestId('workspace-maximize-btn')
    await maxBtn.locator('svg.lucide-maximize-2').waitFor()
    assert.equal(await maxBtn.getAttribute('title'), 'Maximize workspace panel')
    await maxBtn.click()
    await maxBtn.locator('svg.lucide-minimize-2').waitFor()
    assert.equal(await maxBtn.getAttribute('aria-label'), 'Restore workspace panel')
    assert.equal(await shell.getAttribute('data-maximized'), 'true')
    const maxWidth = await shell.evaluate((el) => el.getBoundingClientRect().width)
    assert.ok(maxWidth > resizedWidth, `Expected maximized width (${maxWidth}) > resized width (${resizedWidth})`)
    await page.screenshot({ path: join(screenshotDir, 'alpha2a-maximized-dark-1440x900.png') })

    await page.keyboard.press('Escape')
    assert.equal(await shell.getAttribute('data-maximized'), 'false')
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'workspace-maximize-btn')

    // 7. Collapse and restore
    await page.getByTestId('workspace-collapse-btn').click()
    await page.getByTestId('workspace-panel-shell').waitFor({ state: 'detached' })
    assert.equal(await page.getByTestId('workspace-panel-shell').count(), 0)
    await page.getByRole('button', { name: 'Expand right workspace' }).click()
    await page.waitForSelector('[data-testid="workspace-panel-shell"]')

    // 8. The five icon-only tabs fit at the minimum width in both themes.
    const handleBounds = await resizeHandle.boundingBox()
    assert.ok(handleBounds)
    const handleY = handleBounds.y + handleBounds.height / 2
    await page.mouse.move(handleBounds.x + handleBounds.width / 2, handleY)
    await page.mouse.down()
    await page.mouse.move(1438, handleY)
    await page.mouse.up()
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="workspace-panel-shell"]')?.getBoundingClientRect().width === 220)
    const screenshotOutput = process.env.GHOST_BOT_WORKSPACE_SCREENSHOT_DIR ?? screenshotDir
    await mkdir(screenshotOutput, { recursive: true })
    const tablist = shell.getByRole('tablist', { name: 'Workspace sections' })
    for (const theme of ['dark', 'light'] as const) {
      await page.getByRole('button', { name: 'Open Settings' }).click()
      await page.getByLabel('Theme').selectOption(theme)
      await page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, theme)
      await page.keyboard.press('Escape')
      for (const [label, glyph] of [
        ['Overview', 'layout-dashboard'], ['Files', 'files'], ['Changes', 'git-branch'],
        ['Browser', 'globe'], ['Output', 'terminal'],
      ] as const) {
        const tab = tablist.getByRole('tab', { name: label, exact: true })
        assert.equal(await tab.getAttribute('title'), label)
        assert.equal(await tab.textContent(), '')
        const icon = tab.locator(`svg.lucide-${glyph}`)
        assert.equal(await icon.getAttribute('aria-hidden'), 'true')
        assert.equal(await icon.getAttribute('width'), '18')
        assert.equal(await icon.getAttribute('height'), '18')
      }
      const row = await tablist.evaluate((list) => {
        const bounds = list.getBoundingClientRect()
        return Array.from(list.querySelectorAll('[role="tab"]'), (tab) => {
          const rect = tab.getBoundingClientRect()
          return { top: rect.top, width: rect.width, height: rect.height,
            inside: rect.left >= bounds.left && rect.right <= bounds.right }
        })
      })
      assert.equal(row.length, 5)
      assert.ok(row.every((tab) => tab.top === row[0].top && tab.width === 32 && tab.height === 32 && tab.inside))
      await tablist.getByRole('tab', { name: 'Output', exact: true }).click()
      await shell.getByTestId('workspace-output-tab').waitFor()
      assert.equal(await tablist.getByRole('tab', { name: 'Output', exact: true }).getAttribute('aria-selected'), 'true')
      const expectedBackground = theme === 'dark' ? 'rgb(24, 24, 24)' : 'rgb(253, 253, 252)'
      await page.waitForFunction(({ theme, expectedBackground }) => {
        const panel = document.querySelector('[data-testid="workspace-panel-shell"]')
        return panel?.getBoundingClientRect().width === 220 &&
          document.documentElement.dataset.theme === theme &&
          getComputedStyle(panel).backgroundColor === expectedBackground
      }, { theme, expectedBackground })
      await page.mouse.move(700, 100)
      await shell.screenshot({ path: join(screenshotOutput, `workspace-icons-${theme}-220px.png`), scale: 'css' })
      await tablist.getByRole('tab', { name: 'Overview', exact: true }).click()
    }

    // Switch to system theme and restore dark-friendly layout
    await page.getByRole('button', { name: 'Open Settings' }).click()
    await page.getByLabel('Theme').selectOption('system')
    await page.waitForFunction(() => {
      const t = document.documentElement.dataset.theme
      return t === 'dark' || t === 'light'
    })
    await page.keyboard.press('Escape')

    // 9. At 900px the desktop panel remains capped at 65% of the viewport.
    await page.setViewportSize({ width: 900, height: 700 })
    await page.getByTestId('workspace-maximize-btn').click()
    const narrowMaxWidth = await shell.evaluate((el) => el.getBoundingClientRect().width)
    assert.equal(narrowMaxWidth, 585, `Expected the 65% desktop maximum at 900px, got ${narrowMaxWidth}`)
    await page.screenshot({ path: join(screenshotDir, 'alpha2a-narrow-maximized-900x700.png') })
    await page.getByTestId('workspace-maximize-btn').click()

    // Exercise the real preload and daemon with a temporary workspace and no inference.
    const workspace = join(dataDir, 'fixture-workspace')
    const file = join(workspace, 'sample.txt')
    await mkdir(workspace)
    await writeFile(file, 'Initial fixture\n')
    await page.evaluate(async (workspacePath) => {
      const bridge = window.ghostBot!
      const { bots } = await bridge.listBots()
      const bot = bots[0]
      await bridge.updateBot({ id: bot.id, patch: { workspacePath, permission: 'workspace' } })
      await bridge.setActiveBot(bot.id)
      await bridge.createTeam({
        name: 'Workspace Test Team',
        leadBotId: bot.id,
        memberBotIds: [bot.id, bots[1].id],
      })
    }, workspace)
    await app.close()
    app = await launch()
    page = await app.firstWindow()
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(err.message))
    await page.getByTestId('workspace-tab-files').click()
    await page.getByText('Allow read access to this bot workspace', { exact: false }).waitFor()
    const authorize = page.getByRole('button', { name: 'Allow read access', exact: true })
    await app.evaluate(({ dialog }, chosen) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] })
    }, dataDir)
    await authorize.click()
    await page.getByText('Select the configured bot workspace directory', { exact: false }).waitFor()
    await app.evaluate(({ dialog }, chosen) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] })
    }, workspace)
    await authorize.click()
    await page.getByTestId('workspace-tree-entry-sample.txt').click()
    const editor = page.getByTestId('workspace-editor-textarea')
    await editor.waitFor()
    assert.equal(await editor.inputValue(), 'Initial fixture\n')

    await page.getByRole('searchbox', { name: 'Search workspace' }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Add selection to chat draft' }).isDisabled(), true)
    assert.equal(await editor.getAttribute('readonly'), '')
    assert.equal(await page.getByTestId('workspace-files-permission-badge').innerText(), 'Read-only')

    const original = await page.evaluate(async () => {
      const bridge = window.ghostBot!
      const botId = (await bridge.listBots()).activeBotId!
      const context = await bridge.resolveWorkspaceContext({ botId })
      if (!context.workspaceId || !context.authGeneration) throw new Error('Missing authorized context')
      return {
        botId,
        workspaceId: context.workspaceId,
        authGeneration: context.authGeneration,
        relativePath: 'sample.txt',
      }
    })
    const revision = await page.evaluate(async (target) => {
      const bridge = window.ghostBot!
      return (await bridge.readWorkspaceFile(target)).revision
    }, original)

    await assert.rejects(
      page.evaluate((target) => window.ghostBot!.readWorkspaceFile({ ...target, canWrite: true } as typeof target), original),
      /unrecognized key/i,
    )
    await assert.rejects(
      page.evaluate((target) => window.ghostBot!.readWorkspaceFile({ ...target, relativePath: '/etc/hostname' }), original),
      /absolute paths are not allowed/i,
    )

    await writeFile(file, 'External edit\n')
    await assert.rejects(
      page.evaluate(async ({ target, expectedRevision }) => {
        return window.ghostBot!.saveWorkspaceFile({ ...target, expectedRevision, content: 'Denied edit' })
      }, { target: original, expectedRevision: revision }),
      /native write consent is required/i,
    )
    assert.equal(await readFile(file, 'utf8'), 'External edit\n')

    const reopenBotWorkspace = async () => {
      const options = page.getByRole('listbox', { name: 'Bots' }).getByRole('option')
      await options.nth(1).click()
      await options.first().click()
    }
    const replacement = join(dataDir, 'replacement-workspace')
    await mkdir(replacement)
    await page.evaluate(async ({ id, workspacePath }) => {
      await window.ghostBot!.updateBot({ id, patch: { workspacePath } })
    }, { id: original.botId, workspacePath: replacement })
    await assert.rejects(
      page.evaluate((target) => window.ghostBot!.readWorkspaceFile(target), original),
      /authorization changed/i,
    )
    await reopenBotWorkspace()
    await page.getByTestId('workspace-files-unavailable').waitFor()
    assert.equal(await editor.count(), 0)

    await page.locator('[data-team-id] .gb-team-item')
      .filter({ hasText: 'Workspace Test Team' }).click()
    await page.getByText('Group workspace requires an authorized task scope', { exact: false }).waitFor()
    await page.getByTestId('workspace-tab-overview').click()
    await page.getByLabel('Team activity panel').waitFor()
    await page.getByTestId('workspace-tab-files').click()
    await page.getByText('Group workspace requires an authorized task scope', { exact: false }).waitFor()

    assert.deepEqual(consoleErrors, [], `Unexpected console/page errors: ${consoleErrors.join('; ')}`)
    await page.evaluate(async ({ id, workspacePath }) => {
      await window.ghostBot!.updateBot({ id, patch: { workspacePath } })
    }, { id: original.botId, workspacePath: workspace })
    const restoredContext = await page.evaluate((botId) => (
      window.ghostBot!.resolveWorkspaceContext({ botId })
    ), original.botId)
    assert.equal(restoredContext.authorized, false, 'Restoring a root must not revive the old grant')
    await reopenBotWorkspace()
    await authorize.click()
    await page.getByTestId('workspace-tree-entry-sample.txt').waitFor()
    await app.close()
    app = await launch()
    const restartedPage = await app.firstWindow()
    await restartedPage.waitForSelector('[data-active-tab="files"]')
    const restartedContext = await restartedPage.evaluate(async (botId) => {
      return window.ghostBot!.resolveWorkspaceContext({ botId })
    }, original.botId)
    assert.equal(restartedContext.authorized, false)
    assert.equal(restartedContext.authGeneration, null)
  } finally {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
