import {
  OpenAiCompatibleRuntimeBase,
  assertLoopbackOpenAiCompatBaseUrl,
  type OpenAiCompatHttpTransport,
} from './openai-compatible-transport.ts'

export const DEFAULT_LLAMACPP_BASE_URL = 'http://127.0.0.1:8080/v1'

export interface LlamaCppAdapterOptions {
  baseUrl?: string
  isExecutionAuthorized?: () => boolean
  transport?: OpenAiCompatHttpTransport
  timeoutMs?: number
  idleTimeoutMs?: number
  maxOutputTokens?: number
  maxDurationMs?: number
}

export class LlamaCppLocalAdapter extends OpenAiCompatibleRuntimeBase {
  constructor(options: LlamaCppAdapterOptions = {}) {
    super({
      id: 'llamacpp',
      label: 'llama.cpp Server',
      kind: 'local',
      baseUrl: options.baseUrl ?? DEFAULT_LLAMACPP_BASE_URL,
      validateEndpoint: (url) => assertLoopbackOpenAiCompatBaseUrl(url, '/v1'),
      requiresApiKey: false,
      isExecutionAuthorized: options.isExecutionAuthorized,
      transport: options.transport,
      timeoutMs: options.timeoutMs ?? 2000,
      idleTimeoutMs: options.idleTimeoutMs,
      maxOutputTokens: options.maxOutputTokens,
      maxDurationMs: options.maxDurationMs,
    })
  }
}
