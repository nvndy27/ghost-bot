import { createHash } from 'node:crypto'

export function normalizeStoredContent(content: string): string {
  return content.normalize('NFC').trim()
}

export function normalizeForDeduplication(content: string): string {
  return content.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()
}

export function computeContentHash(normalizedContent: string): string {
  return createHash('sha256').update(normalizedContent, 'utf8').digest('hex')
}

export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tags) {
    const normalized = raw.normalize('NFC').trim().toLowerCase()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

export function foldVietnameseAccents(input: string): string {
  return input
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .normalize('NFC')
}
