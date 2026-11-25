import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

const repoRoot = process.cwd()
const desktopDir = join(repoRoot, 'apps', 'desktop')
const dataDir = await mkdtemp(join(tmpdir(), 'ghost-bot-3d1-e2e-'))
const screenshotDir = join(repoRoot, 'design', 'reviews', 'phase-3d1')
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
    await page.waitForSelector('text=Chief of Staff', { timeout: 10_000 })

    // 1. Open Settings -> Memory
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Memory', exact: true }).click()
    await page.waitForSelector('text=Enable memory storage', { timeout: 5000 })

    // 2. Create a synthetic memory
    await page.getByLabel('New memory content').fill('Dự án Ghost Bot ưu tiên bảo mật cục bộ.')
    await page.getByLabel('Memory tags').fill('security, local')
    await page.getByRole('button', { name: 'Save memory' }).click()
    await page.waitForSelector('text=Dự án Ghost Bot ưu tiên bảo mật cục bộ.', { timeout: 5000 })

    // 3. Search it (Vietnamese accent-folded)
    await page.getByLabel('Search memories').fill('bao mat cuc bo')
    await page.waitForSelector('text=Dự án Ghost Bot ưu tiên bảo mật cục bộ.', { timeout: 5000 })
    await page.getByRole('button', { name: 'Clear' }).click()

    // 4. Edit it
    const settingsDialog = page.locator('[role="dialog"][aria-label="Settings"]')
    try {
      await settingsDialog.getByRole('button', { name: 'Edit', exact: true }).first().click({ timeout: 5000 })
    } catch (e) {
      console.error('DIALOG_TEXT:', await settingsDialog.innerText())
      throw e
    }
    await settingsDialog
      .getByLabel('Edit memory content')
      .fill('Dự án Ghost Bot ưu tiên bảo mật cục bộ và kiểm soát.')
    await settingsDialog.getByRole('button', { name: 'Save', exact: true }).click()
    await page.waitForSelector('text=Dự án Ghost Bot ưu tiên bảo mật cục bộ và kiểm soát.', {
      timeout: 5000,
    })

    // 5. Switch bot scope -> verify isolation
    const botSelect = page.getByLabel('Memory bot')
    const botOptions = await botSelect.locator('option').evaluateAll((opts) =>
      opts.map((o) => ({ value: o.value, label: o.textContent ?? '' })),
    )
    assert.ok(botOptions.length >= 2, 'Expected at least 2 seeded bots')
    await botSelect.selectOption(botOptions[1].value)
    await page.waitForSelector('text=No memories found for this scope.', { timeout: 5000 })

    // Switch back to first bot & enable authorized automatic retrieval
    await botSelect.selectOption(botOptions[0].value)
    await page.waitForSelector('text=Dự án Ghost Bot ưu tiên bảo mật cục bộ và kiểm soát.', {
      timeout: 5000,
    })
    const autoCheckbox = page.getByLabel('Automatic retrieval for new runs')
    await autoCheckbox.click()
    await page.waitForTimeout(250)
    assert.equal(await autoCheckbox.isChecked(), true)
    await page.screenshot({ path: join(screenshotDir, '01-memory-settings.png') })

    // 6. Close settings and run a deterministic mock request
    await page.getByRole('button', { name: 'Close settings' }).click()
    const composer = page.getByLabel('Message Chief of Staff')
    await composer.fill('Kiểm tra bảo mật cục bộ')
    await page.getByRole('button', { name: 'Send message' }).click()
    await page.waitForSelector('text=[Memory Context Attached: 1 item(s)', { timeout: 10_000 })
    await page.screenshot({ path: join(screenshotDir, '02-mock-memory-context.png') })

    // 7. Reopen Memory settings, disable retrieval, and delete the memory
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Memory', exact: true }).click()
    await page.getByLabel('Automatic retrieval for new runs').click()
    await page.waitForTimeout(250)
    assert.equal(await page.getByLabel('Automatic retrieval for new runs').isChecked(), false)
    await settingsDialog.getByRole('button', { name: 'Delete', exact: true }).first().click()
    await settingsDialog.getByRole('button', { name: 'Confirm delete', exact: true }).click()
    await page.waitForSelector('text=No memories found for this scope.', { timeout: 5000 })
  } finally {
    await app1.close()
  }

  // 8. Restart Electron and verify persistence & lifecycle
  const app2 = await launchDesktop(dataDir)
  try {
    const page2 = await app2.firstWindow()
    await page2.waitForSelector('text=Chief of Staff', { timeout: 10_000 })
    await page2.getByRole('button', { name: 'Settings' }).click()
    await page2.getByRole('button', { name: 'Memory', exact: true }).click()
    await page2.waitForSelector('text=No memories found for this scope.', { timeout: 5000 })
    const autoChecked = await page2.getByLabel('Automatic retrieval for new runs').isChecked()
    assert.equal(autoChecked, false)
  } finally {
    await app2.close()
  }

  console.log(
    JSON.stringify({
      phase: '3d1',
      electronE2E: 'passed',
      screenshots: [
        'design/reviews/phase-3d1/01-memory-settings.png',
        'design/reviews/phase-3d1/02-mock-memory-context.png',
      ],
    }),
  )
} finally {
  await rm(dataDir, { recursive: true, force: true })
}
