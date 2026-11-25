import { foldVietnameseAccents } from '../repository/normalization.ts'

export function buildSafeFts5MatchQuery(tokens: readonly string[]): string | null {
  const safeTerms: string[] = []
  const seen = new Set<string>()

  for (const rawToken of tokens) {
    const cleaned = rawToken.replace(/["*^:()[\]{}\\]/g, '').trim()
    if (!cleaned) continue
    for (const variant of [cleaned, foldVietnameseAccents(cleaned)]) {
      if (!variant || seen.has(variant)) continue
      seen.add(variant)
      safeTerms.push(`"${variant}"`)
    }
  }

  if (safeTerms.length === 0) {
    return null
  }

  return safeTerms.join(' OR ')
}
