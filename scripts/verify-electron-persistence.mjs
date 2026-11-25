import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

const repoRoot = process.cwd()
const desktopDir = join(repoRoot, 'apps', 'desktop')
const dataDir = await mkdtemp(join(tmpdir(), 'ghost-bot-e2e-persist-'))

async function launchDesktop() {
  return electron.launch({
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
}

try {
  // Launch 1: Create bot -> Edit bot -> Close
  const app1 = await launchDesktop()
  try {
    const page = await app1.firstWindow()
    await page.waitForSelector('text=Chief of Staff')

    await page.getByRole('button', { name: 'Create bot' }).click()
    await page.getByPlaceholder('e.g. Security Auditor').fill('E2E Persisted Bot')
    await page.getByLabel('Shape Analyst').click()
    await page.getByLabel('Avatar eyes').selectOption('round')
    await page.getByRole('button', { name: 'Create bot' }).last().click()

    await page.waitForSelector('header >> text=E2E Persisted Bot')

    await page.getByRole('button', { name: 'Edit bot' }).click()
    await page.getByPlaceholder('e.g. Security Auditor').fill('E2E Edited Bot')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await page.waitForSelector('header >> text=E2E Edited Bot')
  } finally {
    await app1.close()
  }

  // Launch 2: Restart -> Verify edited bot & active selection persisted -> Delete -> Close
  const app2 = await launchDesktop()
  try {
    const page = await app2.firstWindow()
    await page.waitForSelector('header >> text=E2E Edited Bot')

    await page.getByRole('button', { name: 'Edit bot' }).click()
    await page.getByRole('button', { name: 'Delete' }).click()
    await page.getByRole('button', { name: 'Confirm delete' }).click()
    await page.waitForSelector('header >> text=Chief of Staff')
  } finally {
    await app2.close()
  }

  // Launch 3: Restart -> Verify deletion persisted, then delete all remaining seeded bots
  const app3 = await launchDesktop()
  try {
    const page = await app3.firstWindow()
    await page.waitForSelector('text=Chief of Staff')
    const count = await page.locator('[role="option"]', { hasText: 'E2E Edited Bot' }).count()
    assert.equal(count, 0, 'Deleted bot must not reappear after restart')

    for (let i = 0; i < 6; i += 1) {
      const editBtn = page.getByRole('button', { name: 'Edit bot' })
      if ((await editBtn.count()) === 0) break
      await editBtn.click()
      await page.getByRole('button', { name: 'Delete' }).click()
      await page.getByRole('button', { name: 'Confirm delete' }).click()
    }
    await page.waitForSelector('text=No bots yet')
  } finally {
    await app3.close()
  }

  // Launch 4: Restart -> Verify deleted default bots are NOT recreated
  const app4 = await launchDesktop()
  try {
    const page = await app4.firstWindow()
    await page.waitForSelector('text=No bots yet')
    assert.equal(await page.locator('[role="option"]').count(), 0, 'Deleted seeded bots must not be recreated')
    console.log(JSON.stringify({ electronPersistenceE2E: 'passed', launches: 4 }))
  } finally {
    await app4.close()
  }
} finally {
  await rm(dataDir, { recursive: true, force: true })
}
