import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

const repoRoot = process.cwd()
const desktopDir = join(repoRoot, 'apps', 'desktop')
const dataDir = await mkdtemp(join(tmpdir(), 'ghost-bot-5c-e2e-'))
const screenshotDir = join(repoRoot, 'design', 'reviews', 'phase-5c')
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

    // 1. Open Settings -> Routines
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Routines', exact: true }).click()
    await page.waitForSelector('[data-testid="routines-settings-section"]', { timeout: 5000 })

    // 2. Create a bot-targeted routine with cron & explicit IANA timezone
    await page.getByRole('button', { name: '+ New routine' }).click()
    await page.getByLabel('Routine name').fill('Daily Audit 5C')
    await page.getByLabel('Description').fill('Automated offline verification routine')
    await page.getByLabel('Task instructions (untrusted prompt data)').fill('Summarize workspace state')
    await page.getByLabel('Schedule type').selectOption('cron')
    await page.getByLabel('IANA Timezone').fill('America/New_York')
    await page.getByLabel('Cron expression (5 fields)').fill('*/15 * * * *')
    await page.getByRole('button', { name: 'Save routine' }).click()
    await page.waitForSelector('text=Daily Audit 5C', { timeout: 5000 })

    const routinesSection = page.getByTestId('routines-settings-section')

    // 3. Inspect routine, preview schedule, diagnose, and dry-run simulate
    await routinesSection.getByRole('button', { name: 'Inspect', exact: true }).first().click()
    await routinesSection.getByRole('button', { name: 'Preview Schedule' }).click()
    await page.waitForSelector('text=Upcoming Occurrences (America/New_York)', { timeout: 5000 })
    await routinesSection.getByRole('button', { name: 'Diagnose' }).click()
    await page.waitForSelector('text=Diagnostics', { timeout: 5000 })
    await routinesSection.getByRole('button', { name: 'Simulate (Dry Run)' }).click()
    await page.waitForSelector('text=Dry-Run Simulation (Simulated Only', { timeout: 5000 })

    // 4. Trigger manual run & inspect execution history
    await routinesSection.getByRole('button', { name: 'Run now', exact: true }).first().click()
    await page.waitForSelector('text=Triggered manual run', { timeout: 5000 })
    await page.waitForSelector('text=Execution History (1)', { timeout: 5000 })

    // 5. Capture Light theme screenshot
    await page.getByRole('button', { name: 'Appearance', exact: true }).click()
    await page.getByLabel('Theme').selectOption('light')
    await page.getByRole('button', { name: 'Routines', exact: true }).click()
    await page.waitForTimeout(200)
    await page.screenshot({ path: join(screenshotDir, 'routines-light.png') })

    // 6. Disable routine, export & import (verifying disabled-by-default), and capture Dark screenshot
    await routinesSection.getByRole('button', { name: 'Disable', exact: true }).first().click()
    await routinesSection.getByRole('button', { name: 'Enable', exact: true }).first().waitFor({ timeout: 5000 })

    await page.getByRole('button', { name: 'Export routines JSON' }).click()
    const exportedJson = await page.getByLabel('Exported routines JSON').inputValue()
    assert.ok(exportedJson.includes('Daily Audit 5C'))

    await page.getByLabel('Import routines JSON').fill(exportedJson)
    await page.getByLabel('Import conflict policy').selectOption('rename')
    await page.getByRole('button', { name: 'Preview import' }).click()
    await page.waitForSelector('text=Valid: true', { timeout: 5000 })
    await page.getByRole('button', { name: 'Confirm import' }).click()
    await page.waitForSelector('text=Imported 1 routine(s) (disabled by default).', { timeout: 5000 })

    await page.getByRole('button', { name: 'Appearance', exact: true }).click()
    await page.getByLabel('Theme').selectOption('dark')
    await page.getByRole('button', { name: 'Routines', exact: true }).click()
    await page.waitForTimeout(200)
    await page.screenshot({ path: join(screenshotDir, 'routines-dark.png') })

    // 7. Close Settings & verify RightPanel shows daemon routines and single-bot chat works
    await page.keyboard.press('Escape')
    await page.waitForSelector('text=Daily Audit 5C', { timeout: 5000 })
    await page.waitForSelector('textarea[placeholder*="Message"]', { timeout: 5000 })
  } finally {
    await app1.close()
  }

  // 8. Restart Electron and verify persistence without replay
  const app2 = await launchDesktop(dataDir)
  try {
    const page = await app2.firstWindow()
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.waitForSelector('text=Daily Audit 5C', { timeout: 10_000 })
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Routines', exact: true }).click()
    const routinesSection2 = page.getByTestId('routines-settings-section')
    const inspectCount = await routinesSection2.getByRole('button', { name: 'Inspect', exact: true }).count()
    assert.ok(inspectCount >= 2, `Expected >=2 persisted routines after restart, got ${inspectCount}`)
    await routinesSection2.getByRole('button', { name: 'Inspect', exact: true }).last().click()
    await page.waitForSelector('text=Execution History (1)', { timeout: 5000 })
  } finally {
    await app2.close()
  }

  console.log('Phase 5C offline Electron E2E verification PASSED')
} finally {
  await rm(dataDir, { recursive: true, force: true })
}
