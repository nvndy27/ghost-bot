import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

export async function assertPackagedRendererSandbox(pid: number) {
  if (!process.env.GHOST_BOT_WORKSPACE_TEST_BINARY) return
  assert.ok(pid > 0, 'Packaged renderer did not report an OS process')
  const status = await readFile(`/proc/${pid}/status`, 'utf8')
  assert.match(status, /^Seccomp:\s+2$/m)
  assert.match(status, /^NoNewPrivs:\s+1$/m)
}

export async function launchWorkspaceElectron(dataDir: string) {
  const desktop = join(process.cwd(), 'apps', 'desktop')
  const packaged = process.env.GHOST_BOT_WORKSPACE_TEST_BINARY
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_DISABLE_SANDBOX
  delete env.GHOST_BOT_DEV_URL
  const app = await electron.launch({
    executablePath: packaged ?? join(desktop, 'node_modules', '.bin', 'electron'),
    args: packaged ? [] : [join(desktop, 'dist-electron', 'main.js')],
    cwd: packaged ? dataDir : desktop,
    chromiumSandbox: Boolean(packaged),
    env: {
      ...env,
      ...(packaged?.endsWith('.AppImage') ? { APPIMAGE_EXTRACT_AND_RUN: '1' } : {}),
      GHOST_BOT_DATA_DIR: dataDir,
      GHOST_BOT_RUNTIME_MODE: 'mock',
      GHOST_BOT_SMOKE_EXIT: '0',
    },
  })
  if (!packaged) return app

  try {
    const page = await app.firstWindow()
    await page.locator('meta[http-equiv="Content-Security-Policy"]').waitFor({ state: 'attached' })
    const facts = await app.evaluate(({ app, BrowserWindow }) => {
      const web = BrowserWindow.getAllWindows()[0]?.webContents
      const preferences = web?.getLastWebPreferences()
      return {
        rendererPid: web?.getOSProcessId() ?? 0,
        packaged: app.isPackaged,
        disabled: app.commandLine.hasSwitch('no-sandbox'),
        sandbox: preferences?.sandbox,
        isolated: preferences?.contextIsolation,
        node: preferences?.nodeIntegration,
      }
    })
    const { rendererPid, ...security } = facts
    assert.deepEqual(security, { packaged: true, disabled: false, sandbox: true, isolated: true, node: false })
    await assertPackagedRendererSandbox(rendererPid)
    const boot = await page.evaluate(async () => {
      const bridge = window.ghostBot!
      const health = await bridge.getDaemonHealth()
      const providers = await bridge.listProviders()
      const visibility = {
        node: typeof (window as unknown as { require?: unknown }).require,
        process: typeof (window as unknown as { process?: unknown }).process,
      }
      const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')
      return { health, providers, visibility, csp }
    })
    assert.equal(boot.health.ok, true)
    assert.equal(boot.health.runtimeMode, 'mock')
    assert.ok(boot.providers.some((provider) => provider.status === 'mock'))
    assert.deepEqual(boot.visibility, { node: 'undefined', process: 'undefined' })
    assert.match(boot.csp ?? '', /default-src 'self'/)
    return app
  } catch (error) {
    await app.close()
    throw error
  }
}
