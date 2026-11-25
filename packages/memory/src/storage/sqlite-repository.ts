import { randomUUID } from 'node:crypto'
import type { SQLInputValue } from 'node:sqlite'
import {
  MemoryDuplicateError,
  MemoryError,
  MemoryNotFoundError,
  MemoryStorageCorruptionError,
  MemoryStorageError,
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
import type {
  MemoryListResult,
  MemoryRepository,
  MemorySearchMatch,
  MemorySearchResult,
} from '../repository/interface.ts'
import {
  computeContentHash,
  foldVietnameseAccents,
  normalizeForDeduplication,
  normalizeStoredContent,
  normalizeTags,
} from '../repository/normalization.ts'
import { buildSafeFts5MatchQuery } from '../search/fts5.ts'
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
import { assertNoCredentialsInFields, sanitizeErrorMessage } from '../security/redaction.ts'
import type { MemoryDatabaseHandle } from './sqlite-client.ts'

export interface SqliteMemoryRepositoryOptions {
  clock?: Clock
  idGenerator?: IdGenerator
}

interface RawMemoryRow {
  id: unknown
  schema_version: unknown
  scope_kind: unknown
  user_id: unknown
  bot_id: unknown
  workspace_id: unknown
  scope_key: unknown
  origin: unknown
  category: unknown
  content: unknown
  normalized_content: unknown
  content_hash: unknown
  tags_json: unknown
  provenance_json: unknown
  status: unknown
  created_at: unknown
  updated_at: unknown
  archived_at: unknown
  expires_at: unknown
}

function buildScopeFromRow(row: RawMemoryRow): MemoryScope {
  if (row.scope_kind === 'user') {
    return { kind: 'user', userId: String(row.user_id) }
  }
  if (row.scope_kind === 'bot') {
    return { kind: 'bot', userId: String(row.user_id), botId: String(row.bot_id) }
  }
  if (row.scope_kind === 'workspace') {
    return { kind: 'workspace', userId: String(row.user_id), workspaceId: String(row.workspace_id) }
  }
  throw new MemoryStorageCorruptionError('Stored memory row has invalid scope_kind')
}

function decodeMemoryRow(row: RawMemoryRow): MemoryRecord {
  let tags: unknown
  let provenance: unknown
  try {
    if (typeof row.tags_json !== 'string' || typeof row.provenance_json !== 'string') {
      throw new Error('Missing JSON columns')
    }
    tags = JSON.parse(row.tags_json)
    provenance = JSON.parse(row.provenance_json)
  } catch {
    throw new MemoryStorageCorruptionError('Stored memory row contains invalid JSON metadata')
  }

  const candidate = {
    schemaVersion: row.schema_version,
    id: row.id,
    scope: buildScopeFromRow(row),
    origin: row.origin,
    category: row.category,
    content: row.content,
    normalizedContent: row.normalized_content,
    contentHash: row.content_hash,
    tags,
    provenance,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? null,
    expiresAt: row.expires_at ?? null,
  }

  const parsed = MemoryRecordSchema.safeParse(candidate)
  if (!parsed.success) {
    throw new MemoryStorageCorruptionError('Stored memory row failed contract validation')
  }
  return parsed.data
}

function formatFtsTagsText(tags: readonly string[]): string {
  const expanded: string[] = []
  for (const tag of tags) {
    expanded.push(tag)
    const folded = foldVietnameseAccents(tag)
    if (folded !== tag) expanded.push(folded)
  }
  return expanded.join(' ')
}

function formatFtsContentText(content: string): string {
  const folded = foldVietnameseAccents(content)
  return folded === content ? content : `${content}\n${folded}`
}

function isUniqueConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('UNIQUE constraint failed') || msg.includes('ERR_SQLITE_ERROR') && msg.includes('UNIQUE')
}

export class SqliteMemoryRepository implements MemoryRepository {
  private readonly handle: MemoryDatabaseHandle
  private readonly clock: Clock
  private readonly idGenerator: IdGenerator

  constructor(handle: MemoryDatabaseHandle, options: SqliteMemoryRepositoryOptions = {}) {
    this.handle = handle
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
    const tags = normalizeTags(input.tags)
    const id = input.id ?? this.idGenerator()

    const record = MemoryRecordSchema.parse({
      schemaVersion: MEMORY_SCHEMA_VERSION,
      id,
      scope: input.scope,
      origin: 'explicit',
      category: input.category,
      content,
      normalizedContent,
      contentHash,
      tags,
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

    try {
      this.handle.transaction(() => {
        const existingId = this.handle.sqlite
          .prepare('SELECT id FROM memories WHERE id = ?')
          .get(record.id) as { id?: string } | undefined
        if (existingId) {
          throw new MemoryValidationError('Memory ID already exists')
        }

        this.handle.sqlite
          .prepare(
            `INSERT INTO memories (
              id, schema_version, scope_kind, user_id, bot_id, workspace_id, scope_key,
              origin, category, content, normalized_content, content_hash,
              tags_json, provenance_json, status, created_at, updated_at, archived_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            record.id,
            record.schemaVersion,
            record.scope.kind,
            record.scope.userId,
            record.scope.kind === 'bot' ? record.scope.botId : null,
            record.scope.kind === 'workspace' ? record.scope.workspaceId : null,
            scopeKey,
            record.origin,
            record.category,
            record.content,
            record.normalizedContent,
            record.contentHash,
            JSON.stringify(record.tags),
            JSON.stringify(record.provenance),
            record.status,
            record.createdAt,
            record.updatedAt,
            record.archivedAt,
            record.expiresAt,
          )

        if (this.handle.fts5Enabled) {
          this.handle.sqlite
            .prepare('INSERT INTO memories_fts (memory_id, content, tags_text) VALUES (?, ?, ?)')
            .run(record.id, formatFtsContentText(record.content), formatFtsTagsText(record.tags))
        }
      })
    } catch (err) {
      if (err instanceof MemoryError) throw err
      if (isUniqueConstraintError(err)) {
        throw new MemoryDuplicateError()
      }
      throw new MemoryStorageError(`Failed to persist memory: ${sanitizeErrorMessage(err)}`)
    }

    return record
  }

  getById(
    rawAuth: MemoryAuthContext,
    id: string,
    options?: { includeUserWide?: boolean; includeArchived?: boolean; includeExpired?: boolean },
  ): MemoryRecord | null {
    const auth = validateAuthContext(rawAuth)
    const row = this.handle.sqlite
      .prepare('SELECT * FROM memories WHERE id = ?')
      .get(id) as RawMemoryRow | undefined

    if (!row) return null
    const record = decodeMemoryRow(row)

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

    return record
  }

  list(rawAuth: MemoryAuthContext, rawQuery: ListMemoriesQuery = {}): MemoryListResult {
    const auth = validateAuthContext(rawAuth)
    const parsed = ListMemoriesQuerySchema.safeParse(rawQuery)
    if (!parsed.success) {
      throw new MemoryValidationError(`Invalid list query: ${parsed.error.issues[0]?.message ?? 'validation failed'}`)
    }
    const query = parsed.data
    const allowedScopes = resolveAuthorizedScopesForQuery(auth, query.scopeKinds, query.includeUserWide)
    if (allowedScopes.length === 0) {
      return { items: [], total: 0, limit: query.limit, offset: query.offset }
    }

    const scopeKeys = allowedScopes.map(getScopeKey)
    const placeholders = scopeKeys.map(() => '?').join(', ')
    const whereClauses: string[] = [`scope_key IN (${placeholders})`, 'user_id = ?']
    const params: SQLInputValue[] = [...scopeKeys, auth.userId]

    if (!(query.includeArchived && auth.allowArchivedRead === true)) {
      whereClauses.push("status = 'active'")
    }

    const now = this.clock().toISOString()
    if (!query.includeExpired) {
      whereClauses.push('(expires_at IS NULL OR expires_at > ?)')
      params.push(now)
    }

    if (query.category) {
      whereClauses.push('category = ?')
      params.push(query.category)
    }

    const filterTags = query.tags ? normalizeTags(query.tags) : []
    const sql = `SELECT * FROM memories WHERE ${whereClauses.join(' AND ')} ORDER BY updated_at DESC, id ASC`

    const rows = this.handle.sqlite.prepare(sql).all(...params) as unknown as RawMemoryRow[]
    const decoded = rows.map(decodeMemoryRow).filter((rec) => {
      if (!isAuthorizedToReadRecord(auth, rec, { includeUserWide: query.includeUserWide, includeArchived: query.includeArchived })) {
        return false
      }
      if (filterTags.length > 0 && !filterTags.every((t) => rec.tags.includes(t))) {
        return false
      }
      return true
    })

    const items = decoded.slice(query.offset, query.offset + query.limit)
    return {
      items,
      total: decoded.length,
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
    const parsedQuery = parseSearchQuery(query.query)
    const engine: MemorySearchResult['engine'] = this.handle.fts5Enabled ? 'fts5' : 'lexical_fallback'

    if (allowedScopes.length === 0 || parsedQuery.tokens.length === 0) {
      return { items: [], engine, queryTokens: parsedQuery.tokens }
    }

    const scopeKeys = allowedScopes.map(getScopeKey)
    const placeholders = scopeKeys.map(() => '?').join(', ')
    const now = this.clock().toISOString()
    const whereClauses: string[] = [
      `m.scope_key IN (${placeholders})`,
      'm.user_id = ?',
      "m.status = 'active'",
      '(m.expires_at IS NULL OR m.expires_at > ?)',
    ]
    const params: SQLInputValue[] = [...scopeKeys, auth.userId, now]

    if (query.category) {
      whereClauses.push('m.category = ?')
      params.push(query.category)
    }

    let rows: RawMemoryRow[]
    const ftsMatchQuery = this.handle.fts5Enabled ? buildSafeFts5MatchQuery(parsedQuery.tokens) : null

    if (this.handle.fts5Enabled && ftsMatchQuery !== null) {
      const sql = `
        SELECT m.*
        FROM memories_fts f
        INNER JOIN memories m ON m.id = f.memory_id
        WHERE ${whereClauses.join(' AND ')} AND memories_fts MATCH ?
      `
      rows = this.handle.sqlite.prepare(sql).all(...params, ftsMatchQuery) as unknown as RawMemoryRow[]
    } else {
      const sql = `SELECT m.* FROM memories m WHERE ${whereClauses.join(' AND ')}`
      rows = this.handle.sqlite.prepare(sql).all(...params) as unknown as RawMemoryRow[]
    }

    const filterTags = query.tags ? normalizeTags(query.tags) : []
    const matches: MemorySearchMatch[] = []

    for (const row of rows) {
      const record = decodeMemoryRow(row)
      if (!isAuthorizedToReadRecord(auth, record, { includeUserWide: query.includeUserWide, includeArchived: false })) {
        continue
      }
      if (filterTags.length > 0 && !filterTags.every((t) => record.tags.includes(t))) {
        continue
      }
      const scored = scoreRecordLexical(record, parsedQuery)
      if (scored) {
        matches.push(scored)
      }
    }

    const ranked = rankAndDeduplicateMatches(matches, {
      limit: query.limit,
      deduplicateAcrossScopes: query.deduplicateAcrossScopes,
    })

    return {
      items: ranked,
      engine,
      queryTokens: parsedQuery.tokens,
    }
  }

  update(rawAuth: MemoryAuthContext, id: string, rawInput: UpdateMemoryInput): MemoryRecord {
    const auth = validateAuthContext(rawAuth)
    const parsed = UpdateMemoryInputSchema.safeParse(rawInput)
    if (!parsed.success) {
      throw new MemoryValidationError(`Invalid update input: ${parsed.error.issues[0]?.message ?? 'validation failed'}`)
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

    try {
      return this.handle.transaction(() => {
        const row = this.handle.sqlite
          .prepare('SELECT * FROM memories WHERE id = ?')
          .get(id) as RawMemoryRow | undefined
        if (!row) {
          throw new MemoryNotFoundError()
        }
        const existing = decodeMemoryRow(row)
        if (!isAuthorizedToWriteRecord(auth, existing)) {
          throw new MemoryNotFoundError()
        }

        const nextContent = input.content !== undefined ? normalizeStoredContent(input.content) : existing.content
        const nextNormalized = normalizeForDeduplication(nextContent)
        const nextHash = computeContentHash(nextNormalized)
        const nextTags = input.tags !== undefined ? normalizeTags(input.tags) : existing.tags

        const updated = MemoryRecordSchema.parse({
          ...existing,
          category: input.category ?? existing.category,
          content: nextContent,
          normalizedContent: nextNormalized,
          contentHash: nextHash,
          tags: nextTags,
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

        this.handle.sqlite
          .prepare(
            `UPDATE memories SET
              category = ?,
              content = ?,
              normalized_content = ?,
              content_hash = ?,
              tags_json = ?,
              provenance_json = ?,
              updated_at = ?,
              expires_at = ?
            WHERE id = ?`,
          )
          .run(
            updated.category,
            updated.content,
            updated.normalizedContent,
            updated.contentHash,
            JSON.stringify(updated.tags),
            JSON.stringify(updated.provenance),
            updated.updatedAt,
            updated.expiresAt,
            updated.id,
          )

        if (this.handle.fts5Enabled) {
          this.handle.sqlite.prepare('DELETE FROM memories_fts WHERE memory_id = ?').run(updated.id)
          this.handle.sqlite
            .prepare('INSERT INTO memories_fts (memory_id, content, tags_text) VALUES (?, ?, ?)')
            .run(updated.id, formatFtsContentText(updated.content), formatFtsTagsText(updated.tags))
        }

        return updated
      })
    } catch (err) {
      if (err instanceof MemoryError) throw err
      if (isUniqueConstraintError(err)) {
        throw new MemoryDuplicateError()
      }
      throw new MemoryStorageError(`Failed to update memory: ${sanitizeErrorMessage(err)}`)
    }
  }

  archive(rawAuth: MemoryAuthContext, id: string): MemoryRecord {
    const auth = validateAuthContext(rawAuth)
    const now = this.clock().toISOString()

    try {
      return this.handle.transaction(() => {
        const row = this.handle.sqlite
          .prepare('SELECT * FROM memories WHERE id = ?')
          .get(id) as RawMemoryRow | undefined
        if (!row) {
          throw new MemoryNotFoundError()
        }
        const existing = decodeMemoryRow(row)
        if (!isAuthorizedToWriteRecord(auth, existing)) {
          throw new MemoryNotFoundError()
        }
        if (existing.status === 'archived') {
          return existing
        }

        const archived = MemoryRecordSchema.parse({
          ...existing,
          status: 'archived',
          archivedAt: now,
          updatedAt: now,
        })

        this.handle.sqlite
          .prepare("UPDATE memories SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?")
          .run(archived.archivedAt, archived.updatedAt, archived.id)

        return archived
      })
    } catch (err) {
      if (err instanceof MemoryError) throw err
      throw new MemoryStorageError(`Failed to archive memory: ${sanitizeErrorMessage(err)}`)
    }
  }

  delete(rawAuth: MemoryAuthContext, id: string): boolean {
    const auth = validateAuthContext(rawAuth)

    try {
      return this.handle.transaction(() => {
        const row = this.handle.sqlite
          .prepare('SELECT * FROM memories WHERE id = ?')
          .get(id) as RawMemoryRow | undefined
        if (!row) {
          throw new MemoryNotFoundError()
        }
        const existing = decodeMemoryRow(row)
        if (!isAuthorizedToWriteRecord(auth, existing)) {
          throw new MemoryNotFoundError()
        }

        const result = this.handle.sqlite.prepare('DELETE FROM memories WHERE id = ?').run(id)
        if (this.handle.fts5Enabled) {
          this.handle.sqlite.prepare('DELETE FROM memories_fts WHERE memory_id = ?').run(id)
        }
        return result.changes > 0
      })
    } catch (err) {
      if (err instanceof MemoryError) throw err
      throw new MemoryStorageError(`Failed to delete memory: ${sanitizeErrorMessage(err)}`)
    }
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

    const row = this.handle.sqlite
      .prepare(
        `SELECT * FROM memories
         WHERE scope_key = ? AND content_hash = ? AND status = 'active'
           AND (expires_at IS NULL OR expires_at > ?)
         LIMIT 1`,
      )
      .get(scopeKey, contentHash, now) as RawMemoryRow | undefined

    if (!row) return null
    const record = decodeMemoryRow(row)
    return isAuthorizedToReadRecord(auth, record, { includeUserWide: scope.kind === 'user', includeArchived: false })
      ? record
      : null
  }

  close(): void {
    this.handle.close()
  }
}
