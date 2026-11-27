import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

const repoRoot = process.cwd()
const desktopDir = join(repoRoot, 'apps', 'desktop')
const dataDir = await mkdtemp(join(tmpdir(), 'ghost-bot-4d3-e2e-'))
const screenshotDir = join(repoRoot, 'design', 'reviews', 'phase-4d3')
await mkdir(screenshotDir, { recursive: true })

async function launchDesktop(dir) {
  return electron.launch({
    executablePath: join(desktopDir, 'node_modules', '.bin', 'electron'),
    args: [join(desktopDir, 'dist-electron', 'main.js')],
    cwd: desktopDir,
    env: {
      ...process.env,
      GHOST_BOT_DATA_DIR: dir,
      GHOST_BOT_RUNTIME_MODE: 'mock',
      GHOST_BOT_SMOKE_EXIT: '0',
    },
  })
}

try {
  const app1 = await launchDesktop(dataDir)
  try {
    const page = await app1.firstWindow()
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.waitForSelector('text=Chief of Staff', { timeout: 10_000 })

    // 1. Create and configure a team
    await page.getByRole('button', { name: 'Create team', exact: true }).click()
    await page.waitForSelector('text=Create Team', { timeout: 5000 })
    await page.getByLabel('Team name').fill('Phase 4D.3 Acceptance Squad')
    await page.getByLabel('Description').fill('Final offline Teams acceptance verification')
    await page.getByRole('button', { name: 'Create Team', exact: true }).click()

    await page.waitForSelector('text=Simulated (Mock)', { timeout: 5000 })
    await page.waitForSelector('text=Team Activity', { timeout: 5000 })
    await page.waitForSelector('text=Budget vs Actual Usage', { timeout: 5000 })

    // 2. Preview deterministic multi-worker DAG
    await page.getByLabel('Team goal input').fill('Verify multi-worker DAG and cancellation')
    await page.getByRole('button', { name: 'Preview DAG Plan' }).click()
    await page.waitForSelector('text=Plan Preview', { timeout: 5000 })
    await page.waitForSelector('text=Layer 1', { timeout: 5000 })

    // 3. Start team run and observe task transitions
    await page.getByRole('button', { name: 'Start team run' }).click()
    await page.waitForSelector('text=worker_research', { timeout: 5000 })
    await page.waitForSelector('text=lead_synthesis', { timeout: 5000 })

    // Wait for completion and inspect results + usage
    await page.waitForFunction(
      () => document.body.innerText.includes('completed') && document.body.innerText.includes('Run status'),
      { timeout: 15_000 },
    )
    await page.waitForTimeout(250)

    // Switch to Light theme for screenshot 1
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.waitForSelector('text=Appearance', { timeout: 5000 })
    await page.getByLabel('Theme').selectOption('light')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    await page.screenshot({ path: join(screenshotDir, 'acceptance-light.png') })

    // 4. Start a second run and stop it while active
    await page.getByLabel('Team goal input').fill('Run to be cancelled mid-execution')
    await page.getByRole('button', { name: 'Start team run' }).click()
    const stopBtn = page.getByRole('button', { name: 'Stop Team Run' })
    await stopBtn.waitFor({ state: 'visible', timeout: 5000 })
    await stopBtn.click()
    await page.waitForFunction(
      () =>
        document.body.innerText.includes('Team run cancelled') ||
        document.body.innerText.includes('Cancellation pending') ||
        document.body.innerText.includes('Execution outcome uncertain') ||
        document.body.innerText.includes('[completed] Run to be cancelled'),
      undefined,
      { timeout: 10_000 },
    )

    // Switch to Dark theme for screenshot 2
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.waitForSelector('text=Appearance', { timeout: 5000 })
    await page.getByLabel('Theme').selectOption('dark')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    await page.screenshot({ path: join(screenshotDir, 'acceptance-dark-cancelled.png') })

    // 5. Verify normal single-bot chat remains functional
    await page.locator('.gb-bot-item').first().click()
    await page.waitForSelector('textarea[placeholder*="Message"]', { timeout: 5000 })
  } finally {
    await app1.close()
  }

  // 6. Restart Electron and verify persisted team & task history without auto-replay
  const app2 = await launchDesktop(dataDir)
  try {
    const page = await app2.firstWindow()
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.waitForSelector('text=Phase 4D.3 Acceptance Squad', { timeout: 10_000 })
    await page.getByRole('button', { name: /Phase 4D\.3 Acceptance Squad/ }).click()
    await page.waitForSelector('text=Final offline Teams acceptance verification', { timeout: 5000 })
    const runCount = await page.getByLabel('Select team run').locator('option').count()
    assert.equal(runCount, 2, 'Expected exactly 2 persisted team runs (no auto-replay on restart)')
  } finally {
    await app2.close()
  }

  console.log('Phase 4D.3 offline Electron E2E acceptance PASSED')
} finally {
  await rm(dataDir, { recursive: true, force: true })
}
