import { randomUUID } from 'node:crypto'
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

export const OPENAI_COMPAT_MAX_HISTORY_MESSAGES = 24
export const OPENAI_COMPAT_MAX_HISTORY_BYTES = 48 * 1024
export const OPENAI_COMPAT_MAX_OUTPUT_TOKENS = 4096
export const OPENAI_COMPAT_MAX_OUTPUT_TOKENS_CEILING = 8192
export const OPENAI_COMPAT_MAX_CONCURRENT_RUNS = 1
export const OPENAI_COMPAT_MAX_DURATION_MS = 120_000
export const OPENAI_COMPAT_IDLE_STREAM_MS = 30_000
export const OPENAI_COMPAT_MAX_STREAM_BYTES = 2 * 1024 * 1024
export const OPENAI_COMPAT_MAX_METADATA_BYTES = 256 * 1024

const SECRET_PATTERN =
  /(sk-or-v1-[a-z0-9_-]{8,}|sk-[a-z0-9_-]{8,}|bearer\s+[a-z0-9._-]+|x-api-key:\s*[^\s]+|token=[a-z0-9._-]+)/gi

export function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

export function redactOpenAiCompatSecrets(text: string): string {
  return text.replace(SECRET_PATTERN, '[REDACTED]')
}

export function assertLoopbackOpenAiCompatBaseUrl(rawUrl: string, expectedPath = '/v1'): string {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error(`Invalid local OpenAI-compatible URL: "${rawUrl}"`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Local endpoint must use http:// or https://, got "${parsed.protocol}"`)
  }
  if (parsed.username || parsed.password) {
    throw new Error('Local endpoint URL must not embed credentials')
  }
  if (parsed.search || parsed.hash) {
    throw new Error('Local endpoint URL must not contain query parameters or fragments')
  }
  const host = parsed.hostname.toLowerCase()
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '[::1]') {
    throw new Error(`Local endpoint must target literal loopback only; refused "${parsed.hostname}"`)
  }
  if (parsed.port) {
    const portNum = Number(parsed.port)
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      throw new Error(`Invalid loopback port "${parsed.port}"`)
    }
  }
  const cleanPath = parsed.pathname.replace(/\/$/, '') || ''
  if (cleanPath !== expectedPath) {
    throw new Error(`Local endpoint path must be "${expectedPath}", got "${parsed.pathname}"`)
  }
  return `${parsed.protocol}//${parsed.host}${expectedPath}`
}

export async function readBoundedResponseText(
  res: Response,
  maxBytes: number,
  label: string,
): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let totalBytes = 0
  let out = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new Error(`${label} response exceeded ${maxBytes} bytes limit`)
      }
      out += decoder.decode(value, { stream: true })
    }
    out += decoder.decode()
    return out
  } finally {
    reader.releaseLock()
  }
}

export function assertPinnedHttpsOriginUrl(
  rawUrl: string,
  expectedOrigin: string,
  allowedExactPaths: string[],
): string {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error(`Invalid provider URL: "${rawUrl}"`)
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Cloud provider URL must use https:, got "${parsed.protocol}"`)
  }
  if (parsed.username || parsed.password) {
    throw new Error('Provider URL must not embed credentials')
  }
  if (parsed.search || parsed.hash) {
    throw new Error('Provider URL must not contain unexpected query parameters or fragments')
  }
  if (parsed.origin !== expectedOrigin) {
    throw new Error(
      `Provider URL must target pinned origin "${expectedOrigin}"; refused "${parsed.origin}"`,
    )
  }
  if (!allowedExactPaths.includes(parsed.pathname)) {
    throw new Error(
      `Provider URL path "${parsed.pathname}" is not in allowlisted paths (${allowedExactPaths.join(', ')})`,
    )
  }
  return parsed.toString()
}

export function assertValidOpenAiCompatModelId(modelId: string): string {
  const trimmed = modelId.trim()
  if (!trimmed || trimmed.length > 160 || /\s/.test(trimmed) || hasControlChar(trimmed)) {
    throw new Error(`Invalid model identity: "${modelId}"`)
  }
  return trimmed
}

export type OpenAiCompatHttpTransport = (url: string, init: RequestInit) => Promise<Response>

export interface OpenAiCompatRuntimeConfig {
  id: string
  label: string
  kind: 'local' | 'cloud'
  baseUrl: string
  validateEndpoint: (url: string) => string
  requiresApiKey: boolean
  resolveApiKey?: () => string | null
  isExecutionAuthorized?: () => boolean
  getCredentialGeneration?: () => number
  getAccountRef?: () => string
  transport?: OpenAiCompatHttpTransport
  timeoutMs?: number
  idleTimeoutMs?: number
  maxConcurrentRuns?: number
  maxOutputTokens?: number
  maxDurationMs?: number
  extraBodyFields?: Record<string, unknown>
  extraHeaders?: Record<string, string>
}

interface CompatSessionState {
  config: SessionConfig
  endpoint: string
  configGeneration: number
  credentialGeneration: number
  accountRef: string
  history: Array<{ role: 'user' | 'assistant'; content: string }>
  lastRunId: string | null
}

export class OpenAiCompatibleRuntimeBase implements AgentRuntime {
  readonly id: string
  protected readonly label: string
  protected readonly kind: 'local' | 'cloud'
  protected baseUrl: string
  protected readonly validateEndpoint: (url: string) => string
  protected readonly requiresApiKey: boolean
  protected readonly resolveApiKey: () => string | null
  protected readonly isExecutionAuthorized: () => boolean
  protected readonly getCredentialGeneration: () => number
  protected readonly getAccountRef: () => string
  protected readonly transport: OpenAiCompatHttpTransport
  protected readonly timeoutMs: number
  protected readonly idleTimeoutMs: number
  protected readonly maxConcurrentRuns: number
  protected readonly maxOutputTokens: number
  protected readonly maxDurationMs: number
  protected readonly extraBodyFields: Record<string, unknown>
  protected readonly extraHeaders: Record<string, string>
  protected readonly sessions = new Map<string, CompatSessionState>()
  protected readonly activeControllers = new Map<string, AbortController>()
  protected readonly cancelledRuns = new Set<string>()
  protected readonly uncertainRuns = new Set<string>()
  protected configGeneration = 0

  constructor(cfg: OpenAiCompatRuntimeConfig) {
    this.id = cfg.id
    this.label = cfg.label
    this.kind = cfg.kind
    this.validateEndpoint = cfg.validateEndpoint
    this.baseUrl = cfg.validateEndpoint(cfg.baseUrl)
    this.requiresApiKey = cfg.requiresApiKey
    this.resolveApiKey = cfg.resolveApiKey ?? (() => null)
    this.isExecutionAuthorized = cfg.isExecutionAuthorized ?? (() => false)
    this.getCredentialGeneration = cfg.getCredentialGeneration ?? (() => 0)
    this.getAccountRef = cfg.getAccountRef ?? (() => 'default')
    this.transport = cfg.transport ?? ((url, init) => fetch(url, init))
    this.timeoutMs = Math.max(250, Math.min(cfg.timeoutMs ?? 5_000, 30_000))
    this.idleTimeoutMs = Math.max(500, Math.min(cfg.idleTimeoutMs ?? OPENAI_COMPAT_IDLE_STREAM_MS, 60_000))
    this.maxConcurrentRuns = Math.max(
      1,
      Math.min(cfg.maxConcurrentRuns ?? OPENAI_COMPAT_MAX_CONCURRENT_RUNS, 2),
    )
    this.maxOutputTokens = Math.max(
      64,
      Math.min(
        cfg.maxOutputTokens ?? OPENAI_COMPAT_MAX_OUTPUT_TOKENS,
        OPENAI_COMPAT_MAX_OUTPUT_TOKENS_CEILING,
      ),
    )
    this.maxDurationMs = Math.max(
      1_000,
      Math.min(cfg.maxDurationMs ?? OPENAI_COMPAT_MAX_DURATION_MS, 300_000),
    )
    this.extraBodyFields = cfg.extraBodyFields ?? {}
    this.extraHeaders = cfg.extraHeaders ?? {}
  }

  getBaseUrl(): string {
    return this.baseUrl
  }

  updateBaseUrl(nextUrl: string): string {
    const validated = this.validateEndpoint(nextUrl)
    if (validated !== this.baseUrl) {
      this.baseUrl = validated
      this.configGeneration += 1
      this.abortActiveRuns()
    }
    return this.baseUrl
  }

  abortActiveRuns(): void {
    for (const ctrl of this.activeControllers.values()) {
      ctrl.abort()
    }
  }

  getResourceLimits(): {
    maxConcurrentRuns: number
    maxHistoryMessages: number
    maxHistoryBytes: number
    maxOutputTokens: number
    maxDurationMs: number
    maxStreamBytes: number
  } {
    return {
      maxConcurrentRuns: this.maxConcurrentRuns,
      maxHistoryMessages: OPENAI_COMPAT_MAX_HISTORY_MESSAGES,
      maxHistoryBytes: OPENAI_COMPAT_MAX_HISTORY_BYTES,
      maxOutputTokens: this.maxOutputTokens,
      maxDurationMs: this.maxDurationMs,
      maxStreamBytes: OPENAI_COMPAT_MAX_STREAM_BYTES,
    }
  }

  async checkAvailability(): Promise<{
    available: boolean
    detail: string
    models: ModelInfo[]
  }> {
    if (this.kind === 'cloud' && !this.isExecutionAuthorized()) {
      return {
        available: false,
        detail: `${this.label} model discovery and execution are gated until explicit opt-in`,
        models: [],
      }
    }
    try {
      const models = await this.listModels({ allowNetworkDiscovery: this.kind === 'local' })
      return {
        available: true,
        detail: `${this.label} available at ${this.baseUrl} (${models.length} model(s))`,
        models,
      }
    } catch (err) {
      return {
        available: false,
        detail:
          err instanceof Error
            ? redactOpenAiCompatSecrets(err.message)
            : `${this.label} unreachable at ${this.baseUrl}`,
        models: [],
      }
    }
  }

  async authenticate(): Promise<AuthState> {
    return this.getAuthStatus()
  }

  async getAuthStatus(): Promise<AuthState> {
    if (this.requiresApiKey) {
      let hasKey = false
      try {
        const key = this.resolveApiKey()
        hasKey = typeof key === 'string' && key.trim().length > 0
      } catch (err) {
        return {
          status: 'error',
          detail:
            err instanceof Error
              ? redactOpenAiCompatSecrets(err.message)
              : 'Credential store unavailable',
        }
      }
      if (!hasKey) {
        return {
          status: 'disconnected',
          detail: `No ${this.label} API key configured in OS Secret Service`,
        }
      }
      return {
        status: 'connected',
        detail: this.isExecutionAuthorized()
          ? `${this.label} API key configured and authorized`
          : `${this.label} API key configured (execution gated until explicit opt-in)`,
      }
    }

    const avail = await this.checkAvailability()
    return avail.available
      ? { status: 'connected', detail: avail.detail }
      : { status: 'disconnected', detail: avail.detail }
  }

  async disconnect(): Promise<void> {
    for (const [runId, ctrl] of this.activeControllers.entries()) {
      this.cancelledRuns.add(runId)
      ctrl.abort()
    }
    this.activeControllers.clear()
  }

  async reconnect(): Promise<AuthState> {
    await this.disconnect()
    return this.getAuthStatus()
  }

  async listModels(_options: { allowNetworkDiscovery?: boolean } = {}): Promise<ModelInfo[]> {
    if (this.kind === 'cloud' && !this.isExecutionAuthorized()) {
      return []
    }
    const headers: Record<string, string> = { ...this.extraHeaders }
    if (this.requiresApiKey) {
      const apiKey = this.resolveApiKey()?.trim()
      if (!apiKey) return []
      headers.Authorization = `Bearer ${apiKey}`
    }
    const validatedBase = this.validateEndpoint(this.baseUrl)
    const url = `${validatedBase}/models`
    const res = await this.transport(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
      headers,
    })
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      throw new Error(`${this.label} /models attempted HTTP redirect (${res.status}), which is forbidden`)
    }
    if (!res.ok) {
      throw new Error(`${this.label} /models failed with HTTP ${res.status}`)
    }
    const raw = await readBoundedResponseText(res, OPENAI_COMPAT_MAX_METADATA_BYTES, `${this.label} /models`)
    const parsed = JSON.parse(raw) as { data?: unknown }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.data)) {
      throw new Error(`${this.label} /models returned unexpected payload`)
    }
    const out: ModelInfo[] = []
    const seen = new Set<string>()
    for (const item of parsed.data) {
      if (!item || typeof item !== 'object') continue
      const rec = item as Record<string, unknown>
      const id = typeof rec.id === 'string' ? rec.id.trim() : ''
      if (!id || seen.has(id)) continue
      seen.add(id)
      const label = typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : id
      out.push({
        id,
        label,
        efforts: [],
        permissionModes: ['read-only'],
        supportsTools: false,
        supportsAttachments: false,
      })
    }
    return out
  }

  async capabilities(): Promise<Capabilities> {
    const models = await this.listModels().catch(() => [])
    return {
      streaming: true,
      cancellation: true,
      resume: false,
      approvals: false,
      usage: true,
      sandbox: false,
      models,
    }
  }

  async getUsage(): Promise<UsageSnapshot | null> {
    // OpenAI-compatible endpoints do not expose ChatGPT/Claude subscription quota windows.
    return null
  }

  async createSession(config: SessionConfig): Promise<Session> {
    if (config.permission !== 'read-only') {
      throw new Error(
        `${this.label} initial integration supports 'read-only' tool-free chat only; rejected '${config.permission}'`,
      )
    }
    const validModelId = assertValidOpenAiCompatModelId(config.modelId)
    const id = `${this.id}-${randomUUID()}`
    this.sessions.set(id, {
      config: { ...config, modelId: validModelId },
      endpoint: this.baseUrl,
      configGeneration: this.configGeneration,
      credentialGeneration: this.getCredentialGeneration(),
      accountRef: this.getAccountRef(),
      history: [],
      lastRunId: null,
    })
    return { id, externalId: id, runtimeId: this.id }
  }

  async resumeSession(externalId: string, config?: SessionConfig): Promise<Session> {
    const existing = this.sessions.get(externalId)
    if (existing) {
      if (
        existing.endpoint !== this.baseUrl ||
        existing.configGeneration !== this.configGeneration ||
        existing.credentialGeneration !== this.getCredentialGeneration() ||
        existing.accountRef !== this.getAccountRef()
      ) {
        this.sessions.delete(externalId)
        throw new Error(`${this.label} endpoint or credential changed; session invalidated`)
      }
      return { id: externalId, externalId, runtimeId: this.id }
    }
    if (!config) {
      throw new Error(`Unknown ${this.label} session "${externalId}"`)
    }
    if (config.permission !== 'read-only') {
      throw new Error(
        `${this.label} initial integration supports 'read-only' tool-free chat only; rejected '${config.permission}'`,
      )
    }
    const validModelId = assertValidOpenAiCompatModelId(config.modelId)
    this.sessions.set(externalId, {
      config: { ...config, modelId: validModelId },
      endpoint: this.baseUrl,
      configGeneration: this.configGeneration,
      credentialGeneration: this.getCredentialGeneration(),
      accountRef: this.getAccountRef(),
      history: [],
      lastRunId: null,
    })
    return { id: externalId, externalId, runtimeId: this.id }
  }

  async inspectSession(externalId: string): Promise<{
    exists: boolean
    historyTurns: number
    lastRunId: string | null
    uncertainLastRun: boolean
    staleBinding: boolean
  }> {
    const state = this.sessions.get(externalId)
    if (!state) {
      return {
        exists: false,
        historyTurns: 0,
        lastRunId: null,
        uncertainLastRun: false,
        staleBinding: false,
      }
    }
    return {
      exists: true,
      historyTurns: state.history.length,
      lastRunId: state.lastRunId,
      uncertainLastRun: state.lastRunId ? this.uncertainRuns.has(state.lastRunId) : false,
      staleBinding:
        state.endpoint !== this.baseUrl ||
        state.configGeneration !== this.configGeneration ||
        state.credentialGeneration !== this.getCredentialGeneration() ||
        state.accountRef !== this.getAccountRef(),
    }
  }

  async *run(request: AgentRequest): AsyncIterable<AgentEvent> {
    if (request.session.runtimeId !== this.id) {
      throw new Error(`${this.label} received mismatched runtimeId "${request.session.runtimeId}"`)
    }
    const state = this.sessions.get(request.session.externalId)
    if (!state) {
      throw new Error(`Unknown ${this.label} session "${request.session.externalId}"`)
    }
    const startGen = this.getCredentialGeneration()
    const startAccountRef = this.getAccountRef()
    const startEndpoint = this.baseUrl
    const startConfigGen = this.configGeneration
    if (
      state.endpoint !== startEndpoint ||
      state.configGeneration !== startConfigGen ||
      state.credentialGeneration !== startGen ||
      state.accountRef !== startAccountRef
    ) {
      yield {
        type: 'run.failed',
        runId: request.runId,
        seq: 1,
        timestamp: new Date().toISOString(),
        code: 'OPENAI_COMPAT_BINDING_STALE',
        message: `${this.label} endpoint, account, or credential changed; re-authorize before running`,
      }
      return
    }
    if (!this.isExecutionAuthorized()) {
      yield {
        type: 'run.failed',
        runId: request.runId,
        seq: 1,
        timestamp: new Date().toISOString(),
        code: 'OPENAI_COMPAT_EXECUTION_GATED',
        message: `${this.label} execution is gated until explicit opt-in authorization`,
      }
      return
    }
    if (request.attachments && request.attachments.length > 0) {
      throw new Error(`${this.label} read-only integration does not support attachments`)
    }
    if (this.activeControllers.size >= this.maxConcurrentRuns) {
      yield {
        type: 'run.failed',
        runId: request.runId,
        seq: 1,
        timestamp: new Date().toISOString(),
        code: 'OPENAI_COMPAT_CONCURRENCY_LIMIT',
        message: `${this.label} concurrent inference limit (${this.maxConcurrentRuns}) reached`,
      }
      return
    }

    state.lastRunId = request.runId
    const ctrl = new AbortController()
    this.activeControllers.set(request.runId, ctrl)
    let seq = 0
    let assistantText = ''
    let terminalEmitted = false
    let timedOut = false
    let idleTimedOut = false
    let lastUsage: { inputTokens?: number; outputTokens?: number } | null = null
    const getLastUsage = () => lastUsage
    let finishReason: string | null = null
    let sawDoneSentinel = false

    const durationTimer = setTimeout(() => {
      timedOut = true
      ctrl.abort()
    }, this.maxDurationMs)

    const recentTurns = state.history.slice(-OPENAI_COMPAT_MAX_HISTORY_MESSAGES)
    const boundedHistory: Array<{ role: 'user' | 'assistant'; content: string }> = []
    let historyBytes = 0
    for (let i = recentTurns.length - 1; i >= 0; i -= 1) {
      const turn = recentTurns[i]
      if (!turn) continue
      const turnBytes = Buffer.byteLength(turn.content, 'utf8')
      if (historyBytes + turnBytes > OPENAI_COMPAT_MAX_HISTORY_BYTES) break
      historyBytes += turnBytes
      boundedHistory.unshift(turn)
    }
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = []
    if (state.config.instructions.trim()) {
      messages.push({ role: 'system', content: state.config.instructions.trim() })
    }
    for (const t of boundedHistory) messages.push(t)
    messages.push({ role: 'user', content: request.text })

    try {
      // Pre-request revalidation immediately before dispatch
      if (
        this.baseUrl !== startEndpoint ||
        this.getCredentialGeneration() !== startGen ||
        this.getAccountRef() !== startAccountRef
      ) {
        terminalEmitted = true
        seq += 1
        yield {
          type: 'run.failed',
          runId: request.runId,
          seq,
          timestamp: new Date().toISOString(),
          code: 'OPENAI_COMPAT_BINDING_STALE',
          message: `${this.label} binding changed before request dispatch`,
        }
        return
      }
      if (!this.isExecutionAuthorized()) {
        terminalEmitted = true
        seq += 1
        yield {
          type: 'run.failed',
          runId: request.runId,
          seq,
          timestamp: new Date().toISOString(),
          code: 'OPENAI_COMPAT_EXECUTION_GATED',
          message: `${this.label} authorization revoked before request dispatch`,
        }
        return
      }
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...this.extraHeaders,
      }
      if (this.requiresApiKey) {
        const latestKey = this.resolveApiKey()?.trim()
        if (!latestKey) {
          terminalEmitted = true
          seq += 1
          yield {
            type: 'run.failed',
            runId: request.runId,
            seq,
            timestamp: new Date().toISOString(),
            code: 'OPENAI_COMPAT_CREDENTIAL_MISSING',
            message: `${this.label} API key missing before request dispatch`,
          }
          return
        }
        headers.Authorization = `Bearer ${latestKey}`
      }

      const validatedBase = this.validateEndpoint(this.baseUrl)
      const url = `${validatedBase}/chat/completions`
      const bodyPayload: Record<string, unknown> = {
        model: state.config.modelId,
        messages,
        stream: true,
        max_tokens: this.maxOutputTokens,
        stream_options: { include_usage: true },
        ...this.extraBodyFields,
      }

      const response = await this.transport(url, {
        method: 'POST',
        redirect: 'error',
        signal: ctrl.signal,
        headers,
        body: JSON.stringify(bodyPayload),
      })

      if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
        terminalEmitted = true
        seq += 1
        yield {
          type: 'run.failed',
          runId: request.runId,
          seq,
          timestamp: new Date().toISOString(),
          code: 'OPENAI_COMPAT_REDIRECT_FORBIDDEN',
          message: `${this.label} attempted HTTP redirect (${response.status}), which is forbidden`,
        }
        return
      }

      if (!response.ok || !response.body) {
        terminalEmitted = true
        const code =
          response.status === 401 || response.status === 403
            ? 'OPENAI_COMPAT_AUTH_ERROR'
            : response.status === 429
              ? 'OPENAI_COMPAT_RATE_LIMITED'
              : 'OPENAI_COMPAT_HTTP_ERROR'
        seq += 1
        yield {
          type: 'run.failed',
          runId: request.runId,
          seq,
          timestamp: new Date().toISOString(),
          code,
          message: `${this.label} /chat/completions failed with HTTP ${response.status} (no automatic retries)`,
        }
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let totalStreamBytes = 0
      let currentDataLines: string[] = []

      const readWithAbortAndIdle = (): Promise<ReadableStreamReadResult<Uint8Array>> => {
        if (ctrl.signal.aborted) {
          return Promise.reject(new Error('Aborted'))
        }
        return new Promise((resolve, reject) => {
          const idleTimer = setTimeout(() => {
            idleTimedOut = true
            ctrl.abort()
            reject(new Error('Idle stream timeout'))
          }, this.idleTimeoutMs)
          const onAbort = () => {
            clearTimeout(idleTimer)
            reject(new Error('Aborted'))
          }
          ctrl.signal.addEventListener('abort', onAbort, { once: true })
          reader
            .read()
            .then(
              (r) => {
                clearTimeout(idleTimer)
                resolve(r)
              },
              (e) => {
                clearTimeout(idleTimer)
                reject(e)
              },
            )
            .finally(() => ctrl.signal.removeEventListener('abort', onAbort))
        })
      }

      const processFrame = (rawData: string): { events: AgentEvent[]; abort: boolean } => {
        const events: AgentEvent[] = []
        if (!rawData) return { events, abort: false }
        if (sawDoneSentinel) {
          // Ignore/suppress frames emitted after [DONE]
          return { events, abort: true }
        }
        if (rawData === '[DONE]') {
          sawDoneSentinel = true
          return { events, abort: false }
        }
        if (
          this.baseUrl !== startEndpoint ||
          this.getCredentialGeneration() !== startGen ||
          this.getAccountRef() !== startAccountRef
        ) {
          terminalEmitted = true
          seq += 1
          events.push({
            type: 'run.failed',
            runId: request.runId,
            seq,
            timestamp: new Date().toISOString(),
            code: 'OPENAI_COMPAT_BINDING_STALE',
            message: `${this.label} credential or endpoint changed during active stream`,
          })
          return { events, abort: true }
        }

        let parsed: Record<string, unknown>
        try {
          const val = JSON.parse(rawData) as unknown
          if (!val || typeof val !== 'object' || Array.isArray(val)) {
            throw new Error('Non-object SSE frame')
          }
          parsed = val as Record<string, unknown>
        } catch {
          terminalEmitted = true
          seq += 1
          events.push({
            type: 'run.failed',
            runId: request.runId,
            seq,
            timestamp: new Date().toISOString(),
            code: 'OPENAI_COMPAT_MALFORMED_SSE',
            message: `${this.label} emitted malformed SSE JSON frame`,
          })
          return { events, abort: true }
        }

        if (parsed.error && typeof parsed.error === 'object') {
          const errObj = parsed.error as Record<string, unknown>
          terminalEmitted = true
          seq += 1
          events.push({
            type: 'run.failed',
            runId: request.runId,
            seq,
            timestamp: new Date().toISOString(),
            code: 'OPENAI_COMPAT_STREAM_ERROR',
            message:
              typeof errObj.message === 'string'
                ? redactOpenAiCompatSecrets(errObj.message)
                : `${this.label} stream error`,
          })
          return { events, abort: true }
        }

        if (parsed.usage && typeof parsed.usage === 'object') {
          const u = parsed.usage as Record<string, unknown>
          const inputTokens =
            typeof u.prompt_tokens === 'number' && Number.isFinite(u.prompt_tokens)
              ? u.prompt_tokens
              : undefined
          const outputTokens =
            typeof u.completion_tokens === 'number' && Number.isFinite(u.completion_tokens)
              ? u.completion_tokens
              : undefined
          if (inputTokens !== undefined || outputTokens !== undefined) {
            lastUsage = {
              ...(inputTokens !== undefined ? { inputTokens } : {}),
              ...(outputTokens !== undefined ? { outputTokens } : {}),
            }
          }
        }

        const choices = Array.isArray(parsed.choices) ? parsed.choices : []
        if (choices.length > 0 && choices[0] && typeof choices[0] === 'object') {
          const c = choices[0] as Record<string, unknown>
          if (typeof c.finish_reason === 'string' && c.finish_reason) {
            finishReason = c.finish_reason
          }
          const delta =
            c.delta && typeof c.delta === 'object' ? (c.delta as Record<string, unknown>) : {}
          if (
            (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) ||
            delta.function_call !== undefined
          ) {
            terminalEmitted = true
            seq += 1
            events.push({
              type: 'run.failed',
              runId: request.runId,
              seq,
              timestamp: new Date().toISOString(),
              code: 'OPENAI_COMPAT_TOOLS_UNSUPPORTED',
              message: `${this.label} emitted tool_calls/function_call in read-only tool-free mode`,
            })
            return { events, abort: true }
          }
          // Suppress private reasoning fields (`reasoning`, `reasoning_content`, `thinking`)
          if (typeof delta.content === 'string' && delta.content) {
            assistantText += delta.content
            seq += 1
            events.push({
              type: 'message.delta',
              runId: request.runId,
              seq,
              timestamp: new Date().toISOString(),
              text: delta.content,
            })
          }
        }

        return { events, abort: false }
      }

      while (true) {
        const { done, value } = await readWithAbortAndIdle()
        if (done) break
        totalStreamBytes += value.byteLength
        if (totalStreamBytes > OPENAI_COMPAT_MAX_STREAM_BYTES) {
          ctrl.abort()
          terminalEmitted = true
          seq += 1
          yield {
            type: 'run.failed',
            runId: request.runId,
            seq,
            timestamp: new Date().toISOString(),
            code: 'OPENAI_COMPAT_RESPONSE_TOO_LARGE',
            message: `${this.label} stream exceeded ${OPENAI_COMPAT_MAX_STREAM_BYTES} bytes limit`,
          }
          return
        }
        buffer += decoder.decode(value, { stream: true })
        let nlIdx = buffer.indexOf('\n')
        while (nlIdx !== -1) {
          const line = buffer.slice(0, nlIdx).replace(/\r$/, '')
          buffer = buffer.slice(nlIdx + 1)
          nlIdx = buffer.indexOf('\n')
          if (terminalEmitted) continue

          if (line === '') {
            if (currentDataLines.length > 0) {
              const rawData = currentDataLines.join('\n')
              currentDataLines = []
              const res = processFrame(rawData)
              for (const ev of res.events) yield ev
              if (res.abort) {
                ctrl.abort()
                return
              }
            }
            continue
          }
          if (line.startsWith(':')) continue
          if (line.startsWith('data:')) {
            currentDataLines.push(line.slice(5).trimStart())
          }
        }
      }

      if (!terminalEmitted && currentDataLines.length > 0) {
        const res = processFrame(currentDataLines.join('\n'))
        for (const ev of res.events) yield ev
        if (res.abort) return
      }

      if (!terminalEmitted) {
        const finalUsage = getLastUsage()
        if (finalUsage) {
          seq += 1
          yield {
            type: 'usage.updated',
            runId: request.runId,
            seq,
            timestamp: new Date().toISOString(),
            usage: {
              source: this.kind === 'local' ? 'local' : 'provider',
              observedAt: new Date().toISOString(),
              windows: [],
              ...(finalUsage.inputTokens !== undefined ? { inputTokens: finalUsage.inputTokens } : {}),
              ...(finalUsage.outputTokens !== undefined ? { outputTokens: finalUsage.outputTokens } : {}),
            },
          }
        }

        if (finishReason === 'length') {
          this.uncertainRuns.add(request.runId)
          seq += 1
          yield {
            type: 'run.failed',
            runId: request.runId,
            seq,
            timestamp: new Date().toISOString(),
            code: 'OPENAI_COMPAT_MAX_TOKENS',
            message: `${this.label} reached max_tokens (${this.maxOutputTokens}) before natural completion`,
          }
          return
        }
        if (finishReason === 'content_filter') {
          seq += 1
          yield {
            type: 'run.failed',
            runId: request.runId,
            seq,
            timestamp: new Date().toISOString(),
            code: 'OPENAI_COMPAT_CONTENT_FILTERED',
            message: `${this.label} stopped generation due to content_filter`,
          }
          return
        }
        if (finishReason !== null && finishReason !== 'stop') {
          this.uncertainRuns.add(request.runId)
          seq += 1
          yield {
            type: 'run.failed',
            runId: request.runId,
            seq,
            timestamp: new Date().toISOString(),
            code: 'OPENAI_COMPAT_UNEXPECTED_FINISH_REASON',
            message: `${this.label} ended with unexpected finish_reason "${finishReason}"`,
          }
          return
        }
        if ((sawDoneSentinel || finishReason === 'stop') && assistantText.length > 0) {
          state.history.push({ role: 'user', content: request.text })
          state.history.push({ role: 'assistant', content: assistantText })
          if (state.history.length > OPENAI_COMPAT_MAX_HISTORY_MESSAGES) {
            state.history.splice(0, state.history.length - OPENAI_COMPAT_MAX_HISTORY_MESSAGES)
          }
          seq += 1
          yield {
            type: 'run.completed',
            runId: request.runId,
            seq,
            timestamp: new Date().toISOString(),
          }
          return
        }

        this.uncertainRuns.add(request.runId)
        seq += 1
        yield {
          type: 'run.failed',
          runId: request.runId,
          seq,
          timestamp: new Date().toISOString(),
          code: 'OPENAI_COMPAT_UNKNOWN_TERMINATION',
          message: `${this.label} stream ended without terminal [DONE]/stop confirmation`,
        }
      }
    } catch (err) {
      if (terminalEmitted) return
      if (timedOut || idleTimedOut) {
        this.uncertainRuns.add(request.runId)
        seq += 1
        yield {
          type: 'run.failed',
          runId: request.runId,
          seq,
          timestamp: new Date().toISOString(),
          code: idleTimedOut ? 'OPENAI_COMPAT_IDLE_TIMEOUT' : 'OPENAI_COMPAT_TIMEOUT',
          message: `${this.label} stream timed out`,
        }
        return
      }
      if (ctrl.signal.aborted || this.cancelledRuns.has(request.runId)) {
        seq += 1
        yield {
          type: 'run.cancelled',
          runId: request.runId,
          seq,
          timestamp: new Date().toISOString(),
        }
        return
      }
      this.uncertainRuns.add(request.runId)
      const errCause =
        err && typeof err === 'object' && 'cause' in err && err.cause instanceof Error
          ? ` ${err.cause.message}`
          : ''
      const rawErrMsg =
        err instanceof Error ? `${err.message}${errCause}` : `${this.label} stream error`
      const isRedirectErr = /redirect/i.test(rawErrMsg)
      seq += 1
      yield {
        type: 'run.failed',
        runId: request.runId,
        seq,
        timestamp: new Date().toISOString(),
        code: isRedirectErr ? 'OPENAI_COMPAT_REDIRECT_FORBIDDEN' : 'OPENAI_COMPAT_STREAM_ERROR',
        message: redactOpenAiCompatSecrets(rawErrMsg),
      }
    } finally {
      clearTimeout(durationTimer)
      this.activeControllers.delete(request.runId)
    }
  }

  async resolveApproval(_decision: ApprovalDecision): Promise<void> {
    throw new Error(`${this.label} read-only integration does not support tool approvals.`)
  }

  async cancel(runId: string): Promise<void> {
    this.cancelledRuns.add(runId)
    const ctrl = this.activeControllers.get(runId)
    if (ctrl) {
      ctrl.abort()
    }
  }
}
