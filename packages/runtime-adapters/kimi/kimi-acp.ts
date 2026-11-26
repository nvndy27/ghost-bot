import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import type {
  AgentEvent,
  AgentRequest,
  AgentRuntime,
  ApprovalDecision,
  AuthState,
  Capabilities,
  EventPayload,
  ModelInfo,
  Session,
  SessionConfig,
  UsageSnapshot,
} from '@ghost-bot/shared-types/runtime'

const execFileAsync = promisify(execFile)

export const SUPPORTED_ACP_PROTOCOL_VERSION = 1
export const KIMI_ACP_MAX_MESSAGE_BYTES = 1024 * 1024
export const KIMI_ACP_MAX_STDERR_BYTES = 64 * 1024
export const KIMI_ACP_MAX_PENDING_REQUESTS = 16
export const KIMI_ACP_MAX_CONCURRENT_RUNS = 1
export const KIMI_ACP_MAX_DURATION_MS = 120_000
export const KIMI_ACP_MAX_STREAM_BYTES = 2 * 1024 * 1024

const KIMI_SECRET_PATTERN = /(bearer\s+[a-z0-9._-]+|sk-[a-z0-9_-]{8,}|token=[a-z0-9._-]+)/gi

export function redactKimiSecrets(text: string): string {
  return text.replace(KIMI_SECRET_PATTERN, '[REDACTED]')
}

export async function detectKimiCli(command = 'kimi'): Promise<{
  available: boolean
  version: string | null
  detail: string
}> {
  try {
    const { stdout, stderr } = await execFileAsync(command, ['--version'], {
      timeout: 3_000,
      maxBuffer: 64 * 1024,
      env: { PATH: process.env.PATH ?? '' },
    })
    const out = `${stdout}\n${stderr}`.trim()
    const match = /(\d+\.\d+\.\d+(?:[-+][^\s]+)?)/.exec(out)
    const version = match?.[1] ?? (out.slice(0, 48) || null)
    return {
      available: true,
      version,
      detail: version ? `Kimi Code CLI ${version} detected` : 'Kimi Code CLI detected',
    }
  } catch {
    return {
      available: false,
      version: null,
      detail: 'Kimi Code CLI (`kimi`) not installed on host; run official installer and `kimi login`',
    }
  }
}

export interface KimiAcpRpcRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: Record<string, unknown>
}

export interface KimiAcpRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

export interface KimiAcpRpcResponse {
  jsonrpc: '2.0'
  id: number | string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface KimiAcpTransport {
  sendRequest(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
  sendNotification(method: string, params?: Record<string, unknown>): void
  respondToAgentRequest(id: number | string, result?: unknown, error?: { code: number; message: string }): void
  onNotification(handler: (method: string, params: Record<string, unknown>) => void): () => void
  onAgentRequest(handler: (id: number | string, method: string, params: Record<string, unknown>) => void): () => void
  onClose(handler: (reason: string) => void): () => void
  close(): Promise<{ confirmed: boolean }>
}

class StdioKimiAcpTransport implements KimiAcpTransport {
  private child: ChildProcess
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >()
  private readonly notifHandlers = new Set<(method: string, params: Record<string, unknown>) => void>()
  private readonly reqHandlers = new Set<(id: number | string, method: string, params: Record<string, unknown>) => void>()
  private readonly closeHandlers = new Set<(reason: string) => void>()
  private stdoutBuffer = ''
  private stderrBytes = 0
  private closed = false

  constructor(command: string) {
    this.child = spawn(command, ['acp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        TERM: 'dumb',
      },
    })

    this.child.stdout?.on('data', (chunk: Buffer) => {
      if (this.stdoutBuffer.length + chunk.length > KIMI_ACP_MAX_MESSAGE_BYTES) {
        this.handleFatal('ACP stdout exceeded 1 MiB framing limit')
        return
      }
      this.stdoutBuffer += chunk.toString('utf8')
      let nl = this.stdoutBuffer.indexOf('\n')
      while (nl !== -1) {
        const line = this.stdoutBuffer.slice(0, nl).trim()
        this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1)
        nl = this.stdoutBuffer.indexOf('\n')
        if (!line) continue
        this.handleLine(line)
      }
    })

    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrBytes += chunk.length
      if (this.stderrBytes > KIMI_ACP_MAX_STDERR_BYTES) {
        // Drain without unbounded buffering
      }
    })

    this.child.once('exit', (code, signal) => {
      this.closed = true
      const reason = `Kimi ACP process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error(reason))
      }
      this.pending.clear()
      for (const h of this.closeHandlers) h(reason)
    })

    this.child.once('error', (err) => {
      this.handleFatal(`Kimi ACP spawn error: ${err.message}`)
    })
  }

  private handleFatal(reason: string): void {
    this.closed = true
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error(reason))
    }
    this.pending.clear()
    try {
      this.child.kill('SIGKILL')
    } catch {
      // ignore
    }
    for (const h of this.closeHandlers) h(reason)
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>
    try {
      const parsed = JSON.parse(line) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Non-object JSON-RPC message')
      }
      msg = parsed as Record<string, unknown>
    } catch {
      this.handleFatal('Kimi ACP emitted malformed JSON-RPC frame')
      return
    }

    if ('id' in msg && msg.id !== undefined && !('method' in msg)) {
      const id = Number(msg.id)
      const p = this.pending.get(id)
      if (!p) return
      this.pending.delete(id)
      clearTimeout(p.timer)
      if (msg.error && typeof msg.error === 'object') {
        const e = msg.error as { message?: unknown }
        p.reject(new Error(redactKimiSecrets(String(e.message ?? 'ACP RPC error'))))
      } else {
        p.resolve(msg.result)
      }
      return
    }

    if (typeof msg.method === 'string') {
      const params =
        msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params)
          ? (msg.params as Record<string, unknown>)
          : {}
      if ('id' in msg && msg.id !== undefined) {
        for (const h of this.reqHandlers) h(msg.id as number | string, msg.method, params)
      } else {
        for (const h of this.notifHandlers) h(msg.method, params)
      }
    }
  }

  sendRequest(method: string, params?: Record<string, unknown>, timeoutMs = 15_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Kimi ACP transport is closed'))
    if (this.pending.size >= KIMI_ACP_MAX_PENDING_REQUESTS) {
      return Promise.reject(new Error('Kimi ACP pending request limit reached'))
    }
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })
    if (Buffer.byteLength(payload, 'utf8') > KIMI_ACP_MAX_MESSAGE_BYTES) {
      return Promise.reject(new Error('Kimi ACP request exceeds 1 MiB limit'))
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Kimi ACP request "${method}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin?.write(payload + '\n')
    })
  }

  sendNotification(method: string, params?: Record<string, unknown>): void {
    if (this.closed) return
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} })
    if (Buffer.byteLength(payload, 'utf8') <= KIMI_ACP_MAX_MESSAGE_BYTES) {
      this.child.stdin?.write(payload + '\n')
    }
  }

  respondToAgentRequest(
    id: number | string,
    result?: unknown,
    error?: { code: number; message: string },
  ): void {
    if (this.closed) return
    const payload = JSON.stringify(
      error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result: result ?? {} },
    )
    this.child.stdin?.write(payload + '\n')
  }

  onNotification(handler: (method: string, params: Record<string, unknown>) => void): () => void {
    this.notifHandlers.add(handler)
    return () => this.notifHandlers.delete(handler)
  }

  onAgentRequest(
    handler: (id: number | string, method: string, params: Record<string, unknown>) => void,
  ): () => void {
    this.reqHandlers.add(handler)
    return () => this.reqHandlers.delete(handler)
  }

  onClose(handler: (reason: string) => void): () => void {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  async close(): Promise<{ confirmed: boolean }> {
    if (this.closed && this.child.exitCode !== null) return { confirmed: true }
    try {
      this.child.kill('SIGTERM')
    } catch {
      return { confirmed: this.child.exitCode !== null }
    }
    return new Promise((resolve) => {
      if (this.child.exitCode !== null) {
        resolve({ confirmed: true })
        return
      }
      const timer = setTimeout(() => {
        try {
          this.child.kill('SIGKILL')
        } catch {
          // ignore
        }
        setTimeout(() => resolve({ confirmed: this.child.exitCode !== null }), 300)
      }, 1_000)
      this.child.once('exit', () => {
        clearTimeout(timer)
        resolve({ confirmed: true })
      })
    })
  }
}

export interface KimiAcpAdapterOptions {
  kimiCommand?: string
  transportFactory?: () => KimiAcpTransport
  isExecutionAuthorized?: () => boolean
  maxDurationMs?: number
}

interface KimiSessionState {
  sessionId: string
  config: SessionConfig
  activeRunId: string | null
  lastRunId: string | null
}

interface PendingPermission {
  approvalId: string
  runId: string
  rpcId: number | string
  argsHash: string
  expiresAtMs: number
  allowOptionId: string | null
  denyOptionId: string | null
  resolve: (decision: 'allow-once' | 'deny') => void
}

export class KimiAcpAdapter implements AgentRuntime {
  readonly id = 'kimi-acp'
  private readonly kimiCommand: string
  private readonly transportFactory?: () => KimiAcpTransport
  private readonly isExecutionAuthorized: () => boolean
  private readonly maxDurationMs: number
  private transport: KimiAcpTransport | null = null
  private negotiatedProtocolVersion: number | null = null
  private negotiatedLoadSession = false
  private negotiatedModels: ModelInfo[] = []
  private authenticated = false
  private readonly sessions = new Map<string, KimiSessionState>()
  private readonly pendingPermissions = new Map<string, PendingPermission>()
  private readonly cancelledRuns = new Set<string>()
  private readonly quarantinedSessions = new Set<string>()

  constructor(options: KimiAcpAdapterOptions = {}) {
    this.kimiCommand = options.kimiCommand ?? 'kimi'
    this.transportFactory = options.transportFactory
    this.isExecutionAuthorized = options.isExecutionAuthorized ?? (() => false)
    this.maxDurationMs = Math.max(1_000, Math.min(options.maxDurationMs ?? KIMI_ACP_MAX_DURATION_MS, 300_000))
  }

  async inspectRuntime(): Promise<{
    cliAvailable: boolean
    cliVersion: string | null
    protocolVersion: number | null
    acpProtocolSupported: boolean
    authenticated: boolean
    loadSessionSupported: boolean
    models: ModelInfo[]
    detail: string
  }> {
    if (!this.transportFactory) {
      const cli = await detectKimiCli(this.kimiCommand)
      if (!cli.available) {
        return {
          cliAvailable: false,
          cliVersion: null,
          protocolVersion: null,
          acpProtocolSupported: false,
          authenticated: false,
          loadSessionSupported: false,
          models: [],
          detail: cli.detail,
        }
      }
      return {
        cliAvailable: true,
        cliVersion: cli.version,
        protocolVersion: this.negotiatedProtocolVersion,
        acpProtocolSupported: this.negotiatedProtocolVersion === SUPPORTED_ACP_PROTOCOL_VERSION,
        authenticated: this.authenticated,
        loadSessionSupported: this.negotiatedLoadSession,
        models: this.negotiatedModels,
        detail: `${cli.detail} (ACP execution gated by default)`,
      }
    }

    try {
      await this.ensureInitialized()
      return {
        cliAvailable: true,
        cliVersion: 'fixture',
        protocolVersion: this.negotiatedProtocolVersion,
        acpProtocolSupported: this.negotiatedProtocolVersion === SUPPORTED_ACP_PROTOCOL_VERSION,
        authenticated: this.authenticated,
        loadSessionSupported: this.negotiatedLoadSession,
        models: this.negotiatedModels,
        detail: this.authenticated
          ? 'Kimi ACP initialized and authenticated'
          : 'Kimi ACP initialized (run `kimi login` to authenticate)',
      }
    } catch (err) {
      return {
        cliAvailable: false,
        cliVersion: null,
        protocolVersion: null,
        acpProtocolSupported: false,
        authenticated: false,
        loadSessionSupported: false,
        models: [],
        detail: err instanceof Error ? redactKimiSecrets(err.message) : 'Kimi ACP unavailable',
      }
    }
  }

  private async ensureInitialized(): Promise<KimiAcpTransport> {
    if (this.transport) return this.transport
    const transport = this.transportFactory
      ? this.transportFactory()
      : new StdioKimiAcpTransport(this.kimiCommand)

    const initRes = (await transport.sendRequest('initialize', {
      protocolVersion: SUPPORTED_ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'ghost-bot', version: '0.1.0' },
    })) as Record<string, unknown>

    const proto = Number(initRes?.protocolVersion)
    if (proto !== SUPPORTED_ACP_PROTOCOL_VERSION) {
      await transport.close().catch(() => {})
      throw new Error(
        `Unsupported Kimi ACP protocolVersion "${String(initRes?.protocolVersion)}"; expected ${SUPPORTED_ACP_PROTOCOL_VERSION}`,
      )
    }

    const agentCaps =
      initRes?.agentCapabilities && typeof initRes.agentCapabilities === 'object'
        ? (initRes.agentCapabilities as Record<string, unknown>)
        : {}
    this.negotiatedProtocolVersion = proto
    this.negotiatedLoadSession = agentCaps.loadSession === true
    this.authenticated = initRes?.authenticated !== false

    const rawModels = Array.isArray(initRes?.models) ? initRes.models : []
    this.negotiatedModels = rawModels
      .filter((m): m is Record<string, unknown> => Boolean(m && typeof m === 'object'))
      .map((m) => ({
        id: String(m.id ?? '').trim(),
        label: String(m.label ?? m.id ?? '').trim(),
        efforts: [],
        permissionModes: ['read-only', 'ask-approval'] as ('read-only' | 'ask-approval')[],
        supportsTools: true,
        supportsAttachments: false,
      }))
      .filter((m) => m.id.length > 0)

    // Reject unsupported fs/* and terminal/* callbacks by default
    transport.onAgentRequest((rpcId, method) => {
      if (method.startsWith('fs/') || method.startsWith('terminal/')) {
        transport.respondToAgentRequest(rpcId, undefined, {
          code: -32601,
          message: `Unsupported client capability "${method}" rejected by Ghost Bot policy`,
        })
      }
    })

    transport.onClose(() => {
      this.transport = null
      for (const sess of this.sessions.values()) {
        if (sess.activeRunId) {
          this.quarantinedSessions.add(sess.sessionId)
        }
      }
    })

    this.transport = transport
    return transport
  }

  async authenticate(): Promise<AuthState> {
    return this.getAuthStatus()
  }

  async getAuthStatus(): Promise<AuthState> {
    const info = await this.inspectRuntime()
    if (!info.cliAvailable) {
      return { status: 'disconnected', detail: info.detail }
    }
    if (!info.authenticated) {
      return {
        status: 'pending',
        detail: 'Kimi CLI not authenticated; run `kimi login` in your terminal',
      }
    }
    return { status: 'connected', detail: info.detail }
  }

  async disconnect(): Promise<void> {
    for (const [id, p] of this.pendingPermissions.entries()) {
      p.resolve('deny')
      this.pendingPermissions.delete(id)
    }
    if (this.transport) {
      const res = await this.transport.close()
      this.transport = null
      if (!res.confirmed) {
        for (const sess of this.sessions.values()) {
          this.quarantinedSessions.add(sess.sessionId)
        }
      }
    }
  }

  async reconnect(): Promise<AuthState> {
    await this.disconnect()
    return this.getAuthStatus()
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.negotiatedModels
  }

  async capabilities(): Promise<Capabilities> {
    return {
      streaming: true,
      cancellation: true,
      resume: this.negotiatedLoadSession,
      approvals: true,
      usage: true,
      sandbox: false,
      models: this.negotiatedModels,
    }
  }

  async getUsage(): Promise<UsageSnapshot | null> {
    // Kimi subscription plan/quota is never fabricated.
    return null
  }

  async createSession(config: SessionConfig): Promise<Session> {
    if (config.permission === 'full-access') {
      throw new Error('Full Access mode is disabled for Kimi ACP')
    }
    if (!config.workspace || config.workspace.includes('\0') || config.workspace.includes('..')) {
      throw new Error('Valid canonical workspace is required for Kimi ACP session')
    }
    const transport = await this.ensureInitialized()
    if (!this.authenticated) {
      throw new Error('Kimi ACP requires `kimi login` authentication before creating sessions')
    }
    const res = (await transport.sendRequest('session/new', {
      cwd: config.workspace,
      mcpServers: [],
      ...(config.modelId ? { model: config.modelId } : {}),
    })) as { sessionId?: unknown }
    const sessionId = typeof res?.sessionId === 'string' ? res.sessionId.trim() : ''
    if (!sessionId) {
      throw new Error('Kimi ACP session/new did not return a valid sessionId')
    }
    this.sessions.set(sessionId, {
      sessionId,
      config,
      activeRunId: null,
      lastRunId: null,
    })
    return { id: sessionId, externalId: sessionId, runtimeId: this.id }
  }

  async resumeSession(externalId: string, config?: SessionConfig): Promise<Session> {
    if (this.quarantinedSessions.has(externalId)) {
      throw new Error(`Kimi ACP session "${externalId}" is quarantined after unconfirmed termination`)
    }
    const transport = await this.ensureInitialized()
    if (!this.negotiatedLoadSession) {
      throw new Error('Kimi ACP agent did not negotiate loadSession capability')
    }
    await transport.sendRequest('session/load', {
      sessionId: externalId,
      cwd: config?.workspace ?? '/tmp',
      mcpServers: [],
    })
    const existing = this.sessions.get(externalId)
    if (!existing && config) {
      this.sessions.set(externalId, {
        sessionId: externalId,
        config,
        activeRunId: null,
        lastRunId: null,
      })
    }
    return { id: externalId, externalId, runtimeId: this.id }
  }

  async inspectSession(externalId: string): Promise<{
    exists: boolean
    quarantined: boolean
    activeRunId: string | null
    lastRunId: string | null
  }> {
    const state = this.sessions.get(externalId)
    return {
      exists: Boolean(state),
      quarantined: this.quarantinedSessions.has(externalId),
      activeRunId: state?.activeRunId ?? null,
      lastRunId: state?.lastRunId ?? null,
    }
  }

  async *run(request: AgentRequest): AsyncIterable<AgentEvent> {
    if (request.session.runtimeId !== this.id) {
      throw new Error(`KimiAcpAdapter received mismatched runtimeId "${request.session.runtimeId}"`)
    }
    const state = this.sessions.get(request.session.externalId)
    if (!state) {
      throw new Error(`Unknown Kimi ACP session "${request.session.externalId}"`)
    }
    if (this.quarantinedSessions.has(state.sessionId)) {
      yield {
        type: 'run.failed',
        runId: request.runId,
        seq: 1,
        timestamp: new Date().toISOString(),
        code: 'KIMI_SESSION_QUARANTINED',
        message: 'Kimi ACP session is quarantined after unconfirmed termination; no replay allowed',
      }
      return
    }
    if (!this.isExecutionAuthorized()) {
      yield {
        type: 'run.failed',
        runId: request.runId,
        seq: 1,
        timestamp: new Date().toISOString(),
        code: 'KIMI_EXECUTION_GATED',
        message: 'Kimi ACP execution is gated until runtime containment and explicit opt-in are verified',
      }
      return
    }
    if (state.activeRunId) {
      yield {
        type: 'run.failed',
        runId: request.runId,
        seq: 1,
        timestamp: new Date().toISOString(),
        code: 'KIMI_SESSION_BUSY',
        message: `Session "${state.sessionId}" already has an active prompt "${state.activeRunId}"`,
      }
      return
    }

    const transport = await this.ensureInitialized()
    state.activeRunId = request.runId
    state.lastRunId = request.runId

    const queue: AgentEvent[] = []
    let wakeQueue: (() => void) | null = null
    let finished = false
    let seq = 0
    let streamBytes = 0
    const seenToolCalls = new Set<string>()
    const seenApprovals = new Set<string>()

    const pushEvent = (payload: EventPayload) => {
      seq += 1
      queue.push({
        ...payload,
        runId: request.runId,
        seq,
        timestamp: new Date().toISOString(),
      })
      wakeQueue?.()
      wakeQueue = null
    }

    const offNotif = transport.onNotification((method, params) => {
      if (finished || method !== 'session/update') return
      if (params.sessionId !== state.sessionId) return
      const update =
        params.update && typeof params.update === 'object'
          ? (params.update as Record<string, unknown>)
          : {}
      const kind = String(update.sessionUpdate ?? '')
      if (kind === 'agent_thought_chunk') {
        // Never emit or persist private agent reasoning.
        return
      }
      if (kind === 'agent_message_chunk') {
        const content =
          update.content && typeof update.content === 'object'
            ? (update.content as Record<string, unknown>)
            : {}
        const text = typeof content.text === 'string' ? content.text : ''
        if (text) {
          streamBytes += Buffer.byteLength(text, 'utf8')
          if (streamBytes > KIMI_ACP_MAX_STREAM_BYTES) {
            finished = true
            pushEvent({
              type: 'run.failed',
              code: 'KIMI_STREAM_TOO_LARGE',
              message: `Kimi ACP stream exceeded ${KIMI_ACP_MAX_STREAM_BYTES} bytes limit`,
            })
            return
          }
          pushEvent({ type: 'message.delta', text })
        }
      } else if (kind === 'tool_call' || kind === 'tool_call_update') {
        const callId = String(update.toolCallId ?? '')
        if (!callId) return
        const dedupKey = `${kind}:${callId}:${String(update.status ?? '')}`
        if (seenToolCalls.has(dedupKey)) return
        seenToolCalls.add(dedupKey)
        const tool = String(update.title ?? update.kind ?? 'tool')
        if (kind === 'tool_call' || update.status === 'in_progress') {
          pushEvent({ type: 'tool.started', tool, callId, summary: tool })
        } else if (update.status === 'completed' || update.status === 'failed') {
          pushEvent({ type: 'tool.completed', tool, callId, summary: String(update.status) })
        }
      }
    })

    const offReq = transport.onAgentRequest((rpcId, method, params) => {
      if (finished || method !== 'session/request_permission') return
      if (params.sessionId !== state.sessionId) {
        transport.respondToAgentRequest(rpcId, { outcome: { outcome: 'cancelled' } })
        return
      }
      const toolCall =
        params.toolCall && typeof params.toolCall === 'object'
          ? (params.toolCall as Record<string, unknown>)
          : {}
      const toolCallId = String(toolCall.toolCallId ?? rpcId)
      if (seenApprovals.has(toolCallId)) {
        transport.respondToAgentRequest(rpcId, { outcome: { outcome: 'cancelled' } })
        return
      }
      seenApprovals.add(toolCallId)

      const rawOptions = Array.isArray(params.options) ? params.options : []
      let allowOptionId: string | null = null
      let denyOptionId: string | null = null
      for (const opt of rawOptions) {
        if (!opt || typeof opt !== 'object') continue
        const o = opt as Record<string, unknown>
        const optKind = String(o.kind ?? '')
        // Explicitly reject allow_always options
        if (optKind === 'allow_always') continue
        if (optKind === 'allow_once' && !allowOptionId) allowOptionId = String(o.optionId ?? 'allow')
        if ((optKind === 'reject_once' || optKind === 'reject_always') && !denyOptionId) {
          denyOptionId = String(o.optionId ?? 'deny')
        }
      }

      const approvalId = `kimi-appr-${randomUUID()}`
      const argsHash = createHash('sha256')
        .update(JSON.stringify({ sessionId: state.sessionId, toolCallId, title: toolCall.title ?? '' }))
        .digest('hex')
      const expiresAtMs = Date.now() + 60_000

      this.pendingPermissions.set(approvalId, {
        approvalId,
        runId: request.runId,
        rpcId,
        argsHash,
        expiresAtMs,
        allowOptionId,
        denyOptionId,
        resolve: (decision) => {
          this.pendingPermissions.delete(approvalId)
          if (decision === 'allow-once' && allowOptionId) {
            transport.respondToAgentRequest(rpcId, {
              outcome: { outcome: 'selected', optionId: allowOptionId },
            })
          } else if (denyOptionId) {
            transport.respondToAgentRequest(rpcId, {
              outcome: { outcome: 'selected', optionId: denyOptionId },
            })
          } else {
            transport.respondToAgentRequest(rpcId, { outcome: { outcome: 'cancelled' } })
          }
        },
      })

      pushEvent({
        type: 'approval.requested',
        approvalId,
        tool: String(toolCall.title ?? 'kimi_tool'),
        argsHash,
        summary: String(toolCall.title ?? 'Permission requested by Kimi ACP'),
        expiresAt: new Date(expiresAtMs).toISOString(),
      })
    })

    const offClose = transport.onClose((reason) => {
      if (finished) return
      finished = true
      this.quarantinedSessions.add(state.sessionId)
      pushEvent({
        type: 'run.failed',
        code: 'KIMI_UNKNOWN_TERMINATION',
        message: `Kimi ACP terminated unexpectedly (${reason}); session quarantined`,
      })
    })

    const promptPromise = transport
      .sendRequest(
        'session/prompt',
        {
          sessionId: state.sessionId,
          prompt: [{ type: 'text', text: request.text }],
        },
        this.maxDurationMs,
      )
      .then((res) => {
        if (finished) return
        finished = true
        const rec = res && typeof res === 'object' ? (res as Record<string, unknown>) : {}
        if (rec.stopReason === 'cancelled' || this.cancelledRuns.has(request.runId)) {
          pushEvent({ type: 'run.cancelled' })
        } else {
          if (rec.usage && typeof rec.usage === 'object') {
            const u = rec.usage as Record<string, unknown>
            pushEvent({
              type: 'usage.updated',
              usage: {
                source: 'provider',
                observedAt: new Date().toISOString(),
                windows: [],
                ...(typeof u.inputTokens === 'number' ? { inputTokens: u.inputTokens } : {}),
                ...(typeof u.outputTokens === 'number' ? { outputTokens: u.outputTokens } : {}),
              },
            })
          }
          pushEvent({ type: 'run.completed' })
        }
      })
      .catch((err) => {
        if (finished) return
        finished = true
        if (this.cancelledRuns.has(request.runId)) {
          pushEvent({ type: 'run.cancelled' })
          return
        }
        this.quarantinedSessions.add(state.sessionId)
        pushEvent({
          type: 'run.failed',
          code: 'KIMI_PROMPT_ERROR',
          message: err instanceof Error ? redactKimiSecrets(err.message) : 'Kimi ACP prompt failed',
        })
      })

    try {
      while (!finished || queue.length > 0) {
        if (queue.length > 0) {
          yield queue.shift()!
          continue
        }
        await new Promise<void>((resolve) => {
          wakeQueue = resolve
        })
      }
      await promptPromise
    } finally {
      offNotif()
      offReq()
      offClose()
      for (const [id, p] of this.pendingPermissions.entries()) {
        if (p.runId === request.runId) {
          p.resolve('deny')
          this.pendingPermissions.delete(id)
        }
      }
      state.activeRunId = null
    }
  }

  async resolveApproval(decision: ApprovalDecision): Promise<void> {
    const pending = this.pendingPermissions.get(decision.approvalId)
    if (!pending) {
      throw new Error(`Unknown or already consumed Kimi approval "${decision.approvalId}"`)
    }
    if (pending.runId !== decision.runId || pending.argsHash !== decision.argsHash) {
      throw new Error('Kimi approval correlation mismatch (runId or argsHash)')
    }
    if (Date.now() >= pending.expiresAtMs) {
      pending.resolve('deny')
      throw new Error('Kimi approval expired')
    }
    pending.resolve(decision.decision)
  }

  async cancel(runId: string): Promise<void> {
    this.cancelledRuns.add(runId)
    for (const [id, p] of this.pendingPermissions.entries()) {
      if (p.runId === runId) {
        p.resolve('deny')
        this.pendingPermissions.delete(id)
      }
    }
    for (const sess of this.sessions.values()) {
      if (sess.activeRunId === runId && this.transport) {
        this.transport.sendNotification('session/cancel', { sessionId: sess.sessionId })
      }
    }
  }
}
