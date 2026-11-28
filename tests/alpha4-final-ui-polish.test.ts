import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { launchWorkspaceElectron } from './helpers/workspace-electron.ts'

test('Alpha.4 final UI polish: creation width, narrow output filters and single run cancellation', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ghost-alpha4-ui-polish-'))
  const app = await launchWorkspaceElectron(dataDir)
  try {
    const page = await app.firstWindow()
    page.setDefaultTimeout(10_000)
    await page.setViewportSize({ width: 1440, height: 900 })

    const security = await app.evaluate(({ app: electronApp, BrowserWindow }) => ({
      noSandbox: electronApp.commandLine.hasSwitch('no-sandbox'),
      sandbox: BrowserWindow.getAllWindows()[0]?.webContents.getLastWebPreferences()?.sandbox,
      contextIsolation: BrowserWindow.getAllWindows()[0]?.webContents.getLastWebPreferences()?.contextIsolation,
      nodeIntegration: BrowserWindow.getAllWindows()[0]?.webContents.getLastWebPreferences()?.nodeIntegration,
    }))
    assert.deepEqual(security, {
      noSandbox: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    })

    for (const viewport of [{ width: 1440, height: 900 }, { width: 900, height: 700 }]) {
      await page.setViewportSize(viewport)
      await page.getByRole('button', { name: 'Create team' }).click()
      const dialog = page.getByRole('dialog', { name: 'Create Team' })
      await dialog.waitFor()
      const bounds = await dialog.boundingBox()
      assert.ok(bounds && bounds.width <= 510, `Group editor exceeded 510px at ${viewport.width}px viewport`)
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
    }

    await page.setViewportSize({ width: 1440, height: 900 })
    const run = await page.evaluate(async () => {
      const bridge = window.ghostBot!
      const { activeBotId } = await bridge.listBots()
      if (!activeBotId) throw new Error('Missing synthetic bot')
      const session = await bridge.createSession({ agentId: activeBotId })
      const started = await bridge.startRun({
        sessionId: session.id,
        idempotencyKey: crypto.randomUUID(),
        text: 'Test approval flow',
      })
      return { botId: activeBotId, runId: started.run.id }
    })
    await page.getByTestId('workspace-tab-output').click()
    const runSummary = page.getByTestId(`output-entry-run-summary:${run.runId}`)
    await runSummary.getByText('Run awaiting_approval', { exact: true }).waitFor()
    const cancelButtons = page.locator(`[data-testid="output-cancel-${run.runId}"]`)
    assert.equal(await cancelButtons.count(), 1, 'A run must expose one cancellation action, not one per event')

    const shell = page.getByTestId('workspace-panel-shell')
    const resize = page.getByRole('separator', { name: 'Resize right workspace panel' })
    const currentWidth = await shell.evaluate((element) => element.getBoundingClientRect().width)
    const handle = await resize.boundingBox()
    assert.ok(handle)
    await page.mouse.move(handle.x + handle.width / 2, 400)
    await page.mouse.down()
    await page.mouse.move(handle.x + handle.width / 2 + currentWidth - 220, 400)
    await page.mouse.up()
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="workspace-panel-shell"]')?.getBoundingClientRect().width === 220,
    )
    const filterWidths = await page.locator('.gb-output-select').evaluateAll((elements) =>
      elements.map((element) => Math.round(element.getBoundingClientRect().width)),
    )
    assert.equal(filterWidths.length, 3)
    assert.ok(filterWidths.every((width) => width >= 90), `Output filters were clipped at 220px: ${filterWidths}`)
    assert.equal(await cancelButtons.count(), 1)

    await cancelButtons.click()
    await runSummary.getByText('Run cancelled', { exact: true }).waitFor()
    assert.equal(await cancelButtons.count(), 0)

    await page.setViewportSize({ width: 720, height: 900 })
    await page.waitForFunction(() =>
      getComputedStyle(document.querySelector('[data-testid="workspace-panel-shell"]')!).position === 'absolute',
    )
    const overlayWidths = await page.locator('.gb-output-select').evaluateAll((elements) =>
      elements.map((element) => Math.round(element.getBoundingClientRect().width)),
    )
    assert.ok(overlayWidths.every((width) => width >= 90))
  } finally {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
