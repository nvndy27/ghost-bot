import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app, BrowserWindow, ipcMain, session } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import {
  AppInfoResponseSchema,
  DaemonHealthResponseSchema,
  EmptyParamsSchema,
  IPC_CHANNELS,
  ProviderSummarySchema,
} from '@ghost-bot/shared-types/ipc'
import { z } from 'zod'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(__dirname, '..')
const repoRoot = resolve(appRoot, '..', '..')
const devUrl = process.env.GHOST_BOT_DEV_URL || ''

let mainWindow: BrowserWindow | null = null
let daemonChild: ChildProcessWithoutNullStreams | null = null
let daemonSocketPath = ''
let daemonToken = ''
let quitting = false

if (process.platform === 'linux') {
  // Fedora/GTK4 environments require pinning Chromium/Electron to GTK 3.
  app.commandLine.appendSwitch('gtk-version', '3')
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto')
}

function buildCspHeader(): string {
  if (devUrl) {
    return [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline' ${devUrl}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      `connect-src 'self' ${devUrl} ws://127.0.0.1:5173`,
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; ')
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}

export function isAuthorizedSender(event: IpcMainInvokeEvent): boolean {
  const frameUrl = event.senderFrame?.url
  if (!frameUrl) return false
  if (devUrl) {
    try {
      return new URL(frameUrl).origin === new URL(devUrl).origin
    } catch {
      return false
    }
  }
  const distIndexUrl = pathToFileURL(join(appRoot, 'dist', 'index.html')).href
  return frameUrl === distIndexUrl || frameUrl.startsWith(`${distIndexUrl}#`)
}

async function startDaemon(): Promise<void> {
  daemonToken = randomBytes(32).toString('hex')
  daemonSocketPath = join(tmpdir(), `ghost-bot-daemon-${process.pid}.sock`)
  const daemonEntry = join(repoRoot, 'apps', 'daemon', 'src', 'index.ts')
  const runtimeMode = process.env.GHOST_BOT_RUNTIME_MODE === 'mock' ? 'mock' : 'codex'

  const child = spawn(process.execPath, [daemonEntry], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      DISPLAY: process.env.DISPLAY,
      WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
      ELECTRON_RUN_AS_NODE: '1',
      GHOST_BOT_DAEMON_TOKEN: daemonToken,
      GHOST_BOT_DAEMON_SOCKET: daemonSocketPath,
      GHOST_BOT_RUNTIME_MODE: runtimeMode,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  daemonChild = child

  await new Promise<void>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      rejectReady(new Error('Daemon startup timed out'))
    }, 10_000)

    const rl = createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line) as { event?: string }
        if (msg.event === 'daemon.ready') {
          clearTimeout(timeout)
          rl.close()
          resolveReady()
        }
      } catch {
        // Ignore non-JSON startup lines.
      }
    })

    child.once('exit', (code) => {
      clearTimeout(timeout)
      rl.close()
      if (!quitting) {
        rejectReady(new Error(`Daemon exited early with code ${code ?? 'unknown'}`))
      }
    })
  })
}

async function stopDaemon(): Promise<void> {
  const child = daemonChild
  daemonChild = null
  if (!child) return

  await new Promise<void>((resolveStop) => {
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore
      }
      resolveStop()
    }, 2000)

    child.once('close', () => {
      clearTimeout(killTimer)
      resolveStop()
    })

    try {
      child.kill('SIGTERM')
    } catch {
      clearTimeout(killTimer)
      resolveStop()
    }
  })
}

function queryDaemon<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  return new Promise((resolveReq, rejectReq) => {
    const req = httpRequest(
      {
        socketPath: daemonSocketPath,
        path,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${daemonToken}`,
        },
        timeout: 5000,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          try {
            const parsed = JSON.parse(raw) as unknown
            if ((res.statusCode ?? 500) >= 400) {
              rejectReq(new Error(`Daemon error ${res.statusCode}`))
              return
            }
            resolveReq(schema.parse(parsed))
          } catch (err) {
            rejectReq(err)
          }
        })
      },
    )
    req.on('error', rejectReq)
    req.on('timeout', () => {
      req.destroy(new Error('Daemon request timed out'))
    })
    req.end()
  })
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.APP_INFO, (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    EmptyParamsSchema.parse(params)
    return AppInfoResponseSchema.parse({
      name: 'ghost-bot',
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      sandboxed: true,
    })
  })

  ipcMain.handle(IPC_CHANNELS.DAEMON_HEALTH, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    EmptyParamsSchema.parse(params)
    return queryDaemon('/health', DaemonHealthResponseSchema)
  })

  ipcMain.handle(IPC_CHANNELS.PROVIDERS_LIST, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    EmptyParamsSchema.parse(params)
    return queryDaemon('/providers', z.array(ProviderSummarySchema))
  })
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: 'Ghost Bot',
    backgroundColor: '#181818',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, targetUrl) => {
    const allowedPrefix = devUrl || pathToFileURL(join(appRoot, 'dist', 'index.html')).href
    if (!targetUrl.startsWith(allowedPrefix)) {
      event.preventDefault()
    }
  })

  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(appRoot, 'dist', 'index.html'))
  }

  return win
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [buildCspHeader()],
      },
    })
  })

  await startDaemon()
  registerIpcHandlers()
  mainWindow = createMainWindow()

  if (process.env.GHOST_BOT_SMOKE_EXIT === '1') {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => app.quit(), 300)
    })
  }
})

app.on('before-quit', () => {
  quitting = true
})

app.on('window-all-closed', () => {
  void stopDaemon().finally(() => {
    app.quit()
  })
})

process.on('SIGINT', () => {
  quitting = true
  void stopDaemon().finally(() => app.quit())
})

process.on('SIGTERM', () => {
  quitting = true
  void stopDaemon().finally(() => app.quit())
})
