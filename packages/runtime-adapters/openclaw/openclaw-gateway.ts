import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import type {
  AgentEvent,
  AgentRequest,
  AgentRuntime,
  ApprovalDecision,
  AuthState,
  Capabilities,
  ModelInfo,
  Session,
  SessionConfig,
  UsageSnapshot,
} from '@ghost-bot/shared-types/runtime'

const execFileAsync = promisify(execFile)

export const DEFAULT_OPENCLAW_GATEWAY_URL = 'ws://127.0.0.1:18789'

export function assertLoopbackGatewayUrl(rawUrl: string): string {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error(`Invalid OpenClaw Gateway URL: "${rawUrl}"`)
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error(`OpenClaw Gateway URL must use ws:// or wss://, got "${parsed.protocol}"`)
  }
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost' && parsed.hostname !== '::1') {
    throw new Error(
      `OpenClaw Gateway URL must target loopback only; refused "${parsed.hostname}"`,
    )
  }
  return parsed.toString().replace(/\/$/, '')
}

export interface OpenClawGatewayTransport {
  callRpc<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>
  streamChat?(
    params: { sessionId: string; runId: string; modelId: string; text: string; effort?: string },
    signal: AbortSignal,
  ): AsyncIterable<OpenClawStreamChunk>
  resolveApproval?(decision: ApprovalDecision): Promise<void>
}

export type OpenClawStreamChunk =
  | { type: 'delta'; text: string }
  | { type: 'tool.started' | 'tool.completed'; tool: string; callId: string; summary: string }
  | {
      type: 'approval.requested'
      approvalId: string
      tool: string
      argsHash: string
      summary: string
      expiresAt: string
    }
  | { type: 'completed' }
  | { type: 'failed'; code: string; message: string }

export interface OpenClawStatusSummary {
  available: boolean
  runtimeVersion: string | null
  authState: AuthState
  detail: string
  verifiedModes: ('read-only' | 'ask-approval' | 'workspace')[]
}

export interface OpenClawGatewayAdapterOptions {
  gatewayUrl?: string
  openclawCommand?: string
  timeoutMs?: number
  transport?: OpenClawGatewayTransport
}

class CliOpenClawTransport implements OpenClawGatewayTransport {
  private readonly gatewayUrl: string
  private readonly command: string
  private readonly timeoutMs: number

  constructor(gatewayUrl: string, command: string, timeoutMs: number) {
    this.gatewayUrl = gatewayUrl
    this.command = command
    this.timeoutMs = timeoutMs
  }

  async callRpc<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const { stdout } = await execFileAsync(
      this.command,
      [
        'gateway',
        'call',
        method,
        '--expect-url',
        this.gatewayUrl,
        '--params',
        JSON.stringify(params),
        '--timeout',
        String(this.timeoutMs),
        '--json',
      ],
      {
        timeout: this.timeoutMs + 3000,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        },
      },
    )
    return JSON.parse(stdout) as T
  }
}

export class OpenClawGatewayAdapter implements AgentRuntime {
  readonly id = 'openclaw'
  private readonly gatewayUrl: string
  private readonly transport: OpenClawGatewayTransport
  private readonly activeControllers = new Map<string, AbortController>()
  private readonly sessions = new Map<string, SessionConfig>()
  private lastVersion: string | null = null

  constructor(options: OpenClawGatewayAdapterOptions = {}) {
    this.gatewayUrl = assertLoopbackGatewayUrl(
      options.gatewayUrl ?? DEFAULT_OPENCLAW_GATEWAY_URL,
    )
    this.transport =
      options.transport ??
      new CliOpenClawTransport(
        this.gatewayUrl,
        options.openclawCommand ?? 'openclaw',
        options.timeoutMs ?? 5000,
      )
  }

  getGatewayUrl(): string {
    return this.gatewayUrl
  }

  getRuntimeVersion(): string | null {
    return this.lastVersion
  }

  async inspectGateway(): Promise<OpenClawStatusSummary> {
    try {
      const health = await this.transport.callRpc<{ ok?: unknown }>('health')
      if (health?.ok !== true) {
        return {
          available: false,
          runtimeVersion: this.lastVersion,
          authState: { status: 'error', detail: 'OpenClaw Gateway health check returned ok=false' },
          detail: 'OpenClaw Gateway health check failed.',
          verifiedModes: [],
        }
      }
      const status = await this.transport.callRpc<{ runtimeVersion?: unknown }>('status')
      const runtimeVersion =
        typeof status?.runtimeVersion === 'string' && status.runtimeVersion.trim()
          ? status.runtimeVersion.trim()
          : null
      this.lastVersion = runtimeVersion
      return {
        available: true,
        runtimeVersion,
        authState: {
          status: 'connected',
          detail: `Loopback Gateway ${this.gatewayUrl} authenticated (metadata-only; upstream provider billing/auth is separate)`,
        },
        detail: runtimeVersion
          ? `OpenClaw Gateway ${runtimeVersion} reachable at ${this.gatewayUrl} (metadata verified; live execution gated)`
          : `OpenClaw Gateway reachable at ${this.gatewayUrl} (metadata verified; live execution gated)`,
        verifiedModes: [],
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'OpenClaw Gateway unreachable'
      const authRequired = /auth|token|password|unauthorized|401/i.test(msg)
      return {
        available: false,
        runtimeVersion: null,
        authState: {
          status: authRequired ? 'disconnected' : 'error',
          detail: msg,
        },
        detail: authRequired
          ? 'OpenClaw Gateway authentication required.'
          : `OpenClaw Gateway unavailable at ${this.gatewayUrl}: ${msg}`,
        verifiedModes: [],
      }
    }
  }

  async authenticate(): Promise<AuthState> {
    return this.getAuthStatus()
  }

  async getAuthStatus(): Promise<AuthState> {
    const info = await this.inspectGateway()
    return info.authState
  }

  async disconnect(): Promise<void> {
    // Externally managed Gateway processes must never be terminated by Ghost Bot.
    for (const ctrl of this.activeControllers.values()) {
      ctrl.abort()
    }
    this.activeControllers.clear()
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await this.transport.callRpc<{ models?: unknown }>('models.list')
    const rawModels = Array.isArray(res?.models) ? res.models : []
    const seen = new Set<string>()
    const out: ModelInfo[] = []
    for (const item of rawModels) {
      if (!item || typeof item !== 'object') continue
      const rec = item as Record<string, unknown>
      if (typeof rec.id !== 'string' || !rec.id.trim() || seen.has(rec.id)) continue
      seen.add(rec.id)
      const label =
        typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : rec.id.trim()
      const rawLevels = Array.isArray(rec.thinkingLevels) ? rec.thinkingLevels : []
      const efforts: string[] = []
      for (const lvl of rawLevels) {
        if (lvl && typeof lvl === 'object' && typeof (lvl as { id?: unknown }).id === 'string') {
          const id = (lvl as { id: string }).id.trim()
          if (id && !efforts.includes(id)) efforts.push(id)
        }
      }
      out.push({
        id: rec.id.trim(),
        label,
        efforts,
        permissionModes: [],
        supportsTools: false,
        supportsAttachments: false,
      })
    }
    return out
  }

  async capabilities(): Promise<Capabilities> {
    const models = await this.listModels().catch(() => [])
    return {
      streaming: typeof this.transport.streamChat === 'function',
      cancellation: typeof this.transport.streamChat === 'function',
      resume: false,
      approvals: typeof this.transport.resolveApproval === 'function',
      usage: false,
      sandbox: false,
      models,
    }
  }

  async getUsage(): Promise<UsageSnapshot | null> {
    // OpenClaw Gateway does not expose verified upstream subscription quota windows.
    return null
  }

  async createSession(config: SessionConfig): Promise<Session> {
    if (typeof this.transport.streamChat !== 'function') {
      throw new Error(
        'OpenClaw live execution is gated until Gateway sandbox/billing enforcement is verified.',
      )
    }
    const id = `openclaw-${randomUUID()}`
    this.sessions.set(id, config)
    return { id, externalId: id, runtimeId: this.id }
  }

  async *run(request: AgentRequest): AsyncIterable<AgentEvent> {
    if (typeof this.transport.streamChat !== 'function') {
      throw new Error(
        'OpenClaw live execution is gated until Gateway sandbox/billing enforcement is verified.',
      )
    }
    const cfg = this.sessions.get(request.session.externalId)
    if (!cfg) {
      throw new Error(`Unknown OpenClaw session "${request.session.externalId}"`)
    }
    const ctrl = new AbortController()
    this.activeControllers.set(request.runId, ctrl)
    let seq = 0
    try {
      for await (const chunk of this.transport.streamChat(
        {
          sessionId: request.session.externalId,
          runId: request.runId,
          modelId: cfg.modelId,
          text: request.text,
          effort: cfg.effort,
        },
        ctrl.signal,
      )) {
        seq += 1
        const timestamp = new Date().toISOString()
        if (chunk.type === 'delta') {
          yield { type: 'message.delta', runId: request.runId, seq, timestamp, text: chunk.text }
        } else if (chunk.type === 'tool.started' || chunk.type === 'tool.completed') {
          yield {
            type: chunk.type,
            runId: request.runId,
            seq,
            timestamp,
            tool: chunk.tool,
            callId: chunk.callId,
            summary: chunk.summary,
          }
        } else if (chunk.type === 'approval.requested') {
          yield {
            type: 'approval.requested',
            runId: request.runId,
            seq,
            timestamp,
            approvalId: chunk.approvalId,
            tool: chunk.tool,
            argsHash: chunk.argsHash,
            summary: chunk.summary,
            expiresAt: chunk.expiresAt,
          }
        } else if (chunk.type === 'completed') {
          yield { type: 'run.completed', runId: request.runId, seq, timestamp }
          return
        } else if (chunk.type === 'failed') {
          yield {
            type: 'run.failed',
            runId: request.runId,
            seq,
            timestamp,
            code: chunk.code,
            message: chunk.message,
          }
          return
        }
      }
      if (ctrl.signal.aborted) {
        seq += 1
        yield {
          type: 'run.cancelled',
          runId: request.runId,
          seq,
          timestamp: new Date().toISOString(),
        }
      }
    } finally {
      this.activeControllers.delete(request.runId)
    }
  }

  async resolveApproval(decision: ApprovalDecision): Promise<void> {
    if (typeof this.transport.resolveApproval !== 'function') {
      throw new Error('OpenClaw approval resolution is not enabled on this transport.')
    }
    await this.transport.resolveApproval(decision)
  }

  async cancel(runId: string): Promise<void> {
    const ctrl = this.activeControllers.get(runId)
    if (ctrl) {
      ctrl.abort()
    }
  }
}
