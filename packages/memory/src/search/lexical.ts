import { MEMORY_LIMITS } from '../contracts/limits.ts'
import type { MemoryRecord, MemoryScopeKind } from '../contracts/types.ts'
import type { MemorySearchMatch } from '../repository/interface.ts'
import { foldVietnameseAccents } from '../repository/normalization.ts'

const TOKEN_REGEX = /[\p{L}\p{N}_-]+/gu

const SCOPE_PRIORITY_BONUS: Record<MemoryScopeKind, number> = {
  workspace: 6,
  bot: 4,
  user: 2,
}

export interface ParsedSearchQuery {
  readonly normalizedPhrase: string
  readonly foldedPhrase: string
  readonly tokens: readonly string[]
  readonly foldedTokens: readonly string[]
}

export function parseSearchQuery(rawQuery: string): ParsedSearchQuery {
  const normalizedPhrase = rawQuery.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()
  const foldedPhrase = foldVietnameseAccents(normalizedPhrase).toLowerCase()

  const rawMatches = normalizedPhrase.match(TOKEN_REGEX) ?? []
  const tokens: string[] = []
  const seen = new Set<string>()
  for (const tok of rawMatches) {
    if (seen.has(tok)) continue
    seen.add(tok)
    tokens.push(tok)
    if (tokens.length >= MEMORY_LIMITS.maxQueryTokens) break
  }

  const foldedTokens = tokens.map((t) => foldVietnameseAccents(t).toLowerCase())

  return {
    normalizedPhrase,
    foldedPhrase,
    tokens,
    foldedTokens,
  }
}

export function scoreRecordLexical(
  record: MemoryRecord,
  parsed: ParsedSearchQuery,
): MemorySearchMatch | null {
  if (parsed.tokens.length === 0) {
    return null
  }

  const contentLower = record.content.normalize('NFC').toLowerCase()
  const contentFolded = foldVietnameseAccents(contentLower).toLowerCase()
  const tagsLower = record.tags.map((t) => t.normalize('NFC').toLowerCase())
  const tagsFolded = tagsLower.map((t) => foldVietnameseAccents(t).toLowerCase())

  let score = 0
  let matchType: MemorySearchMatch['matchType'] | null = null

  if (parsed.normalizedPhrase.length > 0 && contentLower.includes(parsed.normalizedPhrase)) {
    score += 100
    matchType = 'exact_phrase'
  } else if (parsed.foldedPhrase.length > 0 && contentFolded.includes(parsed.foldedPhrase)) {
    score += 65
    matchType = 'accent_folded'
  }

  let exactTokenHits = 0
  let foldedTokenHits = 0
  let tagHits = 0

  for (let i = 0; i < parsed.tokens.length; i++) {
    const tok = parsed.tokens[i]!
    const folded = parsed.foldedTokens[i]!
    if (contentLower.includes(tok)) {
      exactTokenHits++
    } else if (contentFolded.includes(folded)) {
      foldedTokenHits++
    }
    if (tagsLower.some((t) => t.includes(tok)) || tagsFolded.some((t) => t.includes(folded))) {
      tagHits++
    }
  }

  if (exactTokenHits === 0 && foldedTokenHits === 0 && tagHits === 0 && matchType === null) {
    return null
  }

  const tokenCount = parsed.tokens.length
  score += Math.round((exactTokenHits / tokenCount) * 50)
  score += Math.round((foldedTokenHits / tokenCount) * 25)
  score += tagHits * 20
  score += SCOPE_PRIORITY_BONUS[record.scope.kind]

  if (matchType === null) {
    if (exactTokenHits > 0) {
      matchType = 'exact_tokens'
    } else if (foldedTokenHits > 0) {
      matchType = 'accent_folded'
    } else {
      matchType = 'tag'
    }
  }

  return {
    record,
    score,
    matchType,
  }
}
