/**
 * Packaged Linux AppImage Verification (Phase 2D).
 * Verifies:
 * - No bundled credentials or user data in release/linux-unpacked/resources
 * - Isolated APPIMAGE_EXTRACT_AND_RUN=1 smoke launch (sandboxed: true, daemon health, typed IPC)
 * - Two-launch Playwright Electron verification against the actual AppImage:
 *   actual daemon startup, mock execution, SQLite persistence across restart,
 *   strict CSP, sandboxed: true, and clean shutdown.
 */
import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { _electron as electron } from 'playwright-core'

const execFileAsync = promisify(execFile)
const repoRoot = process.cwd()
const appImagePath = join(repoRoot, 'apps', 'desktop', 'release', 'GhostBot-0.1.0-x86_64.AppImage')
const unpackedResourcesDir = join(repoRoot, 'apps', 'desktop', 'release', 'linux-unpacked', 'resources')

// 1. Compute SHA-256 & verify zero bundled credentials/user data
const imgBytes = await readFile(appImagePath)
const sha256 = createHash('sha256').update(imgBytes).digest('hex')

async function walkNames(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const out = []
  for (const e of entries) {
    out.push(e.name)
    if (e.isDirectory()) {
      out.push(...(await walkNames(join(dir, e.name))))
    }
  }
  return out
}

const resourceNames = await walkNames(unpackedResourcesDir)
for (const forbidden of ['.codex', 'auth.json', 'ghost-bot.sqlite', '.env', 'codex-profile']) {
  assert.ok(
    !resourceNames.includes(forbidden),
    `Packaged resources must NOT bundle "${forbidden}"`,
  )
}

const dataDir = await mkdtemp(join(tmpdir(), 'ghost-bot-appimage-e2e-'))

try {
  // 2. Smoke launch of the packaged AppImage
  const smokeRes = await execFileAsync(appImagePath, [], {
    timeout: 30_000,
    env: {
      ...process.env,
      APPIMAGE_EXTRACT_AND_RUN: '1',
      GHOST_BOT_DATA_DIR: dataDir,
      GHOST_BOT_RUNTIME_MODE: 'mock',
      GHOST_BOT_SMOKE_EXIT: '1',
    },
  })
  assert.match(smokeRes.stdout, /Smoke verification passed:/)
  assert.match(smokeRes.stdout, /"sandboxed":true/)
  assert.match(smokeRes.stdout, /"ok":true/)

  // 3. Two-launch Playwright verification against the packaged AppImage
  async function launchPackaged() {
    return electron.launch({
      executablePath: appImagePath,
      env: {
        ...process.env,
        APPIMAGE_EXTRACT_AND_RUN: '1',
        GHOST_BOT_DATA_DIR: dataDir,
        GHOST_BOT_RUNTIME_MODE: 'mock',
        GHOST_BOT_SMOKE_EXIT: '0',
      },
    })
  }

  const app1 = await launchPackaged()
  try {
    const page = await app1.firstWindow()
    await page.waitForSelector('text=Chief of Staff', { timeout: 20_000 })

    const info = await page.evaluate(() => window.ghostBot.getAppInfo())
    assert.equal(info.sandboxed, true)
    assert.equal(info.name, 'ghost-bot')

    const health = await page.evaluate(() => window.ghostBot.getDaemonHealth())
    assert.equal(health.ok, true)
    assert.equal(health.runtimeMode, 'mock')

    const csp = await page.evaluate(() => {
      const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]')
      return meta?.getAttribute('content') ?? ''
    })
    assert.ok(csp.includes("default-src 'self'"), `Expected strict CSP, got: ${csp}`)

    const composer = page.getByLabel('Message Chief of Staff')
    await composer.fill('Packaged AppImage persistence probe')
    await page.getByRole('button', { name: 'Send message' }).click()
    await page.waitForFunction(
      () => !document.querySelector('button[aria-label="Stop generation"]'),
      null,
      { timeout: 20_000 },
    )
    await page.waitForSelector('text=Packaged AppImage persistence probe')
  } finally {
    await app1.close()
  }

  const app2 = await launchPackaged()
  try {
    const page = await app2.firstWindow()
    await page.waitForSelector('text=Chief of Staff', { timeout: 20_000 })
    await page.waitForSelector('text=Packaged AppImage persistence probe', { timeout: 15_000 })
  } finally {
    await app2.close()
  }

  const dirMode = (await stat(dataDir)).mode & 0o777
  const dbMode = (await stat(join(dataDir, 'ghost-bot.sqlite'))).mode & 0o777
  assert.equal(dirMode, 0o700, `Expected 0700 dataDir, got ${dirMode.toString(8)}`)
  assert.equal(dbMode, 0o600, `Expected 0600 sqlite file, got ${dbMode.toString(8)}`)

  console.log(
    JSON.stringify({
      ok: true,
      appImagePath: 'apps/desktop/release/GhostBot-0.1.0-x86_64.AppImage',
      sha256,
      bytes: imgBytes.length,
      sandboxed: true,
      cspVerified: true,
      persistenceLaunches: 2,
      dirMode: '0700',
      dbMode: '0600',
    }),
  )
} finally {
  await rm(dataDir, { recursive: true, force: true })
}
