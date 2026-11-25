import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

const repoRoot = process.cwd()
const desktopDir = join(repoRoot, 'apps', 'desktop')
const mockDataDir = await mkdtemp(join(tmpdir(), 'ghost-bot-1d-mock-'))
const codexDataDir = await mkdtemp(join(tmpdir(), 'ghost-bot-1d-codex-'))

async function launchDesktop(runtimeMode, dataDir) {
  return electron.launch({
    executablePath: join(desktopDir, 'node_modules', '.bin', 'electron'),
    args: [join(desktopDir, 'dist-electron', 'main.js')],
    cwd: desktopDir,
    env: {
      ...process.env,
      GHOST_BOT_DATA_DIR: dataDir,
      GHOST_BOT_RUNTIME_MODE: runtimeMode,
      GHOST_BOT_SMOKE_EXIT: '0',
    },
  })
}

try {
  // Path A: Actual Electron in mock mode (Settings SQLite persistence + reset)
  const appMock1 = await launchDesktop('mock', mockDataDir)
  try {
    const page = await appMock1.firstWindow()
    await page.waitForSelector('text=Chief of Staff')
    await page.getByRole('button', { name: 'Open Settings' }).click()
    await page.getByLabel('Theme').selectOption('light')
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'General' }).click()
    await page.getByLabel('Launch behavior').selectOption('new-session')
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Data & Privacy' }).click()
    await page.getByLabel('Audit retention days').fill('45')
    await page.waitForTimeout(200)
  } finally {
    await appMock1.close()
  }

  const appMock2 = await launchDesktop('mock', mockDataDir)
  try {
    const page = await appMock2.firstWindow()
    await page.waitForSelector('text=Chief of Staff')
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light')
    await page.getByRole('button', { name: 'Open Settings' }).click()
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'General' }).click()
    assert.equal(await page.getByLabel('Launch behavior').inputValue(), 'new-session')
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Advanced' }).click()
    await page.getByRole('button', { name: 'Reset to defaults' }).click()
    await page.getByRole('button', { name: 'Confirm reset' }).click()
    await page.waitForTimeout(200)
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark')
  } finally {
    await appMock2.close()
  }

  // Path B: Actual Electron + Daemon + Policy Broker + Codex App Server metadata (NO inference)
  const appCodex = await launchDesktop('codex', codexDataDir)
  try {
    const page = await appCodex.firstWindow()
    await page.waitForSelector('text=Chief of Staff')
    const snap = await page.evaluate(async () => {
      return window.ghostBot?.getRuntimeSnapshot(false)
    })
    assert.ok(snap, 'Expected RuntimeSnapshot from real Codex IPC')
    assert.equal(snap.runtimeMode, 'codex')
    assert.ok(snap.codexVersion, 'Expected detected Codex version')
    console.log(
      JSON.stringify({
        electronMockSettingsPersistence: 'passed',
        electronCodexMetadataBridge: {
          codexVersion: snap.codexVersion,
          status: snap.status,
          authStatus: snap.authStatus,
          authMethod: snap.authMethod,
          planType: snap.planType,
          modelCount: snap.models.length,
          usageStatus: snap.usageStatus,
          usageWindowsCount: snap.usageWindows.length,
          verifiedPermissionModes: snap.verifiedPermissionModes,
        },
      }),
    )
  } finally {
    await appCodex.close()
  }
} finally {
  await rm(mockDataDir, { recursive: true, force: true })
  await rm(codexDataDir, { recursive: true, force: true })
}
