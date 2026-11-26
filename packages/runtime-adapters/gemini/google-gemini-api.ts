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

export const APPROVED_GEMINI_ORIGIN = 'https://generativelanguage.googleapis.com'
export const GEMINI_API_VERSION = 'v1beta'
export const GEMINI_MAX_HISTORY_MESSAGES = 24
export const GEMINI_MAX_HISTORY_BYTES = 48 * 1024
export const GEMINI_MAX_OUTPUT_TOKENS = 4096
export const GEMINI_MAX_OUTPUT_TOKENS_CEILING = 8192
export const GEMINI_MAX_CONCURRENT_RUNS = 1
export const GEMINI_MAX_DURATION_MS = 120_000
export const GEMINI_MAX_STREAM_BYTES = 2 * 1024 * 1024
export const GEMINI_MAX_METADATA_BYTES = 256 * 1024

const GEMINI_SECRET_PATTERN =
  /(AIza[0-9A-Za-z_-]{16,}|x-goog-api-key:\s*[^\s]+|[?&]key=[^&\s]+|bearer\s+[a-z0-9._-]+)/gi

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

export function redactGeminiSecrets(text: string): string {
  return text.replace(GEMINI_SECRET_PATTERN, '[REDACTED]')
}

export function assertApprovedGeminiUrl(rawUrl: string): string {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error(`Invalid Gemini API URL: "${rawUrl}"`)
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Gemini API URL must use https:, got "${parsed.protocol}"`)
  }
  if (parsed.username || parsed.password) {
    throw new Error('Gemini API URL must not embed credentials')
  }
  if (
    parsed.hostname.toLowerCase() !== 'generativelanguage.googleapis.com' ||
    parsed.port !== ''
  ) {
    throw new Error(
      `Gemini API URL must target official https://generativelanguage.googleapis.com only; refused "${parsed.host}"`,
    )
  }
  if (parsed.searchParams.has('key')) {
    throw new Error('Gemini API key must be passed via x-goog-api-key header, never URL query params')
  }
  return parsed.toString()
}

export function assertValidGeminiModelId(modelId: string): string {
  const trimmed = modelId.trim().replace(/^models\//, '')
  if (
    !trimmed ||
    trimmed.length > 128 ||
    /\s/.test(trimmed) ||
    trimmed.includes('..') ||
    trimmed.includes('/') ||
    trimmed.includes('?') ||
    trimmed.includes('#') ||
    hasControlChar(trimmed)
  ) {
    throw new Error(`Invalid Google Gemini model identity: "${modelId}"`)
  }
  return trimmed
}

export type GeminiHttpTransport = (url: string, init: RequestInit) => Promise<Response>

export interface GoogleGeminiApiAdapterOptions {
  resolveApiKey?: () => string | null
  isExecutionAuthorized?: () => boolean
  getCredentialGeneration?: () => number
  getAccountRef?: () => string
  transport?: GeminiHttpTransport
  timeoutMs?: number
  maxConcurrentRuns?: number
  maxOutputTokens?: number
  maxDurationMs?: number
}

interface GeminiSessionState {
  config: SessionConfig
  credentialGeneration: number
  accountRef: string
  /**
   * Gemini `generateContent` / `streamGenerateContent` is stateless per HTTP request.
   * Ghost Bot maintains a bounded local turn window (`user` / `model`) without tools.
   */
  history: Array<{ role: 'user' | 'model'; text: string }>
  lastRunId: string | null
}

export class GoogleGeminiApiAdapter implements AgentRuntime {
  readonly id = 'gemini-api'
  private readonly endpointOrigin = APPROVED_GEMINI_ORIGIN
  private readonly resolveApiKey: () => string | null
  private readonly isExecutionAuthorized: () => boolean
  private readonly getCredentialGeneration: () => number
  private readonly getAccountRef: () => string
  private readonly transport: GeminiHttpTransport
  private readonly timeoutMs: number
  private readonly maxConcurrentRuns: number
  private readonly maxOutputTokens: number
  private readonly maxDurationMs: number
  private readonly sessions = new Map<string, GeminiSessionState>()
  private readonly activeControllers = new Map<string, AbortController>()
  private readonly cancelledRuns = new Set<string>()
  private readonly uncertainRuns = new Set<string>()

  constructor(options: GoogleGeminiApiAdapterOptions = {}) {
    this.resolveApiKey = options.resolveApiKey ?? (() => null)
    this.isExecutionAuthorized = options.isExecutionAuthorized ?? (() => false)
    this.getCredentialGeneration = options.getCredentialGeneration ?? (() => 0)
    this.getAccountRef = options.getAccountRef ?? (() => 'default')
    this.transport = options.transport ?? ((url, init) => fetch(url, init))
    this.timeoutMs = Math.max(500, Math.min(options.timeoutMs ?? 10_000, 30_000))
    this.maxConcurrentRuns = Math.max(
      1,
      Math.min(options.maxConcurrentRuns ?? GEMINI_MAX_CONCURRENT_RUNS, 2),
    )
    this.maxOutputTokens = Math.max(
      64,
      Math.min(options.maxOutputTokens ?? GEMINI_MAX_OUTPUT_TOKENS, GEMINI_MAX_OUTPUT_TOKENS_CEILING),
    )
    this.maxDurationMs = Math.max(
      1_000,
      Math.min(options.maxDurationMs ?? GEMINI_MAX_DURATION_MS, 300_000),
    )
  }

  getEndpointOrigin(): string {
    return this.endpointOrigin
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
      maxHistoryMessages: GEMINI_MAX_HISTORY_MESSAGES,
      maxHistoryBytes: GEMINI_MAX_HISTORY_BYTES,
      maxOutputTokens: this.maxOutputTokens,
      maxDurationMs: this.maxDurationMs,
      maxStreamBytes: GEMINI_MAX_STREAM_BYTES,
    }
  }

  async authenticate(): Promise<AuthState> {
    return this.getAuthStatus()
  }

  async getAuthStatus(): Promise<AuthState> {
    let hasKey = false
    try {
      const key = this.resolveApiKey()
      hasKey = typeof key === 'string' && key.trim().length > 0
    } catch (err) {
      return {
        status: 'error',
        detail:
          err instanceof Error
            ? redactGeminiSecrets(err.message)
            : 'Credential store unavailable',
      }
    }
    if (!hasKey) {
      return {
        status: 'disconnected',
        detail: 'No Gemini API key configured in OS Secret Service',
      }
    }
    if (!this.isExecutionAuthorized()) {
      return {
        status: 'connected',
        detail: 'Gemini API key configured (execution gated until explicit API opt-in)',
      }
    }
    return {
      status: 'connected',
      detail: 'Gemini API key configured and authorized for bounded read-only chat',
    }
  }

  async disconnect(): Promise<void> {
    for (const [runId, ctrl] of this.activeControllers.entries()) {
      this.cancelledRuns.add(runId)
      ctrl.abort()
    }
    this.activeControllers.clear()
  }

  abortActiveRuns(): void {
    for (const ctrl of this.activeControllers.values()) {
      ctrl.abort()
    }
  }

  async reconnect(): Promise<AuthState> {
    await this.disconnect()
    return this.getAuthStatus()
  }

  async listModels(options: { allowNetworkDiscovery?: boolean } = {}): Promise<ModelInfo[]> {
    if (!options.allowNetworkDiscovery && !this.isExecutionAuthorized()) {
      return []
    }
    const apiKey = this.resolveApiKey()?.trim()
    if (!apiKey) {
      return []
    }

    const out: ModelInfo[] = []
    const seen = new Set<string>()
    let pageToken: string | null = null
    let pages = 0

    while (pages < 5) {
      pages += 1
      const urlObj = new URL(`${this.endpointOrigin}/${GEMINI_API_VERSION}/models`)
      urlObj.searchParams.set('pageSize', '50')
      if (pageToken) {
        urlObj.searchParams.set('pageToken', pageToken)
      }
      const url = assertApprovedGeminiUrl(urlObj.toString())
      const res = await this.transport(url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          'x-goog-api-key': apiKey,
        },
      })
      if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
        throw new Error(`Gemini /v1beta/models attempted HTTP redirect (${res.status}), which is forbidden`)
      }
      if (!res.ok) {
        throw new Error(`Gemini /v1beta/models failed with HTTP ${res.status}`)
      }
      const raw = await res.text()
      if (Buffer.byteLength(raw, 'utf8') > GEMINI_MAX_METADATA_BYTES) {
        throw new Error(`Gemini /v1beta/models response exceeded ${GEMINI_MAX_METADATA_BYTES} bytes limit`)
      }
      const parsed = JSON.parse(raw) as { models?: unknown; nextPageToken?: unknown }
      const items = Array.isArray(parsed?.models) ? parsed.models : []
      for (const item of items) {
        if (!item || typeof item !== 'object') continue
        const rec = item as Record<string, unknown>
        const rawName = typeof rec.name === 'string' ? rec.name.trim() : ''
        const methods = Array.isArray(rec.supportedGenerationMethods)
          ? rec.supportedGenerationMethods.filter((m): m is string => typeof m === 'string')
          : []
        if (!rawName || !methods.includes('generateContent')) continue
        const id = rawName.replace(/^models\//, '')
        if (!id || seen.has(id)) continue
        seen.add(id)
        const label =
          typeof rec.displayName === 'string' && rec.displayName.trim()
            ? rec.displayName.trim()
            : id
        out.push({
          id,
          label,
          efforts: [],
          permissionModes: ['read-only'],
          supportsTools: false,
          supportsAttachments: false,
        })
      }
      if (typeof parsed?.nextPageToken === 'string' && parsed.nextPageToken.trim()) {
        pageToken = parsed.nextPageToken.trim()
      } else {
        break
      }
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
    // Gemini API usage does not expose subscription quota windows.
    return null
  }

  async createSession(config: SessionConfig): Promise<Session> {
    if (config.permission !== 'read-only') {
      throw new Error(
        `Google Gemini API initial integration supports 'read-only' tool-free chat only; rejected '${config.permission}'`,
      )
    }
    const validModelId = assertValidGeminiModelId(config.modelId)
    const id = `gemini-${randomUUID()}`
    this.sessions.set(id, {
      config: { ...config, modelId: validModelId },
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
        existing.credentialGeneration !== this.getCredentialGeneration() ||
        existing.accountRef !== this.getAccountRef()
      ) {
        this.sessions.delete(externalId)
        throw new Error('Gemini credential or account changed; session authorization invalidated')
      }
      return { id: externalId, externalId, runtimeId: this.id }
    }
    if (!config) {
      throw new Error(`Unknown Google Gemini session "${externalId}"`)
    }
    if (config.permission !== 'read-only') {
      throw new Error(
        `Google Gemini API initial integration supports 'read-only' tool-free chat only; rejected '${config.permission}'`,
      )
    }
    const validModelId = assertValidGeminiModelId(config.modelId)
    this.sessions.set(externalId, {
      config: { ...config, modelId: validModelId },
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
    credentialStale: boolean
  }> {
    const state = this.sessions.get(externalId)
    if (!state) {
      return {
        exists: false,
        historyTurns: 0,
        lastRunId: null,
        uncertainLastRun: false,
        credentialStale: false,
      }
    }
    return {
      exists: true,
      historyTurns: state.history.length,
      lastRunId: state.lastRunId,
      uncertainLastRun: state.lastRunId ? this.uncertainRuns.has(state.lastRunId) : false,
      credentialStale:
        state.credentialGeneration !== this.getCredentialGeneration() ||
        state.accountRef !== this.getAccountRef(),
    }
  }

  async *run(request: AgentRequest): AsyncIterable<AgentEvent> {
    if (request.session.runtimeId !== this.id) {
      throw new Error(
        `GoogleGeminiApiAdapter received mismatched runtimeId "${request.session.runtimeId}"`,
      )
    }
    const state = this.sessions.get(request.session.externalId)
    if (!state) {
      throw new Error(`Unknown Google Gemini session "${request.session.externalId}"`)
    }
    const startGeneration = this.getCredentialGeneration()
    const startAccountRef = this.getAccountRef()
    if (state.credentialGeneration !== startGeneration || state.accountRef !== startAccountRef) {
      yield {
        type: 'run.failed',
        runId: request.runId,
        seq: 1,
        timestamp: new Date().toISOString(),
        code: 'GEMINI_CREDENTIAL_ROTATED',
        message: 'Gemini API credential or account changed; re-authorize before running',
      }
      return
    }
    if (!this.isExecutionAuthorized()) {
      yield {
        type: 'run.failed',
        runId: request.runId,
        seq: 1,
        timestamp: new Date().toISOString(),
        code: 'GEMINI_EXECUTION_GATED',
        message: 'Google Gemini API execution requires explicit API usage authorization',
      }
      return
    }
    if (request.attachments && request.attachments.length > 0) {
      throw new Error('Google Gemini API read-only integration does not support attachments')
    }

    let apiKey: string | null = null
    try {
      apiKey = this.resolveApiKey()
    } catch (err) {
      yield {
        type: 'run.failed',
        runId: request.runId,
        seq: 1,
        timestamp: new Date().toISOString(),
        code: 'GEMINI_CREDENTIAL_UNAVAILABLE',
        message:
          err instanceof Error
            ? redactGeminiSecrets(err.message)
            : 'Gemini API key unavailable',
      }
      return
    }
    if (!apiKey || !apiKey.trim()) {
      yield {
        type: 'run.failed',
        runId: request.runId,
        seq: 1,
        timestamp: new Date().toISOString(),
        code: 'GEMINI_CREDENTIAL_MISSING',
        message: 'Gemini API key is not configured in OS Secret Service',
      }
      return
    }
    if (this.activeControllers.size >= this.maxConcurrentRuns) {
      yield {
        type: 'run.failed',
        runId: request.runId,
        seq: 1,
        timestamp: new Date().toISOString(),
        code: 'GEMINI_CONCURRENCY_LIMIT',
        message: `Gemini concurrent inference limit (${this.maxConcurrentRuns}) reached`,
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
    let lastUsage: { inputTokens?: number; outputTokens?: number } | null = null
    let lastFinishReason: string | null = null

    const durationTimer = setTimeout(() => {
      timedOut = true
      ctrl.abort()
    }, this.maxDurationMs)

    const recentTurns = state.history.slice(-GEMINI_MAX_HISTORY_MESSAGES)
    const boundedHistory: Array<{ role: 'user' | 'model'; text: string }> = []
    let historyBytes = 0
    for (let i = recentTurns.length - 1; i >= 0; i -= 1) {
      const turn = recentTurns[i]
      if (!turn) continue
      const turnBytes = Buffer.byteLength(turn.text, 'utf8')
      if (historyBytes + turnBytes > GEMINI_MAX_HISTORY_BYTES) break
      historyBytes += turnBytes
      boundedHistory.unshift(turn)
    }

    const contents = [
      ...boundedHistory.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
      { role: 'user' as const, parts: [{ text: request.text }] },
    ]

    try {
      const url = assertApprovedGeminiUrl(
        `${this.endpointOrigin}/${GEMINI_API_VERSION}/models/${state.config.modelId}:streamGenerateContent?alt=sse`,
      )
      const bodyPayload: Record<string, unknown> = {
        contents,
        generationConfig: {
          maxOutputTokens: this.maxOutputTokens,
        },
      }
      if (state.config.instructions.trim()) {
        bodyPayload.systemInstruction = {
          parts: [{ text: state.config.instructions.trim() }],
        }
      }

      // Re-verify credential generation, accountRef, authorization, and key immediately before dispatch
      if (this.getCredentialGeneration() !== startGeneration || this.getAccountRef() !== startAccountRef) {
        terminalEmitted = true
        seq += 1
        yield {
          type: 'run.failed',
          runId: request.runId,
          seq,
          timestamp: new Date().toISOString(),
          code: 'GEMINI_CREDENTIAL_ROTATED',
          message: 'Gemini credential rotated before request dispatch',
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
          code: 'GEMINI_EXECUTION_GATED',
          message: 'Gemini execution authorization revoked before request dispatch',
        }
        return
      }
      const latestKey = this.resolveApiKey()?.trim()
      if (!latestKey) {
        terminalEmitted = true
        seq += 1
        yield {
          type: 'run.failed',
          runId: request.runId,
          seq,
          timestamp: new Date().toISOString(),
          code: 'GEMINI_CREDENTIAL_MISSING',
          message: 'Gemini API key deleted before request dispatch',
        }
        return
      }

      const response = await this.transport(url, {
        method: 'POST',
        redirect: 'error',
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': latestKey,
        },
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
          code: 'GEMINI_REDIRECT_FORBIDDEN',
          message: `Gemini streamGenerateContent attempted redirect (${response.status}), which is forbidden`,
        }
        return
      }

      if (!response.ok || !response.body) {
        terminalEmitted = true
        const code =
          response.status === 401 || response.status === 403
            ? 'GEMINI_AUTH_ERROR'
            : response.status === 429
              ? 'GEMINI_RATE_LIMITED'
              : response.status === 503
                ? 'GEMINI_UNAVAILABLE'
                : 'GEMINI_HTTP_ERROR'
        seq += 1
        yield {
          type: 'run.failed',
          runId: request.runId,
          seq,
          timestamp: new Date().toISOString(),
          code,
          message: `Gemini streamGenerateContent failed with HTTP ${response.status} (no automatic retries)`,
        }
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let totalStreamBytes = 0
      let currentDataLines: string[] = []

      const emitUsageIfPresent = (): AgentEvent | null => {
        if (!lastUsage) return null
        seq += 1
        return {
          type: 'usage.updated',
          runId: request.runId,
          seq,
          timestamp: new Date().toISOString(),
          usage: {
            source: 'provider',
            observedAt: new Date().toISOString(),
            windows: [],
            ...(lastUsage.inputTokens !== undefined ? { inputTokens: lastUsage.inputTokens } : {}),
            ...(lastUsage.outputTokens !== undefined ? { outputTokens: lastUsage.outputTokens } : {}),
          },
        }
      }

      const processSseData = (rawData: string): { events: AgentEvent[]; abort: boolean } => {
        const events: AgentEvent[] = []
        if (!rawData) return { events, abort: false }

        if (this.getCredentialGeneration() !== startGeneration || this.getAccountRef() !== startAccountRef) {
          terminalEmitted = true
          seq += 1
          events.push({
            type: 'run.failed',
            runId: request.runId,
            seq,
            timestamp: new Date().toISOString(),
            code: 'GEMINI_CREDENTIAL_ROTATED',
            message: 'Gemini credential rotated during active run; aborting stream',
          })
          return { events, abort: true }
        }

        let parsed: Record<string, unknown>
        try {
          const val = JSON.parse(rawData) as unknown
          if (!val || typeof val !== 'object' || Array.isArray(val)) {
            throw new Error('Non-object SSE data')
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
            code: 'GEMINI_MALFORMED_SSE',
            message: 'Gemini SSE stream emitted malformed JSON chunk',
          })
          return { events, abort: true }
        }

        if (parsed.error && typeof parsed.error === 'object') {
          const errObj = parsed.error as Record<string, unknown>
          const msg =
            typeof errObj.message === 'string'
              ? redactGeminiSecrets(errObj.message)
              : 'Gemini stream error'
          terminalEmitted = true
          seq += 1
          events.push({
            type: 'run.failed',
            runId: request.runId,
            seq,
            timestamp: new Date().toISOString(),
            code: 'GEMINI_API_ERROR',
            message: msg,
          })
          return { events, abort: true }
        }

        if (parsed.usageMetadata && typeof parsed.usageMetadata === 'object') {
          const um = parsed.usageMetadata as Record<string, unknown>
          const inputTokens =
            typeof um.promptTokenCount === 'number' && Number.isFinite(um.promptTokenCount)
              ? um.promptTokenCount
              : undefined
          const candTokens =
            typeof um.candidatesTokenCount === 'number' && Number.isFinite(um.candidatesTokenCount)
              ? um.candidatesTokenCount
              : undefined
          const thoughtTokens =
            typeof um.thoughtsTokenCount === 'number' && Number.isFinite(um.thoughtsTokenCount)
              ? um.thoughtsTokenCount
              : 0
          const outputTokens =
            candTokens !== undefined ? candTokens + thoughtTokens : thoughtTokens > 0 ? thoughtTokens : undefined
          lastUsage = {
            ...(inputTokens !== undefined ? { inputTokens } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
          }
        }

        const promptFeedback =
          parsed.promptFeedback && typeof parsed.promptFeedback === 'object'
            ? (parsed.promptFeedback as Record<string, unknown>)
            : null
        if (promptFeedback && typeof promptFeedback.blockReason === 'string' && promptFeedback.blockReason) {
          const u = emitUsageIfPresent()
          if (u) events.push(u)
          terminalEmitted = true
          seq += 1
          events.push({
            type: 'run.failed',
            runId: request.runId,
            seq,
            timestamp: new Date().toISOString(),
            code: 'GEMINI_SAFETY_BLOCKED',
            message: `Gemini blocked prompt (${promptFeedback.blockReason})`,
          })
          return { events, abort: true }
        }

        const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : []
        if (candidates.length === 0) {
          return { events, abort: false }
        }

        const first = candidates[0] as Record<string, unknown>
        if (typeof first?.finishReason === 'string' && first.finishReason) {
          lastFinishReason = first.finishReason
        }

        const content =
          first?.content && typeof first.content === 'object'
            ? (first.content as Record<string, unknown>)
            : null
        const parts = Array.isArray(content?.parts) ? content.parts : []
        for (const rawPart of parts) {
          if (!rawPart || typeof rawPart !== 'object') continue
          const part = rawPart as Record<string, unknown>
          if (part.functionCall || part.executableCode || part.codeExecutionResult) {
            terminalEmitted = true
            seq += 1
            events.push({
              type: 'run.failed',
              runId: request.runId,
              seq,
              timestamp: new Date().toISOString(),
              code: 'GEMINI_UNSUPPORTED_PART',
              message: 'Gemini model emitted unsupported tool/code part in tool-free read-only mode',
            })
            return { events, abort: true }
          }
          if (part.thought === true) {
            // Do not persist or emit hidden model thinking text.
            continue
          }
          if (typeof part.text === 'string' && part.text) {
            assistantText += part.text
            seq += 1
            events.push({
              type: 'message.delta',
              runId: request.runId,
              seq,
              timestamp: new Date().toISOString(),
              text: part.text,
            })
          }
        }

        if (
          lastFinishReason === 'SAFETY' ||
          lastFinishReason === 'RECITATION' ||
          lastFinishReason === 'BLOCKLIST' ||
          lastFinishReason === 'PROHIBITED_CONTENT' ||
          lastFinishReason === 'SPII'
        ) {
          const u = emitUsageIfPresent()
          if (u) events.push(u)
          terminalEmitted = true
          seq += 1
          events.push({
            type: 'run.failed',
            runId: request.runId,
            seq,
            timestamp: new Date().toISOString(),
            code: 'GEMINI_SAFETY_BLOCKED',
            message: `Gemini stopped generation (${lastFinishReason})`,
          })
          return { events, abort: true }
        }

        if (lastFinishReason === 'MAX_TOKENS') {
          const u = emitUsageIfPresent()
          if (u) events.push(u)
          terminalEmitted = true
          seq += 1
          events.push({
            type: 'run.failed',
            runId: request.runId,
            seq,
            timestamp: new Date().toISOString(),
            code: 'GEMINI_MAX_TOKENS',
            message: `Gemini reached maxOutputTokens (${this.maxOutputTokens}) before natural completion`,
          })
          return { events, abort: true }
        }

        return { events, abort: false }
      }

      const readWithAbort = (): Promise<ReadableStreamReadResult<Uint8Array>> => {
        if (ctrl.signal.aborted) {
          return Promise.reject(new Error('Aborted'))
        }
        return new Promise((resolve, reject) => {
          const onAbort = () => reject(new Error('Aborted'))
          ctrl.signal.addEventListener('abort', onAbort, { once: true })
          reader
            .read()
            .then(resolve, reject)
            .finally(() => ctrl.signal.removeEventListener('abort', onAbort))
        })
      }

      while (true) {
        const { done, value } = await readWithAbort()
        if (done) break
        totalStreamBytes += value.byteLength
        if (totalStreamBytes > GEMINI_MAX_STREAM_BYTES) {
          ctrl.abort()
          terminalEmitted = true
          seq += 1
          yield {
            type: 'run.failed',
            runId: request.runId,
            seq,
            timestamp: new Date().toISOString(),
            code: 'GEMINI_RESPONSE_TOO_LARGE',
            message: `Gemini SSE stream exceeded ${GEMINI_MAX_STREAM_BYTES} bytes limit`,
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
              const res = processSseData(rawData)
              for (const ev of res.events) {
                yield ev
              }
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
        const res = processSseData(currentDataLines.join('\n'))
        for (const ev of res.events) {
          yield ev
        }
        if (res.abort) return
      }

      if (!terminalEmitted) {
        if (lastFinishReason === 'STOP' && assistantText.length > 0) {
          state.history.push({ role: 'user', text: request.text })
          state.history.push({ role: 'model', text: assistantText })
          if (state.history.length > GEMINI_MAX_HISTORY_MESSAGES) {
            state.history.splice(0, state.history.length - GEMINI_MAX_HISTORY_MESSAGES)
          }
          const u = emitUsageIfPresent()
          if (u) yield u
          terminalEmitted = true
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
        terminalEmitted = true
        seq += 1
        yield {
          type: 'run.failed',
          runId: request.runId,
          seq,
          timestamp: new Date().toISOString(),
          code: assistantText.length === 0 ? 'GEMINI_EMPTY_RESPONSE' : 'GEMINI_UNKNOWN_TERMINATION',
          message:
            assistantText.length === 0
              ? 'Gemini returned no text candidates'
              : 'Gemini SSE stream ended without terminal STOP confirmation',
        }
      }
    } catch (err) {
      if (terminalEmitted) return
      if (timedOut) {
        this.uncertainRuns.add(request.runId)
        seq += 1
        yield {
          type: 'run.failed',
          runId: request.runId,
          seq,
          timestamp: new Date().toISOString(),
          code: 'GEMINI_TIMEOUT',
          message: `Gemini inference exceeded ${this.maxDurationMs}ms duration limit (billing outcome uncertain)`,
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
      seq += 1
      yield {
        type: 'run.failed',
        runId: request.runId,
        seq,
        timestamp: new Date().toISOString(),
        code: 'GEMINI_STREAM_ERROR',
        message:
          err instanceof Error
            ? redactGeminiSecrets(err.message)
            : 'Gemini stream error',
      }
    } finally {
      clearTimeout(durationTimer)
      this.activeControllers.delete(request.runId)
    }
  }

  async resolveApproval(_decision: ApprovalDecision): Promise<void> {
    throw new Error('Google Gemini API initial integration does not support tool approvals.')
  }

  async cancel(runId: string): Promise<void> {
    this.cancelledRuns.add(runId)
    const ctrl = this.activeControllers.get(runId)
    if (ctrl) {
      ctrl.abort()
    }
  }
}
