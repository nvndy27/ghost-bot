import { randomUUID } from 'node:crypto'
import type { SQLInputValue } from 'node:sqlite'
import { buildSafeFts5MatchQuery, foldVietnameseAccents, normalizeTags } from '@ghost-bot/memory'
import { buildKnowledgeCitation } from '../citations/builder.ts'
import {
  KnowledgeAuthorizationError,
  KnowledgeDuplicateError,
  KnowledgeError,
  KnowledgeNotFoundError,
  KnowledgeStorageCorruptionError,
  KnowledgeStorageError,
  KnowledgeValidationError,
} from '../contracts/errors.ts'
import { KNOWLEDGE_LIMITS, KNOWLEDGE_SCHEMA_VERSION } from '../contracts/limits.ts'
import {
  ChunkIdSchema,
  CreateCollectionInputSchema,
  DocumentIdSchema,
  KnowledgeChunkSchema,
  KnowledgeCollectionSchema,
  KnowledgeDocumentRevisionSchema,
  KnowledgeDocumentSchema,
  ListDocumentsQuerySchema,
  RevisionIdSchema,
  SearchKnowledgeQuerySchema,
  Sha256HexSchema,
  UpdateDocumentMetadataInputSchema,
} from '../contracts/schemas.ts'
import type {
  Clock,
  CreateCollectionInput,
  IdGenerator,
  KnowledgeAuthContext,
  KnowledgeChunk,
  KnowledgeCitation,
  KnowledgeCollection,
  KnowledgeDocument,
  KnowledgeScope,
  ListDocumentsQuery,
  SearchKnowledgeQuery,
  UpdateDocumentMetadataInput,
} from '../contracts/types.ts'
import type {
  KnowledgeListResult,
  KnowledgeRepository,
  KnowledgeSearchResult,
  PersistedDocumentResult,
  PersistPreparedDocumentInput,
} from '../repository/interface.ts'
import { parseKnowledgeQuery, scoreKnowledgeChunk, type KnowledgeSearchMatch } from '../retrieval/lexical.ts'
import { rankAndSuppressChunks } from '../retrieval/ranker.ts'
import {
  authorizeKnowledgeCreateScope,
  getScopeKey,
  isAuthorizedToReadKnowledgeScope,
  isAuthorizedToWriteKnowledgeScope,
  resolveAuthorizedKnowledgeScopes,
  validateKnowledgeAuthContext,
} from '../security/authorization.ts'
import { assertNoCredentialsInKnowledgeFields, sanitizeErrorMessage } from '../security/redaction.ts'
import type { KnowledgeDatabaseHandle } from './sqlite-client.ts'

export interface SqliteKnowledgeRepositoryOptions {
  clock?: Clock
  idGenerator?: IdGenerator
}

function buildScopeFromRow(row: Record<string, unknown>): KnowledgeScope {
  if (row.scope_kind === 'user') return { kind: 'user', userId: String(row.user_id) }
  if (row.scope_kind === 'bot') return { kind: 'bot', userId: String(row.user_id), botId: String(row.bot_id) }
  if (row.scope_kind === 'workspace') {
    return { kind: 'workspace', userId: String(row.user_id), workspaceId: String(row.workspace_id) }
  }
  throw new KnowledgeStorageCorruptionError('Stored knowledge row has invalid scope_kind')
}

function decodeCollectionRow(row: Record<string, unknown>): KnowledgeCollection {
  const parsed = KnowledgeCollectionSchema.safeParse({
    schemaVersion: row.schema_version,
    id: row.id,
    scope: buildScopeFromRow(row),
    name: row.name,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? null,
  })
  if (!parsed.success) {
    throw new KnowledgeStorageCorruptionError('Stored collection row failed contract validation')
  }
  return parsed.data
}

function decodeDocumentRow(row: Record<string, unknown>): KnowledgeDocument {
  let tags: unknown
  try {
    if (typeof row.tags_json !== 'string') throw new Error('Missing tags_json')
    tags = JSON.parse(row.tags_json)
  } catch {
    throw new KnowledgeStorageCorruptionError('Stored document row contains invalid JSON tags')
  }
  const parsed = KnowledgeDocumentSchema.safeParse({
    schemaVersion: row.schema_version,
    id: row.id,
    collectionId: row.collection_id ?? null,
    scope: buildScopeFromRow(row),
    title: row.title,
    sourceType: row.source_type,
    mediaType: row.media_type,
    displayFilename: row.display_filename ?? null,
    tags,
    status: row.status,
    currentRevisionId: row.current_revision_id,
    rawFingerprint: row.raw_fingerprint,
    extractedFingerprint: row.extracted_fingerprint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? null,
  })
  if (!parsed.success) {
    throw new KnowledgeStorageCorruptionError('Stored document row failed contract validation')
  }
  return parsed.data
}

function decodeChunkRow(row: Record<string, unknown>): KnowledgeChunk {
  let location: unknown
  try {
    if (typeof row.location_json !== 'string') throw new Error('Missing location_json')
    location = JSON.parse(row.location_json)
  } catch {
    throw new KnowledgeStorageCorruptionError('Stored chunk row contains invalid JSON location')
  }
  const parsed = KnowledgeChunkSchema.safeParse({
    schemaVersion: row.schema_version,
    id: row.id,
    documentId: row.document_id,
    revisionId: row.revision_id,
    scope: buildScopeFromRow(row),
    chunkIndex: row.chunk_index,
    content: row.content,
    normalizedContent: row.normalized_content,
    contentHash: row.content_hash,
    location,
    createdAt: row.created_at,
  })
  if (!parsed.success) {
    throw new KnowledgeStorageCorruptionError('Stored chunk row failed contract validation')
  }
  return parsed.data
}

function formatFtsContent(text: string): string {
  const folded = foldVietnameseAccents(text)
  return folded === text ? text : `${text}\n${folded}`
}

function formatFtsTitleAndTags(title: string, tags: readonly string[]): string {
  const parts = [title, foldVietnameseAccents(title)]
  for (const tag of tags) {
    parts.push(tag)
    const folded = foldVietnameseAccents(tag)
    if (folded !== tag) parts.push(folded)
  }
  return parts.join(' ')
}

function isUniqueConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('UNIQUE constraint failed') || (msg.includes('ERR_SQLITE_ERROR') && msg.includes('UNIQUE'))
}

export class SqliteKnowledgeRepository implements KnowledgeRepository {
  private readonly handle: KnowledgeDatabaseHandle
  private readonly clock: Clock
  private readonly idGenerator: IdGenerator
  private closed = false

  constructor(handle: KnowledgeDatabaseHandle, options: SqliteKnowledgeRepositoryOptions = {}) {
    this.handle = handle
    this.clock = options.clock ?? (() => new Date())
    this.idGenerator = options.idGenerator ?? (() => randomUUID())
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new KnowledgeStorageError('Knowledge repository is closed')
    }
  }

  private nowIso(): string {
    const d = this.clock()
    if (!(d instanceof Date) || !Number.isFinite(d.getTime())) {
      throw new KnowledgeValidationError('Repository clock returned an invalid Date')
    }
    return d.toISOString()
  }

  private nextId(label: string): string {
    const id = this.idGenerator()
    if (!DocumentIdSchema.safeParse(id).success) {
      throw new KnowledgeValidationError(`Generated ${label} ID is invalid`)
    }
    return id
  }

  private assertCollectionAccessibleInTx(collectionId: string, scopeKey: string): void {
    const row = this.handle.sqlite
      .prepare('SELECT * FROM knowledge_collections WHERE id = ?')
      .get(collectionId) as Record<string, unknown> | undefined
    if (!row) {
      throw new KnowledgeNotFoundError('Target knowledge collection not found or not accessible')
    }
    const collection = decodeCollectionRow(row)
    if (collection.status !== 'active' || getScopeKey(collection.scope) !== scopeKey) {
      throw new KnowledgeAuthorizationError('Target knowledge collection does not match document scope')
    }
  }

  createCollection(rawAuth: KnowledgeAuthContext, rawInput: CreateCollectionInput): KnowledgeCollection {
    this.assertOpen()
    const auth = validateKnowledgeAuthContext(rawAuth)
    const parsed = CreateCollectionInputSchema.safeParse(rawInput)
    if (!parsed.success) {
      throw new KnowledgeValidationError(
        `Invalid create collection input: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
      )
    }
    const input = parsed.data
    authorizeKnowledgeCreateScope(auth, input.scope)
    assertNoCredentialsInKnowledgeFields({
      collectionName: input.name,
      collectionDescription: input.description,
    })

    const id = input.id ?? this.nextId('collection')
    const now = this.nowIso()
    const scopeKey = getScopeKey(input.scope)

    const collection = KnowledgeCollectionSchema.parse({
      schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
      id,
      scope: input.scope,
      name: input.name,
      description: input.description,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    })

    try {
      this.handle.transaction(() => {
        this.handle.sqlite
          .prepare(
            `INSERT INTO knowledge_collections (
              id, schema_version, scope_kind, user_id, bot_id, workspace_id, scope_key,
              name, description, status, created_at, updated_at, archived_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            collection.id,
            collection.schemaVersion,
            collection.scope.kind,
            collection.scope.userId,
            collection.scope.kind === 'bot' ? collection.scope.botId : null,
            collection.scope.kind === 'workspace' ? collection.scope.workspaceId : null,
            scopeKey,
            collection.name,
            collection.description,
            collection.status,
            collection.createdAt,
            collection.updatedAt,
            collection.archivedAt,
          )
      })
    } catch (err) {
      if (err instanceof KnowledgeError) throw err
      if (isUniqueConstraintError(err)) {
        throw new KnowledgeDuplicateError('An active collection with this name already exists in this scope')
      }
      throw new KnowledgeStorageError(`Failed to create collection: ${sanitizeErrorMessage(err)}`)
    }

    return collection
  }

  listCollections(
    rawAuth: KnowledgeAuthContext,
    options?: { includeUserWide?: boolean; includeArchived?: boolean },
  ): KnowledgeCollection[] {
    this.assertOpen()
    const auth = validateKnowledgeAuthContext(rawAuth)
    const includeUserWide = options?.includeUserWide ?? false
    const includeArchived = options?.includeArchived ?? false
    const allowedScopes = resolveAuthorizedKnowledgeScopes(auth, undefined, includeUserWide)
    if (allowedScopes.length === 0) return []

    const scopeKeys = allowedScopes.map(getScopeKey)
    const placeholders = scopeKeys.map(() => '?').join(', ')
    const where = [`scope_key IN (${placeholders})`, 'user_id = ?']
    if (!(includeArchived && auth.allowArchivedRead === true)) {
      where.push("status = 'active'")
    }

    const rows = this.handle.sqlite
      .prepare(`SELECT * FROM knowledge_collections WHERE ${where.join(' AND ')} ORDER BY name ASC, id ASC`)
      .all(...scopeKeys, auth.userId) as unknown as Array<Record<string, unknown>>

    return rows
      .map(decodeCollectionRow)
      .filter((col) => isAuthorizedToReadKnowledgeScope(auth, col.scope, { includeUserWide }))
  }

  persistDocument(rawAuth: KnowledgeAuthContext, input: PersistPreparedDocumentInput): PersistedDocumentResult {
    this.assertOpen()
    const auth = validateKnowledgeAuthContext(rawAuth)
    authorizeKnowledgeCreateScope(auth, input.scope)
    if (input.chunks.length === 0 || input.chunks.length > KNOWLEDGE_LIMITS.maxChunksPerDocument) {
      throw new KnowledgeValidationError('Invalid chunk count for document persistence')
    }

    const documentId = input.documentId ?? this.nextId('document')
    if (!DocumentIdSchema.safeParse(documentId).success) {
      throw new KnowledgeValidationError('Invalid document ID')
    }
    const revisionId = this.nextId('revision')
    const now = this.nowIso()
    const scopeKey = getScopeKey(input.scope)
    const tags = normalizeTags(input.tags)

    const document = KnowledgeDocumentSchema.parse({
      schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
      id: documentId,
      collectionId: input.collectionId,
      scope: input.scope,
      title: input.title,
      sourceType: input.sourceType,
      mediaType: input.mediaType,
      displayFilename: input.displayFilename,
      tags,
      status: 'ready',
      currentRevisionId: revisionId,
      rawFingerprint: input.rawFingerprint,
      extractedFingerprint: input.extractedFingerprint,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    })

    const revision = KnowledgeDocumentRevisionSchema.parse({
      schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
      id: revisionId,
      documentId: document.id,
      revisionNumber: 1,
      rawFingerprint: input.rawFingerprint,
      extractedFingerprint: input.extractedFingerprint,
      charCount: input.charCount,
      chunkCount: input.chunks.length,
      createdAt: now,
    })

    const chunks = input.chunks.map((c) =>
      KnowledgeChunkSchema.parse({
        schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
        id: this.nextId('chunk'),
        documentId: document.id,
        revisionId: revision.id,
        scope: document.scope,
        chunkIndex: c.chunkIndex,
        content: c.content,
        normalizedContent: c.normalizedContent,
        contentHash: c.contentHash,
        location: c.location,
        createdAt: now,
      }),
    )

    try {
      this.handle.transaction(() => {
        if (document.collectionId !== null) {
          this.assertCollectionAccessibleInTx(document.collectionId, scopeKey)
        }

        const existingId = this.handle.sqlite
          .prepare('SELECT id FROM knowledge_documents WHERE id = ?')
          .get(document.id)
        if (existingId) {
          throw new KnowledgeValidationError('Document ID already exists')
        }

        this.handle.sqlite
          .prepare(
            `INSERT INTO knowledge_documents (
              id, schema_version, collection_id, scope_kind, user_id, bot_id, workspace_id, scope_key,
              title, source_type, media_type, display_filename, tags_json, status, current_revision_id,
              raw_fingerprint, extracted_fingerprint, created_at, updated_at, archived_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            document.id,
            document.schemaVersion,
            document.collectionId,
            document.scope.kind,
            document.scope.userId,
            document.scope.kind === 'bot' ? document.scope.botId : null,
            document.scope.kind === 'workspace' ? document.scope.workspaceId : null,
            scopeKey,
            document.title,
            document.sourceType,
            document.mediaType,
            document.displayFilename,
            JSON.stringify(document.tags),
            document.status,
            document.currentRevisionId,
            document.rawFingerprint,
            document.extractedFingerprint,
            document.createdAt,
            document.updatedAt,
            document.archivedAt,
          )

        this.handle.sqlite
          .prepare(
            `INSERT INTO knowledge_document_revisions (
              id, schema_version, document_id, revision_number,
              raw_fingerprint, extracted_fingerprint, char_count, chunk_count, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            revision.id,
            revision.schemaVersion,
            revision.documentId,
            revision.revisionNumber,
            revision.rawFingerprint,
            revision.extractedFingerprint,
            revision.charCount,
            revision.chunkCount,
            revision.createdAt,
          )

        this.insertChunksAndFtsInTx(document, chunks, scopeKey)
      })
    } catch (err) {
      if (err instanceof KnowledgeError) throw err
      if (isUniqueConstraintError(err)) {
        throw new KnowledgeDuplicateError()
      }
      throw new KnowledgeStorageError(`Failed to persist document: ${sanitizeErrorMessage(err)}`)
    }

    return { document, revision, chunks }
  }

  replaceDocument(
    rawAuth: KnowledgeAuthContext,
    documentId: string,
    input: PersistPreparedDocumentInput,
  ): PersistedDocumentResult {
    this.assertOpen()
    const auth = validateKnowledgeAuthContext(rawAuth)
    if (!DocumentIdSchema.safeParse(documentId).success) {
      throw new KnowledgeValidationError('Invalid document ID')
    }
    if (input.chunks.length === 0 || input.chunks.length > KNOWLEDGE_LIMITS.maxChunksPerDocument) {
      throw new KnowledgeValidationError('Invalid chunk count for document replacement')
    }

    const now = this.nowIso()
    const newRevisionId = this.nextId('revision')
    const tags = normalizeTags(input.tags)

    try {
      return this.handle.transaction(() => {
        const docRow = this.handle.sqlite
          .prepare('SELECT * FROM knowledge_documents WHERE id = ?')
          .get(documentId) as Record<string, unknown> | undefined
        if (!docRow) throw new KnowledgeNotFoundError()
        const existing = decodeDocumentRow(docRow)
        if (!isAuthorizedToWriteKnowledgeScope(auth, existing.scope)) {
          throw new KnowledgeNotFoundError()
        }
        if (existing.status === 'archived') {
          throw new KnowledgeValidationError('Cannot replace an archived document')
        }
        const scopeKey = getScopeKey(existing.scope)
        if (getScopeKey(input.scope) !== scopeKey) {
          throw new KnowledgeAuthorizationError('Cannot change document scope during replacement')
        }
        if (input.collectionId !== null) {
          this.assertCollectionAccessibleInTx(input.collectionId, scopeKey)
        }

        const maxRevRow = this.handle.sqlite
          .prepare('SELECT MAX(revision_number) AS max_rev FROM knowledge_document_revisions WHERE document_id = ?')
          .get(existing.id) as { max_rev?: unknown } | undefined
        const nextRevNum = Number(maxRevRow?.max_rev ?? 0) + 1

        const updatedDoc = KnowledgeDocumentSchema.parse({
          ...existing,
          collectionId: input.collectionId,
          title: input.title,
          sourceType: input.sourceType,
          mediaType: input.mediaType,
          displayFilename: input.displayFilename,
          tags,
          currentRevisionId: newRevisionId,
          rawFingerprint: input.rawFingerprint,
          extractedFingerprint: input.extractedFingerprint,
          updatedAt: now,
        })

        const revision = KnowledgeDocumentRevisionSchema.parse({
          schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
          id: newRevisionId,
          documentId: updatedDoc.id,
          revisionNumber: nextRevNum,
          rawFingerprint: input.rawFingerprint,
          extractedFingerprint: input.extractedFingerprint,
          charCount: input.charCount,
          chunkCount: input.chunks.length,
          createdAt: now,
        })

        const chunks = input.chunks.map((c) =>
          KnowledgeChunkSchema.parse({
            schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
            id: this.nextId('chunk'),
            documentId: updatedDoc.id,
            revisionId: revision.id,
            scope: updatedDoc.scope,
            chunkIndex: c.chunkIndex,
            content: c.content,
            normalizedContent: c.normalizedContent,
            contentHash: c.contentHash,
            location: c.location,
            createdAt: now,
          }),
        )

        this.handle.sqlite
          .prepare(
            `UPDATE knowledge_documents SET
              collection_id = ?, title = ?, source_type = ?, media_type = ?, display_filename = ?,
              tags_json = ?, current_revision_id = ?, raw_fingerprint = ?, extracted_fingerprint = ?,
              updated_at = ?
            WHERE id = ?`,
          )
          .run(
            updatedDoc.collectionId,
            updatedDoc.title,
            updatedDoc.sourceType,
            updatedDoc.mediaType,
            updatedDoc.displayFilename,
            JSON.stringify(updatedDoc.tags),
            updatedDoc.currentRevisionId,
            updatedDoc.rawFingerprint,
            updatedDoc.extractedFingerprint,
            updatedDoc.updatedAt,
            updatedDoc.id,
          )

        this.handle.sqlite
          .prepare(
            `INSERT INTO knowledge_document_revisions (
              id, schema_version, document_id, revision_number,
              raw_fingerprint, extracted_fingerprint, char_count, chunk_count, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            revision.id,
            revision.schemaVersion,
            revision.documentId,
            revision.revisionNumber,
            revision.rawFingerprint,
            revision.extractedFingerprint,
            revision.charCount,
            revision.chunkCount,
            revision.createdAt,
          )

        if (this.handle.fts5Enabled) {
          this.handle.sqlite.prepare('DELETE FROM knowledge_chunks_fts WHERE document_id = ?').run(updatedDoc.id)
        }
        this.insertChunksAndFtsInTx(updatedDoc, chunks, scopeKey)

        return { document: updatedDoc, revision, chunks }
      })
    } catch (err) {
      if (err instanceof KnowledgeError) throw err
      if (isUniqueConstraintError(err)) {
        throw new KnowledgeDuplicateError()
      }
      throw new KnowledgeStorageError(`Failed to replace document: ${sanitizeErrorMessage(err)}`)
    }
  }

  private insertChunksAndFtsInTx(
    document: KnowledgeDocument,
    chunks: readonly KnowledgeChunk[],
    scopeKey: string,
  ): void {
    const chunkStmt = this.handle.sqlite.prepare(
      `INSERT INTO knowledge_chunks (
        id, schema_version, document_id, revision_id,
        scope_kind, user_id, bot_id, workspace_id, scope_key,
        chunk_index, content, normalized_content, content_hash, location_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const ftsStmt = this.handle.fts5Enabled
      ? this.handle.sqlite.prepare(
          'INSERT INTO knowledge_chunks_fts (chunk_id, document_id, revision_id, content, title_and_tags) VALUES (?, ?, ?, ?, ?)',
        )
      : null
    const titleAndTags = formatFtsTitleAndTags(document.title, document.tags)

    for (const chunk of chunks) {
      chunkStmt.run(
        chunk.id,
        chunk.schemaVersion,
        chunk.documentId,
        chunk.revisionId,
        chunk.scope.kind,
        chunk.scope.userId,
        chunk.scope.kind === 'bot' ? chunk.scope.botId : null,
        chunk.scope.kind === 'workspace' ? chunk.scope.workspaceId : null,
        scopeKey,
        chunk.chunkIndex,
        chunk.content,
        chunk.normalizedContent,
        chunk.contentHash,
        JSON.stringify(chunk.location),
        chunk.createdAt,
      )
      if (ftsStmt) {
        ftsStmt.run(chunk.id, chunk.documentId, chunk.revisionId, formatFtsContent(chunk.content), titleAndTags)
      }
    }
  }

  getDocumentById(
    rawAuth: KnowledgeAuthContext,
    documentId: string,
    options?: { includeUserWide?: boolean; includeArchived?: boolean },
  ): KnowledgeDocument | null {
    this.assertOpen()
    const auth = validateKnowledgeAuthContext(rawAuth)
    if (!DocumentIdSchema.safeParse(documentId).success) return null

    const row = this.handle.sqlite
      .prepare('SELECT * FROM knowledge_documents WHERE id = ?')
      .get(documentId) as Record<string, unknown> | undefined
    if (!row) return null
    const doc = decodeDocumentRow(row)

    const includeUserWide = options?.includeUserWide ?? false
    const includeArchived = options?.includeArchived ?? false
    if (!isAuthorizedToReadKnowledgeScope(auth, doc.scope, { includeUserWide })) return null
    if (doc.status === 'archived' && !(includeArchived && auth.allowArchivedRead === true)) return null
    return doc
  }

  listDocuments(rawAuth: KnowledgeAuthContext, rawQuery: ListDocumentsQuery = {}): KnowledgeListResult {
    this.assertOpen()
    const auth = validateKnowledgeAuthContext(rawAuth)
    const parsed = ListDocumentsQuerySchema.safeParse(rawQuery)
    if (!parsed.success) {
      throw new KnowledgeValidationError(
        `Invalid list documents query: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
      )
    }
    const query = parsed.data
    const allowedScopes = resolveAuthorizedKnowledgeScopes(auth, query.scopeKinds, query.includeUserWide)
    if (allowedScopes.length === 0) {
      return { items: [], total: 0, limit: query.limit, offset: query.offset }
    }

    const scopeKeys = allowedScopes.map(getScopeKey)
    const placeholders = scopeKeys.map(() => '?').join(', ')
    const where = [`scope_key IN (${placeholders})`, 'user_id = ?']
    const params: SQLInputValue[] = [...scopeKeys, auth.userId]

    if (!(query.includeArchived && auth.allowArchivedRead === true)) {
      where.push("status = 'ready'")
    }
    if (query.collectionId) {
      where.push('collection_id = ?')
      params.push(query.collectionId)
    }

    const filterTags = query.tags ? normalizeTags(query.tags) : []
    const rows = this.handle.sqlite
      .prepare(`SELECT * FROM knowledge_documents WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id ASC`)
      .all(...params) as unknown as Array<Record<string, unknown>>

    const docs = rows.map(decodeDocumentRow).filter((doc) => {
      if (!isAuthorizedToReadKnowledgeScope(auth, doc.scope, { includeUserWide: query.includeUserWide })) {
        return false
      }
      if (filterTags.length > 0 && !filterTags.every((t) => doc.tags.includes(t))) {
        return false
      }
      return true
    })

    return {
      items: docs.slice(query.offset, query.offset + query.limit),
      total: docs.length,
      limit: query.limit,
      offset: query.offset,
    }
  }

  getDocumentChunks(
    rawAuth: KnowledgeAuthContext,
    documentId: string,
    options?: { includeUserWide?: boolean; includeArchived?: boolean },
  ): KnowledgeChunk[] {
    const doc = this.getDocumentById(rawAuth, documentId, options)
    if (!doc) return []

    const rows = this.handle.sqlite
      .prepare('SELECT * FROM knowledge_chunks WHERE document_id = ? AND revision_id = ? ORDER BY chunk_index ASC')
      .all(doc.id, doc.currentRevisionId) as unknown as Array<Record<string, unknown>>

    return rows.map(decodeChunkRow)
  }

  updateDocumentMetadata(
    rawAuth: KnowledgeAuthContext,
    documentId: string,
    rawInput: UpdateDocumentMetadataInput,
  ): KnowledgeDocument {
    this.assertOpen()
    const auth = validateKnowledgeAuthContext(rawAuth)
    if (!DocumentIdSchema.safeParse(documentId).success) {
      throw new KnowledgeValidationError('Invalid document ID')
    }
    const parsed = UpdateDocumentMetadataInputSchema.safeParse(rawInput)
    if (!parsed.success) {
      throw new KnowledgeValidationError(
        `Invalid update metadata input: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
      )
    }
    const input = parsed.data
    assertNoCredentialsInKnowledgeFields({
      title: input.title,
      tags: input.tags,
    })

    const now = this.nowIso()
    return this.handle.transaction(() => {
      const row = this.handle.sqlite
        .prepare('SELECT * FROM knowledge_documents WHERE id = ?')
        .get(documentId) as Record<string, unknown> | undefined
      if (!row) throw new KnowledgeNotFoundError()
      const existing = decodeDocumentRow(row)
      if (!isAuthorizedToWriteKnowledgeScope(auth, existing.scope)) {
        throw new KnowledgeNotFoundError()
      }
      if (existing.status === 'archived') {
        throw new KnowledgeValidationError('Cannot update metadata of an archived document')
      }

      const nextCollectionId = input.collectionId !== undefined ? input.collectionId : existing.collectionId
      if (nextCollectionId !== null) {
        this.assertCollectionAccessibleInTx(nextCollectionId, getScopeKey(existing.scope))
      }

      const updated = KnowledgeDocumentSchema.parse({
        ...existing,
        title: input.title ?? existing.title,
        collectionId: nextCollectionId,
        tags: input.tags !== undefined ? normalizeTags(input.tags) : existing.tags,
        updatedAt: now,
      })

      this.handle.sqlite
        .prepare('UPDATE knowledge_documents SET collection_id = ?, title = ?, tags_json = ?, updated_at = ? WHERE id = ?')
        .run(updated.collectionId, updated.title, JSON.stringify(updated.tags), updated.updatedAt, updated.id)

      if (this.handle.fts5Enabled) {
        this.handle.sqlite
          .prepare('UPDATE knowledge_chunks_fts SET title_and_tags = ? WHERE document_id = ? AND revision_id = ?')
          .run(formatFtsTitleAndTags(updated.title, updated.tags), updated.id, updated.currentRevisionId)
      }

      return updated
    })
  }

  archiveDocument(rawAuth: KnowledgeAuthContext, documentId: string): KnowledgeDocument {
    this.assertOpen()
    const auth = validateKnowledgeAuthContext(rawAuth)
    if (!DocumentIdSchema.safeParse(documentId).success) {
      throw new KnowledgeValidationError('Invalid document ID')
    }
    const now = this.nowIso()

    return this.handle.transaction(() => {
      const row = this.handle.sqlite
        .prepare('SELECT * FROM knowledge_documents WHERE id = ?')
        .get(documentId) as Record<string, unknown> | undefined
      if (!row) throw new KnowledgeNotFoundError()
      const existing = decodeDocumentRow(row)
      if (!isAuthorizedToWriteKnowledgeScope(auth, existing.scope)) {
        throw new KnowledgeNotFoundError()
      }
      if (existing.status === 'archived') return existing

      const archived = KnowledgeDocumentSchema.parse({
        ...existing,
        status: 'archived',
        archivedAt: now,
        updatedAt: now,
      })

      this.handle.sqlite
        .prepare("UPDATE knowledge_documents SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?")
        .run(archived.archivedAt, archived.updatedAt, archived.id)

      if (this.handle.fts5Enabled) {
        this.handle.sqlite.prepare('DELETE FROM knowledge_chunks_fts WHERE document_id = ?').run(archived.id)
      }

      return archived
    })
  }

  deleteDocument(rawAuth: KnowledgeAuthContext, documentId: string): boolean {
    this.assertOpen()
    const auth = validateKnowledgeAuthContext(rawAuth)
    if (!DocumentIdSchema.safeParse(documentId).success) {
      throw new KnowledgeValidationError('Invalid document ID')
    }

    return this.handle.transaction(() => {
      const row = this.handle.sqlite
        .prepare('SELECT * FROM knowledge_documents WHERE id = ?')
        .get(documentId) as Record<string, unknown> | undefined
      if (!row) throw new KnowledgeNotFoundError()
      const existing = decodeDocumentRow(row)
      if (!isAuthorizedToWriteKnowledgeScope(auth, existing.scope)) {
        throw new KnowledgeNotFoundError()
      }

      if (this.handle.fts5Enabled) {
        this.handle.sqlite.prepare('DELETE FROM knowledge_chunks_fts WHERE document_id = ?').run(existing.id)
      }
      const res = this.handle.sqlite.prepare('DELETE FROM knowledge_documents WHERE id = ?').run(existing.id)
      return res.changes > 0
    })
  }

  findDuplicateByFingerprint(
    rawAuth: KnowledgeAuthContext,
    scope: KnowledgeScope,
    extractedFingerprint: string,
  ): KnowledgeDocument | null {
    this.assertOpen()
    const auth = validateKnowledgeAuthContext(rawAuth)
    if (!Sha256HexSchema.safeParse(extractedFingerprint).success) {
      throw new KnowledgeValidationError('Invalid extracted fingerprint')
    }
    if (!isAuthorizedToReadKnowledgeScope(auth, scope, { includeUserWide: scope.kind === 'user' })) {
      return null
    }
    const row = this.handle.sqlite
      .prepare("SELECT * FROM knowledge_documents WHERE scope_key = ? AND extracted_fingerprint = ? AND status = 'ready' LIMIT 1")
      .get(getScopeKey(scope), extractedFingerprint) as Record<string, unknown> | undefined
    if (!row) return null
    const doc = decodeDocumentRow(row)
    return isAuthorizedToReadKnowledgeScope(auth, doc.scope, { includeUserWide: scope.kind === 'user' }) ? doc : null
  }

  search(rawAuth: KnowledgeAuthContext, rawQuery: SearchKnowledgeQuery): KnowledgeSearchResult {
    this.assertOpen()
    const auth = validateKnowledgeAuthContext(rawAuth)
    const parsed = SearchKnowledgeQuerySchema.safeParse(rawQuery)
    if (!parsed.success) {
      throw new KnowledgeValidationError(
        `Invalid knowledge search query: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
      )
    }
    const query = parsed.data
    const allowedScopes = resolveAuthorizedKnowledgeScopes(auth, query.scopeKinds, query.includeUserWide)
    const parsedQuery = parseKnowledgeQuery(query.query)
    const engine: KnowledgeSearchResult['engine'] = this.handle.fts5Enabled ? 'fts5' : 'lexical_fallback'

    if (allowedScopes.length === 0 || parsedQuery.tokens.length === 0) {
      return { items: [], citations: [], engine, queryTokens: parsedQuery.tokens }
    }

    const scopeKeys = allowedScopes.map(getScopeKey)
    const placeholders = scopeKeys.map(() => '?').join(', ')
    const where = [
      `d.scope_key IN (${placeholders})`,
      'd.user_id = ?',
      "d.status = 'ready'",
      'c.revision_id = d.current_revision_id',
    ]
    const params: SQLInputValue[] = [...scopeKeys, auth.userId]

    if (query.collectionId) {
      where.push('d.collection_id = ?')
      params.push(query.collectionId)
    }
    if (query.documentId) {
      where.push('d.id = ?')
      params.push(query.documentId)
    }

    const ftsQuery = this.handle.fts5Enabled ? buildSafeFts5MatchQuery(parsedQuery.tokens) : null
    const filterTags = query.tags ? normalizeTags(query.tags) : []
    const matches: KnowledgeSearchMatch[] = []

    const JOINED_COLUMNS = `
      d.id AS d_id, d.schema_version AS d_schema_version, d.collection_id AS d_collection_id,
      d.scope_kind AS d_scope_kind, d.user_id AS d_user_id, d.bot_id AS d_bot_id,
      d.workspace_id AS d_workspace_id, d.title AS d_title, d.source_type AS d_source_type,
      d.media_type AS d_media_type, d.display_filename AS d_display_filename, d.tags_json AS d_tags_json,
      d.status AS d_status, d.current_revision_id AS d_current_revision_id,
      d.raw_fingerprint AS d_raw_fingerprint, d.extracted_fingerprint AS d_extracted_fingerprint,
      d.created_at AS d_created_at, d.updated_at AS d_updated_at, d.archived_at AS d_archived_at,
      c.id AS c_id, c.schema_version AS c_schema_version, c.document_id AS c_document_id,
      c.revision_id AS c_revision_id, c.scope_kind AS c_scope_kind, c.user_id AS c_user_id,
      c.bot_id AS c_bot_id, c.workspace_id AS c_workspace_id, c.chunk_index AS c_chunk_index,
      c.content AS c_content, c.normalized_content AS c_normalized_content,
      c.content_hash AS c_content_hash, c.location_json AS c_location_json, c.created_at AS c_created_at
    `

    const stmt =
      this.handle.fts5Enabled && ftsQuery !== null
        ? this.handle.sqlite.prepare(`
            SELECT ${JOINED_COLUMNS}
            FROM knowledge_chunks_fts f
            INNER JOIN knowledge_chunks c ON c.id = f.chunk_id
            INNER JOIN knowledge_documents d ON d.id = c.document_id
            WHERE ${where.join(' AND ')} AND knowledge_chunks_fts MATCH ?
          `)
        : this.handle.sqlite.prepare(`
            SELECT ${JOINED_COLUMNS}
            FROM knowledge_chunks c
            INNER JOIN knowledge_documents d ON d.id = c.document_id
            WHERE ${where.join(' AND ')}
          `)

    const queryParams =
      this.handle.fts5Enabled && ftsQuery !== null ? [...params, ftsQuery] : params

    for (const rawRow of stmt.iterate(...queryParams) as Iterable<Record<string, unknown>>) {
      const { doc, chunk } = decodeJoinedRow(rawRow)
      if (!isAuthorizedToReadKnowledgeScope(auth, doc.scope, { includeUserWide: query.includeUserWide })) {
        continue
      }
      if (filterTags.length > 0 && !filterTags.every((t) => doc.tags.includes(t))) {
        continue
      }
      const scored = scoreKnowledgeChunk(doc, chunk, parsedQuery)
      if (scored) matches.push(scored)
    }

    const ranked = rankAndSuppressChunks(matches, {
      limit: query.limit,
      deduplicateOverlappingChunks: query.deduplicateOverlappingChunks,
    })

    return {
      items: ranked,
      citations: ranked.map((m) => buildKnowledgeCitation(m.document, m.chunk)),
      engine,
      queryTokens: parsedQuery.tokens,
    }
  }

  resolveCitation(
    rawAuth: KnowledgeAuthContext,
    ref: { documentId: string; revisionId: string; chunkId: string },
    options?: { includeUserWide?: boolean },
  ): KnowledgeCitation | null {
    this.assertOpen()
    const auth = validateKnowledgeAuthContext(rawAuth)
    if (
      !DocumentIdSchema.safeParse(ref.documentId).success ||
      !RevisionIdSchema.safeParse(ref.revisionId).success ||
      !ChunkIdSchema.safeParse(ref.chunkId).success
    ) {
      return null
    }

    const doc = this.getDocumentById(auth, ref.documentId, {
      includeUserWide: options?.includeUserWide ?? false,
      includeArchived: false,
    })
    if (!doc || doc.currentRevisionId !== ref.revisionId) {
      return null
    }

    const chunkRow = this.handle.sqlite
      .prepare('SELECT * FROM knowledge_chunks WHERE id = ? AND document_id = ? AND revision_id = ?')
      .get(ref.chunkId, doc.id, doc.currentRevisionId) as Record<string, unknown> | undefined
    if (!chunkRow) return null

    const chunk = decodeChunkRow(chunkRow)
    return buildKnowledgeCitation(doc, chunk)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.handle.close()
  }
}

function decodeJoinedRow(r: Record<string, unknown>): { doc: KnowledgeDocument; chunk: KnowledgeChunk } {
  const doc = decodeDocumentRow({
    schema_version: r.d_schema_version,
    id: r.d_id,
    collection_id: r.d_collection_id,
    scope_kind: r.d_scope_kind,
    user_id: r.d_user_id,
    bot_id: r.d_bot_id,
    workspace_id: r.d_workspace_id,
    title: r.d_title,
    source_type: r.d_source_type,
    media_type: r.d_media_type,
    display_filename: r.d_display_filename,
    tags_json: r.d_tags_json,
    status: r.d_status,
    current_revision_id: r.d_current_revision_id,
    raw_fingerprint: r.d_raw_fingerprint,
    extracted_fingerprint: r.d_extracted_fingerprint,
    created_at: r.d_created_at,
    updated_at: r.d_updated_at,
    archived_at: r.d_archived_at,
  })
  const chunk = decodeChunkRow({
    schema_version: r.c_schema_version,
    id: r.c_id,
    document_id: r.c_document_id,
    revision_id: r.c_revision_id,
    scope_kind: r.c_scope_kind,
    user_id: r.c_user_id,
    bot_id: r.c_bot_id,
    workspace_id: r.c_workspace_id,
    chunk_index: r.c_chunk_index,
    content: r.c_content,
    normalized_content: r.c_normalized_content,
    content_hash: r.c_content_hash,
    location_json: r.c_location_json,
    created_at: r.c_created_at,
  })
  return { doc, chunk }
}
