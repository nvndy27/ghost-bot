import {
  OpenAiCompatibleRuntimeBase,
  assertLoopbackOpenAiCompatBaseUrl,
  type OpenAiCompatHttpTransport,
} from './openai-compatible-transport.ts'

export const DEFAULT_LMSTUDIO_BASE_URL = 'http://127.0.0.1:1234/v1'

export interface LmStudioAdapterOptions {
  baseUrl?: string
  isExecutionAuthorized?: () => boolean
  transport?: OpenAiCompatHttpTransport
  timeoutMs?: number
  idleTimeoutMs?: number
  maxOutputTokens?: number
  maxDurationMs?: number
}

export class LmStudioLocalAdapter extends OpenAiCompatibleRuntimeBase {
  constructor(options: LmStudioAdapterOptions = {}) {
    super({
      id: 'lmstudio',
      label: 'LM Studio',
      kind: 'local',
      baseUrl: options.baseUrl ?? DEFAULT_LMSTUDIO_BASE_URL,
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
