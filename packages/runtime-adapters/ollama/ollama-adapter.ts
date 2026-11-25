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
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost' && parsed.hostname !== '::1') {
    throw new Error(`Ollama URL must target loopback only; refused "${parsed.hostname}"`)
  }
  return parsed.toString().replace(/\/$/, '')
}

export interface OllamaAdapterOptions {
  baseUrl?: string
  timeoutMs?: number
}

interface OllamaSessionState {
  config: SessionConfig
  /**
   * Stateless local chat APIs do not persist threads server-side like Codex `thread/start`.
   * Ghost Bot maintains a bounded window of user/assistant chat turns only (no privileged tool context).
   */
  history: Array<{ role: 'user' | 'assistant'; content: string }>
}

export class OllamaLocalAdapter implements AgentRuntime {
  readonly id = 'ollama'
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly sessions = new Map<string, OllamaSessionState>()
  private readonly activeControllers = new Map<string, AbortController>()

  constructor(options: OllamaAdapterOptions = {}) {
    this.baseUrl = assertLoopbackOllamaUrl(options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL)
    this.timeoutMs = options.timeoutMs ?? 2500
  }

  getBaseUrl(): string {
    return this.baseUrl
  }

  async checkAvailability(): Promise<{
    available: boolean
    version: string | null
    detail: string
  }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/version`, {
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (!res.ok) {
        return {
          available: false,
          version: null,
          detail: `Ollama returned HTTP ${res.status} at ${this.baseUrl}`,
        }
      }
      const data = (await res.json()) as { version?: unknown }
      if (typeof data?.version !== 'string' || !data.version.trim()) {
        return {
          available: false,
          version: null,
          detail: 'Ollama returned an unexpected /api/version payload',
        }
      }
      return {
        available: true,
        version: data.version.trim(),
        detail: `Ollama ${data.version.trim()} available at ${this.baseUrl}`,
      }
    } catch {
      return {
        available: false,
        version: null,
        detail: `Local service not detected at ${this.baseUrl}`,
      }
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
    for (const ctrl of this.activeControllers.values()) {
      ctrl.abort()
    }
    this.activeControllers.clear()
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await fetch(`${this.baseUrl}/api/tags`, {
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!res.ok) {
      throw new Error(`Ollama /api/tags failed with HTTP ${res.status}`)
    }
    const data = (await res.json()) as { models?: unknown }
    const raw = Array.isArray(data?.models) ? data.models : []
    const out: ModelInfo[] = []
    const seen = new Set<string>()
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue
      const name = (item as { name?: unknown }).name
      if (typeof name !== 'string' || !name.trim() || seen.has(name)) continue
      seen.add(name)
      out.push({
        id: name.trim(),
        label: name.trim(),
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
    const id = `ollama-${randomUUID()}`
    this.sessions.set(id, { config, history: [] })
    return { id, externalId: id, runtimeId: this.id }
  }

  async *run(request: AgentRequest): AsyncIterable<AgentEvent> {
    const state = this.sessions.get(request.session.externalId)
    if (!state) {
      throw new Error(`Unknown Ollama session "${request.session.externalId}"`)
    }

    const ctrl = new AbortController()
    this.activeControllers.set(request.runId, ctrl)
    let seq = 0
    let assistantText = ''

    const boundedHistory = state.history.slice(-OLLAMA_MAX_HISTORY_MESSAGES)
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
        }),
      })
      if (!response.ok || !response.body) {
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

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let nlIdx = buffer.indexOf('\n')
        while (nlIdx !== -1) {
          const line = buffer.slice(0, nlIdx).trim()
          buffer = buffer.slice(nlIdx + 1)
          nlIdx = buffer.indexOf('\n')
          if (!line) continue

          const chunk = JSON.parse(line) as {
            message?: { content?: unknown }
            done?: unknown
            prompt_eval_count?: unknown
            eval_count?: unknown
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
            state.history.push({ role: 'user', content: request.text })
            state.history.push({ role: 'assistant', content: assistantText })
            if (state.history.length > OLLAMA_MAX_HISTORY_MESSAGES) {
              state.history.splice(0, state.history.length - OLLAMA_MAX_HISTORY_MESSAGES)
            }
            const inputTokens =
              typeof chunk.prompt_eval_count === 'number' ? chunk.prompt_eval_count : undefined
            const outputTokens =
              typeof chunk.eval_count === 'number' ? chunk.eval_count : undefined
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
    } catch (err) {
      if (ctrl.signal.aborted) {
        seq += 1
        yield {
          type: 'run.cancelled',
          runId: request.runId,
          seq,
          timestamp: new Date().toISOString(),
        }
        return
      }
      seq += 1
      yield {
        type: 'run.failed',
        runId: request.runId,
        seq,
        timestamp: new Date().toISOString(),
        code: 'OLLAMA_STREAM_ERROR',
        message: err instanceof Error ? err.message : 'Ollama stream error',
      }
    } finally {
      this.activeControllers.delete(request.runId)
    }
  }

  async resolveApproval(_decision: ApprovalDecision): Promise<void> {
    throw new Error('Ollama local adapter does not support tool approvals.')
  }

  async cancel(runId: string): Promise<void> {
    const ctrl = this.activeControllers.get(runId)
    if (ctrl) {
      ctrl.abort()
    }
  }
}
