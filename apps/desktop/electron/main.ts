import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, constants as fsConstants, lstat, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
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
  CreateKnowledgeCollectionInputSchema,
  CreateMemoryIpcInputSchema,
  CreateSessionInputSchema,
  DaemonHealthResponseSchema,
  EmptyParamsSchema,
  GetMcpPromptInputSchema,
  GetMcpPromptResponseSchema,
  IPC_CHANNELS,
  CreateTeamIpcInputSchema,
  ListTeamMessagesIpcInputSchema,
  ListTeamsInputSchema,
  PreviewTeamPlanIpcInputSchema,
  StartTeamRunIpcInputSchema,
  TeamIdParamSchema,
  TeamRecordDtoSchema,
  TeamRunIdParamSchema,
  UpdateTeamMembersIpcInputSchema,
  ImportAvatarSvgInputSchema,
  ImportAvatarSvgResponseSchema,
  IngestKnowledgeTextInputSchema,
  KnowledgeCollectionDtoSchema,
  KnowledgeDocumentDtoSchema,
  KnowledgeIdParamSchema,
  KnowledgeIpcIdSchema,
  ListKnowledgeCollectionsInputSchema,
  ListKnowledgeDocsInputSchema,
  ListKnowledgeDocsResponseSchema,
  ListMcpServersInputSchema,
  ListMcpServersResponseSchema,
  ListMemoriesIpcInputSchema,
  ListMemoriesResponseSchema,
  ListMessagesParamsSchema,
  ListRunEventsParamsSchema,
  ListSessionsParamsSchema,
  McpCapabilitySnapshotDtoSchema,
  McpConnectionStatusDtoSchema,
  McpIpcIdSchema,
  McpServerDtoSchema,
  McpServerIdParamSchema,
  MemoryIpcIdSchema,
  MemoryIdParamSchema,
  MemoryRecordDtoSchema,
  MessagesListResponseSchema,
  PickAndIngestKnowledgeFileInputSchema,
  ProviderSummarySchema,
  ReadMcpResourceInputSchema,
  ReadMcpResourceResponseSchema,
  RegisterMcpServerIpcInputSchema,
  RenameSessionInputSchema,
  ReplaceKnowledgeDocTextInputSchema,
  ResolveApprovalInputSchema,
  ResolveApprovalResponseSchema,
  ResolveKnowledgeCitationInputSchema,
  ResolveKnowledgeCitationResponseSchema,
  RetryRunInputSchema,
  RunEventsResponseSchema,
  RunIdParamsSchema,
  RunRecordSchema,
  RuntimeSnapshotParamsSchema,
  SetMcpServerEnabledInputSchema,
  UpdateMcpServerIpcInputSchema,
  RuntimeSnapshotSchema,
  SearchKnowledgeDocsInputSchema,
  SearchKnowledgeDocsResponseSchema,
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
  UpdateKnowledgeDocInputSchema,
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

  function assertBoundedMemoryIpcPayload(raw: unknown): void {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Invalid memory payload')
    }
    const rec = raw as Record<string, unknown>
    if (Array.isArray(rec.tags) && rec.tags.length > 32) {
      throw new Error('Memory tags array exceeds pre-validation limit')
    }
    if (typeof rec.content === 'string' && rec.content.length > 16_384) {
      throw new Error('Memory content exceeds pre-validation limit')
    }
    if (typeof rec.query === 'string' && rec.query.length > 1024) {
      throw new Error('Memory query exceeds pre-validation limit')
    }
  }

  ipcMain.handle(IPC_CHANNELS.MEMORY_LIST, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    assertBoundedMemoryIpcPayload(params ?? {})
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
    assertBoundedMemoryIpcPayload(params)
    const parsed = SearchMemoriesIpcInputSchema.parse(params)
    return queryDaemon('/memories/search', SearchMemoriesResponseSchema, {
      method: 'POST',
      body: parsed,
    })
  })

  ipcMain.handle(IPC_CHANNELS.MEMORY_CREATE, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    assertBoundedMemoryIpcPayload(params)
    const parsed = CreateMemoryIpcInputSchema.parse(params)
    return queryDaemon('/memories', MemoryRecordDtoSchema, {
      method: 'POST',
      body: parsed,
    })
  })

  ipcMain.handle(IPC_CHANNELS.MEMORY_UPDATE, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    assertBoundedMemoryIpcPayload(params)
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

  function assertBoundedKnowledgeIpcPayload(raw: unknown): void {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Invalid knowledge payload')
    }
    const rec = raw as Record<string, unknown>
    if (Array.isArray(rec.tags) && rec.tags.length > 32) {
      throw new Error('Knowledge tags array exceeds pre-validation limit')
    }
    if (typeof rec.text === 'string' && rec.text.length > 524_288) {
      throw new Error('Knowledge text exceeds pre-validation limit')
    }
    if (typeof rec.query === 'string' && rec.query.length > 1024) {
      throw new Error('Knowledge query exceeds pre-validation limit')
    }
  }

  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_COLLECTIONS_LIST, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    assertBoundedKnowledgeIpcPayload(params ?? {})
    const parsed = ListKnowledgeCollectionsInputSchema.parse(params ?? {})
    const qs = new URLSearchParams()
    if (parsed.botId) qs.set('botId', parsed.botId)
    if (parsed.scopeKind) qs.set('scopeKind', parsed.scopeKind)
    if (parsed.includeUserWide) qs.set('includeUserWide', 'true')
    return queryDaemon(
      `/knowledge/collections?${qs.toString()}`,
      z.object({ collections: z.array(KnowledgeCollectionDtoSchema) }),
    )
  })

  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_COLLECTIONS_CREATE, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    assertBoundedKnowledgeIpcPayload(params)
    const parsed = CreateKnowledgeCollectionInputSchema.parse(params)
    return queryDaemon('/knowledge/collections', KnowledgeCollectionDtoSchema, {
      method: 'POST',
      body: parsed,
    })
  })

  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_DOCS_LIST, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    assertBoundedKnowledgeIpcPayload(params ?? {})
    const parsed = ListKnowledgeDocsInputSchema.parse(params ?? {})
    const qs = new URLSearchParams()
    if (parsed.botId) qs.set('botId', parsed.botId)
    if (parsed.scopeKind) qs.set('scopeKind', parsed.scopeKind)
    if (parsed.collectionId) qs.set('collectionId', parsed.collectionId)
    if (parsed.includeUserWide) qs.set('includeUserWide', 'true')
    if (parsed.includeArchived) qs.set('includeArchived', 'true')
    qs.set('limit', String(parsed.limit))
    qs.set('offset', String(parsed.offset))
    return queryDaemon(`/knowledge/documents?${qs.toString()}`, ListKnowledgeDocsResponseSchema)
  })

  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_DOCS_SEARCH, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    assertBoundedKnowledgeIpcPayload(params)
    const parsed = SearchKnowledgeDocsInputSchema.parse(params)
    return queryDaemon('/knowledge/documents/search', SearchKnowledgeDocsResponseSchema, {
      method: 'POST',
      body: parsed,
    })
  })

  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_DOCS_INGEST_TEXT, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    assertBoundedKnowledgeIpcPayload(params)
    const parsed = IngestKnowledgeTextInputSchema.parse(params)
    return queryDaemon('/knowledge/documents/ingest-text', KnowledgeDocumentDtoSchema, {
      method: 'POST',
      body: parsed,
    })
  })

  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_DOCS_PICK_AND_INGEST, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    assertBoundedKnowledgeIpcPayload(params)
    const parsed = PickAndIngestKnowledgeFileInputSchema.parse(params)
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const result = await dialog.showOpenDialog(win ?? BrowserWindow.getAllWindows()[0], {
      title: 'Import Knowledge Document (UTF-8 TXT or Markdown)',
      properties: ['openFile'],
      filters: [{ name: 'Text & Markdown', extensions: ['txt', 'md', 'markdown'] }],
    })
    const chosen = !result.canceled && result.filePaths[0] ? result.filePaths[0] : null
    if (!chosen) {
      return { canceled: true, document: null }
    }
    const realChosen = await realpath(chosen)
    const st = await lstat(realChosen)
    if (!st.isFile() || st.isSymbolicLink() || st.nlink > 1) {
      throw new Error('Selected file must be a regular non-hardlinked file')
    }
    if (st.size <= 0 || st.size > 2 * 1024 * 1024) {
      throw new Error('Selected file must be between 1 byte and 2 MiB')
    }
    const fh = await open(realChosen, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    let fileBytes: Buffer
    try {
      const fdStat = await fh.stat()
      if (!fdStat.isFile() || fdStat.nlink > 1 || fdStat.size > 2 * 1024 * 1024) {
        throw new Error('Selected file failed file-descriptor safety check')
      }
      fileBytes = await fh.readFile()
    } finally {
      await fh.close()
    }
    const doc = await queryDaemon('/knowledge/documents/ingest-bytes', KnowledgeDocumentDtoSchema, {
      method: 'POST',
      body: {
        scope: parsed.scope,
        collectionId: parsed.collectionId,
        displayFilename: basename(realChosen),
        bytesBase64: fileBytes.toString('base64'),
        tags: parsed.tags,
      },
    })
    return { canceled: false, document: doc }
  })

  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_DOCS_UPDATE, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    assertBoundedKnowledgeIpcPayload(params)
    const parsed = UpdateKnowledgeDocInputSchema.parse(params)
    const { id, ...patch } = parsed
    return queryDaemon(`/knowledge/documents/${encodeURIComponent(id)}`, KnowledgeDocumentDtoSchema, {
      method: 'PATCH',
      body: patch,
    })
  })

  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_DOCS_REPLACE_TEXT, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    assertBoundedKnowledgeIpcPayload(params)
    const parsed = ReplaceKnowledgeDocTextInputSchema.parse(params)
    const { id, ...body } = parsed
    return queryDaemon(
      `/knowledge/documents/${encodeURIComponent(id)}/replace-text`,
      KnowledgeDocumentDtoSchema,
      {
        method: 'POST',
        body,
      },
    )
  })

  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_DOCS_ARCHIVE, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const { id } = KnowledgeIdParamSchema.parse(params)
    return queryDaemon(
      `/knowledge/documents/${encodeURIComponent(id)}/archive`,
      KnowledgeDocumentDtoSchema,
      { method: 'POST' },
    )
  })

  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_DOCS_DELETE, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const { id } = KnowledgeIdParamSchema.parse(params)
    return queryDaemon(
      `/knowledge/documents/${encodeURIComponent(id)}`,
      z.object({ deletedId: KnowledgeIpcIdSchema }),
      { method: 'DELETE' },
    )
  })

  ipcMain.handle(IPC_CHANNELS.KNOWLEDGE_CITATIONS_RESOLVE, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    assertBoundedKnowledgeIpcPayload(params)
    const parsed = ResolveKnowledgeCitationInputSchema.parse(params)
    return queryDaemon('/knowledge/citations/resolve', ResolveKnowledgeCitationResponseSchema, {
      method: 'POST',
      body: parsed,
    })
  })

  function assertBoundedMcpIpcPayload(raw: unknown): void {
    if (raw === undefined || raw === null) return
    const serialized = JSON.stringify(raw)
    if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > 64 * 1024) {
      throw new Error('MCP IPC payload exceeds maximum size')
    }
    const checkShape = (val: unknown, depth: number): void => {
      if (depth > 12) throw new Error('MCP IPC payload exceeds maximum nesting depth')
      if (Array.isArray(val)) {
        if (val.length > 256) throw new Error('MCP IPC payload array exceeds maximum length')
        for (const item of val) checkShape(item, depth + 1)
      } else if (val && typeof val === 'object') {
        const entries = Object.entries(val as Record<string, unknown>)
        if (entries.length > 128) throw new Error('MCP IPC payload object exceeds maximum keys')
        for (const [, v] of entries) checkShape(v, depth + 1)
      }
    }
    checkShape(raw, 0)
  }

  ipcMain.handle(IPC_CHANNELS.MCP_SERVERS_LIST, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    assertBoundedMcpIpcPayload(params)
    const parsed = ListMcpServersInputSchema.parse(params ?? {})
    const qs = new URLSearchParams()
    if (parsed.scopeKinds?.length) qs.set('scopeKinds', parsed.scopeKinds.join(','))
    if (parsed.botId) qs.set('botId', parsed.botId)
    qs.set('includeUserWide', String(parsed.includeUserWide))
    qs.set('enabledOnly', String(parsed.enabledOnly))
    qs.set('limit', String(parsed.limit))
    qs.set('offset', String(parsed.offset))
    return queryDaemon(`/mcp/servers?${qs.toString()}`, ListMcpServersResponseSchema)
  })

  ipcMain.handle(IPC_CHANNELS.MCP_SERVERS_REGISTER, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    assertBoundedMcpIpcPayload(params)
    const parsed = RegisterMcpServerIpcInputSchema.parse(params)
    return queryDaemon('/mcp/servers', McpServerDtoSchema, { method: 'POST', body: parsed })
  })

  ipcMain.handle(IPC_CHANNELS.MCP_SERVERS_UPDATE, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    assertBoundedMcpIpcPayload(params)
    const parsed = UpdateMcpServerIpcInputSchema.parse(params)
    const { id, ...body } = parsed
    return queryDaemon(`/mcp/servers/${encodeURIComponent(id)}`, McpServerDtoSchema, {
      method: 'PATCH',
      body,
    })
  })

  ipcMain.handle(IPC_CHANNELS.MCP_SERVERS_APPROVE_TRUST, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const { id } = McpServerIdParamSchema.parse(params)
    return queryDaemon(`/mcp/servers/${encodeURIComponent(id)}/trust`, McpServerDtoSchema, {
      method: 'POST',
    })
  })

  ipcMain.handle(IPC_CHANNELS.MCP_SERVERS_REVOKE_TRUST, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const { id } = McpServerIdParamSchema.parse(params)
    return queryDaemon(`/mcp/servers/${encodeURIComponent(id)}/revoke-trust`, McpServerDtoSchema, {
      method: 'POST',
    })
  })

  ipcMain.handle(IPC_CHANNELS.MCP_SERVERS_SET_ENABLED, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const parsed = SetMcpServerEnabledInputSchema.parse(params)
    return queryDaemon(`/mcp/servers/${encodeURIComponent(parsed.id)}/enabled`, McpServerDtoSchema, {
      method: 'POST',
      body: { enabled: parsed.enabled },
    })
  })

  ipcMain.handle(IPC_CHANNELS.MCP_SERVERS_DELETE, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const { id } = McpServerIdParamSchema.parse(params)
    return queryDaemon(`/mcp/servers/${encodeURIComponent(id)}`, z.object({ deletedId: McpIpcIdSchema }), {
      method: 'DELETE',
    })
  })

  ipcMain.handle(IPC_CHANNELS.MCP_SERVERS_CONNECT, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const { id } = McpServerIdParamSchema.parse(params)
    return queryDaemon(`/mcp/servers/${encodeURIComponent(id)}/connect`, McpConnectionStatusDtoSchema, {
      method: 'POST',
    })
  })

  ipcMain.handle(IPC_CHANNELS.MCP_SERVERS_DISCONNECT, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const { id } = McpServerIdParamSchema.parse(params)
    return queryDaemon(`/mcp/servers/${encodeURIComponent(id)}/disconnect`, McpConnectionStatusDtoSchema, {
      method: 'POST',
    })
  })

  ipcMain.handle(IPC_CHANNELS.MCP_SERVERS_CAPABILITIES, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const { id } = McpServerIdParamSchema.parse(params)
    return queryDaemon(
      `/mcp/servers/${encodeURIComponent(id)}/capabilities`,
      McpCapabilitySnapshotDtoSchema.nullable(),
    )
  })

  ipcMain.handle(IPC_CHANNELS.MCP_SERVERS_READ_RESOURCE, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    assertBoundedMcpIpcPayload(params)
    const parsed = ReadMcpResourceInputSchema.parse(params)
    return queryDaemon('/mcp/resources/read', ReadMcpResourceResponseSchema, {
      method: 'POST',
      body: parsed,
    })
  })

  ipcMain.handle(IPC_CHANNELS.MCP_SERVERS_GET_PROMPT, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    assertBoundedMcpIpcPayload(params)
    const parsed = GetMcpPromptInputSchema.parse(params)
    return queryDaemon('/mcp/prompts/get', GetMcpPromptResponseSchema, {
      method: 'POST',
      body: parsed,
    })
  })

  const LooseRecordSchema = z.record(z.string(), z.unknown())

  ipcMain.handle(IPC_CHANNELS.TEAMS_LIST, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const parsed = ListTeamsInputSchema.parse(params ?? {})
    const qs = new URLSearchParams()
    if (parsed.limit !== undefined) qs.set('limit', String(parsed.limit))
    if (parsed.offset !== undefined) qs.set('offset', String(parsed.offset))
    if (parsed.includeArchived !== undefined) qs.set('includeArchived', String(parsed.includeArchived))
    return queryDaemon(
      `/teams?${qs.toString()}`,
      z.object({ teams: z.array(TeamRecordDtoSchema), total: z.number() }),
    )
  })

  ipcMain.handle(IPC_CHANNELS.TEAMS_CREATE, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const parsed = CreateTeamIpcInputSchema.parse(params)
    return queryDaemon('/teams', TeamRecordDtoSchema, { method: 'POST', body: parsed })
  })

  ipcMain.handle(IPC_CHANNELS.TEAMS_UPDATE_MEMBERS, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const parsed = UpdateTeamMembersIpcInputSchema.parse(params)
    return queryDaemon(`/teams/${encodeURIComponent(parsed.teamId)}/members`, TeamRecordDtoSchema, {
      method: 'PATCH',
      body: { memberBotIds: parsed.memberBotIds },
    })
  })

  ipcMain.handle(IPC_CHANNELS.TEAMS_ARCHIVE, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const { teamId } = TeamIdParamSchema.parse(params)
    return queryDaemon(`/teams/${encodeURIComponent(teamId)}/archive`, TeamRecordDtoSchema, {
      method: 'POST',
    })
  })

  ipcMain.handle(IPC_CHANNELS.TEAMS_PREVIEW_PLAN, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const parsed = PreviewTeamPlanIpcInputSchema.parse(params)
    return queryDaemon(`/teams/${encodeURIComponent(parsed.teamId)}/preview`, LooseRecordSchema, {
      method: 'POST',
      body: { plan: parsed.plan },
    })
  })

  ipcMain.handle(IPC_CHANNELS.TEAMS_RUN_START, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const parsed = StartTeamRunIpcInputSchema.parse(params)
    return queryDaemon(`/teams/${encodeURIComponent(parsed.teamId)}/runs`, LooseRecordSchema, {
      method: 'POST',
      body: { goal: parsed.goal, idempotencyKey: parsed.idempotencyKey, plan: parsed.plan },
    })
  })

  ipcMain.handle(IPC_CHANNELS.TEAMS_RUN_GET, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const { teamRunId } = TeamRunIdParamSchema.parse(params)
    return queryDaemon(`/teams/runs/${encodeURIComponent(teamRunId)}`, LooseRecordSchema)
  })

  ipcMain.handle(IPC_CHANNELS.TEAMS_RUN_CANCEL, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const { teamRunId } = TeamRunIdParamSchema.parse(params)
    return queryDaemon(`/teams/runs/${encodeURIComponent(teamRunId)}/cancel`, LooseRecordSchema, {
      method: 'POST',
    })
  })

  ipcMain.handle(IPC_CHANNELS.TEAMS_RUN_TASKS, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const { teamRunId } = TeamRunIdParamSchema.parse(params)
    return queryDaemon(
      `/teams/runs/${encodeURIComponent(teamRunId)}/tasks`,
      z.object({ tasks: z.array(LooseRecordSchema) }),
    )
  })

  ipcMain.handle(IPC_CHANNELS.TEAMS_RUN_DIAGNOSTICS, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const { teamRunId } = TeamRunIdParamSchema.parse(params)
    return queryDaemon(`/teams/runs/${encodeURIComponent(teamRunId)}/diagnostics`, LooseRecordSchema)
  })

  ipcMain.handle(IPC_CHANNELS.TEAMS_RUN_USAGE, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const { teamRunId } = TeamRunIdParamSchema.parse(params)
    return queryDaemon(`/teams/runs/${encodeURIComponent(teamRunId)}/usage`, LooseRecordSchema)
  })

  ipcMain.handle(IPC_CHANNELS.TEAMS_MESSAGES_LIST, async (event, params) => {
    if (!isAuthorizedSender(event)) throw new Error('Unauthorized IPC sender')
    const parsed = ListTeamMessagesIpcInputSchema.parse(params)
    const qs = new URLSearchParams()
    if (parsed.teamRunId) qs.set('teamRunId', parsed.teamRunId)
    if (parsed.viewerBotId) qs.set('viewerBotId', parsed.viewerBotId)
    if (parsed.afterSeq !== undefined) qs.set('afterSeq', String(parsed.afterSeq))
    if (parsed.limit !== undefined) qs.set('limit', String(parsed.limit))
    return queryDaemon(
      `/teams/${encodeURIComponent(parsed.teamId)}/messages?${qs.toString()}`,
      z.object({ messages: z.array(LooseRecordSchema) }),
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
