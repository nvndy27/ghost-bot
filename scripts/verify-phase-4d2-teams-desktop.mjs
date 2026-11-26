import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

const repoRoot = process.cwd()
const desktopDir = join(repoRoot, 'apps', 'desktop')
const dataDir = await mkdtemp(join(tmpdir(), 'ghost-bot-4d2-e2e-'))
const screenshotDir = join(repoRoot, 'design', 'reviews', 'phase-4d2')
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

    // 1. Create a team via sidebar "+ New" button
    await page.getByRole('button', { name: 'Create team', exact: true }).click()
    await page.waitForSelector('text=Create Team', { timeout: 5000 })
    await page.getByLabel('Team name').fill('Phase 4D.2 Squad')
    await page.getByLabel('Description').fill('Offline mock multi-bot verification team')
    await page.getByRole('button', { name: 'Create Team', exact: true }).click()

    // 2. Verify team workspace opens with Simulated (Mock) badge & Team Activity right panel
    await page.waitForSelector('text=Simulated (Mock)', { timeout: 5000 })
    await page.waitForSelector('text=Team Activity', { timeout: 5000 })
    await page.waitForSelector('text=Budget vs Actual Usage', { timeout: 5000 })

    // 3. Preview DAG Plan
    await page.getByLabel('Team goal input').fill('Audit local repository documentation')
    await page.getByRole('button', { name: 'Preview DAG Plan' }).click()
    await page.waitForSelector('text=Plan Preview', { timeout: 5000 })
    await page.waitForSelector('text=Layer 1', { timeout: 5000 })

    // 4. Start Team Run and wait for completion
    await page.getByRole('button', { name: 'Start team run' }).click()
    await page.waitForSelector('text=worker_research', { timeout: 5000 })
    await page.waitForSelector('text=lead_synthesis', { timeout: 5000 })

    // Wait for mock tasks to complete
    await page.waitForFunction(
      () => document.body.innerText.includes('completed') && document.body.innerText.includes('Run status'),
      { timeout: 15_000 },
    )
    await page.waitForTimeout(300)

    // Capture Light screenshot of Team Workspace
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.waitForSelector('text=Appearance', { timeout: 5000 })
    await page.getByLabel('Theme').selectOption('light')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    await page.screenshot({ path: join(screenshotDir, 'team-workspace-light.png') })

    // 5. Edit team modal check
    await page.getByRole('button', { name: 'Edit team' }).click()
    await page.waitForSelector('text=Edit Team · Phase 4D.2 Squad', { timeout: 5000 })
    await page.getByLabel('Description').fill('Updated squad description')
    await page.getByRole('button', { name: 'Save Team' }).click()
    await page.waitForSelector('text=Updated squad description', { timeout: 5000 })

    // 6. Switch theme to Dark in Settings and capture dark screenshot
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.waitForSelector('text=Appearance', { timeout: 5000 })
    await page.getByLabel('Theme').selectOption('dark')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    await page.screenshot({ path: join(screenshotDir, 'team-workspace-dark.png') })

    // 7. Verify single-bot chat still works when selecting a bot from sidebar
    await page.locator('.gb-bot-item').first().click()
    await page.waitForSelector('textarea[placeholder*="Message"]', { timeout: 5000 })
  } finally {
    await app1.close()
  }

  // 8. Restart Electron and verify persisted team & run history survive restart
  const app2 = await launchDesktop(dataDir)
  try {
    const page = await app2.firstWindow()
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.waitForSelector('text=Phase 4D.2 Squad', { timeout: 10_000 })
    await page.getByRole('button', { name: /Phase 4D\.2 Squad/ }).click()
    await page.waitForSelector('text=Updated squad description', { timeout: 5000 })
    await page.waitForSelector('text=worker_research', { timeout: 5000 })
  } finally {
    await app2.close()
  }

  console.log('Phase 4D.2 offline Electron E2E verification PASSED')
} finally {
  await rm(dataDir, { recursive: true, force: true })
}
