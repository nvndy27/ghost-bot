import { ComputerUseError } from '../contracts/types.ts'

const DISALLOWED_SCHEMES = new Set([
  'file:',
  'chrome:',
  'chrome-extension:',
  'devtools:',
  'javascript:',
  'data:',
  'blob:',
  'about:',
  'view-source:',
])

export function normalizeAllowedOrigins(origins: string[]): Set<string> {
  const normalized = new Set<string>()
  for (const raw of origins) {
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      throw new ComputerUseError('INVALID_INPUT', `Invalid allowed origin "${raw}"`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ComputerUseError(
        'INVALID_INPUT',
        `Allowed origin "${raw}" must use http: or https:`,
      )
    }
    normalized.add(parsed.origin)
  }
  if (normalized.size === 0) {
    throw new ComputerUseError('INVALID_INPUT', 'At least one allowed origin is required')
  }
  return normalized
}

export function validateBrowserUrl(
  rawUrl: string,
  allowedOrigins: Set<string>,
  options: { allowWebSocket?: boolean } = {},
): URL {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new ComputerUseError('INVALID_INPUT', `Malformed URL "${rawUrl}"`)
  }

  if (DISALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new ComputerUseError(
      'SCOPE_FORBIDDEN',
      `Disallowed URL scheme "${parsed.protocol}"`,
    )
  }

  if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') {
    if (!options.allowWebSocket) {
      throw new ComputerUseError('SCOPE_FORBIDDEN', `WebSocket "${parsed.origin}" is not permitted`)
    }
    const httpEquivalent = parsed.protocol === 'ws:' ? `http://${parsed.host}` : `https://${parsed.host}`
    if (!allowedOrigins.has(httpEquivalent)) {
      throw new ComputerUseError('SCOPE_FORBIDDEN', `WebSocket origin "${parsed.origin}" is not allowlisted`)
    }
    return parsed
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ComputerUseError('SCOPE_FORBIDDEN', `Unsupported URL protocol "${parsed.protocol}"`)
  }

  if (!allowedOrigins.has(parsed.origin)) {
    throw new ComputerUseError(
      'SCOPE_FORBIDDEN',
      `Origin "${parsed.origin}" is outside authorized browser allowlist`,
    )
  }

  return parsed
}
