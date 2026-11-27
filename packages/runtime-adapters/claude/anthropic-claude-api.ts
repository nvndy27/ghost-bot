import { randomUUID } from 'node:crypto'
import { readBoundedResponseText } from '../openai-compat/openai-compatible-transport.ts'
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

export const APPROVED_ANTHROPIC_ORIGIN = 'https://api.anthropic.com'
export const ANTHROPIC_API_VERSION = '2023-06-01'
export const CLAUDE_MAX_HISTORY_MESSAGES = 24
export const CLAUDE_MAX_HISTORY_BYTES = 48 * 1024
export const CLAUDE_MAX_TOKENS = 4096
export const CLAUDE_MAX_TOKENS_CEILING = 8192
export const CLAUDE_MAX_CONCURRENT_RUNS = 1
export const CLAUDE_MAX_DURATION_MS = 120_000
export const CLAUDE_MAX_STREAM_BYTES = 2 * 1024 * 1024
export const CLAUDE_MAX_METADATA_BYTES = 256 * 1024

const ANTHROPIC_KEY_PATTERN = /(sk-ant-[a-z0-9_-]{6,}|x-api-key:\s*[^\s]+|bearer\s+[a-z0-9._-]+)/gi

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

export function redactAnthropicSecrets(text: string): string {
  return text.replace(ANTHROPIC_KEY_PATTERN, '[REDACTED]')
}

export function assertApprovedAnthropicUrl(rawUrl: string): string {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error(`Invalid Anthropic API URL: "${rawUrl}"`)
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Anthropic API URL must use https:, got "${parsed.protocol}"`)
  }
  if (parsed.username || parsed.password) {
    throw new Error('Anthropic API URL must not embed credentials')
  }
  if (parsed.hostname.toLowerCase() !== 'api.anthropic.com' || parsed.port !== '') {
    throw new Error(
      `Anthropic API URL must target official https://api.anthropic.com only; refused "${parsed.host}"`,
    )
  }
  return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`.replace(/\/$/, '')
}

export function assertValidClaudeModelId(modelId: string): string {
  const trimmed = modelId.trim()
  if (!trimmed || trimmed.length > 128 || /\s/.test(trimmed) || hasControlChar(trimmed)) {
    throw new Error(`Invalid Anthropic Claude model identity: "${modelId}"`)
  }
  return trimmed
}

export type AnthropicHttpTransport = (
  url: string,
  init: RequestInit,
) => Promise<Response>

export interface AnthropicClaudeApiAdapterOptions {
  resolveApiKey?: () => string | null
  isExecutionAuthorized?: () => boolean
  getCredentialGeneration?: () => number
  transport?: AnthropicHttpTransport
  timeoutMs?: number
  maxConcurrentRuns?: number
  maxOutputTokens?: number
  maxDurationMs?: number
}

interface ClaudeSessionState {
  config: SessionConfig
  credentialGeneration: number
  /**
   * Anthropic Messages API is stateless per HTTP request.
   * Ghost Bot persists bounded user/assistant turns locally for conversation continuity.
   */
  history: Array<{ role: 'user' | 'assistant'; content: string }>
  lastRunId: string | null
}

export class AnthropicClaudeApiAdapter implements AgentRuntime {
  readonly id = 'claude-api'
  private readonly endpointOrigin = APPROVED_ANTHROPIC_ORIGIN
  private readonly resolveApiKey: () => string | null
  private readonly isExecutionAuthorized: () => boolean
  private readonly getCredentialGeneration: () => number
  private readonly transport: AnthropicHttpTransport
  private readonly timeoutMs: number
  private readonly maxConcurrentRuns: number
  private readonly maxOutputTokens: number
  private readonly maxDurationMs: number
  private readonly sessions = new Map<string, ClaudeSessionState>()
  private readonly activeControllers = new Map<string, AbortController>()
  private readonly cancelledRuns = new Set<string>()
  private readonly uncertainRuns = new Set<string>()

  constructor(options: AnthropicClaudeApiAdapterOptions = {}) {
    this.resolveApiKey = options.resolveApiKey ?? (() => null)
    this.isExecutionAuthorized = options.isExecutionAuthorized ?? (() => false)
    this.getCredentialGeneration = options.getCredentialGeneration ?? (() => 0)
    this.transport = options.transport ?? ((url, init) => fetch(url, init))
    this.timeoutMs = Math.max(500, Math.min(options.timeoutMs ?? 10_000, 30_000))
    this.maxConcurrentRuns = Math.max(
      1,
      Math.min(options.maxConcurrentRuns ?? CLAUDE_MAX_CONCURRENT_RUNS, 2),
    )
    this.maxOutputTokens = Math.max(
      64,
      Math.min(options.maxOutputTokens ?? CLAUDE_MAX_TOKENS, CLAUDE_MAX_TOKENS_CEILING),
    )
    this.maxDurationMs = Math.max(
      1_000,
      Math.min(options.maxDurationMs ?? CLAUDE_MAX_DURATION_MS, 300_000),
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
      maxHistoryMessages: CLAUDE_MAX_HISTORY_MESSAGES,
      maxHistoryBytes: CLAUDE_MAX_HISTORY_BYTES,
      maxOutputTokens: this.maxOutputTokens,
      maxDurationMs: this.maxDurationMs,
      maxStreamBytes: CLAUDE_MAX_STREAM_BYTES,
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
        detail: err instanceof Error ? redactAnthropicSecrets(err.message) : 'Credential store unavailable',
      }
    }
    if (!hasKey) {
      return {
        status: 'disconnected',
        detail: 'No Anthropic API key configured in OS Secret Service',
      }
    }
    if (!this.isExecutionAuthorized()) {
      return {
        status: 'connected',
        detail: 'Anthropic API key configured (API-billed execution gated until explicit opt-in)',
      }
    }
    return {
      status: 'connected',
      detail: 'Anthropic API key configured and authorized for bounded API-billed read-only chat',
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

  async listModels(_options: { allowNetworkDiscovery?: boolean } = {}): Promise<ModelInfo[]> {
    if (!this.isExecutionAuthorized()) {
      return []
    }
    const apiKey = this.resolveApiKey()?.trim()
    if (!apiKey) {
      return []
    }
    const url = assertApprovedAnthropicUrl(`${this.endpointOrigin}/v1/models`)
    const res = await this.transport(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_API_VERSION,
      },
    })
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      throw new Error(`Anthropic /v1/models attempted HTTP redirect (${res.status}), which is forbidden`)
    }
    if (!res.ok) {
      throw new Error(`Anthropic /v1/models failed with HTTP ${res.status}`)
    }
    const raw = await readBoundedResponseText(res, CLAUDE_MAX_METADATA_BYTES, 'Anthropic /v1/models')
    const parsed = JSON.parse(raw) as { data?: unknown }
    const items = Array.isArray(parsed?.data) ? parsed.data : []
    const out: ModelInfo[] = []
    const seen = new Set<string>()
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      const rec = item as Record<string, unknown>
      const id = typeof rec.id === 'string' ? rec.id.trim() : ''
      if (!id || seen.has(id)) continue
      seen.add(id)
      const label =
        typeof rec.display_name === 'string' && rec.display_name.trim()
          ? rec.display_name.trim()
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
    // Anthropic API-key usage does not expose Claude Pro/Max subscription quota windows.
    return null
  }

  async createSession(config: SessionConfig): Promise<Session> {
    if (config.permission !== 'read-only') {
      throw new Error(
        `Anthropic Claude API initial integration supports 'read-only' tool-free chat only; rejected '${config.permission}'`,
      )
    }
    const validModelId = assertValidClaudeModelId(config.modelId)
    const id = `claude-${randomUUID()}`
    this.sessions.set(id, {
      config: { ...config, modelId: validModelId },
      credentialGeneration: this.getCredentialGeneration(),
      history: [],
      lastRunId: null,
    })
    return { id, externalId: id, runtimeId: this.id }
  }

  async resumeSession(externalId: string, config?: SessionConfig): Promise<Session> {
    const existing = this.sessions.get(externalId)
    if (existing) {
      if (existing.credentialGeneration !== this.getCredentialGeneration()) {
        this.sessions.delete(externalId)
        throw new Error('Anthropic credential rotated; session authorization invalidated')
      }
      return { id: externalId, externalId, runtimeId: this.id }
    }
    if (!config) {
      throw new Error(`Unknown Anthropic Claude session "${externalId}"`)
    }
    if (config.permission !== 'read-only') {
      throw new Error(
        `Anthropic Claude API initial integration supports 'read-only' tool-free chat only; rejected '${config.permission}'`,
      )
    }
    const validModelId = assertValidClaudeModelId(config.modelId)
    this.sessions.set(externalId, {
      config: { ...config, modelId: validModelId },
      credentialGeneration: this.getCredentialGeneration(),
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
      credentialStale: state.credentialGeneration !== this.getCredentialGeneration(),
    }
  }

  async *run(request: AgentRequest): AsyncIterable<AgentEvent> {
    if (request.session.runtimeId !== this.id) {
      throw new Error(
        `AnthropicClaudeApiAdapter received mismatched runtimeId "${request.session.runtimeId}"`,
      )
    }
    const state = this.sessions.get(request.session.externalId)
    if (!state) {
      throw new Error(`Unknown Anthropic Claude session "${request.session.externalId}"`)
    }
    const startGeneration = this.getCredentialGeneration()
    if (state.credentialGeneration !== startGeneration) {
      yield {
        type: 'run.failed',
        runId: request.runId,
        seq: 1,
        timestamp: new Date().toISOString(),
        code: 'CLAUDE_CREDENTIAL_ROTATED',
        message: 'Anthropic API credential was rotated or deleted; re-authorize before running',
      }
      return
    }
    if (!this.isExecutionAuthorized()) {
      yield {
        type: 'run.failed',
        runId: request.runId,
        seq: 1,
        timestamp: new Date().toISOString(),
        code: 'CLAUDE_EXECUTION_GATED',
        message: 'Anthropic Claude API execution requires explicit API-billed authorization',
      }
      return
    }
    if (request.attachments && request.attachments.length > 0) {
      throw new Error('Anthropic Claude API read-only integration does not support attachments')
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
        code: 'CLAUDE_CREDENTIAL_UNAVAILABLE',
        message:
          err instanceof Error
            ? redactAnthropicSecrets(err.message)
            : 'Anthropic API key unavailable',
      }
      return
    }
    if (!apiKey || !apiKey.trim()) {
      yield {
        type: 'run.failed',
        runId: request.runId,
        seq: 1,
        timestamp: new Date().toISOString(),
        code: 'CLAUDE_CREDENTIAL_MISSING',
        message: 'Anthropic API key is not configured in OS Secret Service',
      }
      return
    }
    if (this.activeControllers.size >= this.maxConcurrentRuns) {
      yield {
        type: 'run.failed',
        runId: request.runId,
        seq: 1,
        timestamp: new Date().toISOString(),
        code: 'CLAUDE_CONCURRENCY_LIMIT',
        message: `Anthropic concurrent inference limit (${this.maxConcurrentRuns}) reached`,
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
    let inputTokens: number | undefined
    let outputTokens: number | undefined

    const durationTimer = setTimeout(() => {
      timedOut = true
      ctrl.abort()
    }, this.maxDurationMs)

    const recentTurns = state.history.slice(-CLAUDE_MAX_HISTORY_MESSAGES)
    const boundedHistory: Array<{ role: 'user' | 'assistant'; content: string }> = []
    let historyBytes = 0
    for (let i = recentTurns.length - 1; i >= 0; i -= 1) {
      const turn = recentTurns[i]
      if (!turn) continue
      const turnBytes = Buffer.byteLength(turn.content, 'utf8')
      if (historyBytes + turnBytes > CLAUDE_MAX_HISTORY_BYTES) break
      historyBytes += turnBytes
      boundedHistory.unshift(turn)
    }
    const messages = [
      ...boundedHistory,
      { role: 'user' as const, content: request.text },
    ]

    try {
      const url = assertApprovedAnthropicUrl(`${this.endpointOrigin}/v1/messages`)
      const bodyPayload: Record<string, unknown> = {
        model: state.config.modelId,
        max_tokens: this.maxOutputTokens,
        stream: true,
        messages,
      }
      if (state.config.instructions.trim()) {
        bodyPayload.system = state.config.instructions.trim()
      }

      // Re-verify credential generation, authorization, and key immediately before outgoing request
      if (this.getCredentialGeneration() !== startGeneration) {
        terminalEmitted = true
        seq += 1
        yield {
          type: 'run.failed',
          runId: request.runId,
          seq,
          timestamp: new Date().toISOString(),
          code: 'CLAUDE_CREDENTIAL_ROTATED',
          message: 'Anthropic credential rotated before request dispatch',
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
          code: 'CLAUDE_EXECUTION_GATED',
          message: 'Anthropic execution authorization revoked before request dispatch',
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
          code: 'CLAUDE_CREDENTIAL_MISSING',
          message: 'Anthropic API key deleted before request dispatch',
        }
        return
      }

      const response = await this.transport(url, {
        method: 'POST',
        redirect: 'error',
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': latestKey,
          'anthropic-version': ANTHROPIC_API_VERSION,
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
          code: 'CLAUDE_REDIRECT_FORBIDDEN',
          message: `Anthropic /v1/messages attempted redirect (${response.status}), which is forbidden`,
        }
        return
      }

      if (!response.ok || !response.body) {
        terminalEmitted = true
        const code =
          response.status === 401 || response.status === 403
            ? 'CLAUDE_AUTH_ERROR'
            : response.status === 429
              ? 'CLAUDE_RATE_LIMITED'
              : response.status === 529
                ? 'CLAUDE_OVERLOADED'
                : 'CLAUDE_HTTP_ERROR'
        seq += 1
        yield {
          type: 'run.failed',
          runId: request.runId,
          seq,
          timestamp: new Date().toISOString(),
          code,
          message: `Anthropic /v1/messages failed with HTTP ${response.status} (no automatic retries)`,
        }
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let totalStreamBytes = 0
      let currentEventName = ''
      let currentDataLines: string[] = []

      const processSseFrame = (
        eventName: string,
        rawData: string,
      ): { events: AgentEvent[]; done: boolean } => {
        const events: AgentEvent[] = []
        if (!rawData) return { events, done: false }
        if (this.getCredentialGeneration() !== startGeneration) {
          terminalEmitted = true
          seq += 1
          events.push({
            type: 'run.failed',
            runId: request.runId,
            seq,
            timestamp: new Date().toISOString(),
            code: 'CLAUDE_CREDENTIAL_ROTATED',
            message: 'Anthropic credential rotated during active run; aborting stream',
          })
          return { events, done: true }
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
            code: 'CLAUDE_MALFORMED_SSE',
            message: 'Anthropic SSE stream emitted malformed JSON event',
          })
          return { events, done: true }
        }

        const effectiveType =
          typeof parsed.type === 'string' && parsed.type ? parsed.type : eventName

        if (effectiveType === 'error') {
          terminalEmitted = true
          const errObj =
            parsed.error && typeof parsed.error === 'object'
              ? (parsed.error as Record<string, unknown>)
              : {}
          const errType = typeof errObj.type === 'string' ? errObj.type : 'api_error'
          const errMsg =
            typeof errObj.message === 'string'
              ? redactAnthropicSecrets(errObj.message)
              : 'Anthropic stream error'
          seq += 1
          events.push({
            type: 'run.failed',
            runId: request.runId,
            seq,
            timestamp: new Date().toISOString(),
            code: `CLAUDE_${errType.toUpperCase()}`,
            message: errMsg,
          })
          return { events, done: true }
        }

        if (effectiveType === 'message_start') {
          const msg =
            parsed.message && typeof parsed.message === 'object'
              ? (parsed.message as Record<string, unknown>)
              : {}
          const usage =
            msg.usage && typeof msg.usage === 'object'
              ? (msg.usage as Record<string, unknown>)
              : {}
          if (typeof usage.input_tokens === 'number' && Number.isFinite(usage.input_tokens)) {
            inputTokens = usage.input_tokens
          }
          return { events, done: false }
        }

        if (effectiveType === 'content_block_start') {
          const block =
            parsed.content_block && typeof parsed.content_block === 'object'
              ? (parsed.content_block as Record<string, unknown>)
              : {}
          if (block.type === 'tool_use' || block.type === 'server_tool_use') {
            terminalEmitted = true
            seq += 1
            events.push({
              type: 'run.failed',
              runId: request.runId,
              seq,
              timestamp: new Date().toISOString(),
              code: 'CLAUDE_TOOLS_UNSUPPORTED',
              message: 'Anthropic model emitted tool_use block in tool-free read-only mode',
            })
            return { events, done: true }
          }
          return { events, done: false }
        }

        if (effectiveType === 'content_block_delta') {
          const delta =
            parsed.delta && typeof parsed.delta === 'object'
              ? (parsed.delta as Record<string, unknown>)
              : {}
          if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
            assistantText += delta.text
            seq += 1
            events.push({
              type: 'message.delta',
              runId: request.runId,
              seq,
              timestamp: new Date().toISOString(),
              text: delta.text,
            })
          }
          return { events, done: false }
        }

        if (effectiveType === 'message_delta') {
          const usage =
            parsed.usage && typeof parsed.usage === 'object'
              ? (parsed.usage as Record<string, unknown>)
              : {}
          if (typeof usage.output_tokens === 'number' && Number.isFinite(usage.output_tokens)) {
            outputTokens = usage.output_tokens
          }
          return { events, done: false }
        }

        if (effectiveType === 'message_stop') {
          terminalEmitted = true
          state.history.push({ role: 'user', content: request.text })
          state.history.push({ role: 'assistant', content: assistantText })
          if (state.history.length > CLAUDE_MAX_HISTORY_MESSAGES) {
            state.history.splice(0, state.history.length - CLAUDE_MAX_HISTORY_MESSAGES)
          }
          if (inputTokens !== undefined || outputTokens !== undefined) {
            seq += 1
            events.push({
              type: 'usage.updated',
              runId: request.runId,
              seq,
              timestamp: new Date().toISOString(),
              usage: {
                source: 'provider',
                observedAt: new Date().toISOString(),
                windows: [],
                ...(inputTokens !== undefined ? { inputTokens } : {}),
                ...(outputTokens !== undefined ? { outputTokens } : {}),
              },
            })
          }
          seq += 1
          events.push({
            type: 'run.completed',
            runId: request.runId,
            seq,
            timestamp: new Date().toISOString(),
          })
          return { events, done: true }
        }

        return { events, done: false }
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
        if (totalStreamBytes > CLAUDE_MAX_STREAM_BYTES) {
          ctrl.abort()
          terminalEmitted = true
          seq += 1
          yield {
            type: 'run.failed',
            runId: request.runId,
            seq,
            timestamp: new Date().toISOString(),
            code: 'CLAUDE_RESPONSE_TOO_LARGE',
            message: `Anthropic SSE stream exceeded ${CLAUDE_MAX_STREAM_BYTES} bytes limit`,
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
              const res = processSseFrame(currentEventName, rawData)
              currentEventName = ''
              currentDataLines = []
              for (const ev of res.events) {
                yield ev
              }
              if (res.done) {
                ctrl.abort()
                return
              }
            } else {
              currentEventName = ''
            }
            continue
          }

          if (line.startsWith(':')) continue
          if (line.startsWith('event:')) {
            currentEventName = line.slice(6).trim()
          } else if (line.startsWith('data:')) {
            currentDataLines.push(line.slice(5).trimStart())
          }
        }
      }

      if (!terminalEmitted && currentDataLines.length > 0) {
        const res = processSseFrame(currentEventName, currentDataLines.join('\n'))
        for (const ev of res.events) {
          yield ev
        }
        if (res.done) return
      }

      if (!terminalEmitted) {
        this.uncertainRuns.add(request.runId)
        terminalEmitted = true
        seq += 1
        yield {
          type: 'run.failed',
          runId: request.runId,
          seq,
          timestamp: new Date().toISOString(),
          code: 'CLAUDE_UNKNOWN_TERMINATION',
          message:
            'Anthropic SSE stream ended without message_stop (billing/completion outcome uncertain)',
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
          code: 'CLAUDE_TIMEOUT',
          message: `Anthropic inference exceeded ${this.maxDurationMs}ms duration limit (billing outcome uncertain)`,
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
        code: 'CLAUDE_STREAM_ERROR',
        message:
          err instanceof Error
            ? redactAnthropicSecrets(err.message)
            : 'Anthropic stream error',
      }
    } finally {
      clearTimeout(durationTimer)
      this.activeControllers.delete(request.runId)
    }
  }

  async resolveApproval(_decision: ApprovalDecision): Promise<void> {
    throw new Error('Anthropic Claude API initial integration does not support tool approvals.')
  }

  async cancel(runId: string): Promise<void> {
    this.cancelledRuns.add(runId)
    const ctrl = this.activeControllers.get(runId)
    if (ctrl) {
      ctrl.abort()
    }
  }
}
