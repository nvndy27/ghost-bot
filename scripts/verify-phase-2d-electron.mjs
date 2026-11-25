import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron } from 'playwright-core'

const repoRoot = process.cwd()
const desktopDir = join(repoRoot, 'apps', 'desktop')
const outDir = join(repoRoot, 'design', 'reviews', 'phase-2d')
await mkdir(outDir, { recursive: true })

const dataDir = await mkdtemp(join(tmpdir(), 'ghost-bot-2d-e2e-'))

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
  // Launch 1: Start a disconnect run + pending approval so restart triggers recovery
  const app1 = await launchDesktop()
  try {
    const page = await app1.firstWindow()
    await page.waitForSelector('text=Chief of Staff')
    const composer = page.getByLabel('Message Chief of Staff')
    await composer.fill('Simulate disconnect mid-run')
    await page.getByRole('button', { name: 'Send message' }).click()
    await page.waitForSelector('text=Streaming partial output before simulated daemon disconnect', {
      timeout: 8000,
    })
  } finally {
    await app1.close()
  }

  // Launch 2: Relaunch Electron -> verify interrupted recovery banner, no auto-replay, manual retry works
  const app2 = await launchDesktop()
  try {
    const page2 = await app2.firstWindow()
    await page2.waitForSelector('text=Chief of Staff')
    await page2.waitForSelector('text=Previous run was interrupted', { timeout: 8000 })
    await page2.screenshot({ path: join(outDir, '01-interrupted-recovery-banner.png') })

    // Reconnect runtime without submitting inference
    const snap = await page2.evaluate(() => window.ghostBot.reconnectRuntime())
    assert.equal(snap.runtimeMode, 'mock')

    // Explicit continuation works cleanly
    const composer2 = page2.getByLabel('Message Chief of Staff')
    await composer2.fill('Explicit continuation after recovery')
    await page2.getByRole('button', { name: 'Send message' }).click()
    await page2.waitForSelector('text=daemon-owned Mock Runtime', { timeout: 8000 })
    await page2.screenshot({ path: join(outDir, '02-explicit-continuation.png') })
  } finally {
    await app2.close()
  }

  // Launch 3: Repeated restart reconciliation remains idempotent
  const app3 = await launchDesktop()
  try {
    const page3 = await app3.firstWindow()
    await page3.waitForSelector('text=Chief of Staff')
    await page3.waitForSelector('text=daemon-owned Mock Runtime', { timeout: 8000 })
  } finally {
    await app3.close()
  }

  const db = new DatabaseSync(join(dataDir, 'ghost-bot.sqlite'))
  try {
    const interruptedCount = db
      .prepare(`SELECT COUNT(*) AS cnt FROM runs WHERE status = 'interrupted'`)
      .get().cnt
    assert.equal(Number(interruptedCount), 1)
  } finally {
    db.close()
  }

  console.log('Phase 2D Electron recovery E2E passed (2 screenshots saved).')
} finally {
  await rm(dataDir, { recursive: true, force: true })
}
