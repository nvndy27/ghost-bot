const ALLOWED_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export function validateLoopbackDevUrl(rawUrl: string): string {
  if (!rawUrl) return ''
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('Invalid GHOST_BOT_DEV_URL')
  }
  if (parsed.protocol !== 'http:' || !ALLOWED_LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(`Disallowed dev URL origin: ${parsed.origin}`)
  }
  return parsed.origin
}

export function isAllowedNavigationUrl(
  targetUrl: string,
  devOrigin: string,
  distIndexUrl: string,
): boolean {
  let target: URL
  try {
    target = new URL(targetUrl)
  } catch {
    return false
  }
  if (devOrigin) {
    return target.origin === devOrigin
  }
  const expected = new URL(distIndexUrl)
  return target.protocol === 'file:' && target.pathname === expected.pathname
}

export interface SenderCheckInput {
  senderMatchesWindow: boolean
  frameMatchesMainFrame: boolean
  frameUrl: string | undefined
}

export function isAuthorizedIpcContext(
  input: SenderCheckInput,
  devOrigin: string,
  distIndexUrl: string,
): boolean {
  if (!input.senderMatchesWindow || !input.frameMatchesMainFrame || !input.frameUrl) {
    return false
  }
  return isAllowedNavigationUrl(input.frameUrl, devOrigin, distIndexUrl)
}
