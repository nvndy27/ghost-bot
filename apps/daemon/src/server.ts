import { timingSafeEqual } from 'node:crypto'
import { chmod, unlink } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { CodexAppServerAdapter } from '@ghost-bot/runtime-adapters/codex'
import { MockRuntimeAdapter } from '@ghost-bot/runtime-adapters/mock'
import type { RuntimePermissionEvidence } from '@ghost-bot/shared-types/permissions'
import type { DaemonHealthResponse, ProviderSummary } from '@ghost-bot/shared-types/ipc'
import { DaemonError, normalizeDaemonError } from './errors.ts'

export interface DaemonServerOptions {
  authToken: string
  socketPath?: string
  port?: number
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

export function resolveCodexVerifiedEvidence(
  codexVersion: string | null,
): RuntimePermissionEvidence | null {
  // Bind permission evidence to verified Codex App Server >= 0.172.0 capabilities
  // confirmed in Phase 0B/0C (read-only, ask-approval, workspace with excludeSlashTmp).
  if (!codexVersion) return null
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(codexVersion.trim())
  if (!match) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  if (major > 0 || (major === 0 && minor >= 172)) {
    return {
      sandboxEnforced: true,
      approvalEnforced: true,
      sensitiveActionsEnforced: true,
      verifiedModes: ['read-only', 'ask-approval', 'workspace'],
    }
  }
  return null
}

export class GhostBotDaemon {
  private readonly options: DaemonServerOptions
  private readonly runtimeMode: 'codex' | 'mock'
  private readonly codex: CodexAppServerAdapter
  private readonly mock: MockRuntimeAdapter
  private server: Server | null = null
  private readonly startedAt = Date.now()

  constructor(options: DaemonServerOptions) {
    if (!options.authToken || options.authToken.length < 16) {
      throw new DaemonError('INVALID_CONFIG', 'Daemon requires a strong authToken (>=16 chars)')
    }
    this.options = options
    this.runtimeMode = options.runtimeMode ?? 'codex'
    const evidence = resolveCodexVerifiedEvidence(options.codexVersion ?? '0.172.0')
    this.codex = new CodexAppServerAdapter({
      permissionEvidence: evidence,
      fullAccessOptIn: false,
    })
    this.mock = new MockRuntimeAdapter()
  }

  async start(): Promise<{ address: string }> {
    if (this.server) {
      throw new DaemonError('ALREADY_STARTED', 'Daemon server is already running')
    }

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
    await this.codex.close()
    await this.mock.disconnect()
    if (this.server) {
      const srv = this.server
      this.server = null
      await new Promise<void>((resolve) => srv.close(() => resolve()))
    }
    if (this.options.socketPath) {
      await unlink(this.options.socketPath).catch(() => undefined)
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
        const providers = await this.getProviders()
        sendJson(res, 200, providers)
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

  private async getProviders(): Promise<ProviderSummary[]> {
    const list: ProviderSummary[] = []
    if (this.runtimeMode === 'mock') {
      list.push({
        id: this.mock.id,
        label: 'Mock Offline Runtime',
        kind: 'mock',
        status: 'mock',
        detail: 'Explicit offline mock runtime (no real provider calls)',
      })
      return list
    }

    const codexAuth = await this.codex.getAuthStatus()
    list.push({
      id: this.codex.id,
      label: 'OpenAI Codex (ChatGPT Subscription)',
      kind: 'subscription',
      status: codexAuth.status === 'connected' ? 'connected' : 'disconnected',
      detail: codexAuth.detail ?? 'Managed ChatGPT profile',
    })
    list.push({
      id: 'openclaw',
      label: 'OpenClaw Gateway',
      kind: 'local',
      status: 'unavailable',
      detail: 'Phase 0 probe verified read-only health; native adapter pending Phase 2',
    })
    list.push({
      id: 'ollama',
      label: 'Ollama Local',
      kind: 'local',
      status: 'unavailable',
      detail: 'Local service not detected at 127.0.0.1:11434',
    })
    return list
  }
}
