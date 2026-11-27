import type { KnowledgeSearchMatch } from './lexical.ts'

export function compareKnowledgeMatches(a: KnowledgeSearchMatch, b: KnowledgeSearchMatch): number {
  if (b.score !== a.score) {
    return b.score - a.score
  }
  if (b.document.updatedAt !== a.document.updatedAt) {
    return b.document.updatedAt > a.document.updatedAt ? 1 : -1
  }
  const docCmp = a.document.id.localeCompare(b.document.id)
  if (docCmp !== 0) return docCmp
  return a.chunk.chunkIndex - b.chunk.chunkIndex
}

const SUBSTANTIAL_OVERLAP_RATIO = 0.5

function hasSubstantialOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  const overlapLen = Math.min(aEnd, bEnd) - Math.max(aStart, bStart)
  if (overlapLen <= 0) return false
  const candidateLen = bEnd - bStart
  if (candidateLen <= 0) return true
  return overlapLen / candidateLen >= SUBSTANTIAL_OVERLAP_RATIO
}

export function rankAndSuppressChunks(
  matches: readonly KnowledgeSearchMatch[],
  options: { limit: number; deduplicateOverlappingChunks: boolean },
): KnowledgeSearchMatch[] {
  const sorted = [...matches].sort(compareKnowledgeMatches)
  const seenChunkIds = new Set<string>()
  const seenHashes = new Set<string>()
  const acceptedByRevision = new Map<string, Array<{ startChar: number; endChar: number }>>()
  const out: KnowledgeSearchMatch[] = []

  for (const match of sorted) {
    if (seenChunkIds.has(match.chunk.id)) continue
    if (options.deduplicateOverlappingChunks) {
      if (seenHashes.has(match.chunk.contentHash)) continue
      const revKey = `${match.document.id}:${match.chunk.revisionId}`
      const existingRanges = acceptedByRevision.get(revKey) ?? []
      if (
        existingRanges.some((r) =>
          hasSubstantialOverlap(r.startChar, r.endChar, match.chunk.location.startChar, match.chunk.location.endChar),
        )
      ) {
        continue
      }
      existingRanges.push({
        startChar: match.chunk.location.startChar,
        endChar: match.chunk.location.endChar,
      })
      acceptedByRevision.set(revKey, existingRanges)
      seenHashes.add(match.chunk.contentHash)
    }

    seenChunkIds.add(match.chunk.id)
    out.push(match)
    if (out.length >= options.limit) break
  }

  return out
}
