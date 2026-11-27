import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

const dataDir = await mkdtemp(join(tmpdir(), 'ghost-cu5-e2e-'))
const screenshotDir = join(process.cwd(), 'design', 'reviews', 'cu5')
await mkdir(screenshotDir, { recursive: true })

async function launchDesktop(userDataDir) {
  return electron.launch({
    args: ['apps/desktop'],
    env: {
      ...process.env,
      GHOST_BOT_DATA_DIR: userDataDir,
      GHOST_BOT_RUNTIME_MODE: 'mock',
      GHOST_CU_ENABLE_TEST_FIXTURE: '1',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
  })
}

try {
  let sessionId = ''
  const app1 = await launchDesktop(dataDir)
  try {
    const page = await app1.firstWindow()
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.waitForSelector('text=Chief of Staff', { timeout: 15_000 })

    // 1. Open Settings -> Computer Use & verify capabilities
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Computer Use', exact: true }).click()
    const cuSection = page.getByTestId('computer-use-settings-section')
    await cuSection.waitFor({ timeout: 5000 })
    await page.waitForSelector('text=Available (Chromium sandbox)', { timeout: 10_000 })
    await page.waitForSelector('text=Host Desktop Control: Disabled', { timeout: 5000 })

    // Capture Light Settings screenshot
    await page.getByRole('button', { name: 'Appearance', exact: true }).click()
    await page.getByLabel('Theme').selectOption('light')
    await page.getByRole('button', { name: 'Computer Use', exact: true }).click()
    await page.waitForTimeout(200)
    await page.screenshot({ path: join(screenshotDir, 'cu-settings-light.png') })

    // 2. Explicit consent + Start Isolated Session scoped to exact fixture origin
    const fixturePort = 41000 + Math.floor(Math.random() * 10_000)
    const expectedOrigin = `http://127.0.0.1:${fixturePort}`
    await cuSection.getByLabel('Allowed Origins').fill(expectedOrigin)
    await cuSection.getByLabel(/I explicitly consent/).check()
    await cuSection.getByRole('button', { name: 'Start Isolated Session' }).click()
    await page.waitForSelector('text=Started isolated browser session', { timeout: 15_000 })

    // Switch back to Dark theme for Live Viewer screenshot
    await page.getByRole('button', { name: 'Appearance', exact: true }).click()
    await page.getByLabel('Theme').selectOption('dark')
    await page.getByRole('button', { name: 'Computer Use', exact: true }).click()
    await page.waitForTimeout(150)

    const sessionsRes = await page.evaluate(() => window.ghostBot.listComputerUseSessions({ limit: 5 }))
    sessionId = sessionsRes.sessions[0].id
    assert.ok(sessionId)

    // 3. Start synthetic HTML fixture inside Session 1's bwrap sandbox on fixturePort
    const fixture = await page.evaluate(
      ({ sId, port }) =>
        window.ghostBot.startComputerUseTestFixture({
          sessionId: sId,
          port,
          routes: {
            '/': '<html><body><h1>CU5 Synthetic Fixture</h1><input id="q" /><button id="go" onclick="document.getElementById(\'out\').textContent=\'OK:\'+document.getElementById(\'q\').value">Go</button><div id="out"></div></body></html>',
          },
        }),
      { sId: sessionId, port: fixturePort },
    )
    assert.equal(fixture.baseUrl, expectedOrigin)

    // 4. Open Live Viewer on Session 1 & wait for initial screenshot
    await cuSection.getByRole('button', { name: 'Open Live Viewer' }).first().click()
    const viewer = page.getByTestId('cu-live-viewer-modal')
    await viewer.waitFor({ timeout: 5000 })
    await viewer.locator('img').waitFor({ timeout: 10_000 })

    // 5. Approve & Execute Navigation to fixture
    await viewer.getByLabel('Action Kind').selectOption('navigate')
    await viewer.getByLabel('Target URL').fill(fixture.baseUrl)
    await viewer.getByRole('button', { name: 'Request Approval' }).click()
    await viewer.getByRole('button', { name: 'Approve once' }).first().click()
    await viewer.getByRole('button', { name: 'Execute Approved Action' }).first().click()
    await page.waitForSelector('text=Gen: 1', { timeout: 10_000 })
    await page.waitForSelector(`text=${fixture.baseUrl}`, { timeout: 10_000 })

    // 6. Approve & Execute type_text (secret must be redacted in ledger)
    await viewer.getByLabel('Action Kind').selectOption('type_text')
    await viewer.getByLabel('CSS Selector').fill('#q')
    await viewer.getByLabel('Text to Type').fill('secret-cu5-token')
    await viewer.getByRole('button', { name: 'Request Approval' }).click()
    await viewer.getByRole('button', { name: 'Approve once' }).first().click()
    await viewer.getByRole('button', { name: 'Execute Approved Action' }).first().click()
    await page.waitForSelector('text=[REDACTED len=16]', { timeout: 10_000 })

    // 7. Deny an action and confirm it does not execute
    await viewer.getByLabel('Action Kind').selectOption('click_selector')
    await viewer.getByLabel('CSS Selector').fill('#go')
    await viewer.getByRole('button', { name: 'Request Approval' }).click()
    await viewer.getByRole('button', { name: 'Deny' }).first().click()
    await page.waitForSelector('text=denied', { timeout: 5000 })

    // Capture Dark Live Viewer screenshot
    await page.waitForTimeout(200)
    await page.screenshot({ path: join(screenshotDir, 'cu-live-viewer-dark.png') })

    // Verify ledger never exposes raw secret
    const ledgerRes = await page.evaluate((sId) => window.ghostBot.listComputerUseLedger({ sessionId: sId }), sessionId)
    for (const entry of ledgerRes.entries) {
      assert.equal(entry.replayAllowed, false)
      assert.ok(!entry.sanitizedSummary.includes('secret-cu5-token'))
    }

    // 8. Emergency Stop & confirm process termination
    await viewer.getByTestId('cu-emergency-stop-btn').click()
    await page.waitForSelector('text=Confirmed termination', { timeout: 10_000 })

    // 9. Verify existing single-bot chat still works
    await page.keyboard.press('Escape')
    await page.waitForSelector('textarea[placeholder*="Message"]', { timeout: 5000 })
  } finally {
    await app1.close()
  }

  // 10. Restart Electron and verify emergency_stopped persistence without automatic replay
  const app2 = await launchDesktop(dataDir)
  try {
    const page = await app2.firstWindow()
    await page.waitForSelector('text=Chief of Staff', { timeout: 15_000 })
    const sessAfter = await page.evaluate((sId) => window.ghostBot.getComputerUseSession({ sessionId: sId }), sessionId)
    assert.equal(sessAfter.state, 'emergency_stopped')
  } finally {
    await app2.close()
  }

  console.log('CU.5 offline Electron E2E verification PASSED')
} finally {
  await rm(dataDir, { recursive: true, force: true })
}
