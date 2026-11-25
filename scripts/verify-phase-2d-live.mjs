/**
 * Opt-in Real Electron + Daemon + Codex 0.172.0 Live Recovery Verification (Phase 2D).
 * Requires explicit human authorization (`GHOST_BOT_RUN_LIVE_RECOVERY=1`).
 */
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

if (process.env.GHOST_BOT_RUN_LIVE_RECOVERY !== '1') {
  console.log(
    'Skipping Phase 2D live recovery E2E (set GHOST_BOT_RUN_LIVE_RECOVERY=1 with human authorization to run).',
  )
  process.exit(0)
}

const repoRoot = process.cwd()
const desktopDir = join(repoRoot, 'apps', 'desktop')
const dataDir = await mkdtemp(join(tmpdir(), 'ghost-bot-2d-live-'))

const app = await electron.launch({
  executablePath: join(desktopDir, 'node_modules', '.bin', 'electron'),
  args: [join(desktopDir, 'dist-electron', 'main.js')],
  cwd: desktopDir,
  env: {
    ...process.env,
    GHOST_BOT_DATA_DIR: dataDir,
    GHOST_BOT_RUNTIME_MODE: 'codex',
    GHOST_BOT_SMOKE_EXIT: '0',
  },
})

try {
  const page = await app.firstWindow()
  await page.waitForSelector('text=Chief of Staff')
  const snap = await page.evaluate(() => window.ghostBot.reconnectRuntime())
  assert.equal(snap.status, 'available')
  console.log('Phase 2D live reconnect verified.')
} finally {
  await app.close()
  await rm(dataDir, { recursive: true, force: true })
}
