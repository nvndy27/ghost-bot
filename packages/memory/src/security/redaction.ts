import { MemoryCredentialError } from '../contracts/errors.ts'
import type { SourceReference } from '../contracts/types.ts'

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\bsk-(?:proj-|svcacct-|ant-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bpk_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\bAuthorization\s*:\s*(?:Bearer|Basic|Token)\s+[^\s"']+/gi,
  /-----BEGIN\s+(?:[A-Z0-9]+\s+)*PRIVATE KEY-----/g,
  /\b(?:OPENAI_API_KEY|CODEX_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|API_KEY|SECRET_KEY|ACCESS_TOKEN|REFRESH_TOKEN)\s*=\s*[^\s"']+/gi,
  /("(?:access_token|refresh_token|id_token|apiKey|api_key|authorization|secret|password)"\s*:\s*")[^"]+(")/gi,
]

export function containsCredentialPattern(text: string): boolean {
  for (const pattern of CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0
    if (pattern.test(text)) {
      return true
    }
  }
  return false
}

export function assertNoCredentialsInFields(fields: {
  content?: string
  tags?: readonly string[]
  provenanceNote?: string | null
  sourceRefs?: readonly SourceReference[]
}): void {
  if (fields.content && containsCredentialPattern(fields.content)) {
    throw new MemoryCredentialError()
  }
  if (fields.provenanceNote && containsCredentialPattern(fields.provenanceNote)) {
    throw new MemoryCredentialError('Memory provenance note rejected because it matches a recognized credential pattern')
  }
  if (fields.tags) {
    for (const tag of fields.tags) {
      if (containsCredentialPattern(tag)) {
        throw new MemoryCredentialError('Memory tag rejected because it matches a recognized credential pattern')
      }
    }
  }
  if (fields.sourceRefs) {
    for (const ref of fields.sourceRefs) {
      if (
        (ref.refId && containsCredentialPattern(ref.refId)) ||
        (ref.label && containsCredentialPattern(ref.label)) ||
        (ref.uri && containsCredentialPattern(ref.uri))
      ) {
        throw new MemoryCredentialError('Memory source reference rejected because it matches a recognized credential pattern')
      }
    }
  }
}

export function redactSecrets(text: string): string {
  let out = text
  for (const pattern of CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0
    if (pattern.source.includes('access_token')) {
      out = out.replace(pattern, '$1[REDACTED]$2')
    } else if (pattern.source.includes('OPENAI_API_KEY')) {
      out = out.replace(pattern, (match) => {
        const eqIdx = match.indexOf('=')
        return eqIdx >= 0 ? `${match.slice(0, eqIdx + 1)}[REDACTED]` : '[REDACTED]'
      })
    } else {
      out = out.replace(pattern, '[REDACTED]')
    }
  }
  return out
}

export function sanitizeErrorMessage(err: unknown, maxLength = 240): string {
  const raw = err instanceof Error ? err.message : String(err)
  const redacted = redactSecrets(raw).replace(/[\r\n\t]+/g, ' ').trim()
  if (redacted.length <= maxLength) return redacted
  return `${redacted.slice(0, maxLength - 3)}...`
}
