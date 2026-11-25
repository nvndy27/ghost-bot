import { foldVietnameseAccents } from '@ghost-bot/memory'
import { KNOWLEDGE_LIMITS } from '../contracts/limits.ts'
import type { KnowledgeChunk, KnowledgeDocument, KnowledgeScopeKind } from '../contracts/types.ts'

const TOKEN_REGEX = /[\p{L}\p{N}_-]+/gu

const SCOPE_PRIORITY_BONUS: Record<KnowledgeScopeKind, number> = {
  workspace: 6,
  bot: 4,
  user: 2,
}

export interface ParsedKnowledgeQuery {
  readonly normalizedPhrase: string
  readonly foldedPhrase: string
  readonly tokens: readonly string[]
  readonly foldedTokens: readonly string[]
}

export interface KnowledgeSearchMatch {
  readonly document: KnowledgeDocument
  readonly chunk: KnowledgeChunk
  readonly score: number
  readonly matchType: 'exact_phrase' | 'exact_tokens' | 'accent_folded' | 'metadata'
}

export function parseKnowledgeQuery(rawQuery: string): ParsedKnowledgeQuery {
  const normalizedPhrase = rawQuery.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()
  const foldedPhrase = foldVietnameseAccents(normalizedPhrase).toLowerCase()

  const rawMatches = normalizedPhrase.match(TOKEN_REGEX) ?? []
  const tokens: string[] = []
  const seen = new Set<string>()
  for (const tok of rawMatches) {
    if (seen.has(tok)) continue
    seen.add(tok)
    tokens.push(tok)
    if (tokens.length >= KNOWLEDGE_LIMITS.maxQueryTokens) break
  }

  const foldedTokens = tokens.map((t) => foldVietnameseAccents(t).toLowerCase())
  return { normalizedPhrase, foldedPhrase, tokens, foldedTokens }
}

export function scoreKnowledgeChunk(
  document: KnowledgeDocument,
  chunk: KnowledgeChunk,
  parsed: ParsedKnowledgeQuery,
): KnowledgeSearchMatch | null {
  if (parsed.tokens.length === 0) return null

  const contentLower = chunk.content.normalize('NFC').toLowerCase()
  const contentFolded = foldVietnameseAccents(contentLower).toLowerCase()
  const titleLower = document.title.normalize('NFC').toLowerCase()
  const titleFolded = foldVietnameseAccents(titleLower).toLowerCase()
  const tagsLower = document.tags.map((t) => t.normalize('NFC').toLowerCase())
  const tagsFolded = tagsLower.map((t) => foldVietnameseAccents(t).toLowerCase())

  let score = 0
  let matchType: KnowledgeSearchMatch['matchType'] | null = null

  if (parsed.normalizedPhrase.length > 0 && contentLower.includes(parsed.normalizedPhrase)) {
    score += 100
    matchType = 'exact_phrase'
  } else if (parsed.foldedPhrase.length > 0 && contentFolded.includes(parsed.foldedPhrase)) {
    score += 65
    matchType = 'accent_folded'
  }

  let exactHits = 0
  let foldedHits = 0
  let metaHits = 0

  for (let i = 0; i < parsed.tokens.length; i++) {
    const tok = parsed.tokens[i]!
    const folded = parsed.foldedTokens[i]!
    if (contentLower.includes(tok)) {
      exactHits++
    } else if (contentFolded.includes(folded)) {
      foldedHits++
    }
    if (
      titleLower.includes(tok) ||
      titleFolded.includes(folded) ||
      tagsLower.some((t) => t.includes(tok)) ||
      tagsFolded.some((t) => t.includes(folded))
    ) {
      metaHits++
    }
  }

  if (exactHits === 0 && foldedHits === 0 && metaHits === 0 && matchType === null) {
    return null
  }

  const count = parsed.tokens.length
  score += Math.round((exactHits / count) * 50)
  score += Math.round((foldedHits / count) * 25)
  score += metaHits * 15
  score += SCOPE_PRIORITY_BONUS[document.scope.kind]

  if (matchType === null) {
    if (exactHits > 0) matchType = 'exact_tokens'
    else if (foldedHits > 0) matchType = 'accent_folded'
    else matchType = 'metadata'
  }

  return { document, chunk, score, matchType }
}
