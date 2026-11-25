import type { MemorySearchMatch } from '../repository/interface.ts'

export function compareSearchMatches(a: MemorySearchMatch, b: MemorySearchMatch): number {
  if (b.score !== a.score) {
    return b.score - a.score
  }
  if (b.record.updatedAt !== a.record.updatedAt) {
    return b.record.updatedAt > a.record.updatedAt ? 1 : -1
  }
  return a.record.id.localeCompare(b.record.id)
}

export function rankAndDeduplicateMatches(
  matches: readonly MemorySearchMatch[],
  options: { limit: number; deduplicateAcrossScopes: boolean },
): MemorySearchMatch[] {
  const sorted = [...matches].sort(compareSearchMatches)
  const seenIds = new Set<string>()
  const seenHashes = new Set<string>()
  const out: MemorySearchMatch[] = []

  for (const match of sorted) {
    if (seenIds.has(match.record.id)) continue
    if (options.deduplicateAcrossScopes && seenHashes.has(match.record.contentHash)) continue
    seenIds.add(match.record.id)
    if (options.deduplicateAcrossScopes) {
      seenHashes.add(match.record.contentHash)
    }
    out.push(match)
    if (out.length >= options.limit) break
  }

  return out
}
