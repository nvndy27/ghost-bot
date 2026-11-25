import { timingSafeEqual } from 'node:crypto'
import { chmod } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { sanitizeCustomSvg } from '@ghost-bot/avatar/svg-sanitizer'
import {
  AppearanceSettingsSchema,
  AppSettingsPatchSchema,
  BotIdSchema,
  CreateBotInputSchema,
  ImportAvatarSvgInputSchema,
  SetActiveBotParamsSchema,
  UpdateBotInputSchema,
} from '@ghost-bot/shared-types/ipc'
import type { DaemonHealthResponse } from '@ghost-bot/shared-types/ipc'
import { BotRepository } from './bots/repository.ts'
import { openGhostBotDatabase } from './db/client.ts'
import type { DatabaseHandle } from './db/client.ts'
import { seedInitialBotsIfNeeded } from './db/seed.ts'
import { DaemonError, normalizeDaemonError } from './errors.ts'
import { RuntimeRegistry } from './runtime/registry.ts'
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

export class GhostBotDaemon {
  private readonly options: DaemonServerOptions
  private readonly runtimeMode: 'codex' | 'mock'
  private readonly runtimeRegistry: RuntimeRegistry
  private dbHandle: DatabaseHandle | null = null
  private botRepo: BotRepository | null = null
  private settingsRepo: SettingsRepository | null = null
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

  async start(): Promise<{ address: string }> {
    if (this.server) {
      throw new DaemonError('ALREADY_STARTED', 'Daemon server is already running')
    }

    const dbHandle = await openGhostBotDatabase(this.options.dataDir)
    seedInitialBotsIfNeeded(dbHandle)
    this.dbHandle = dbHandle
    this.botRepo = new BotRepository(dbHandle)
    this.settingsRepo = new SettingsRepository(dbHandle)

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
    await this.runtimeRegistry.stop()
    if (this.server) {
      const srv = this.server
      this.server = null
      await new Promise<void>((resolve) => srv.close(() => resolve()))
    }
    this.botRepo = null
    this.settingsRepo = null
    if (this.dbHandle) {
      this.dbHandle.close()
      this.dbHandle = null
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
          sendJson(res, 200, repo.deleteBot(idCheck.data))
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

      throw new DaemonError('NOT_FOUND', `Unknown daemon endpoint: ${req.method} ${url.pathname}`, {
        statusCode: 404,
      })
    } catch (err) {
      const normalized = normalizeDaemonError(err)
      sendJson(res, normalized.statusCode, normalized.body)
    }
  }
}
