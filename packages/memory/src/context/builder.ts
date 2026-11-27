import { MemoryAuthorizationError, MemoryValidationError } from '../contracts/errors.ts'
import { MEMORY_LIMITS } from '../contracts/limits.ts'
import { ContextBuildOptionsSchema, MemoryRecordSchema } from '../contracts/schemas.ts'
import type {
  Clock,
  ContextBuildOptions,
  MemoryAuthContext,
  MemoryRecord,
  MemoryScopeKind,
} from '../contracts/types.ts'
import { isAuthorizedToReadRecord, validateAuthContext } from '../security/authorization.ts'
import { serializeMemoryEnvelope, toSerializedMemoryItem, type SerializedMemoryItem } from './serializer.ts'

const SCOPE_ORDER: Record<MemoryScopeKind, number> = {
  workspace: 0,
  bot: 1,
  user: 2,
}

export interface MemoryContextBuildResult {
  readonly items: readonly SerializedMemoryItem[]
  readonly serialized: string
  readonly metadata: {
    readonly selectedCount: number
    readonly skippedCount: number
    readonly excludedUnauthorizedCount: number
    readonly excludedArchivedOrExpiredCount: number
    readonly deduplicatedCount: number
    readonly chars: number
    readonly bytes: number
    readonly estimatedTokens: number
    readonly tokenEstimateMethod: 'chars_div_4_heuristic'
    readonly evaluatedAt: string
  }
}

export function estimateTokensHeuristic(chars: number): number {
  return Math.ceil(chars / 4)
}

export function buildMemoryContext(
  rawAuth: MemoryAuthContext,
  rawCandidates: readonly MemoryRecord[],
  rawOptions: ContextBuildOptions = {},
  clock: Clock = () => new Date(),
): MemoryContextBuildResult {
  const auth = validateAuthContext(rawAuth)
  const parsedOpts = ContextBuildOptionsSchema.safeParse(rawOptions)
  if (!parsedOpts.success) {
    throw new MemoryValidationError(`Invalid context build options: ${parsedOpts.error.issues[0]?.message ?? 'validation failed'}`)
  }
  const options = parsedOpts.data

  if (rawCandidates.length > MEMORY_LIMITS.maxCandidateRecords) {
    throw new MemoryValidationError(`Candidate record count exceeds limit (${MEMORY_LIMITS.maxCandidateRecords})`)
  }

  const nowIso = clock().toISOString()
  let excludedUnauthorizedCount = 0
  let excludedArchivedOrExpiredCount = 0
  let deduplicatedCount = 0
  let skippedCount = 0

  const eligible: MemoryRecord[] = []
  for (const rawCandidate of rawCandidates) {
    const parsedRec = MemoryRecordSchema.safeParse(rawCandidate)
    if (!parsedRec.success) {
      throw new MemoryValidationError('Candidate memory record failed schema validation')
    }
    const rec = parsedRec.data
    if (rec.scope.userId !== auth.userId) {
      throw new MemoryAuthorizationError('Candidate memory record belongs to a different user')
    }
    if (!isAuthorizedToReadRecord(auth, rec, { includeUserWide: options.includeUserWide, includeArchived: false })) {
      if (rec.status === 'archived') {
        excludedArchivedOrExpiredCount++
      } else {
        excludedUnauthorizedCount++
      }
      continue
    }
    if (rec.expiresAt !== null && rec.expiresAt <= nowIso) {
      excludedArchivedOrExpiredCount++
      continue
    }
    eligible.push(rec)
  }

  eligible.sort((a, b) => {
    const scopeDiff = SCOPE_ORDER[a.scope.kind] - SCOPE_ORDER[b.scope.kind]
    if (scopeDiff !== 0) return scopeDiff
    if (b.updatedAt !== a.updatedAt) return b.updatedAt > a.updatedAt ? 1 : -1
    return a.id.localeCompare(b.id)
  })

  const deduped: MemoryRecord[] = []
  const seenIds = new Set<string>()
  const seenHashes = new Set<string>()
  for (const rec of eligible) {
    if (seenIds.has(rec.id)) {
      deduplicatedCount++
      continue
    }
    if (options.deduplicate && seenHashes.has(rec.contentHash)) {
      deduplicatedCount++
      continue
    }
    seenIds.add(rec.id)
    if (options.deduplicate) seenHashes.add(rec.contentHash)
    deduped.push(rec)
  }

  const selectedItems: SerializedMemoryItem[] = []
  let currentSerialized = serializeMemoryEnvelope([])

  const fitsBudget = (candidateSerialized: string): boolean => {
    const chars = candidateSerialized.length
    const bytes = Buffer.byteLength(candidateSerialized, 'utf8')
    if (chars > options.maxChars || bytes > options.maxBytes) {
      return false
    }
    if (options.maxEstimatedTokens !== undefined && estimateTokensHeuristic(chars) > options.maxEstimatedTokens) {
      return false
    }
    return true
  }

  if (!fitsBudget(currentSerialized)) {
    return {
      items: [],
      serialized: '',
      metadata: {
        selectedCount: 0,
        skippedCount: deduped.length,
        excludedUnauthorizedCount,
        excludedArchivedOrExpiredCount,
        deduplicatedCount,
        chars: 0,
        bytes: 0,
        estimatedTokens: 0,
        tokenEstimateMethod: 'chars_div_4_heuristic',
        evaluatedAt: nowIso,
      },
    }
  }

  for (const rec of deduped) {
    if (selectedItems.length >= options.maxRecords) {
      skippedCount++
      continue
    }
    const nextItem = toSerializedMemoryItem(rec)
    const candidateItems = [...selectedItems, nextItem]
    const candidateSerialized = serializeMemoryEnvelope(candidateItems)
    if (!fitsBudget(candidateSerialized)) {
      skippedCount++
      continue
    }
    selectedItems.push(nextItem)
    currentSerialized = candidateSerialized
  }

  const finalChars = currentSerialized.length
  const finalBytes = Buffer.byteLength(currentSerialized, 'utf8')

  return {
    items: selectedItems,
    serialized: currentSerialized,
    metadata: {
      selectedCount: selectedItems.length,
      skippedCount,
      excludedUnauthorizedCount,
      excludedArchivedOrExpiredCount,
      deduplicatedCount,
      chars: finalChars,
      bytes: finalBytes,
      estimatedTokens: estimateTokensHeuristic(finalChars),
      tokenEstimateMethod: 'chars_div_4_heuristic',
      evaluatedAt: nowIso,
    },
  }
}
