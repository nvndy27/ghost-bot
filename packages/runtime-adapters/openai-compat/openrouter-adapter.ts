import {
  OpenAiCompatibleRuntimeBase,
  assertPinnedHttpsOriginUrl,
  type OpenAiCompatHttpTransport,
} from './openai-compatible-transport.ts'

export const APPROVED_OPENROUTER_ORIGIN = 'https://openrouter.ai'
export const APPROVED_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

export interface OpenRouterAdapterOptions {
  resolveApiKey?: () => string | null
  isExecutionAuthorized?: () => boolean
  getCredentialGeneration?: () => number
  getAccountRef?: () => string
  transport?: OpenAiCompatHttpTransport
  timeoutMs?: number
  idleTimeoutMs?: number
  maxOutputTokens?: number
  maxDurationMs?: number
}

export class OpenRouterApiAdapter extends OpenAiCompatibleRuntimeBase {
  constructor(options: OpenRouterAdapterOptions = {}) {
    super({
      id: 'openrouter',
      label: 'OpenRouter API',
      kind: 'cloud',
      baseUrl: APPROVED_OPENROUTER_BASE_URL,
      validateEndpoint: (url) =>
        assertPinnedHttpsOriginUrl(url, APPROVED_OPENROUTER_ORIGIN, '/api/v1'),
      requiresApiKey: true,
      resolveApiKey: options.resolveApiKey,
      isExecutionAuthorized: options.isExecutionAuthorized,
      getCredentialGeneration: options.getCredentialGeneration,
      getAccountRef: options.getAccountRef,
      transport: options.transport,
      timeoutMs: options.timeoutMs ?? 10_000,
      idleTimeoutMs: options.idleTimeoutMs,
      maxOutputTokens: options.maxOutputTokens,
      maxDurationMs: options.maxDurationMs,
      extraBodyFields: {
        // Disable automatic provider routing fallbacks where supported by OpenRouter
        provider: {
          allow_fallbacks: false,
        },
      },
      extraHeaders: {
        'X-Title': 'Ghost Bot',
      },
    })
  }
}
