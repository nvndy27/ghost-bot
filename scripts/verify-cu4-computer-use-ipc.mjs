import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

const dataDir = mkdtempSync(join(tmpdir(), 'ghost-cu4-ipc-'))

try {
  const app = await electron.launch({
    args: ['apps/desktop'],
    env: {
      ...process.env,
      GHOST_BOT_DATA_DIR: dataDir,
      GHOST_BOT_RUNTIME_MODE: 'mock',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
  })

  try {
    const page = await app.firstWindow()
    await page.waitForSelector('text=Chief of Staff', { timeout: 15_000 })

    const result = await page.evaluate(async () => {
      const api = window.ghostBot

      const caps = await api.getComputerUseCapabilities()
      const sessions = await api.listComputerUseSessions()
      let rejectedConsent = false
      try {
        await api.createComputerUseSession({
          botId: 'bot-chief-of-staff',
          runId: 'run-missing',
          explicitConsent: false,
          allowObservation: true,
          allowNavigation: false,
          allowInteraction: false,
          allowedOrigins: [],
        })
      } catch {
        rejectedConsent = true
      }
      return { caps, sessionCount: sessions.sessions.length, rejectedConsent }
    })

    assert.equal(result.caps.liveModelDrivenEnabled, false)
    assert.equal(result.caps.hostDesktopControlSupported, false)
    assert.equal(result.caps.virtualDesktop.frameCaptureSupported, false)
    assert.equal(result.caps.virtualDesktop.inputInjectionSupported, false)
    assert.equal(result.sessionCount, 0)
    assert.equal(result.rejectedConsent, true)
    console.log('CU.4 offline Electron IPC verification PASSED')
  } finally {
    await app.close()
  }
} finally {
  rmSync(dataDir, { recursive: true, force: true })
}
