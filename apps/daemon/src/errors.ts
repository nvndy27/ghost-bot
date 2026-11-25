import type { AppError } from '@ghost-bot/shared-types/ipc'

export class DaemonError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly statusCode: number

  constructor(code: string, message: string, options?: { retryable?: boolean; statusCode?: number }) {
    super(message)
    this.name = 'DaemonError'
    this.code = code
    this.retryable = options?.retryable ?? false
    this.statusCode = options?.statusCode ?? 500
  }
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /ghp_[A-Za-z0-9]{16,}/g,
  /Bearer\s+[A-Za-z0-9._-]{12,}/gi,
  /(OPENAI_API_KEY|CODEX_API_KEY)\s*=\s*[^\s"']+/gi,
  /("(?:access_token|refresh_token|id_token|apiKey|authorization)"\s*:\s*")[^"]+(")/gi,
]

export function redactSecrets(text: string): string {
  let out = text
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.source.includes('access_token')) {
      out = out.replace(pattern, '$1[REDACTED]$2')
    } else if (pattern.source.includes('OPENAI_API_KEY')) {
      out = out.replace(pattern, '$1=[REDACTED]')
    } else {
      out = out.replace(pattern, '[REDACTED]')
    }
  }
  return out
}

const SENSITIVE_KEYS = new Set([
  'access_token',
  'refresh_token',
  'id_token',
  'apikey',
  'api_key',
  'authorization',
  'token',
  'secret',
  'password',
])

export function redactStructuredValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value)
  if (Array.isArray(value)) return value.map((item) => redactStructuredValue(item))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(k.toLowerCase())) {
        out[k] = '[REDACTED]'
      } else {
        out[k] = redactStructuredValue(v)
      }
    }
    return out
  }
  return value
}

export function normalizeDaemonError(err: unknown): { statusCode: number; body: AppError } {
  if (err instanceof DaemonError) {
    return {
      statusCode: err.statusCode,
      body: {
        code: err.code,
        message: redactSecrets(err.message),
        retryable: err.retryable,
      },
    }
  }
  const msg = err instanceof Error ? err.message : 'Unexpected daemon error'
  return {
    statusCode: 500,
    body: {
      code: 'INTERNAL_ERROR',
      message: redactSecrets(msg),
      retryable: false,
    },
  }
}
