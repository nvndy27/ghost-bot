import { randomUUID } from 'node:crypto'
import {
  MemoryDuplicateError,
  MemoryNotFoundError,
  MemoryUnsupportedOriginError,
  MemoryValidationError,
} from '../contracts/errors.ts'
import { MEMORY_SCHEMA_VERSION } from '../contracts/limits.ts'
import {
  CreateMemoryInputSchema,
  ListMemoriesQuerySchema,
  MemoryRecordSchema,
  MemoryScopeSchema,
  SearchMemoriesQuerySchema,
  UpdateMemoryInputSchema,
} from '../contracts/schemas.ts'
import type {
  Clock,
  CreateMemoryInput,
  IdGenerator,
  ListMemoriesQuery,
  MemoryAuthContext,
  MemoryRecord,
  MemoryScope,
  SearchMemoriesQuery,
  UpdateMemoryInput,
} from '../contracts/types.ts'
import { parseSearchQuery, scoreRecordLexical } from '../search/lexical.ts'
import { rankAndDeduplicateMatches } from '../search/ranker.ts'
import {
  authorizeCreateScope,
  getScopeKey,
  isAuthorizedToReadRecord,
  isAuthorizedToReadScope,
  isAuthorizedToWriteRecord,
  resolveAuthorizedScopesForQuery,
  validateAuthContext,
} from '../security/authorization.ts'
import { assertNoCredentialsInFields } from '../security/redaction.ts'
import type { MemoryListResult, MemoryRepository, MemorySearchMatch, MemorySearchResult } from './interface.ts'
import {
  computeContentHash,
  normalizeForDeduplication,
  normalizeStoredContent,
  normalizeTags,
} from './normalization.ts'

export interface InMemoryRepositoryOptions {
  clock?: Clock
  idGenerator?: IdGenerator
}

export class InMemoryMemoryRepository implements MemoryRepository {
  private readonly records = new Map<string, MemoryRecord>()
  private readonly clock: Clock
  private readonly idGenerator: IdGenerator

  constructor(options: InMemoryRepositoryOptions = {}) {
    this.clock = options.clock ?? (() => new Date())
    this.idGenerator = options.idGenerator ?? (() => randomUUID())
  }

  create(rawAuth: MemoryAuthContext, rawInput: CreateMemoryInput): MemoryRecord {
    const auth = validateAuthContext(rawAuth)
    const parsed = CreateMemoryInputSchema.safeParse(rawInput)
    if (!parsed.success) {
      throw new MemoryValidationError(`Invalid create memory input: ${parsed.error.issues[0]?.message ?? 'validation failed'}`)
    }
    const input = parsed.data
    if (input.origin !== 'explicit') {
      throw new MemoryUnsupportedOriginError()
    }
    authorizeCreateScope(auth, input.scope)
    assertNoCredentialsInFields({
      content: input.content,
      tags: input.tags,
      provenanceNote: input.provenanceNote,
      sourceRefs: input.sourceRefs,
    })

    const now = this.clock().toISOString()
    if (input.expiresAt !== null && input.expiresAt <= now) {
      throw new MemoryValidationError('expiresAt must be strictly in the future relative to creation time')
    }

    const content = normalizeStoredContent(input.content)
    const normalizedContent = normalizeForDeduplication(content)
    const contentHash = computeContentHash(normalizedContent)
    const scopeKey = getScopeKey(input.scope)

    for (const existing of this.records.values()) {
      if (existing.status === 'active' && getScopeKey(existing.scope) === scopeKey && existing.contentHash === contentHash) {
        throw new MemoryDuplicateError()
      }
    }

    const id = input.id ?? this.idGenerator()
    if (this.records.has(id)) {
      throw new MemoryValidationError('Memory ID already exists')
    }

    const record = MemoryRecordSchema.parse({
      schemaVersion: MEMORY_SCHEMA_VERSION,
      id,
      scope: input.scope,
      origin: 'explicit',
      category: input.category,
      content,
      normalizedContent,
      contentHash,
      tags: normalizeTags(input.tags),
      provenance: {
        origin: 'explicit',
        createdBy: auth.actorId,
        sourceRefs: input.sourceRefs,
        ...(input.provenanceNote !== undefined ? { note: input.provenanceNote } : {}),
      },
      status: 'active',
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      expiresAt: input.expiresAt,
    })

    this.records.set(record.id, structuredClone(record))
    return structuredClone(record)
  }

  getById(
    rawAuth: MemoryAuthContext,
    id: string,
    options?: { includeUserWide?: boolean; includeArchived?: boolean; includeExpired?: boolean },
  ): MemoryRecord | null {
    const auth = validateAuthContext(rawAuth)
    const record = this.records.get(id)
    if (!record) return null

    const includeUserWide = options?.includeUserWide ?? false
    const includeArchived = options?.includeArchived ?? false
    const includeExpired = options?.includeExpired ?? false

    if (!isAuthorizedToReadRecord(auth, record, { includeUserWide, includeArchived })) {
      return null
    }

    const now = this.clock().toISOString()
    if (!includeExpired && record.expiresAt !== null && record.expiresAt <= now) {
      return null
    }

    return structuredClone(record)
  }

  list(rawAuth: MemoryAuthContext, rawQuery: ListMemoriesQuery = {}): MemoryListResult {
    const auth = validateAuthContext(rawAuth)
    const parsed = ListMemoriesQuerySchema.safeParse(rawQuery)
    if (!parsed.success) {
      throw new MemoryValidationError(`Invalid list query: ${parsed.error.issues[0]?.message ?? 'validation failed'}`)
    }
    const query = parsed.data
    const allowedScopes = resolveAuthorizedScopesForQuery(auth, query.scopeKinds, query.includeUserWide)
    const allowedScopeKeys = new Set(allowedScopes.map(getScopeKey))
    const filterTags = query.tags ? normalizeTags(query.tags) : []
    const now = this.clock().toISOString()

    const matching: MemoryRecord[] = []
    for (const record of this.records.values()) {
      if (!allowedScopeKeys.has(getScopeKey(record.scope))) continue
      if (!isAuthorizedToReadRecord(auth, record, { includeUserWide: query.includeUserWide, includeArchived: query.includeArchived })) {
        continue
      }
      if (!query.includeExpired && record.expiresAt !== null && record.expiresAt <= now) {
        continue
      }
      if (query.category && record.category !== query.category) {
        continue
      }
      if (filterTags.length > 0 && !filterTags.every((t) => record.tags.includes(t))) {
        continue
      }
      matching.push(structuredClone(record))
    }

    matching.sort((a, b) => {
      if (b.updatedAt !== a.updatedAt) return b.updatedAt > a.updatedAt ? 1 : -1
      return a.id.localeCompare(b.id)
    })

    const items = matching.slice(query.offset, query.offset + query.limit)
    return {
      items,
      total: matching.length,
      limit: query.limit,
      offset: query.offset,
    }
  }

  search(rawAuth: MemoryAuthContext, rawQuery: SearchMemoriesQuery): MemorySearchResult {
    const auth = validateAuthContext(rawAuth)
    const parsed = SearchMemoriesQuerySchema.safeParse(rawQuery)
    if (!parsed.success) {
      throw new MemoryValidationError(`Invalid search query: ${parsed.error.issues[0]?.message ?? 'validation failed'}`)
    }
    const query = parsed.data
    const allowedScopes = resolveAuthorizedScopesForQuery(auth, query.scopeKinds, query.includeUserWide)
    const allowedScopeKeys = new Set(allowedScopes.map(getScopeKey))
    const filterTags = query.tags ? normalizeTags(query.tags) : []
    const parsedQuery = parseSearchQuery(query.query)
    const now = this.clock().toISOString()

    if (parsedQuery.tokens.length === 0) {
      return { items: [], engine: 'lexical_fallback', queryTokens: [] }
    }

    const matches: MemorySearchMatch[] = []
    for (const record of this.records.values()) {
      if (!allowedScopeKeys.has(getScopeKey(record.scope))) continue
      if (!isAuthorizedToReadRecord(auth, record, { includeUserWide: query.includeUserWide, includeArchived: false })) {
        continue
      }
      if (record.expiresAt !== null && record.expiresAt <= now) continue
      if (query.category && record.category !== query.category) continue
      if (filterTags.length > 0 && !filterTags.every((t) => record.tags.includes(t))) continue

      const scored = scoreRecordLexical(record, parsedQuery)
      if (scored) {
        matches.push({ ...scored, record: structuredClone(scored.record) })
      }
    }

    const ranked = rankAndDeduplicateMatches(matches, {
      limit: query.limit,
      deduplicateAcrossScopes: query.deduplicateAcrossScopes,
    })

    return {
      items: ranked,
      engine: 'lexical_fallback',
      queryTokens: parsedQuery.tokens,
    }
  }

  update(rawAuth: MemoryAuthContext, id: string, rawInput: UpdateMemoryInput): MemoryRecord {
    const auth = validateAuthContext(rawAuth)
    const parsed = UpdateMemoryInputSchema.safeParse(rawInput)
    if (!parsed.success) {
      throw new MemoryValidationError(`Invalid update input: ${parsed.error.issues[0]?.message ?? 'validation failed'}`)
    }
    const existing = this.records.get(id)
    if (!existing || !isAuthorizedToWriteRecord(auth, existing)) {
      throw new MemoryNotFoundError()
    }
    const input = parsed.data
    assertNoCredentialsInFields({
      content: input.content,
      tags: input.tags,
      provenanceNote: input.provenanceNote,
      sourceRefs: input.sourceRefs,
    })

    const now = this.clock().toISOString()
    if (input.expiresAt !== undefined && input.expiresAt !== null && input.expiresAt <= now) {
      throw new MemoryValidationError('expiresAt must be strictly in the future relative to update time')
    }

    const nextContent = input.content !== undefined ? normalizeStoredContent(input.content) : existing.content
    const nextNormalized = normalizeForDeduplication(nextContent)
    const nextHash = computeContentHash(nextNormalized)
    const scopeKey = getScopeKey(existing.scope)

    if (existing.status === 'active' && nextHash !== existing.contentHash) {
      for (const other of this.records.values()) {
        if (other.id !== id && other.status === 'active' && getScopeKey(other.scope) === scopeKey && other.contentHash === nextHash) {
          throw new MemoryDuplicateError()
        }
      }
    }

    const updated = MemoryRecordSchema.parse({
      ...existing,
      category: input.category ?? existing.category,
      content: nextContent,
      normalizedContent: nextNormalized,
      contentHash: nextHash,
      tags: input.tags !== undefined ? normalizeTags(input.tags) : existing.tags,
      provenance: {
        ...existing.provenance,
        ...(input.sourceRefs !== undefined ? { sourceRefs: input.sourceRefs } : {}),
        ...(input.provenanceNote === null
          ? { note: undefined }
          : input.provenanceNote !== undefined
            ? { note: input.provenanceNote }
            : {}),
      },
      updatedAt: now,
      expiresAt: input.expiresAt !== undefined ? input.expiresAt : existing.expiresAt,
    })

    this.records.set(id, structuredClone(updated))
    return structuredClone(updated)
  }

  archive(rawAuth: MemoryAuthContext, id: string): MemoryRecord {
    const auth = validateAuthContext(rawAuth)
    const existing = this.records.get(id)
    if (!existing || !isAuthorizedToWriteRecord(auth, existing)) {
      throw new MemoryNotFoundError()
    }
    if (existing.status === 'archived') {
      return structuredClone(existing)
    }
    const now = this.clock().toISOString()
    const archived = MemoryRecordSchema.parse({
      ...existing,
      status: 'archived',
      archivedAt: now,
      updatedAt: now,
    })
    this.records.set(id, structuredClone(archived))
    return structuredClone(archived)
  }

  delete(rawAuth: MemoryAuthContext, id: string): boolean {
    const auth = validateAuthContext(rawAuth)
    const existing = this.records.get(id)
    if (!existing || !isAuthorizedToWriteRecord(auth, existing)) {
      throw new MemoryNotFoundError()
    }
    return this.records.delete(id)
  }

  findDuplicate(rawAuth: MemoryAuthContext, rawScope: MemoryScope, content: string): MemoryRecord | null {
    const auth = validateAuthContext(rawAuth)
    const scopeParsed = MemoryScopeSchema.safeParse(rawScope)
    if (!scopeParsed.success) {
      throw new MemoryValidationError('Invalid scope for duplicate check')
    }
    const scope = scopeParsed.data
    if (!isAuthorizedToReadScope(auth, scope, { includeUserWide: scope.kind === 'user' })) {
      return null
    }
    const contentHash = computeContentHash(normalizeForDeduplication(normalizeStoredContent(content)))
    const scopeKey = getScopeKey(scope)
    const now = this.clock().toISOString()

    for (const existing of this.records.values()) {
      if (
        existing.status === 'active' &&
        getScopeKey(existing.scope) === scopeKey &&
        existing.contentHash === contentHash &&
        (existing.expiresAt === null || existing.expiresAt > now)
      ) {
        return structuredClone(existing)
      }
    }
    return null
  }

  close(): void {
    this.records.clear()
  }
}
