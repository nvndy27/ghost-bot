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
  AppearanceSettingsSchema,
  AppInfoResponseSchema,
  AppSettingsPatchSchema,
  AppSettingsSchema,
  BotIdParamsSchema,
  BotIdSchema,
  BotRecordSchema,
  BotsListResponseSchema,
  CancelRunResponseSchema,
  CreateBotInputSchema,
  CreateMemoryIpcInputSchema,
  CreateSessionInputSchema,
  DaemonHealthResponseSchema,
  EmptyParamsSchema,
  IPC_CHANNELS,
  ImportAvatarSvgInputSchema,
  ImportAvatarSvgResponseSchema,
  ListMemoriesIpcInputSchema,
  ListMemoriesResponseSchema,
  ListMessagesParamsSchema,
  ListRunEventsParamsSchema,
  ListSessionsParamsSchema,
  MemoryIpcIdSchema,
  MemoryIdParamSchema,
  MemoryRecordDtoSchema,
  MessagesListResponseSchema,
  ProviderSummarySchema,
  RenameSessionInputSchema,
  ResolveApprovalInputSchema,
  ResolveApprovalResponseSchema,
  RetryRunInputSchema,
  RunEventsResponseSchema,
  RunIdParamsSchema,
  RunRecordSchema,
  RuntimeSnapshotParamsSchema,
  RuntimeSnapshotSchema,
  SearchMemoriesIpcInputSchema,
  SearchMemoriesResponseSchema,
  SessionIdParamsSchema,
  SessionIdSchema,
  SessionInspectionResponseSchema,
  SessionRecordSchema,
  SessionsListResponseSchema,
  SetActiveBotParamsSchema,
  SetActiveSessionInputSchema,
  StartRunInputSchema,
  StartRunResponseSchema,
  UpdateBotInputSchema,
  UpdateMemoryIpcInputSchema,
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
  const daemonEntry = app.isPackaged
    ? join(process.resourcesPath, 'daemon', 'daemon.mjs')
    : join(repoRoot, 'apps', 'daemon', 'src', 'index.ts')
  const daemonCwd = app.isPackaged ? process.resourcesPath : repoRoot
  const runtimeMode = process.env.GHOST_BOT_RUNTIME_MODE === 'mock' ? 'mock' : 'codex'

  const child = spawn(process.execPath, [daemonEntry], {
    cwd: daemonCwd,
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
  options?: { method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; body?: unknown; timeoutMs?: number },
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
        timeout: options?.timeoutMs ?? 5000,
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
    return queryDaemon('/providers', z.array(ProviderSummarySchema), { timeoutMs: 15_000 })
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

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    EmptyParamsSchema.parse(params)
    return queryDaemon('/settings', AppSettingsSchema)
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_UPDATE, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const patch = AppSettingsPatchSchema.parse(params)
    return queryDaemon('/settings', AppSettingsSchema, { method: 'PATCH', body: patch })
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_RESET, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    EmptyParamsSchema.parse(params)
    return queryDaemon('/settings/reset', AppSettingsSchema, { method: 'POST' })
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_MIGRATE_LOCAL, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const legacy = AppearanceSettingsSchema.partial().parse(params)
    return queryDaemon('/settings/migrate-local', AppSettingsSchema, {
      method: 'POST',
      body: legacy,
    })
  })

  ipcMain.handle(IPC_CHANNELS.RUNTIME_SNAPSHOT, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const parsed = RuntimeSnapshotParamsSchema.parse(params)
    const path = parsed?.refresh ? '/runtime/snapshot?refresh=1' : '/runtime/snapshot'
    return queryDaemon(path, RuntimeSnapshotSchema, parsed?.refresh ? { timeoutMs: 25_000 } : undefined)
  })

  ipcMain.handle(IPC_CHANNELS.SESSIONS_LIST, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const parsed = ListSessionsParamsSchema.parse(params)
    const qs = new URLSearchParams({ agentId: parsed.agentId })
    if (parsed.limit !== undefined) qs.set('limit', String(parsed.limit))
    if (parsed.offset !== undefined) qs.set('offset', String(parsed.offset))
    return queryDaemon(`/sessions?${qs.toString()}`, SessionsListResponseSchema)
  })

  ipcMain.handle(IPC_CHANNELS.SESSIONS_CREATE, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const parsed = CreateSessionInputSchema.parse(params)
    return queryDaemon('/sessions', SessionRecordSchema, { method: 'POST', body: parsed })
  })

  ipcMain.handle(IPC_CHANNELS.SESSIONS_RENAME, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const parsed = RenameSessionInputSchema.parse(params)
    return queryDaemon(`/sessions/${encodeURIComponent(parsed.sessionId)}`, SessionRecordSchema, {
      method: 'PATCH',
      body: { title: parsed.title },
    })
  })

  ipcMain.handle(IPC_CHANNELS.SESSIONS_ARCHIVE, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const { sessionId } = SessionIdParamsSchema.parse(params)
    return queryDaemon(
      `/sessions/${encodeURIComponent(sessionId)}/archive`,
      z.object({ archivedId: SessionIdSchema, activeSessionId: SessionIdSchema.nullable() }),
      { method: 'POST' },
    )
  })

  ipcMain.handle(IPC_CHANNELS.SESSIONS_SET_ACTIVE, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const parsed = SetActiveSessionInputSchema.parse(params)
    return queryDaemon(
      '/settings/active-session',
      z.object({ agentId: BotIdSchema, activeSessionId: SessionIdSchema.nullable() }),
      { method: 'PUT', body: parsed },
    )
  })

  ipcMain.handle(IPC_CHANNELS.MESSAGES_LIST, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const parsed = ListMessagesParamsSchema.parse(params)
    const qs = new URLSearchParams()
    if (parsed.limit !== undefined) qs.set('limit', String(parsed.limit))
    if (parsed.offset !== undefined) qs.set('offset', String(parsed.offset))
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    return queryDaemon(
      `/sessions/${encodeURIComponent(parsed.sessionId)}/messages${suffix}`,
      MessagesListResponseSchema,
    )
  })

  ipcMain.handle(IPC_CHANNELS.RUNS_START, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const parsed = StartRunInputSchema.parse(params)
    return queryDaemon('/runs', StartRunResponseSchema, { method: 'POST', body: parsed })
  })

  ipcMain.handle(IPC_CHANNELS.RUNS_GET, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const { runId } = RunIdParamsSchema.parse(params)
    return queryDaemon(`/runs/${encodeURIComponent(runId)}`, RunRecordSchema)
  })

  ipcMain.handle(IPC_CHANNELS.RUNS_CANCEL, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const { runId } = RunIdParamsSchema.parse(params)
    return queryDaemon(`/runs/${encodeURIComponent(runId)}/cancel`, CancelRunResponseSchema, {
      method: 'POST',
    })
  })

  ipcMain.handle(IPC_CHANNELS.RUNS_EVENTS, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const parsed = ListRunEventsParamsSchema.parse(params)
    const qs = new URLSearchParams()
    if (parsed.afterSeq !== undefined) qs.set('afterSeq', String(parsed.afterSeq))
    if (parsed.limit !== undefined) qs.set('limit', String(parsed.limit))
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    return queryDaemon(
      `/runs/${encodeURIComponent(parsed.runId)}/events${suffix}`,
      RunEventsResponseSchema,
    )
  })

  ipcMain.handle(IPC_CHANNELS.RUNS_RESOLVE_APPROVAL, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const parsed = ResolveApprovalInputSchema.parse(params)
    return queryDaemon(
      `/runs/${encodeURIComponent(parsed.runId)}/approval`,
      ResolveApprovalResponseSchema,
      {
        method: 'POST',
        body: {
          approvalId: parsed.approvalId,
          decision: parsed.decision,
          ...(parsed.argsHash ? { argsHash: parsed.argsHash } : {}),
        },
      },
    )
  })

  ipcMain.handle(IPC_CHANNELS.RUNTIME_RECONNECT, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    EmptyParamsSchema.parse(params)
    return queryDaemon('/runtime/reconnect', RuntimeSnapshotSchema, {
      method: 'POST',
      timeoutMs: 25_000,
    })
  })

  ipcMain.handle(IPC_CHANNELS.SESSIONS_INSPECT, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const { sessionId } = SessionIdParamsSchema.parse(params)
    return queryDaemon(
      `/sessions/${encodeURIComponent(sessionId)}/inspect`,
      SessionInspectionResponseSchema,
      { timeoutMs: 25_000 },
    )
  })

  ipcMain.handle(IPC_CHANNELS.RUNS_RETRY, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const parsed = RetryRunInputSchema.parse(params)
    return queryDaemon(
      `/runs/${encodeURIComponent(parsed.runId)}/retry`,
      StartRunResponseSchema,
      {
        method: 'POST',
        body: {
          idempotencyKey: parsed.idempotencyKey,
          ...(parsed.confirmSideEffects !== undefined
            ? { confirmSideEffects: parsed.confirmSideEffects }
            : {}),
        },
      },
    )
  })

  ipcMain.handle(IPC_CHANNELS.MEMORY_LIST, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const parsed = ListMemoriesIpcInputSchema.parse(params ?? {})
    const qs = new URLSearchParams()
    if (parsed.botId) qs.set('botId', parsed.botId)
    if (parsed.scopeKind) qs.set('scopeKind', parsed.scopeKind)
    if (parsed.includeUserWide) qs.set('includeUserWide', 'true')
    if (parsed.includeArchived) qs.set('includeArchived', 'true')
    if (parsed.category) qs.set('category', parsed.category)
    qs.set('limit', String(parsed.limit))
    qs.set('offset', String(parsed.offset))
    return queryDaemon(`/memories?${qs.toString()}`, ListMemoriesResponseSchema)
  })

  ipcMain.handle(IPC_CHANNELS.MEMORY_SEARCH, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const parsed = SearchMemoriesIpcInputSchema.parse(params)
    return queryDaemon('/memories/search', SearchMemoriesResponseSchema, {
      method: 'POST',
      body: parsed,
    })
  })

  ipcMain.handle(IPC_CHANNELS.MEMORY_CREATE, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const parsed = CreateMemoryIpcInputSchema.parse(params)
    return queryDaemon('/memories', MemoryRecordDtoSchema, {
      method: 'POST',
      body: parsed,
    })
  })

  ipcMain.handle(IPC_CHANNELS.MEMORY_UPDATE, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const parsed = UpdateMemoryIpcInputSchema.parse(params)
    const { id, ...patch } = parsed
    return queryDaemon(`/memories/${encodeURIComponent(id)}`, MemoryRecordDtoSchema, {
      method: 'PATCH',
      body: patch,
    })
  })

  ipcMain.handle(IPC_CHANNELS.MEMORY_ARCHIVE, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const { id } = MemoryIdParamSchema.parse(params)
    return queryDaemon(`/memories/${encodeURIComponent(id)}/archive`, MemoryRecordDtoSchema, {
      method: 'POST',
    })
  })

  ipcMain.handle(IPC_CHANNELS.MEMORY_DELETE, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const { id } = MemoryIdParamSchema.parse(params)
    return queryDaemon(
      `/memories/${encodeURIComponent(id)}`,
      z.object({ deletedId: MemoryIpcIdSchema }),
      { method: 'DELETE' },
    )
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
