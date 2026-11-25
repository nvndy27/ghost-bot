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

const SECRET_PATTERN = /(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9._-]{12,})/g

export function redactSecrets(text: string): string {
  return text.replace(SECRET_PATTERN, '[REDACTED]')
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
