import { timingSafeEqual } from 'node:crypto'
import { chmod, open, readFile, unlink } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { sanitizeCustomSvg } from '@ghost-bot/avatar/svg-sanitizer'
import {
  AppearanceSettingsSchema,
  AppSettingsPatchSchema,
  BotIdSchema,
  CreateBotInputSchema,
  CreateMemoryIpcInputSchema,
  CreateSessionInputSchema,
  ImportAvatarSvgInputSchema,
  ListMemoriesIpcInputSchema,
  MemoryIdParamSchema,
  RenameSessionInputSchema,
  ResolveApprovalInputSchema,
  RetryRunInputSchema,
  RunIdSchema,
  SearchMemoriesIpcInputSchema,
  SessionIdSchema,
  SetActiveBotParamsSchema,
  SetActiveSessionInputSchema,
  StartRunInputSchema,
  UpdateBotInputSchema,
  UpdateMemoryIpcInputSchema,
} from '@ghost-bot/shared-types/ipc'
import type { DaemonHealthResponse } from '@ghost-bot/shared-types/ipc'
import { BotRepository } from './bots/repository.ts'
import { openGhostBotDatabase } from './db/client.ts'
import type { DatabaseHandle } from './db/client.ts'
import { seedInitialBotsIfNeeded } from './db/seed.ts'
import { DaemonError, normalizeDaemonError } from './errors.ts'
import { RunOrchestrator } from './execution/orchestrator.ts'
import { MemoryService } from './memory/service.ts'
import { RuntimeRegistry } from './runtime/registry.ts'
import { SessionRepository } from './sessions/repository.ts'
import { SettingsRepository } from './settings/repository.ts'

export interface DaemonServerOptions {
  authToken: string
  socketPath?: string
  port?: number
  dataDir?: string
  runtimeMode?: 'codex' | 'mock'
  codexVersion?: string | null
}

function constantTimeTokenMatch(headerValue: string | undefined, expectedToken: string): boolean {
  if (!headerValue || !headerValue.startsWith('Bearer ')) return false
  const provided = headerValue.slice('Bearer '.length)
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expectedToken, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(payload))
}

const MAX_BODY_BYTES = 64 * 1024

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > MAX_BODY_BYTES) {
      throw new DaemonError('PAYLOAD_TOO_LARGE', 'Request body exceeds 64 KB limit', {
        statusCode: 413,
      })
    }
    chunks.push(buf)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new DaemonError('INVALID_JSON', 'Malformed JSON request body', { statusCode: 400 })
  }
}

const ACTIVE_DAEMON_LOCKS = new Set<string>()

export class GhostBotDaemon {
  private readonly options: DaemonServerOptions
  private readonly runtimeMode: 'codex' | 'mock'
  private readonly runtimeRegistry: RuntimeRegistry
  private dbHandle: DatabaseHandle | null = null
  private botRepo: BotRepository | null = null
  private settingsRepo: SettingsRepository | null = null
  private sessionRepo: SessionRepository | null = null
  private memoryService: MemoryService | null = null
  private runOrchestrator: RunOrchestrator | null = null
  private lockFilePath: string | null = null
  private server: Server | null = null
  private readonly startedAt = Date.now()

  constructor(options: DaemonServerOptions) {
    if (!options.authToken || options.authToken.length < 16) {
      throw new DaemonError('INVALID_CONFIG', 'Daemon requires a strong authToken (>=16 chars)')
    }
    this.options = options
    this.runtimeMode = options.runtimeMode ?? 'codex'
    this.runtimeRegistry = new RuntimeRegistry({
      runtimeMode: this.runtimeMode,
      codexVersionOverride: options.codexVersion,
    })
  }

  private async acquireDaemonLock(lockPath: string): Promise<void> {
    if (ACTIVE_DAEMON_LOCKS.has(lockPath)) {
      throw new DaemonError(
        'DAEMON_ALREADY_RUNNING',
        `Another Ghost Bot daemon (pid ${process.pid}) already owns ${dirname(lockPath)}`,
        { statusCode: 409 },
      )
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(lockPath, 'wx', 0o600)
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8')
        } finally {
          await handle.close()
        }
        ACTIVE_DAEMON_LOCKS.add(lockPath)
        this.lockFilePath = lockPath
        return
      } catch (err) {
        const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : ''
        if (code !== 'EEXIST') throw err

        let existingPid: number | null = null
        try {
          const raw = await readFile(lockPath, 'utf8')
          const parsed = JSON.parse(raw) as { pid?: unknown }
          if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0) {
            existingPid = parsed.pid
          }
        } catch {
          // Malformed or empty lock file -> treat as stale if unreadable
        }

        if (existingPid !== null && existingPid !== process.pid) {
          let isAlive = false
          try {
            process.kill(existingPid, 0)
            isAlive = true
          } catch (killErr) {
            const killCode =
              killErr && typeof killErr === 'object' && 'code' in killErr ? String(killErr.code) : ''
            if (killCode === 'EPERM') isAlive = true
          }
          if (isAlive) {
            throw new DaemonError(
              'DAEMON_ALREADY_RUNNING',
              `Another Ghost Bot daemon (pid ${existingPid}) already owns ${dirname(lockPath)}`,
              { statusCode: 409 },
            )
          }
        }
        await unlink(lockPath).catch(() => undefined)
      }
    }
  }

  async start(): Promise<{ address: string }> {
    if (this.server) {
      throw new DaemonError('ALREADY_STARTED', 'Daemon server is already running')
    }

    const dbHandle = await openGhostBotDatabase(this.options.dataDir)
    try {
      await this.acquireDaemonLock(join(dirname(dbHandle.dbPath), 'daemon.lock'))
    } catch (err) {
      dbHandle.close()
      throw err
    }
    seedInitialBotsIfNeeded(dbHandle)
    this.dbHandle = dbHandle
    this.botRepo = new BotRepository(dbHandle)
    this.settingsRepo = new SettingsRepository(dbHandle)
    this.sessionRepo = new SessionRepository(dbHandle)
    this.memoryService = new MemoryService(dbHandle, this.settingsRepo)
    this.runOrchestrator = new RunOrchestrator(dbHandle, {
      runtimeRegistry: this.runtimeRegistry,
      settingsRepo: this.settingsRepo,
      memoryService: this.memoryService,
    })
    this.runOrchestrator.reconcileOnStartup()

    const server = createServer((req, res) => {
      void this.handleRequest(req, res)
    })
    this.server = server

    if (this.options.socketPath) {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(this.options.socketPath, () => {
          server.off('error', reject)
          resolve()
        })
      })
      await chmod(this.options.socketPath, 0o600)
      return { address: this.options.socketPath }
    }

    const port = this.options.port ?? 0
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const addr = server.address()
    const boundPort = typeof addr === 'object' && addr ? addr.port : port
    return { address: `http://127.0.0.1:${boundPort}` }
  }

  async stop(): Promise<void> {
    if (this.runOrchestrator) {
      await this.runOrchestrator.stop()
      this.runOrchestrator = null
    }
    await this.runtimeRegistry.stop()
    if (this.server) {
      const srv = this.server
      this.server = null
      await new Promise<void>((resolve) => srv.close(() => resolve()))
    }
    this.botRepo = null
    this.settingsRepo = null
    this.sessionRepo = null
    if (this.memoryService) {
      this.memoryService.close()
      this.memoryService = null
    }
    if (this.dbHandle) {
      this.dbHandle.close()
      this.dbHandle = null
    }
    if (this.lockFilePath) {
      const p = this.lockFilePath
      this.lockFilePath = null
      ACTIVE_DAEMON_LOCKS.delete(p)
      await unlink(p).catch(() => undefined)
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!constantTimeTokenMatch(req.headers.authorization, this.options.authToken)) {
        throw new DaemonError('UNAUTHORIZED', 'Missing or invalid daemon auth token', {
          statusCode: 401,
        })
      }

      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.method === 'GET' && url.pathname === '/health') {
        const body: DaemonHealthResponse = {
          ok: true,
          pid: process.pid,
          uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
          runtimeMode: this.runtimeMode,
        }
        sendJson(res, 200, body)
        return
      }

      if (req.method === 'GET' && url.pathname === '/providers') {
        const providers = await this.runtimeRegistry.listProviders()
        sendJson(res, 200, providers)
        return
      }

      if (req.method === 'GET' && url.pathname === '/runtime/snapshot') {
        const refresh = url.searchParams.get('refresh') === '1'
        const snap = await this.runtimeRegistry.getSnapshot(refresh)
        sendJson(res, 200, snap)
        return
      }

      if (req.method === 'POST' && url.pathname === '/runtime/reconnect') {
        const snap = await this.runtimeRegistry.reconnect()
        if (this.runOrchestrator) {
          await this.runOrchestrator.reconnectRuntime()
        }
        sendJson(res, 200, snap)
        return
      }

      const settingsRepo = this.settingsRepo
      if (settingsRepo) {
        if (req.method === 'GET' && url.pathname === '/settings') {
          sendJson(res, 200, settingsRepo.getSettings())
          return
        }
        if (req.method === 'PATCH' && url.pathname === '/settings') {
          const body = await readJsonBody(req)
          const parsed = AppSettingsPatchSchema.safeParse(body)
          if (!parsed.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid settings patch', { statusCode: 400 })
          }
          sendJson(res, 200, settingsRepo.updateSettings(parsed.data))
          return
        }
        if (req.method === 'POST' && url.pathname === '/settings/reset') {
          sendJson(res, 200, settingsRepo.resetSettings())
          return
        }
        if (req.method === 'POST' && url.pathname === '/settings/migrate-local') {
          const body = await readJsonBody(req)
          const parsed = AppearanceSettingsSchema.partial().safeParse(body)
          if (!parsed.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid legacy settings payload', {
              statusCode: 400,
            })
          }
          sendJson(res, 200, settingsRepo.migrateLegacyAppearance(parsed.data))
          return
        }
      }

      const repo = this.botRepo
      if (!repo) {
        throw new DaemonError('DB_UNAVAILABLE', 'Database repository is not initialized', {
          statusCode: 503,
        })
      }

      if (req.method === 'GET' && url.pathname === '/bots') {
        sendJson(res, 200, repo.listBots())
        return
      }

      if (req.method === 'POST' && url.pathname === '/bots') {
        const body = await readJsonBody(req)
        const parsed = CreateBotInputSchema.safeParse(body)
        if (!parsed.success) {
          throw new DaemonError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid bot input', {
            statusCode: 400,
          })
        }
        sendJson(res, 201, await repo.createBot(parsed.data))
        return
      }

      const dupMatch = /^\/bots\/([^/]+)\/duplicate$/.exec(url.pathname)
      if (req.method === 'POST' && dupMatch) {
        const id = BotIdSchema.parse(decodeURIComponent(dupMatch[1]))
        sendJson(res, 201, await repo.duplicateBot(id))
        return
      }

      const botMatch = /^\/bots\/([^/]+)$/.exec(url.pathname)
      if (botMatch) {
        const idCheck = BotIdSchema.safeParse(decodeURIComponent(botMatch[1]))
        if (!idCheck.success) {
          throw new DaemonError('VALIDATION_ERROR', 'Invalid bot identifier', { statusCode: 400 })
        }
        if (req.method === 'PATCH') {
          const body = await readJsonBody(req)
          const parsed = UpdateBotInputSchema.safeParse({ id: idCheck.data, patch: body })
          if (!parsed.success) {
            throw new DaemonError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid bot patch', {
              statusCode: 400,
            })
          }
          sendJson(res, 200, await repo.updateBot(parsed.data))
          return
        }
        if (req.method === 'DELETE') {
          const result = repo.deleteBot(idCheck.data, {
            onArchiveBot: (botId, now) => {
              this.memoryService?.archiveMemoriesForBotInTx(botId, now)
            },
          })
          sendJson(res, 200, result)
          return
        }
      }

      if (req.method === 'PUT' && url.pathname === '/settings/active-bot') {
        const body = await readJsonBody(req)
        const parsed = SetActiveBotParamsSchema.safeParse(body)
        if (!parsed.success) {
          throw new DaemonError('VALIDATION_ERROR', 'Invalid activeBotId payload', {
            statusCode: 400,
          })
        }
        sendJson(res, 200, repo.setActiveBot(parsed.data.id))
        return
      }

      if (req.method === 'POST' && url.pathname === '/avatars/import-svg') {
        const body = await readJsonBody(req)
        const parsed = ImportAvatarSvgInputSchema.safeParse(body)
        if (!parsed.success) {
          throw new DaemonError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid SVG payload', {
            statusCode: 400,
          })
        }
        const sanitized = sanitizeCustomSvg(parsed.data.rawSvg)
        if (!sanitized.ok) {
          throw new DaemonError('INVALID_AVATAR', sanitized.reason, { statusCode: 400 })
        }
        sendJson(res, 200, {
          svgDataUrl: sanitized.dataUrl,
          label: parsed.data.label,
        })
        return
      }

      const sessionRepo = this.sessionRepo
      const orchestrator = this.runOrchestrator
      if (sessionRepo && orchestrator) {
        if (req.method === 'GET' && url.pathname === '/sessions') {
          const agentIdCheck = BotIdSchema.safeParse(url.searchParams.get('agentId') ?? '')
          if (!agentIdCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Valid agentId query parameter is required', {
              statusCode: 400,
            })
          }
          const limitRaw = url.searchParams.get('limit')
          const offsetRaw = url.searchParams.get('offset')
          const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined
          const offset = offsetRaw ? Number.parseInt(offsetRaw, 10) : undefined
          sendJson(res, 200, sessionRepo.listSessions(agentIdCheck.data, { limit, offset }))
          return
        }

        if (req.method === 'POST' && url.pathname === '/sessions') {
          const body = await readJsonBody(req)
          const parsed = CreateSessionInputSchema.safeParse(body)
          if (!parsed.success) {
            throw new DaemonError(
              'VALIDATION_ERROR',
              parsed.error.issues[0]?.message ?? 'Invalid session create payload',
              { statusCode: 400 },
            )
          }
          sendJson(res, 201, sessionRepo.createSession(parsed.data))
          return
        }

        if (req.method === 'PUT' && url.pathname === '/settings/active-session') {
          const body = await readJsonBody(req)
          const parsed = SetActiveSessionInputSchema.safeParse(body)
          if (!parsed.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid active session payload', {
              statusCode: 400,
            })
          }
          sendJson(
            res,
            200,
            sessionRepo.setActiveSessionId(parsed.data.agentId, parsed.data.sessionId),
          )
          return
        }

        const sessionMessagesMatch = /^\/sessions\/([^/]+)\/messages$/.exec(url.pathname)
        if (req.method === 'GET' && sessionMessagesMatch) {
          const idCheck = SessionIdSchema.safeParse(decodeURIComponent(sessionMessagesMatch[1]))
          if (!idCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid session identifier', {
              statusCode: 400,
            })
          }
          const limitRaw = url.searchParams.get('limit')
          const offsetRaw = url.searchParams.get('offset')
          const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined
          const offset = offsetRaw ? Number.parseInt(offsetRaw, 10) : undefined
          sendJson(res, 200, sessionRepo.getSessionMessages(idCheck.data, { limit, offset }))
          return
        }

        const sessionArchiveMatch = /^\/sessions\/([^/]+)\/archive$/.exec(url.pathname)
        if (req.method === 'POST' && sessionArchiveMatch) {
          const idCheck = SessionIdSchema.safeParse(decodeURIComponent(sessionArchiveMatch[1]))
          if (!idCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid session identifier', {
              statusCode: 400,
            })
          }
          sendJson(res, 200, sessionRepo.archiveSession(idCheck.data))
          return
        }

        const sessionInspectMatch = /^\/sessions\/([^/]+)\/inspect$/.exec(url.pathname)
        if (req.method === 'GET' && sessionInspectMatch) {
          const idCheck = SessionIdSchema.safeParse(decodeURIComponent(sessionInspectMatch[1]))
          if (!idCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid session identifier', {
              statusCode: 400,
            })
          }
          sendJson(res, 200, await orchestrator.inspectSession(idCheck.data))
          return
        }

        const runRetryMatch = /^\/runs\/([^/]+)\/retry$/.exec(url.pathname)
        if (req.method === 'POST' && runRetryMatch) {
          const idCheck = RunIdSchema.safeParse(decodeURIComponent(runRetryMatch[1]))
          if (!idCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid run identifier', { statusCode: 400 })
          }
          const body = await readJsonBody(req)
          const parsed = RetryRunInputSchema.safeParse({
            runId: idCheck.data,
            ...(body && typeof body === 'object' ? body : {}),
          })
          if (!parsed.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid retry payload', { statusCode: 400 })
          }
          sendJson(res, 201, await orchestrator.retryRun(parsed.data))
          return
        }

        const sessionMatch = /^\/sessions\/([^/]+)$/.exec(url.pathname)
        if (req.method === 'PATCH' && sessionMatch) {
          const idCheck = SessionIdSchema.safeParse(decodeURIComponent(sessionMatch[1]))
          if (!idCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid session identifier', {
              statusCode: 400,
            })
          }
          const body = await readJsonBody(req)
          const parsed = RenameSessionInputSchema.safeParse({
            sessionId: idCheck.data,
            ...(body && typeof body === 'object' ? body : {}),
          })
          if (!parsed.success) {
            throw new DaemonError(
              'VALIDATION_ERROR',
              parsed.error.issues[0]?.message ?? 'Invalid session rename payload',
              { statusCode: 400 },
            )
          }
          sendJson(res, 200, sessionRepo.renameSession(parsed.data.sessionId, parsed.data.title))
          return
        }

        if (req.method === 'POST' && url.pathname === '/runs') {
          const body = await readJsonBody(req)
          const parsed = StartRunInputSchema.safeParse(body)
          if (!parsed.success) {
            throw new DaemonError(
              'VALIDATION_ERROR',
              parsed.error.issues[0]?.message ?? 'Invalid start run payload',
              { statusCode: 400 },
            )
          }
          sendJson(res, 201, await orchestrator.startRun(parsed.data))
          return
        }

        const runCancelMatch = /^\/runs\/([^/]+)\/cancel$/.exec(url.pathname)
        if (req.method === 'POST' && runCancelMatch) {
          const idCheck = RunIdSchema.safeParse(decodeURIComponent(runCancelMatch[1]))
          if (!idCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid run identifier', { statusCode: 400 })
          }
          sendJson(res, 200, orchestrator.cancelRun(idCheck.data))
          return
        }

        const runEventsMatch = /^\/runs\/([^/]+)\/events$/.exec(url.pathname)
        if (req.method === 'GET' && runEventsMatch) {
          const idCheck = RunIdSchema.safeParse(decodeURIComponent(runEventsMatch[1]))
          if (!idCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid run identifier', { statusCode: 400 })
          }
          const afterSeqRaw = url.searchParams.get('afterSeq')
          const limitRaw = url.searchParams.get('limit')
          const afterSeq = afterSeqRaw ? Number.parseInt(afterSeqRaw, 10) : 0
          const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 200
          sendJson(res, 200, orchestrator.getRunEvents(idCheck.data, afterSeq, limit))
          return
        }

        const runApprovalMatch = /^\/runs\/([^/]+)\/approval$/.exec(url.pathname)
        if (req.method === 'POST' && runApprovalMatch) {
          const idCheck = RunIdSchema.safeParse(decodeURIComponent(runApprovalMatch[1]))
          if (!idCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid run identifier', { statusCode: 400 })
          }
          const body = await readJsonBody(req)
          const parsed = ResolveApprovalInputSchema.safeParse({
            runId: idCheck.data,
            ...(body && typeof body === 'object' ? body : {}),
          })
          if (!parsed.success) {
            throw new DaemonError(
              'VALIDATION_ERROR',
              parsed.error.issues[0]?.message ?? 'Invalid approval resolution payload',
              { statusCode: 400 },
            )
          }
          sendJson(
            res,
            200,
            await orchestrator.resolveApproval(
              parsed.data.runId,
              parsed.data.approvalId,
              parsed.data.decision,
              parsed.data.argsHash,
            ),
          )
          return
        }

        const runMatch = /^\/runs\/([^/]+)$/.exec(url.pathname)
        if (req.method === 'GET' && runMatch) {
          const idCheck = RunIdSchema.safeParse(decodeURIComponent(runMatch[1]))
          if (!idCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid run identifier', { statusCode: 400 })
          }
          sendJson(res, 200, orchestrator.getRun(idCheck.data))
          return
        }
      }

      if (this.memoryService) {
        const memoryService = this.memoryService

        if (req.method === 'GET' && url.pathname === '/memories') {
          const botId = url.searchParams.get('botId') ?? undefined
          const scopeKind = url.searchParams.get('scopeKind') ?? undefined
          const includeUserWide = url.searchParams.get('includeUserWide') === 'true'
          const includeArchived = url.searchParams.get('includeArchived') === 'true'
          const category = url.searchParams.get('category') ?? undefined
          const limitRaw = url.searchParams.get('limit')
          const offsetRaw = url.searchParams.get('offset')
          const parsed = ListMemoriesIpcInputSchema.safeParse({
            ...(botId ? { botId } : {}),
            ...(scopeKind ? { scopeKind } : {}),
            includeUserWide,
            includeArchived,
            ...(category ? { category } : {}),
            ...(limitRaw ? { limit: Number.parseInt(limitRaw, 10) } : {}),
            ...(offsetRaw ? { offset: Number.parseInt(offsetRaw, 10) } : {}),
          })
          if (!parsed.success) {
            throw new DaemonError(
              'VALIDATION_ERROR',
              parsed.error.issues[0]?.message ?? 'Invalid memory list query',
              { statusCode: 400 },
            )
          }
          sendJson(res, 200, await memoryService.listMemories(parsed.data))
          return
        }

        if (req.method === 'POST' && url.pathname === '/memories/search') {
          const body = await readJsonBody(req)
          const parsed = SearchMemoriesIpcInputSchema.safeParse(body)
          if (!parsed.success) {
            throw new DaemonError(
              'VALIDATION_ERROR',
              parsed.error.issues[0]?.message ?? 'Invalid memory search payload',
              { statusCode: 400 },
            )
          }
          sendJson(res, 200, await memoryService.searchMemories(parsed.data))
          return
        }

        if (req.method === 'POST' && url.pathname === '/memories') {
          const body = await readJsonBody(req)
          const parsed = CreateMemoryIpcInputSchema.safeParse(body)
          if (!parsed.success) {
            throw new DaemonError(
              'VALIDATION_ERROR',
              parsed.error.issues[0]?.message ?? 'Invalid create memory payload',
              { statusCode: 400 },
            )
          }
          sendJson(res, 201, await memoryService.createMemory(parsed.data))
          return
        }

        const memoryArchiveMatch = /^\/memories\/([^/]+)\/archive$/.exec(url.pathname)
        if (req.method === 'POST' && memoryArchiveMatch) {
          const idCheck = MemoryIdParamSchema.safeParse({
            id: decodeURIComponent(memoryArchiveMatch[1]),
          })
          if (!idCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid memory identifier', { statusCode: 400 })
          }
          sendJson(res, 200, await memoryService.archiveMemory(idCheck.data.id))
          return
        }

        const memoryMatch = /^\/memories\/([^/]+)$/.exec(url.pathname)
        if (memoryMatch) {
          const idCheck = MemoryIdParamSchema.safeParse({
            id: decodeURIComponent(memoryMatch[1]),
          })
          if (!idCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid memory identifier', { statusCode: 400 })
          }
          if (req.method === 'PATCH') {
            const body = await readJsonBody(req)
            const parsed = UpdateMemoryIpcInputSchema.safeParse({
              id: idCheck.data.id,
              ...(body && typeof body === 'object' ? body : {}),
            })
            if (!parsed.success) {
              throw new DaemonError(
                'VALIDATION_ERROR',
                parsed.error.issues[0]?.message ?? 'Invalid update memory payload',
                { statusCode: 400 },
              )
            }
            sendJson(res, 200, await memoryService.updateMemory(parsed.data))
            return
          }
          if (req.method === 'DELETE') {
            sendJson(res, 200, await memoryService.deleteMemory(idCheck.data.id))
            return
          }
        }
      }

      throw new DaemonError('NOT_FOUND', `Unknown daemon endpoint: ${req.method} ${url.pathname}`, {
        statusCode: 404,
      })
    } catch (err) {
      const normalized = normalizeDaemonError(err)
      sendJson(res, normalized.statusCode, normalized.body)
    }
  }
}
