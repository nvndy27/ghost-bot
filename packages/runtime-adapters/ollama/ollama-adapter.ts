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

export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434'
export const OLLAMA_MAX_HISTORY_MESSAGES = 24
export const OLLAMA_MAX_HISTORY_BYTES = 32 * 1024
export const OLLAMA_MAX_STREAM_BYTES = 2 * 1024 * 1024
export const OLLAMA_MAX_METADATA_BYTES = 256 * 1024
export const OLLAMA_MAX_OUTPUT_TOKENS = 2048
export const OLLAMA_MAX_OUTPUT_TOKENS_CEILING = 8192
export const OLLAMA_MAX_CONCURRENT_RUNS = 1
export const OLLAMA_MAX_DURATION_MS = 120_000

const SECRET_PATTERN_REGEX = /(bearer\s+[a-z0-9._-]+|sk-[a-z0-9_-]{8,}|token=[a-z0-9._-]+)/gi

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

export function redactOllamaErrorDetail(detail: string): string {
  return detail.replace(SECRET_PATTERN_REGEX, '[REDACTED]')
}

export function assertLoopbackOllamaUrl(rawUrl: string): string {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error(`Invalid Ollama URL: "${rawUrl}"`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Ollama URL must use http:// or https://, got "${parsed.protocol}"`)
  }
  if (parsed.username || parsed.password) {
    throw new Error('Ollama URL must not embed credentials')
  }
  const host = parsed.hostname.toLowerCase()
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '[::1]') {
    throw new Error(`Ollama URL must target loopback only; refused "${parsed.hostname}"`)
  }
  return parsed.toString().replace(/\/$/, '')
}

export function isCloudOllamaModelName(modelId: string): boolean {
  const lower = modelId.trim().toLowerCase()
  return (
    lower.endsWith(':cloud') ||
    lower.endsWith('-cloud') ||
    lower.includes(':cloud-') ||
    lower.startsWith('cloud/')
  )
}

export function assertValidLocalOllamaModelId(modelId: string): string {
  const trimmed = modelId.trim()
  if (!trimmed || trimmed.length > 160 || /\s/.test(trimmed) || hasControlChar(trimmed)) {
    throw new Error(`Invalid Ollama model identity: "${modelId}"`)
  }
  if (isCloudOllamaModelName(trimmed)) {
    throw new Error(`Cloud-backed Ollama model "${trimmed}" is rejected by local-only policy`)
  }
  return trimmed
}

export interface OllamaModelDetails {
  id: string
  label: string
  sizeBytes: number | null
  digest: string | null
  parameterSize: string | null
  quantizationLevel: string | null
  family: string | null
  contextLength: number | null
  isCloud: boolean
}

export interface OllamaRunningModel {
  name: string
  sizeBytes: number | null
  sizeVramBytes: number | null
  expiresAt: string | null
  parameterSize: string | null
  quantizationLevel: string | null
}

export interface OllamaRuntimeSummary {
  available: boolean
  baseUrl: string
  version: string | null
  authStatus: AuthState['status']
  detail: string
  localOnlyVerified: boolean
  models: OllamaModelDetails[]
  runningModels: OllamaRunningModel[]
  resourceLimits: {
    maxConcurrentRuns: number
    maxHistoryMessages: number
    maxHistoryBytes: number
    maxOutputTokens: number
    maxDurationMs: number
    maxStreamBytes: number
  }
  diagnostics: string[]
}

export interface OllamaAdapterOptions {
  baseUrl?: string
  timeoutMs?: number
  maxConcurrentRuns?: number
  maxOutputTokens?: number
  maxDurationMs?: number
}

interface OllamaSessionState {
  config: SessionConfig
  /**
   * Stateless local chat APIs do not persist threads server-side like Codex `thread/start`.
   * Ghost Bot maintains a bounded window of user/assistant chat turns only (no privileged tool context).
   */
  history: Array<{ role: 'user' | 'assistant'; content: string }>
  lastRunId: string | null
}

export class OllamaLocalAdapter implements AgentRuntime {
  readonly id = 'ollama'
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly maxConcurrentRuns: number
  private readonly maxOutputTokens: number
  private readonly maxDurationMs: number
  private readonly sessions = new Map<string, OllamaSessionState>()
  private readonly activeControllers = new Map<string, AbortController>()
  private readonly cancelledRuns = new Set<string>()
  private readonly uncertainRuns = new Set<string>()

  constructor(options: OllamaAdapterOptions = {}) {
    this.baseUrl = assertLoopbackOllamaUrl(options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL)
    this.timeoutMs = Math.max(200, Math.min(options.timeoutMs ?? 2500, 30_000))
    this.maxConcurrentRuns = Math.max(1, Math.min(options.maxConcurrentRuns ?? OLLAMA_MAX_CONCURRENT_RUNS, 4))
    this.maxOutputTokens = Math.max(
      64,
      Math.min(options.maxOutputTokens ?? OLLAMA_MAX_OUTPUT_TOKENS, OLLAMA_MAX_OUTPUT_TOKENS_CEILING),
    )
    this.maxDurationMs = Math.max(1_000, Math.min(options.maxDurationMs ?? OLLAMA_MAX_DURATION_MS, 300_000))
  }

  getBaseUrl(): string {
    return this.baseUrl
  }

  getResourceLimits(): OllamaRuntimeSummary['resourceLimits'] {
    return {
      maxConcurrentRuns: this.maxConcurrentRuns,
      maxHistoryMessages: OLLAMA_MAX_HISTORY_MESSAGES,
      maxHistoryBytes: OLLAMA_MAX_HISTORY_BYTES,
      maxOutputTokens: this.maxOutputTokens,
      maxDurationMs: this.maxDurationMs,
      maxStreamBytes: OLLAMA_MAX_STREAM_BYTES,
    }
  }

  private async fetchBoundedJson<T>(
    path: string,
    init: { method?: 'GET' | 'POST'; body?: string } = {},
  ): Promise<{ ok: boolean; status: number; data: T | null; errorDetail?: string }> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(init.body
          ? {
              headers: { 'Content-Type': 'application/json' },
              body: init.body,
            }
          : {}),
      })
    } catch (err) {
      const msg = err instanceof Error ? redactOllamaErrorDetail(err.message) : 'Connection failed'
      return { ok: false, status: 0, data: null, errorDetail: msg }
    }

    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      return {
        ok: false,
        status: res.status,
        data: null,
        errorDetail: `Ollama endpoint attempted HTTP redirect (${res.status}), which is forbidden`,
      }
    }

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        data: null,
        errorDetail: `Ollama ${path} returned HTTP ${res.status}`,
      }
    }

    const rawText = await res.text()
    if (Buffer.byteLength(rawText, 'utf8') > OLLAMA_MAX_METADATA_BYTES) {
      return {
        ok: false,
        status: res.status,
        data: null,
        errorDetail: `Ollama ${path} response exceeded ${OLLAMA_MAX_METADATA_BYTES} bytes limit`,
      }
    }

    try {
      const parsed = JSON.parse(rawText) as T
      if (!parsed || typeof parsed !== 'object') {
        return {
          ok: false,
          status: res.status,
          data: null,
          errorDetail: `Ollama ${path} returned non-object JSON payload`,
        }
      }
      return { ok: true, status: res.status, data: parsed }
    } catch {
      return {
        ok: false,
        status: res.status,
        data: null,
        errorDetail: `Ollama ${path} returned malformed JSON`,
      }
    }
  }

  async checkAvailability(): Promise<{
    available: boolean
    version: string | null
    detail: string
  }> {
    const res = await this.fetchBoundedJson<{ version?: unknown }>('/api/version')
    if (!res.ok) {
      return {
        available: false,
        version: null,
        detail:
          res.status === 0
            ? `Local service not detected at ${this.baseUrl}`
            : (res.errorDetail ?? `Ollama returned HTTP ${res.status} at ${this.baseUrl}`),
      }
    }
    if (typeof res.data?.version !== 'string' || !res.data.version.trim()) {
      return {
        available: false,
        version: null,
        detail: 'Ollama returned an unexpected /api/version payload',
      }
    }
    const version = res.data.version.trim()
    return {
      available: true,
      version,
      detail: `Ollama ${version} available at ${this.baseUrl}`,
    }
  }

  async authenticate(): Promise<AuthState> {
    return this.getAuthStatus()
  }

  async getAuthStatus(): Promise<AuthState> {
    const status = await this.checkAvailability()
    return status.available
      ? { status: 'connected', detail: status.detail }
      : { status: 'disconnected', detail: status.detail }
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

  async listModelDetails(): Promise<OllamaModelDetails[]> {
    const res = await this.fetchBoundedJson<{ models?: unknown }>('/api/tags')
    if (!res.ok) {
      throw new Error(res.errorDetail ?? `Ollama /api/tags failed with HTTP ${res.status}`)
    }
    const raw = Array.isArray(res.data?.models) ? res.data.models : null
    if (!raw) {
      throw new Error('Ollama /api/tags returned unexpected payload (missing models array)')
    }
    const out: OllamaModelDetails[] = []
    const seen = new Set<string>()
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue
      const rec = item as Record<string, unknown>
      const name = typeof rec.name === 'string' ? rec.name.trim() : ''
      if (!name || seen.has(name)) continue
      seen.add(name)
      const details =
        rec.details && typeof rec.details === 'object'
          ? (rec.details as Record<string, unknown>)
          : {}
      const isCloud =
        isCloudOllamaModelName(name) ||
        typeof rec.remote_model === 'string' ||
        typeof rec.remote_host === 'string'
      out.push({
        id: name,
        label: name,
        sizeBytes: typeof rec.size === 'number' && Number.isFinite(rec.size) ? rec.size : null,
        digest: typeof rec.digest === 'string' && rec.digest.trim() ? rec.digest.trim() : null,
        parameterSize:
          typeof details.parameter_size === 'string' && details.parameter_size.trim()
            ? details.parameter_size.trim()
            : null,
        quantizationLevel:
          typeof details.quantization_level === 'string' && details.quantization_level.trim()
            ? details.quantization_level.trim()
            : null,
        family:
          typeof details.family === 'string' && details.family.trim() ? details.family.trim() : null,
        contextLength: null,
        isCloud,
      })
    }
    return out
  }

  async inspectModel(modelId: string): Promise<{
    parameterSize: string | null
    quantizationLevel: string | null
    family: string | null
    contextLength: number | null
    isCloud: boolean
  } | null> {
    const validId = assertValidLocalOllamaModelId(modelId)
    const res = await this.fetchBoundedJson<Record<string, unknown>>('/api/show', {
      method: 'POST',
      body: JSON.stringify({ model: validId }),
    })
    if (!res.ok || !res.data) {
      if (res.status === 404 || res.status === 0) return null
      throw new Error(res.errorDetail ?? `Ollama /api/show failed with HTTP ${res.status}`)
    }
    const details =
      res.data.details && typeof res.data.details === 'object'
        ? (res.data.details as Record<string, unknown>)
        : {}
    const modelInfo =
      res.data.model_info && typeof res.data.model_info === 'object'
        ? (res.data.model_info as Record<string, unknown>)
        : {}
    let contextLength: number | null = null
    for (const [k, v] of Object.entries(modelInfo)) {
      if (k.endsWith('.context_length') && typeof v === 'number' && Number.isFinite(v) && v > 0) {
        contextLength = v
        break
      }
    }
    const isCloud =
      isCloudOllamaModelName(validId) ||
      typeof res.data.remote_model === 'string' ||
      typeof res.data.remote_host === 'string'
    return {
      parameterSize:
        typeof details.parameter_size === 'string' && details.parameter_size.trim()
          ? details.parameter_size.trim()
          : null,
      quantizationLevel:
        typeof details.quantization_level === 'string' && details.quantization_level.trim()
          ? details.quantization_level.trim()
          : null,
      family:
        typeof details.family === 'string' && details.family.trim() ? details.family.trim() : null,
      contextLength,
      isCloud,
    }
  }

  async listRunningModels(): Promise<OllamaRunningModel[]> {
    const res = await this.fetchBoundedJson<{ models?: unknown }>('/api/ps')
    if (!res.ok) {
      if (res.status === 404 || res.status === 0) return []
      throw new Error(res.errorDetail ?? `Ollama /api/ps failed with HTTP ${res.status}`)
    }
    const raw = Array.isArray(res.data?.models) ? res.data.models : []
    const out: OllamaRunningModel[] = []
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue
      const rec = item as Record<string, unknown>
      const name =
        typeof rec.name === 'string'
          ? rec.name.trim()
          : typeof rec.model === 'string'
            ? rec.model.trim()
            : ''
      if (!name) continue
      const details =
        rec.details && typeof rec.details === 'object'
          ? (rec.details as Record<string, unknown>)
          : {}
      out.push({
        name,
        sizeBytes: typeof rec.size === 'number' && Number.isFinite(rec.size) ? rec.size : null,
        sizeVramBytes:
          typeof rec.size_vram === 'number' && Number.isFinite(rec.size_vram)
            ? rec.size_vram
            : null,
        expiresAt:
          typeof rec.expires_at === 'string' && rec.expires_at.trim()
            ? rec.expires_at.trim()
            : null,
        parameterSize:
          typeof details.parameter_size === 'string' && details.parameter_size.trim()
            ? details.parameter_size.trim()
            : null,
        quantizationLevel:
          typeof details.quantization_level === 'string' && details.quantization_level.trim()
            ? details.quantization_level.trim()
            : null,
      })
    }
    return out
  }

  async inspectLocalRuntime(): Promise<OllamaRuntimeSummary> {
    const avail = await this.checkAvailability()
    const diagnostics: string[] = []
    if (!avail.available) {
      diagnostics.push(`Ollama daemon unreachable at ${this.baseUrl}; zero local models discovered.`)
      return {
        available: false,
        baseUrl: this.baseUrl,
        version: null,
        authStatus: 'disconnected',
        detail: avail.detail,
        localOnlyVerified: false,
        models: [],
        runningModels: [],
        resourceLimits: this.getResourceLimits(),
        diagnostics,
      }
    }

    let models: OllamaModelDetails[] = []
    let runningModels: OllamaRunningModel[] = []
    try {
      models = await this.listModelDetails()
    } catch (err) {
      diagnostics.push(
        err instanceof Error ? redactOllamaErrorDetail(err.message) : 'Failed to list local models',
      )
    }
    try {
      runningModels = await this.listRunningModels()
    } catch (err) {
      diagnostics.push(
        err instanceof Error
          ? redactOllamaErrorDetail(err.message)
          : 'Failed to inspect running models',
      )
    }

    const localModels = models.filter((m) => !m.isCloud)
    const cloudCount = models.length - localModels.length
    if (cloudCount > 0) {
      diagnostics.push(`Filtered ${cloudCount} cloud-backed model(s) under local-only policy.`)
    }
    if (localModels.length === 0) {
      diagnostics.push('No verified local models installed; pull a local model before execution.')
    }

    // Enrich top local models with /api/show context_length when available (bounded to first 10)
    const enriched = await Promise.all(
      localModels.map(async (m, idx) => {
        if (idx >= 10) return m
        const shown = await this.inspectModel(m.id).catch(() => null)
        if (!shown) return m
        return {
          ...m,
          parameterSize: shown.parameterSize ?? m.parameterSize,
          quantizationLevel: shown.quantizationLevel ?? m.quantizationLevel,
          family: shown.family ?? m.family,
          contextLength: shown.contextLength ?? m.contextLength,
          isCloud: m.isCloud || shown.isCloud,
        }
      }),
    )

    const verifiedLocalModels = enriched.filter((m) => !m.isCloud)
    const localOnlyVerified = avail.available && verifiedLocalModels.length > 0

    return {
      available: avail.available,
      baseUrl: this.baseUrl,
      version: avail.version,
      authStatus: 'connected',
      detail: avail.detail,
      localOnlyVerified,
      models: verifiedLocalModels,
      runningModels,
      resourceLimits: this.getResourceLimits(),
      diagnostics,
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const detailed = await this.listModelDetails()
    return detailed
      .filter((m) => !m.isCloud)
      .map((m) => ({
        id: m.id,
        label: m.label,
        efforts: [],
        permissionModes: ['read-only'],
        supportsTools: false,
        supportsAttachments: false,
      }))
  }

  async capabilities(): Promise<Capabilities> {
    const models = await this.listModels().catch(() => [])
    return {
      streaming: true,
      cancellation: true,
      resume: false,
      approvals: false,
      usage: false,
      sandbox: false,
      models,
    }
  }

  async getUsage(): Promise<UsageSnapshot | null> {
    // Local Ollama models have no subscription quota windows.
    return null
  }

  async createSession(config: SessionConfig): Promise<Session> {
    if (config.permission !== 'read-only') {
      throw new Error(
        `Ollama local chat only supports 'read-only' mode without tools; rejected '${config.permission}'`,
      )
    }
    const validModelId = assertValidLocalOllamaModelId(config.modelId)
    const installed = await this.listModelDetails()
    const match = installed.find((m) => m.id === validModelId)
    if (!match) {
      throw new Error(`Ollama model "${validModelId}" is not installed locally at ${this.baseUrl}`)
    }
    if (match.isCloud) {
      throw new Error(`Cloud-backed Ollama model "${validModelId}" is rejected by local-only policy`)
    }
    const show = await this.inspectModel(validModelId)
    if (show?.isCloud) {
      throw new Error(`Ollama model "${validModelId}" reports remote cloud backing and is rejected`)
    }

    const id = `ollama-${randomUUID()}`
    this.sessions.set(id, {
      config: { ...config, modelId: validModelId },
      history: [],
      lastRunId: null,
    })
    return { id, externalId: id, runtimeId: this.id }
  }

  async resumeSession(externalId: string, config?: SessionConfig): Promise<Session> {
    const existing = this.sessions.get(externalId)
    if (existing) {
      return { id: externalId, externalId, runtimeId: this.id }
    }
    if (!config) {
      throw new Error(`Unknown Ollama session "${externalId}"`)
    }
    if (config.permission !== 'read-only') {
      throw new Error(
        `Ollama local chat only supports 'read-only' mode without tools; rejected '${config.permission}'`,
      )
    }
    const validModelId = assertValidLocalOllamaModelId(config.modelId)
    this.sessions.set(externalId, {
      config: { ...config, modelId: validModelId },
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
  }> {
    const state = this.sessions.get(externalId)
    if (!state) {
      return {
        exists: false,
        historyTurns: 0,
        lastRunId: null,
        uncertainLastRun: false,
      }
    }
    return {
      exists: true,
      historyTurns: state.history.length,
      lastRunId: state.lastRunId,
      uncertainLastRun: state.lastRunId ? this.uncertainRuns.has(state.lastRunId) : false,
    }
  }

  async *run(request: AgentRequest): AsyncIterable<AgentEvent> {
    if (request.session.runtimeId !== this.id) {
      throw new Error(
        `OllamaLocalAdapter received mismatched runtimeId "${request.session.runtimeId}"`,
      )
    }
    const state = this.sessions.get(request.session.externalId)
    if (!state) {
      throw new Error(`Unknown Ollama session "${request.session.externalId}"`)
    }
    if (request.attachments && request.attachments.length > 0) {
      throw new Error('Ollama local read-only adapter does not support file attachments')
    }
    if (this.activeControllers.size >= this.maxConcurrentRuns) {
      yield {
        type: 'run.failed',
        runId: request.runId,
        seq: 1,
        timestamp: new Date().toISOString(),
        code: 'OLLAMA_CONCURRENCY_LIMIT',
        message: `Ollama concurrent inference limit (${this.maxConcurrentRuns}) reached`,
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
    const durationTimer = setTimeout(() => {
      timedOut = true
      ctrl.abort()
    }, this.maxDurationMs)

    const recentTurns = state.history.slice(-OLLAMA_MAX_HISTORY_MESSAGES)
    const boundedHistory: Array<{ role: 'user' | 'assistant'; content: string }> = []
    let historyBytes = 0
    for (let i = recentTurns.length - 1; i >= 0; i -= 1) {
      const turn = recentTurns[i]
      if (!turn) continue
      const turnBytes = Buffer.byteLength(turn.content, 'utf8')
      if (historyBytes + turnBytes > OLLAMA_MAX_HISTORY_BYTES) break
      historyBytes += turnBytes
      boundedHistory.unshift(turn)
    }
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = []
    if (state.config.instructions.trim()) {
      messages.push({ role: 'system', content: state.config.instructions.trim() })
    }
    for (const turn of boundedHistory) {
      messages.push(turn)
    }
    messages.push({ role: 'user', content: request.text })

    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        redirect: 'error',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: state.config.modelId,
          messages,
          stream: true,
          options: {
            num_predict: this.maxOutputTokens,
          },
        }),
      })

      if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
        terminalEmitted = true
        seq += 1
        yield {
          type: 'run.failed',
          runId: request.runId,
          seq,
          timestamp: new Date().toISOString(),
          code: 'OLLAMA_REDIRECT_FORBIDDEN',
          message: `Ollama /api/chat attempted redirect (${response.status}), which is forbidden`,
        }
        return
      }

      if (!response.ok || !response.body) {
        terminalEmitted = true
        seq += 1
        yield {
          type: 'run.failed',
          runId: request.runId,
          seq,
          timestamp: new Date().toISOString(),
          code: 'OLLAMA_HTTP_ERROR',
          message: `Ollama /api/chat failed with HTTP ${response.status}`,
        }
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let totalStreamBytes = 0

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        totalStreamBytes += value.byteLength
        if (totalStreamBytes > OLLAMA_MAX_STREAM_BYTES) {
          ctrl.abort()
          terminalEmitted = true
          seq += 1
          yield {
            type: 'run.failed',
            runId: request.runId,
            seq,
            timestamp: new Date().toISOString(),
            code: 'OLLAMA_RESPONSE_TOO_LARGE',
            message: `Ollama stream exceeded ${OLLAMA_MAX_STREAM_BYTES} bytes limit`,
          }
          return
        }
        buffer += decoder.decode(value, { stream: true })
        let nlIdx = buffer.indexOf('\n')
        while (nlIdx !== -1) {
          const line = buffer.slice(0, nlIdx).trim()
          buffer = buffer.slice(nlIdx + 1)
          nlIdx = buffer.indexOf('\n')
          if (!line || terminalEmitted) continue

          let chunk: {
            error?: unknown
            message?: { content?: unknown; tool_calls?: unknown }
            done?: unknown
            prompt_eval_count?: unknown
            eval_count?: unknown
          }
          try {
            const parsed = JSON.parse(line) as unknown
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              throw new Error('Non-object NDJSON chunk')
            }
            chunk = parsed as typeof chunk
          } catch {
            ctrl.abort()
            terminalEmitted = true
            seq += 1
            yield {
              type: 'run.failed',
              runId: request.runId,
              seq,
              timestamp: new Date().toISOString(),
              code: 'OLLAMA_MALFORMED_RESPONSE',
              message: 'Ollama stream emitted malformed NDJSON chunk',
            }
            return
          }

          if (typeof chunk.error === 'string' && chunk.error.trim()) {
            ctrl.abort()
            terminalEmitted = true
            seq += 1
            yield {
              type: 'run.failed',
              runId: request.runId,
              seq,
              timestamp: new Date().toISOString(),
              code: 'OLLAMA_RUNTIME_ERROR',
              message: redactOllamaErrorDetail(chunk.error.trim()),
            }
            return
          }

          if (Array.isArray(chunk.message?.tool_calls) && chunk.message.tool_calls.length > 0) {
            ctrl.abort()
            terminalEmitted = true
            seq += 1
            yield {
              type: 'run.failed',
              runId: request.runId,
              seq,
              timestamp: new Date().toISOString(),
              code: 'OLLAMA_TOOLS_UNSUPPORTED',
              message: 'Ollama model attempted tool_calls in read-only tool-free mode',
            }
            return
          }

          const delta =
            typeof chunk?.message?.content === 'string' ? chunk.message.content : ''
          if (delta) {
            assistantText += delta
            seq += 1
            yield {
              type: 'message.delta',
              runId: request.runId,
              seq,
              timestamp: new Date().toISOString(),
              text: delta,
            }
          }

          if (chunk?.done === true) {
            terminalEmitted = true
            state.history.push({ role: 'user', content: request.text })
            state.history.push({ role: 'assistant', content: assistantText })
            if (state.history.length > OLLAMA_MAX_HISTORY_MESSAGES) {
              state.history.splice(0, state.history.length - OLLAMA_MAX_HISTORY_MESSAGES)
            }
            const inputTokens =
              typeof chunk.prompt_eval_count === 'number' && Number.isFinite(chunk.prompt_eval_count)
                ? chunk.prompt_eval_count
                : undefined
            const outputTokens =
              typeof chunk.eval_count === 'number' && Number.isFinite(chunk.eval_count)
                ? chunk.eval_count
                : undefined
            if (inputTokens !== undefined || outputTokens !== undefined) {
              seq += 1
              yield {
                type: 'usage.updated',
                runId: request.runId,
                seq,
                timestamp: new Date().toISOString(),
                usage: {
                  source: 'local',
                  observedAt: new Date().toISOString(),
                  windows: [],
                  ...(inputTokens !== undefined ? { inputTokens } : {}),
                  ...(outputTokens !== undefined ? { outputTokens } : {}),
                },
              }
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
        }
      }

      if (!terminalEmitted) {
        if (buffer.trim()) {
          terminalEmitted = true
          seq += 1
          yield {
            type: 'run.failed',
            runId: request.runId,
            seq,
            timestamp: new Date().toISOString(),
            code: 'OLLAMA_MALFORMED_RESPONSE',
            message: 'Ollama stream terminated with trailing unparsed data',
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
          code: 'OLLAMA_UNKNOWN_TERMINATION',
          message: 'Ollama stream closed without terminal done:true confirmation',
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
          code: 'OLLAMA_TIMEOUT',
          message: `Ollama inference exceeded ${this.maxDurationMs}ms duration limit`,
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
        code: 'OLLAMA_STREAM_ERROR',
        message: err instanceof Error ? redactOllamaErrorDetail(err.message) : 'Ollama stream error',
      }
    } finally {
      clearTimeout(durationTimer)
      this.activeControllers.delete(request.runId)
    }
  }

  async resolveApproval(_decision: ApprovalDecision): Promise<void> {
    throw new Error('Ollama local adapter does not support tool approvals.')
  }

  async cancel(runId: string): Promise<void> {
    this.cancelledRuns.add(runId)
    const ctrl = this.activeControllers.get(runId)
    if (ctrl) {
      ctrl.abort()
    }
  }
}
