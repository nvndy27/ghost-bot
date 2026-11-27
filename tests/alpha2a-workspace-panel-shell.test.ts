import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { _electron as electron } from 'playwright-core'
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

const repoRoot = process.cwd()
const desktopDir = join(repoRoot, 'apps', 'desktop')

test('Alpha.2A workspace tab definitions and keyboard navigation contract', () => {
  assert.deepEqual(
    WORKSPACE_TABS.map((t) => t.id),
    ['overview', 'files', 'changes', 'browser', 'output'],
  )
  assert.equal(WORKSPACE_TABS[0].implemented, true)
  for (const deferred of WORKSPACE_TABS.slice(1)) {
    assert.equal(deferred.implemented, false, `${deferred.id} must remain unimplemented in Alpha.2A`)
    assert.ok(deferred.milestone?.startsWith('Alpha.2'), `${deferred.id} must declare future milestone`)
  }

  assert.equal(getNextWorkspaceTab('overview', 'ArrowRight'), 'files')
  assert.equal(getNextWorkspaceTab('output', 'ArrowRight'), 'overview')
  assert.equal(getNextWorkspaceTab('overview', 'ArrowLeft'), 'output')
  assert.equal(getNextWorkspaceTab('browser', 'Home'), 'overview')
  assert.equal(getNextWorkspaceTab('overview', 'End'), 'output')
})

test('Alpha.2A preserves UiPreferences compatibility and 12 avatar presets', () => {
  assert.equal(avatarPresets.length, 12)
  assert.equal(DEFAULT_PREFERENCES.rightWidth, 285)
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
  const screenshotDir = join(repoRoot, 'design', 'reviews', 'alpha-2a')
  await mkdir(screenshotDir, { recursive: true })

  const app = await electron.launch({
    executablePath: join(desktopDir, 'node_modules', '.bin', 'electron'),
    args: [join(desktopDir, 'dist-electron', 'main.js')],
    cwd: desktopDir,
    env: {
      ...process.env,
      GHOST_BOT_DATA_DIR: dataDir,
      GHOST_BOT_RUNTIME_MODE: 'mock',
      GHOST_BOT_SMOKE_EXIT: '0',
    },
  })

  try {
    const page = await app.firstWindow()
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.waitForSelector('[data-testid="workspace-panel-shell"]')

    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    page.on('pageerror', (err) => consoleErrors.push(err.message))

    // 1. Default Overview rendering preserves existing right-panel sections
    const shell = page.getByTestId('workspace-panel-shell')
    assert.equal(await shell.getAttribute('data-active-tab'), 'overview')
    assert.equal(await shell.getAttribute('data-maximized'), 'false')
    await page.waitForSelector('text=Live computer')
    await page.waitForSelector('text=Active tasks')
    await page.waitForSelector('text=Routines')
    await page.waitForSelector('text=Connected tools')
    await page.waitForSelector('text=Account usage')
    await page.screenshot({ path: join(screenshotDir, 'alpha2a-overview-dark-1440x900.png') })

    // 2. Sidebar Bot Identity UI contract: avatar + bot name + provider label only (no model/effort)
    const botOptions = page.locator('[role="listbox"][aria-label="Bots"] [role="option"]')
    const botCount = await botOptions.count()
    assert.ok(botCount >= 2, 'Expected at least 2 seeded bots in sidebar')
    const firstBotText = (await botOptions.first().innerText()).trim()
    assert.ok(!/gpt-|claude-|gemini-|kimi-|high|medium|low/i.test(firstBotText), `Unexpected model/effort in sidebar: ${firstBotText}`)

    // 3. Keyboard-accessible tab navigation + honest unimplemented states
    const overviewTab = page.getByTestId('workspace-tab-overview')
    await overviewTab.focus()
    await page.keyboard.press('ArrowRight')
    assert.equal(await shell.getAttribute('data-active-tab'), 'files')
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'workspace-tab-files')
    await page.waitForSelector('[data-testid="workspace-placeholder-files"]')
    assert.ok((await page.getByTestId('workspace-placeholder-files').innerText()).includes('Alpha.2B'))
    await page.screenshot({ path: join(screenshotDir, 'alpha2a-files-placeholder-dark.png') })

    await page.keyboard.press('ArrowRight')
    assert.equal(await shell.getAttribute('data-active-tab'), 'changes')
    await page.waitForSelector('[data-testid="workspace-placeholder-changes"]')

    await page.keyboard.press('ArrowRight')
    assert.equal(await shell.getAttribute('data-active-tab'), 'browser')
    await page.waitForSelector('[data-testid="workspace-placeholder-browser"]')

    await page.keyboard.press('End')
    assert.equal(await shell.getAttribute('data-active-tab'), 'output')
    await page.waitForSelector('[data-testid="workspace-placeholder-output"]')

    // 4. Switching bots resets inactive tab state so stale tab selection does not leak
    await botOptions.nth(1).click()
    assert.equal(await shell.getAttribute('data-active-tab'), 'overview')

    // 5. Panel resizing via keyboard on resize handle
    const initialWidth = await shell.evaluate((el) => el.getBoundingClientRect().width)
    const resizeHandle = page.getByRole('separator', { name: 'Resize right workspace panel' })
    await resizeHandle.focus()
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    const resizedWidth = await shell.evaluate((el) => el.getBoundingClientRect().width)
    assert.ok(resizedWidth > initialWidth, `Expected right panel width to increase on ArrowLeft (${initialWidth} -> ${resizedWidth})`)

    // 6. Maximize and restore (button + Escape)
    const maxBtn = page.getByTestId('workspace-maximize-btn')
    await maxBtn.click()
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

    // 8. Theme switching (light & system) + Team Activity preservation if a team exists
    await page.getByRole('button', { name: 'Open Settings' }).click()
    await page.getByLabel('Theme').selectOption('light')
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
    await page.keyboard.press('Escape')
    await page.screenshot({ path: join(screenshotDir, 'alpha2a-overview-light-1440x900.png') })

    // Switch to system theme and restore dark-friendly layout
    await page.getByRole('button', { name: 'Open Settings' }).click()
    await page.getByLabel('Theme').selectOption('system')
    await page.waitForFunction(() => {
      const t = document.documentElement.dataset.theme
      return t === 'dark' || t === 'light'
    })
    await page.keyboard.press('Escape')

    // 9. Responsive narrow layout + maximize overlay
    await page.setViewportSize({ width: 900, height: 700 })
    await page.getByTestId('workspace-maximize-btn').click()
    const narrowMaxWidth = await shell.evaluate((el) => el.getBoundingClientRect().width)
    assert.ok(narrowMaxWidth >= 880, `Expected full-width overlay on narrow viewport, got ${narrowMaxWidth}`)
    await page.screenshot({ path: join(screenshotDir, 'alpha2a-narrow-maximized-900x700.png') })
    await page.getByTestId('workspace-maximize-btn').click()

    assert.deepEqual(consoleErrors, [], `Unexpected console/page errors: ${consoleErrors.join('; ')}`)
  } finally {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
