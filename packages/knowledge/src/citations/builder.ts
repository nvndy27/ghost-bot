import { KNOWLEDGE_LIMITS } from '../contracts/limits.ts'
import { KnowledgeCitationSchema } from '../contracts/schemas.ts'
import type { KnowledgeChunk, KnowledgeCitation, KnowledgeDocument } from '../contracts/types.ts'

export function buildBoundedExcerpt(content: string, maxChars = KNOWLEDGE_LIMITS.maxCitationExcerptChars): string {
  const collapsed = content.normalize('NFC').replace(/\s+/g, ' ').trim()
  if (collapsed.length <= maxChars) return collapsed
  const codePoints = Array.from(collapsed)
  let out = ''
  for (const cp of codePoints) {
    if (out.length + cp.length + 3 > maxChars) break
    out += cp
  }
  return `${out.trimEnd()}...`
}

export function buildKnowledgeCitation(document: KnowledgeDocument, chunk: KnowledgeChunk): KnowledgeCitation {
  return KnowledgeCitationSchema.parse({
    documentId: document.id,
    revisionId: chunk.revisionId,
    chunkId: chunk.id,
    scope: document.scope,
    title: document.title,
    sourceType: document.sourceType,
    displayFilename: document.displayFilename,
    pageNumber: chunk.location.pageNumber,
    startLine: chunk.location.startLine,
    endLine: chunk.location.endLine,
    startChar: chunk.location.startChar,
    endChar: chunk.location.endChar,
    sectionPath: [...chunk.location.sectionPath],
    excerpt: buildBoundedExcerpt(chunk.content),
  })
}
