import { buildKnowledgeCitation } from '../citations/builder.ts'
import { KnowledgeAuthorizationError, KnowledgeValidationError } from '../contracts/errors.ts'
import { KNOWLEDGE_LIMITS } from '../contracts/limits.ts'
import {
  KnowledgeChunkSchema,
  KnowledgeContextBuildOptionsSchema,
  KnowledgeDocumentSchema,
} from '../contracts/schemas.ts'
import type {
  Clock,
  KnowledgeAuthContext,
  KnowledgeChunk,
  KnowledgeCitation,
  KnowledgeContextBuildOptions,
  KnowledgeDocument,
  KnowledgeScopeKind,
} from '../contracts/types.ts'
import { isAuthorizedToReadKnowledgeScope, validateKnowledgeAuthContext } from '../security/authorization.ts'
import { serializeKnowledgeEnvelope, type SerializedKnowledgeItem } from './serializer.ts'

const SCOPE_ORDER: Record<KnowledgeScopeKind, number> = {
  workspace: 0,
  bot: 1,
  user: 2,
}

export interface KnowledgeContextCandidate {
  readonly document: KnowledgeDocument
  readonly chunk: KnowledgeChunk
  readonly score?: number
}

export interface KnowledgeContextBuildResult {
  readonly items: readonly SerializedKnowledgeItem[]
  readonly citations: readonly KnowledgeCitation[]
  readonly serialized: string
  readonly metadata: {
    readonly selectedDocumentCount: number
    readonly selectedChunkCount: number
    readonly skippedCount: number
    readonly excludedUnauthorizedCount: number
    readonly excludedIneligibleCount: number
    readonly deduplicatedCount: number
    readonly chars: number
    readonly bytes: number
    readonly estimatedTokens: number
    readonly tokenEstimateMethod: 'chars_div_4_heuristic'
    readonly evaluatedAt: string
  }
}

export function estimateKnowledgeTokensHeuristic(chars: number): number {
  return Math.ceil(chars / 4)
}

export function buildKnowledgeContext(
  rawAuth: KnowledgeAuthContext,
  rawCandidates: readonly KnowledgeContextCandidate[],
  rawOptions: KnowledgeContextBuildOptions = {},
  clock: Clock = () => new Date(),
): KnowledgeContextBuildResult {
  const auth = validateKnowledgeAuthContext(rawAuth)
  const parsedOpts = KnowledgeContextBuildOptionsSchema.safeParse(rawOptions)
  if (!parsedOpts.success) {
    throw new KnowledgeValidationError(
      `Invalid knowledge context options: ${parsedOpts.error.issues[0]?.message ?? 'validation failed'}`,
    )
  }
  const options = parsedOpts.data
  if (rawCandidates.length > KNOWLEDGE_LIMITS.maxSearchCandidates) {
    throw new KnowledgeValidationError(
      `Candidate count exceeds limit (${KNOWLEDGE_LIMITS.maxSearchCandidates})`,
    )
  }

  const nowDate = clock()
  if (!(nowDate instanceof Date) || !Number.isFinite(nowDate.getTime())) {
    throw new KnowledgeValidationError('Context builder clock returned an invalid Date')
  }
  const nowIso = nowDate.toISOString()

  let excludedUnauthorizedCount = 0
  let excludedIneligibleCount = 0
  let deduplicatedCount = 0
  let skippedCount = 0

  const eligible: Array<{ document: KnowledgeDocument; chunk: KnowledgeChunk; score: number }> = []
  for (const raw of rawCandidates) {
    const docParsed = KnowledgeDocumentSchema.safeParse(raw.document)
    const chunkParsed = KnowledgeChunkSchema.safeParse(raw.chunk)
    if (!docParsed.success || !chunkParsed.success) {
      throw new KnowledgeValidationError('Candidate document or chunk failed schema validation')
    }
    const doc = docParsed.data
    const chunk = chunkParsed.data

    if (chunk.documentId !== doc.id || chunk.revisionId !== doc.currentRevisionId) {
      excludedIneligibleCount++
      continue
    }
    if (doc.scope.userId !== auth.userId || chunk.scope.userId !== auth.userId) {
      throw new KnowledgeAuthorizationError('Candidate knowledge belongs to a different user')
    }
    if (doc.status !== 'ready') {
      excludedIneligibleCount++
      continue
    }
    if (!isAuthorizedToReadKnowledgeScope(auth, doc.scope, { includeUserWide: options.includeUserWide })) {
      excludedUnauthorizedCount++
      continue
    }

    eligible.push({ document: doc, chunk, score: raw.score ?? 0 })
  }

  eligible.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const scopeDiff = SCOPE_ORDER[a.document.scope.kind] - SCOPE_ORDER[b.document.scope.kind]
    if (scopeDiff !== 0) return scopeDiff
    if (b.document.updatedAt !== a.document.updatedAt) {
      return b.document.updatedAt > a.document.updatedAt ? 1 : -1
    }
    const docCmp = a.document.id.localeCompare(b.document.id)
    if (docCmp !== 0) return docCmp
    return a.chunk.chunkIndex - b.chunk.chunkIndex
  })

  const deduped: typeof eligible = []
  const seenChunkIds = new Set<string>()
  const seenHashes = new Set<string>()
  for (const item of eligible) {
    if (seenChunkIds.has(item.chunk.id)) {
      deduplicatedCount++
      continue
    }
    if (options.deduplicate && seenHashes.has(item.chunk.contentHash)) {
      deduplicatedCount++
      continue
    }
    seenChunkIds.add(item.chunk.id)
    if (options.deduplicate) seenHashes.add(item.chunk.contentHash)
    deduped.push(item)
  }

  const fitsBudget = (serialized: string): boolean => {
    const chars = serialized.length
    const bytes = Buffer.byteLength(serialized, 'utf8')
    if (chars > options.maxChars || bytes > options.maxBytes) return false
    if (options.maxEstimatedTokens !== undefined && estimateKnowledgeTokensHeuristic(chars) > options.maxEstimatedTokens) {
      return false
    }
    return true
  }

  const emptyEnvelope = serializeKnowledgeEnvelope([])
  if (!fitsBudget(emptyEnvelope) || options.maxChunks === 0 || options.maxDocuments === 0) {
    const useEmptyEnvelope = options.maxChunks === 0 || options.maxDocuments === 0 ? fitsBudget(emptyEnvelope) : false
    const serialized = useEmptyEnvelope ? emptyEnvelope : ''
    const chars = serialized.length
    const bytes = Buffer.byteLength(serialized, 'utf8')
    return {
      items: [],
      citations: [],
      serialized,
      metadata: {
        selectedDocumentCount: 0,
        selectedChunkCount: 0,
        skippedCount: deduped.length,
        excludedUnauthorizedCount,
        excludedIneligibleCount,
        deduplicatedCount,
        chars,
        bytes,
        estimatedTokens: estimateKnowledgeTokensHeuristic(chars),
        tokenEstimateMethod: 'chars_div_4_heuristic',
        evaluatedAt: nowIso,
      },
    }
  }

  const selectedItems: SerializedKnowledgeItem[] = []
  const selectedCitations: KnowledgeCitation[] = []
  const selectedDocIds = new Set<string>()
  let currentSerialized = emptyEnvelope

  for (const entry of deduped) {
    if (selectedItems.length >= options.maxChunks) {
      skippedCount++
      continue
    }
    if (!selectedDocIds.has(entry.document.id) && selectedDocIds.size >= options.maxDocuments) {
      skippedCount++
      continue
    }

    const citation = buildKnowledgeCitation(entry.document, entry.chunk)
    const nextItem: SerializedKnowledgeItem = {
      documentId: entry.document.id,
      revisionId: entry.chunk.revisionId,
      chunkId: entry.chunk.id,
      scope: entry.document.scope,
      content: entry.chunk.content,
      citation,
    }
    const candidateSerialized = serializeKnowledgeEnvelope([...selectedItems, nextItem])
    if (!fitsBudget(candidateSerialized)) {
      skippedCount++
      continue
    }

    selectedItems.push(nextItem)
    selectedCitations.push(citation)
    selectedDocIds.add(entry.document.id)
    currentSerialized = candidateSerialized
  }

  const finalChars = currentSerialized.length
  const finalBytes = Buffer.byteLength(currentSerialized, 'utf8')

  return {
    items: selectedItems,
    citations: selectedCitations,
    serialized: currentSerialized,
    metadata: {
      selectedDocumentCount: selectedDocIds.size,
      selectedChunkCount: selectedItems.length,
      skippedCount,
      excludedUnauthorizedCount,
      excludedIneligibleCount,
      deduplicatedCount,
      chars: finalChars,
      bytes: finalBytes,
      estimatedTokens: estimateKnowledgeTokensHeuristic(finalChars),
      tokenEstimateMethod: 'chars_div_4_heuristic',
      evaluatedAt: nowIso,
    },
  }
}
