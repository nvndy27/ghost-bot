import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, session } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import {
  AppInfoResponseSchema,
  BotIdParamsSchema,
  BotIdSchema,
  BotRecordSchema,
  BotsListResponseSchema,
  CreateBotInputSchema,
  DaemonHealthResponseSchema,
  EmptyParamsSchema,
  IPC_CHANNELS,
  ImportAvatarSvgInputSchema,
  ImportAvatarSvgResponseSchema,
  ProviderSummarySchema,
  SetActiveBotParamsSchema,
  UpdateBotInputSchema,
  WorkspacePickResponseSchema,
} from '@ghost-bot/shared-types/ipc'
import { z } from 'zod'
import {
  isAllowedNavigationUrl,
  isAuthorizedIpcContext,
  validateLoopbackDevUrl,
} from './security.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(__dirname, '..')
const repoRoot = resolve(appRoot, '..', '..')
const devOrigin = validateLoopbackDevUrl(process.env.GHOST_BOT_DEV_URL ?? '')
const distIndexPath = join(appRoot, 'dist', 'index.html')
const distIndexUrl = pathToFileURL(distIndexPath).href

let mainWindow: BrowserWindow | null = null
let daemonChild: ChildProcessWithoutNullStreams | null = null
let runtimeDir = ''
let daemonSocketPath = ''
let daemonToken = ''
let quitting = false

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('gtk-version', '3')
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto')
}

function buildCspHeader(): string {
  if (devOrigin) {
    const wsOrigin = devOrigin.replace(/^http:/, 'ws:')
    return [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline' ${devOrigin}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      `connect-src 'self' ${devOrigin} ${wsOrigin}`,
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

function isAuthorizedSender(event: IpcMainInvokeEvent): boolean {
  const win = mainWindow
  return isAuthorizedIpcContext(
    {
      senderMatchesWindow: Boolean(win && !win.isDestroyed() && event.sender === win.webContents),
      frameMatchesMainFrame: Boolean(
        win && !win.isDestroyed() && event.senderFrame === win.webContents.mainFrame,
      ),
      frameUrl: event.senderFrame?.url,
    },
    devOrigin,
    distIndexUrl,
  )
}

async function startDaemon(): Promise<void> {
  const baseRuntime = process.env.XDG_RUNTIME_DIR || tmpdir()
  runtimeDir = await mkdtemp(join(baseRuntime, 'ghost-bot-rt-'))
  await chmod(runtimeDir, 0o700)

  daemonToken = randomBytes(32).toString('hex')
  daemonSocketPath = join(runtimeDir, 'daemon.sock')
  const daemonEntry = join(repoRoot, 'apps', 'daemon', 'src', 'index.ts')
  const runtimeMode = process.env.GHOST_BOT_RUNTIME_MODE === 'mock' ? 'mock' : 'codex'

  const child = spawn(process.execPath, [daemonEntry], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      GHOST_BOT_DATA_DIR: process.env.GHOST_BOT_DATA_DIR,
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

    child.once('error', (err) => {
      clearTimeout(timeout)
      rl.close()
      rejectReady(err)
    })

    child.once('exit', (code) => {
      clearTimeout(timeout)
      rl.close()
      if (!quitting) {
        rejectReady(new Error(`Daemon exited unexpectedly with code ${code ?? 'unknown'}`))
      }
    })
  })

  child.on('exit', (code) => {
    if (!quitting) {
      console.error(`Daemon exited unexpectedly (code=${code ?? 'unknown'}); shutting down.`)
      quitting = true
      app.exit(1)
    }
  })
}

async function stopDaemon(): Promise<void> {
  const child = daemonChild
  daemonChild = null
  if (child) {
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
        child.stdin.end()
        child.kill('SIGTERM')
      } catch {
        clearTimeout(killTimer)
        resolveStop()
      }
    })
  }
  if (runtimeDir) {
    const dir = runtimeDir
    runtimeDir = ''
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

function queryDaemon<T>(
  path: string,
  schema: z.ZodType<T>,
  options?: { method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; body?: unknown },
): Promise<T> {
  return new Promise((resolveReq, rejectReq) => {
    const payload = options?.body !== undefined ? JSON.stringify(options.body) : undefined
    const req = httpRequest(
      {
        socketPath: daemonSocketPath,
        path,
        method: options?.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${daemonToken}`,
          ...(payload !== undefined
            ? {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': Buffer.byteLength(payload, 'utf8'),
              }
            : {}),
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
              const errMsg =
                parsed &&
                typeof parsed === 'object' &&
                'message' in parsed &&
                typeof (parsed as { message?: unknown }).message === 'string'
                  ? (parsed as { message: string }).message
                  : `Daemon error ${res.statusCode}`
              rejectReq(new Error(errMsg))
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
    if (payload !== undefined) req.write(payload)
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

  ipcMain.handle(IPC_CHANNELS.BOTS_LIST, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    EmptyParamsSchema.parse(params)
    return queryDaemon('/bots', BotsListResponseSchema)
  })

  ipcMain.handle(IPC_CHANNELS.BOTS_CREATE, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const input = CreateBotInputSchema.parse(params)
    return queryDaemon('/bots', BotRecordSchema, { method: 'POST', body: input })
  })

  ipcMain.handle(IPC_CHANNELS.BOTS_UPDATE, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const input = UpdateBotInputSchema.parse(params)
    return queryDaemon(`/bots/${encodeURIComponent(input.id)}`, BotRecordSchema, {
      method: 'PATCH',
      body: input.patch,
    })
  })

  ipcMain.handle(IPC_CHANNELS.BOTS_DUPLICATE, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const { id } = BotIdParamsSchema.parse(params)
    return queryDaemon(`/bots/${encodeURIComponent(id)}/duplicate`, BotRecordSchema, {
      method: 'POST',
    })
  })

  ipcMain.handle(IPC_CHANNELS.BOTS_DELETE, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const { id } = BotIdParamsSchema.parse(params)
    return queryDaemon(
      `/bots/${encodeURIComponent(id)}`,
      z.object({ deletedId: BotIdSchema, activeBotId: BotIdSchema.nullable() }),
      { method: 'DELETE' },
    )
  })

  ipcMain.handle(IPC_CHANNELS.BOTS_SET_ACTIVE, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const body = SetActiveBotParamsSchema.parse(params)
    return queryDaemon(
      '/settings/active-bot',
      z.object({ activeBotId: BotIdSchema.nullable() }),
      { method: 'PUT', body },
    )
  })

  ipcMain.handle(IPC_CHANNELS.AVATAR_IMPORT_SVG, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const body = ImportAvatarSvgInputSchema.parse(params)
    return queryDaemon('/avatars/import-svg', ImportAvatarSvgResponseSchema, {
      method: 'POST',
      body,
    })
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_PICK, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    EmptyParamsSchema.parse(params)
    if (!mainWindow || mainWindow.isDestroyed()) {
      return WorkspacePickResponseSchema.parse({ canceled: true, path: null })
    }
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Bot Workspace Directory',
      properties: ['openDirectory', 'createDirectory'],
    })
    const chosen = !result.canceled && result.filePaths[0] ? result.filePaths[0] : null
    return WorkspacePickResponseSchema.parse({
      canceled: result.canceled || !chosen,
      path: chosen,
    })
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
    if (!isAllowedNavigationUrl(targetUrl, devOrigin, distIndexUrl)) {
      event.preventDefault()
    }
  })

  if (devOrigin) {
    void win.loadURL(devOrigin)
  } else {
    void win.loadFile(distIndexPath)
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

  try {
    await startDaemon()
  } catch (err) {
    console.error('Failed to start daemon:', err instanceof Error ? err.message : String(err))
    await stopDaemon()
    app.exit(1)
    return
  }

  registerIpcHandlers()
  mainWindow = createMainWindow()

  if (process.env.GHOST_BOT_SMOKE_EXIT === '1') {
    const consoleErrors: string[] = []
    mainWindow.webContents.on('console-message', (event) => {
      if (event.level === 'error') consoleErrors.push(event.message)
    })
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void mainWindow?.webContents
          .executeJavaScript(`(async () => {
            if (!window.ghostBot) throw new Error('Missing preload bridge');
            const info = await window.ghostBot.getAppInfo();
            const health = await window.ghostBot.getDaemonHealth();
            const providers = await window.ghostBot.listProviders();
            const rootText = document.getElementById('root')?.innerText ?? '';
            return { info, health, providersCount: providers.length, hasRoot: rootText.length > 0 };
          })()`)
          .then((res: { info: { sandboxed: boolean }; health: { ok: boolean }; providersCount: number; hasRoot: boolean }) => {
            if (!res.info.sandboxed || !res.health.ok || res.providersCount < 1 || !res.hasRoot || consoleErrors.length > 0) {
              console.error('Smoke verification failed:', JSON.stringify({ res, consoleErrors }))
              quitting = true
              void stopDaemon().finally(() => app.exit(1))
              return
            }
            console.log('Smoke verification passed:', JSON.stringify(res))
            quitting = true
            void stopDaemon().finally(() => app.exit(0))
          })
          .catch((err: unknown) => {
            console.error('Smoke script error:', err)
            quitting = true
            void stopDaemon().finally(() => app.exit(1))
          })
      }, 400)
    })
  }
})

app.on('before-quit', () => {
  quitting = true
})

app.on('window-all-closed', () => {
  quitting = true
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
