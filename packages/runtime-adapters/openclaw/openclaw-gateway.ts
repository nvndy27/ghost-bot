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
export const SUPPORTED_OPENCLAW_VERSIONS = new Set(['2026.11.8'])
const MAX_STREAM_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_DURATION_MS = 120_000

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

function redactGatewayError(rawMsg: string): string {
  return rawMsg
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/(token|password|secret|key)\s*[=:]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
}

export interface OpenClawGatewayTransport {
  callRpc<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>
  streamChat?(
    params: {
      sessionId: string
      runId: string
      modelId: string
      text: string
      effort?: string
      permission?: string
      workspace?: string
      maxAttempts: 1
    },
    signal: AbortSignal,
  ): AsyncIterable<OpenClawStreamChunk>
  resolveApproval?(decision: ApprovalDecision): Promise<void>
  cancelRun?(params: { sessionId: string; runId: string }): Promise<{ acknowledged: boolean }>
  inspectSession?(externalId: string): Promise<{ exists: boolean; status?: string }>
  resumeSession?(externalId: string): Promise<SessionConfig | null>
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
  | {
      type: 'usage'
      inputTokens?: number
      outputTokens?: number
      source?: 'provider' | 'local' | 'estimated'
    }
  | { type: 'completed' }
  | { type: 'cancelled' }
  | { type: 'failed'; code: string; message: string }

export interface OpenClawStatusSummary {
  available: boolean
  gatewayUrl: string
  runtimeVersion: string | null
  supportedVersion: boolean
  hostDesktopEnabled: boolean
  pluginsLoaded: string[]
  authState: AuthState
  detail: string
  verifiedModes: ('read-only' | 'ask-approval' | 'workspace')[]
}

export interface OpenClawGatewayAdapterOptions {
  gatewayUrl?: string
  openclawCommand?: string
  timeoutMs?: number
  maxDurationMs?: number
  allowedVersions?: Set<string>
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
        maxBuffer: 1024 * 1024,
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
  private readonly allowedVersions: Set<string>
  private readonly maxDurationMs: number
  private readonly activeControllers = new Map<string, { controller: AbortController; sessionId: string }>()
  private readonly sessions = new Map<string, SessionConfig>()
  private lastVersion: string | null = null

  constructor(options: OpenClawGatewayAdapterOptions = {}) {
    this.gatewayUrl = assertLoopbackGatewayUrl(
      options.gatewayUrl ?? DEFAULT_OPENCLAW_GATEWAY_URL,
    )
    this.allowedVersions = options.allowedVersions ?? SUPPORTED_OPENCLAW_VERSIONS
    this.maxDurationMs = Math.max(1_000, Math.min(600_000, options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS))
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
      const [health, status] = await Promise.all([
        this.transport.callRpc<{
          ok?: unknown
          plugins?: { loaded?: unknown }
        }>('health'),
        this.transport.callRpc<{
          runtimeVersion?: unknown
          hostDesktop?: { enabled?: unknown }
        }>('status'),
      ])
      if (health?.ok !== true) {
        return {
          available: false,
          gatewayUrl: this.gatewayUrl,
          runtimeVersion: this.lastVersion,
          supportedVersion: false,
          hostDesktopEnabled: false,
          pluginsLoaded: [],
          authState: { status: 'error', detail: 'OpenClaw Gateway health check returned ok=false' },
          detail: 'OpenClaw Gateway health check failed.',
          verifiedModes: [],
        }
      }
      const runtimeVersion =
        typeof status?.runtimeVersion === 'string' && status.runtimeVersion.trim()
          ? status.runtimeVersion.trim()
          : null
      this.lastVersion = runtimeVersion
      const supportedVersion = runtimeVersion !== null && this.allowedVersions.has(runtimeVersion)
      const hostDesktopEnabled = status?.hostDesktop?.enabled === true
      const pluginsLoaded = Array.isArray(health.plugins?.loaded)
        ? health.plugins.loaded.filter((p): p is string => typeof p === 'string')
        : []

      if (!supportedVersion) {
        return {
          available: true,
          gatewayUrl: this.gatewayUrl,
          runtimeVersion,
          supportedVersion: false,
          hostDesktopEnabled,
          pluginsLoaded,
          authState: {
            status: 'error',
            detail: `Unsupported OpenClaw Gateway version "${runtimeVersion ?? 'unknown'}"`,
          },
          detail: `OpenClaw Gateway version "${runtimeVersion ?? 'unknown'}" is not in verified supported set; execution blocked.`,
          verifiedModes: [],
        }
      }

      return {
        available: true,
        gatewayUrl: this.gatewayUrl,
        runtimeVersion,
        supportedVersion: true,
        hostDesktopEnabled,
        pluginsLoaded,
        authState: {
          status: 'connected',
          detail: `Loopback Gateway ${this.gatewayUrl} authenticated (metadata-only; upstream provider billing/auth is separate)`,
        },
        detail: `OpenClaw Gateway ${runtimeVersion} reachable at ${this.gatewayUrl} (metadata verified; live execution gated)`,
        verifiedModes: [],
      }
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : 'OpenClaw Gateway unreachable'
      const msg = redactGatewayError(rawMsg)
      const authRequired = /auth|token|password|unauthorized|401/i.test(rawMsg)
      return {
        available: false,
        gatewayUrl: this.gatewayUrl,
        runtimeVersion: null,
        supportedVersion: false,
        hostDesktopEnabled: false,
        pluginsLoaded: [],
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

  async reconnect(): Promise<OpenClawStatusSummary> {
    return this.inspectGateway()
  }

  async disconnect(): Promise<void> {
    // Externally managed Gateway processes must never be terminated by Ghost Bot.
    for (const entry of this.activeControllers.values()) {
      entry.controller.abort()
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
      resume: typeof this.transport.resumeSession === 'function',
      approvals: typeof this.transport.resolveApproval === 'function',
      usage: typeof this.transport.streamChat === 'function',
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
    if (config.permission === 'full-access') {
      throw new Error('Full Access permission mode is disabled for OpenClaw.')
    }
    const id = `openclaw-${randomUUID()}`
    this.sessions.set(id, config)
    return { id, externalId: id, runtimeId: this.id }
  }

  async resumeSession(externalId: string): Promise<Session> {
    if (typeof this.transport.resumeSession === 'function') {
      const resumed = await this.transport.resumeSession(externalId)
      if (!resumed) {
        throw new Error(`OpenClaw session "${externalId}" could not be resumed`)
      }
      this.sessions.set(externalId, resumed)
      return { id: externalId, externalId, runtimeId: this.id }
    }
    if (!this.sessions.has(externalId)) {
      throw new Error(`OpenClaw session "${externalId}" not found for resume`)
    }
    return { id: externalId, externalId, runtimeId: this.id }
  }

  async inspectSession(externalId: string): Promise<{ exists: boolean; status?: string }> {
    if (typeof this.transport.inspectSession === 'function') {
      return this.transport.inspectSession(externalId)
    }
    return { exists: this.sessions.has(externalId) }
  }

  async *run(request: AgentRequest): AsyncIterable<AgentEvent> {
    if (typeof this.transport.streamChat !== 'function') {
      throw new Error(
        'OpenClaw live execution is gated until Gateway sandbox/billing enforcement is verified.',
      )
    }
    if (request.session.runtimeId !== this.id) {
      throw new Error(
        `Runtime mismatch: expected "${this.id}", got "${request.session.runtimeId}"`,
      )
    }
    const cfg = this.sessions.get(request.session.externalId)
    if (!cfg) {
      throw new Error(`Unknown OpenClaw session "${request.session.externalId}"`)
    }
    const ctrl = new AbortController()
    const timeoutTimer = setTimeout(() => ctrl.abort(), this.maxDurationMs)
    this.activeControllers.set(request.runId, {
      controller: ctrl,
      sessionId: request.session.externalId,
    })

    let seq = 0
    let streamBytes = 0
    let terminalEmitted = false
    const seenToolCalls = new Set<string>()
    const seenApprovals = new Set<string>()

    try {
      for await (const chunk of this.transport.streamChat(
        {
          sessionId: request.session.externalId,
          runId: request.runId,
          modelId: cfg.modelId,
          text: request.text,
          effort: cfg.effort,
          permission: cfg.permission,
          workspace: cfg.workspace,
          maxAttempts: 1,
        },
        ctrl.signal,
      )) {
        if (terminalEmitted) continue
        if (!chunk || typeof chunk !== 'object' || typeof chunk.type !== 'string') {
          terminalEmitted = true
          seq += 1
          yield {
            type: 'run.failed',
            runId: request.runId,
            seq,
            timestamp: new Date().toISOString(),
            code: 'MALFORMED_GATEWAY_EVENT',
            message: 'Malformed event received from OpenClaw Gateway',
          }
          return
        }

        const chunkBytes = Buffer.byteLength(JSON.stringify(chunk), 'utf8')
        streamBytes += chunkBytes
        if (streamBytes > MAX_STREAM_BYTES) {
          terminalEmitted = true
          seq += 1
          yield {
            type: 'run.failed',
            runId: request.runId,
            seq,
            timestamp: new Date().toISOString(),
            code: 'STREAM_LIMIT_EXCEEDED',
            message: `OpenClaw stream exceeded ${MAX_STREAM_BYTES} byte limit`,
          }
          return
        }

        const timestamp = new Date().toISOString()
        if (chunk.type === 'delta' && typeof chunk.text === 'string') {
          seq += 1
          yield { type: 'message.delta', runId: request.runId, seq, timestamp, text: chunk.text }
        } else if (
          (chunk.type === 'tool.started' || chunk.type === 'tool.completed') &&
          typeof chunk.callId === 'string'
        ) {
          const dedupeKey = `${chunk.type}:${chunk.callId}`
          if (seenToolCalls.has(dedupeKey)) continue
          seenToolCalls.add(dedupeKey)
          seq += 1
          yield {
            type: chunk.type,
            runId: request.runId,
            seq,
            timestamp,
            tool: chunk.tool,
            callId: chunk.callId,
            summary: redactGatewayError(chunk.summary),
          }
        } else if (chunk.type === 'approval.requested' && typeof chunk.approvalId === 'string') {
          if (seenApprovals.has(chunk.approvalId)) continue
          seenApprovals.add(chunk.approvalId)
          seq += 1
          yield {
            type: 'approval.requested',
            runId: request.runId,
            seq,
            timestamp,
            approvalId: chunk.approvalId,
            tool: chunk.tool,
            argsHash: chunk.argsHash,
            summary: redactGatewayError(chunk.summary),
            expiresAt: chunk.expiresAt,
          }
        } else if (chunk.type === 'usage') {
          seq += 1
          yield {
            type: 'usage.updated',
            runId: request.runId,
            seq,
            timestamp,
            usage: {
              source: chunk.source ?? 'provider',
              observedAt: timestamp,
              windows: [],
              ...(typeof chunk.inputTokens === 'number' ? { inputTokens: chunk.inputTokens } : {}),
              ...(typeof chunk.outputTokens === 'number' ? { outputTokens: chunk.outputTokens } : {}),
            },
          }
        } else if (chunk.type === 'completed') {
          terminalEmitted = true
          seq += 1
          yield { type: 'run.completed', runId: request.runId, seq, timestamp }
          return
        } else if (chunk.type === 'cancelled') {
          terminalEmitted = true
          seq += 1
          yield { type: 'run.cancelled', runId: request.runId, seq, timestamp }
          return
        } else if (chunk.type === 'failed') {
          terminalEmitted = true
          seq += 1
          yield {
            type: 'run.failed',
            runId: request.runId,
            seq,
            timestamp,
            code: chunk.code,
            message: redactGatewayError(chunk.message),
          }
          return
        } else {
          terminalEmitted = true
          seq += 1
          yield {
            type: 'run.failed',
            runId: request.runId,
            seq,
            timestamp,
            code: 'MALFORMED_GATEWAY_EVENT',
            message: `Invalid OpenClaw event type "${String((chunk as { type?: unknown }).type)}"`,
          }
          return
        }
      }
      if (!terminalEmitted && ctrl.signal.aborted) {
        seq += 1
        yield {
          type: 'run.cancelled',
          runId: request.runId,
          seq,
          timestamp: new Date().toISOString(),
        }
      }
    } finally {
      clearTimeout(timeoutTimer)
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
    const entry = this.activeControllers.get(runId)
    if (entry) {
      entry.controller.abort()
      if (typeof this.transport.cancelRun === 'function') {
        const res = await this.transport.cancelRun({
          sessionId: entry.sessionId,
          runId,
        })
        if (!res.acknowledged) {
          throw new Error(`OpenClaw cancellation for run "${runId}" was not acknowledged`)
        }
      }
    }
  }
}
