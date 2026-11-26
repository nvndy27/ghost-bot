import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import {
  buildValidatedKnowledgeContext,
  createBorrowedKnowledgeDatabaseHandle,
  KnowledgeAuthorizationError,
  KnowledgeCredentialError,
  KnowledgeDuplicateError,
  KnowledgeError,
  KnowledgeIngestionPipeline,
  KnowledgeNotFoundError,
  KnowledgeUnsafePathError,
  KnowledgeUnsupportedFormatError,
  KnowledgeValidationError,
  SqliteKnowledgeRepository,
  type KnowledgeAuthContext,
  type KnowledgeCitation,
  type KnowledgeCollection,
  type KnowledgeDocument,
  type KnowledgeScope,
} from '@ghost-bot/knowledge'
import {
  CreateKnowledgeCollectionInputSchema,
  IngestKnowledgeTextInputSchema,
  KnowledgeIdParamSchema,
  ListKnowledgeCollectionsInputSchema,
  ListKnowledgeDocsInputSchema,
  ReplaceKnowledgeDocTextInputSchema,
  ResolveKnowledgeCitationInputSchema,
  SearchKnowledgeDocsInputSchema,
  UpdateKnowledgeDocInputSchema,
  type CreateKnowledgeCollectionInput,
  type IngestKnowledgeTextInput,
  type KnowledgeCitationDto,
  type KnowledgeCollectionDto,
  type KnowledgeDocumentDto,
  type ListKnowledgeCollectionsInput,
  type ListKnowledgeDocsInput,
  type ListKnowledgeDocsResponse,
  type ReplaceKnowledgeDocTextInput,
  type ResolveKnowledgeCitationInput,
  type ResolveKnowledgeCitationResponse,
  type SearchKnowledgeDocsInput,
  type SearchKnowledgeDocsResponse,
  type UpdateKnowledgeDocInput,
} from '@ghost-bot/shared-types/ipc'
import type { DatabaseHandle } from '../db/client.ts'
import { DaemonError, redactSecrets } from '../errors.ts'
import {
  deriveWorkspaceId,
  LOCAL_USER_ID,
  MEMORY_RUNTIME_CAPABILITIES,
  type MemoryRuntimeCapability,
} from '../memory/service.ts'
import type { SettingsRepository } from '../settings/repository.ts'

const DAEMON_KNOWLEDGE_ACTOR_ID = 'daemon_knowledge'

export interface PreparedExecutionKnowledgeContext {
  status: 'attached' | 'empty' | 'disabled' | 'consent_required' | 'unsupported_runtime' | 'error_omitted'
  mechanism: MemoryRuntimeCapability['mechanism'] | 'none'
  envelopeJson: string | null
  selectedDocuments: number
  selectedChunks: number
  totalBytes: number
  truncated: boolean
  citations: KnowledgeCitationDto[]
}

function toCollectionDto(col: KnowledgeCollection): KnowledgeCollectionDto {
  return {
    id: col.id,
    scopeKind: col.scope.kind,
    botId: col.scope.kind === 'bot' ? col.scope.botId : null,
    workspaceId: col.scope.kind === 'workspace' ? col.scope.workspaceId : null,
    name: col.name,
    description: col.description,
    status: col.status,
    createdAt: col.createdAt,
    updatedAt: col.updatedAt,
  }
}

function toDocumentDto(
  doc: KnowledgeDocument,
  extra?: { revisionNumber?: number; chunkCount?: number },
): KnowledgeDocumentDto {
  return {
    id: doc.id,
    collectionId: doc.collectionId,
    scopeKind: doc.scope.kind,
    botId: doc.scope.kind === 'bot' ? doc.scope.botId : null,
    workspaceId: doc.scope.kind === 'workspace' ? doc.scope.workspaceId : null,
    title: doc.title,
    sourceType: doc.sourceType,
    mediaType: doc.mediaType,
    displayFilename: doc.displayFilename,
    tags: [...doc.tags],
    status: doc.status,
    currentRevisionId: doc.currentRevisionId,
    revisionNumber: extra?.revisionNumber,
    chunkCount: extra?.chunkCount,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    archivedAt: doc.archivedAt,
  }
}

function toCitationDto(c: KnowledgeCitation): KnowledgeCitationDto {
  return {
    documentId: c.documentId,
    revisionId: c.revisionId,
    chunkId: c.chunkId,
    title: c.title,
    displayFilename: c.displayFilename,
    sectionPath: [...c.sectionPath],
    startLine: c.startLine,
    endLine: c.endLine,
    startChar: c.startChar,
    endChar: c.endChar,
    pageNumber: c.pageNumber,
    excerpt: c.excerpt,
  }
}

function mapKnowledgeError(err: unknown): DaemonError {
  if (err instanceof DaemonError) return err
  if (err instanceof KnowledgeNotFoundError) {
    return new DaemonError('KNOWLEDGE_NOT_FOUND', 'Knowledge document or collection was not found', {
      statusCode: 404,
    })
  }
  if (err instanceof KnowledgeDuplicateError) {
    return new DaemonError('KNOWLEDGE_DUPLICATE', err.message, { statusCode: 409 })
  }
  if (err instanceof KnowledgeCredentialError) {
    return new DaemonError('KNOWLEDGE_CREDENTIAL_REJECTED', err.message, { statusCode: 400 })
  }
  if (err instanceof KnowledgeUnsupportedFormatError) {
    return new DaemonError('KNOWLEDGE_UNSUPPORTED_FORMAT', err.message, { statusCode: 400 })
  }
  if (err instanceof KnowledgeUnsafePathError) {
    return new DaemonError('KNOWLEDGE_UNSAFE_PATH', err.message, { statusCode: 400 })
  }
  if (err instanceof KnowledgeAuthorizationError) {
    return new DaemonError('KNOWLEDGE_FORBIDDEN', err.message, { statusCode: 403 })
  }
  if (err instanceof KnowledgeValidationError) {
    return new DaemonError('VALIDATION_ERROR', err.message, { statusCode: 400 })
  }
  if (err instanceof KnowledgeError) {
    return new DaemonError('KNOWLEDGE_ERROR', redactSecrets(err.message), { statusCode: 500 })
  }
  return new DaemonError(
    'KNOWLEDGE_ERROR',
    redactSecrets(err instanceof Error ? err.message : String(err)),
    { statusCode: 500 },
  )
}

export class KnowledgeService {
  private readonly dbHandle: DatabaseHandle
  private readonly settingsRepo: SettingsRepository
  private readonly repo: SqliteKnowledgeRepository
  private readonly pipeline: KnowledgeIngestionPipeline
  private closed = false

  constructor(dbHandle: DatabaseHandle, settingsRepo: SettingsRepository) {
    this.dbHandle = dbHandle
    this.settingsRepo = settingsRepo
    const borrowed = createBorrowedKnowledgeDatabaseHandle(dbHandle.sqlite, {
      dbLabel: dbHandle.dbPath,
    })
    this.repo = new SqliteKnowledgeRepository(borrowed)
    this.pipeline = new KnowledgeIngestionPipeline(this.repo)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.repo.close()
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new DaemonError('KNOWLEDGE_UNAVAILABLE', 'Knowledge service is closed', {
        statusCode: 503,
      })
    }
  }

  private async resolveActiveBot(
    botId: string,
    requireWorkspace = false,
  ): Promise<{ id: string; workspaceId?: string }> {
    const row = this.dbHandle.sqlite
      .prepare('SELECT id, workspace_path, archived_at FROM agents WHERE id = ?')
      .get(botId) as { id: string; workspace_path: string; archived_at: string | null } | undefined

    if (!row || row.archived_at !== null) {
      throw new DaemonError('BOT_NOT_FOUND', `Bot "${botId}" was not found or is archived`, {
        statusCode: 404,
      })
    }

    let workspaceId: string | undefined
    try {
      const canonicalWorkspace = await realpath(row.workspace_path)
      workspaceId = deriveWorkspaceId(canonicalWorkspace)
    } catch {
      if (requireWorkspace) {
        throw new DaemonError(
          'KNOWLEDGE_SCOPE_UNAVAILABLE',
          'Bot workspace path is unavailable for workspace-scoped knowledge',
          { statusCode: 409 },
        )
      }
    }

    return { id: row.id, workspaceId }
  }

  private writeAudit(
    action: string,
    target: string,
    outcome: 'ok' | 'error',
    details: Record<string, unknown>,
  ): void {
    try {
      this.dbHandle.sqlite
        .prepare(
          `INSERT INTO audit_logs (id, actor, action, target, outcome, redacted_json, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `aud_${randomUUID()}`,
          'user',
          action,
          target,
          outcome,
          redactSecrets(JSON.stringify(details)),
          new Date().toISOString(),
        )
    } catch {
      // Audit logging must not mask primary errors.
    }
  }

  private async resolveScopeAndWriteAuth(
    scopeInput: { kind: 'user' } | { kind: 'bot'; botId: string } | { kind: 'workspace'; botId: string },
  ): Promise<{ scope: KnowledgeScope; auth: KnowledgeAuthContext }> {
    if (scopeInput.kind === 'user') {
      return {
        scope: { kind: 'user', userId: LOCAL_USER_ID },
        auth: {
          actorId: DAEMON_KNOWLEDGE_ACTOR_ID,
          userId: LOCAL_USER_ID,
          allowUserWideRead: true,
          allowUserWideWrite: true,
        },
      }
    }

    if (scopeInput.kind === 'bot') {
      const resolved = await this.resolveActiveBot(scopeInput.botId)
      return {
        scope: { kind: 'bot', userId: LOCAL_USER_ID, botId: resolved.id },
        auth: {
          actorId: DAEMON_KNOWLEDGE_ACTOR_ID,
          userId: LOCAL_USER_ID,
          botId: resolved.id,
          allowUserWideRead: false,
          allowUserWideWrite: false,
        },
      }
    }

    const resolved = await this.resolveActiveBot(scopeInput.botId, true)
    if (!resolved.workspaceId) {
      throw new DaemonError(
        'KNOWLEDGE_SCOPE_UNAVAILABLE',
        'Bot workspace path is unavailable for workspace-scoped knowledge',
        { statusCode: 409 },
      )
    }
    return {
      scope: { kind: 'workspace', userId: LOCAL_USER_ID, workspaceId: resolved.workspaceId },
      auth: {
        actorId: DAEMON_KNOWLEDGE_ACTOR_ID,
        userId: LOCAL_USER_ID,
        botId: resolved.id,
        workspaceId: resolved.workspaceId,
        allowUserWideRead: false,
        allowUserWideWrite: false,
      },
    }
  }

  async listCollections(
    rawInput: Partial<ListKnowledgeCollectionsInput> = {},
  ): Promise<{ collections: KnowledgeCollectionDto[] }> {
    this.assertOpen()
    const parsed = ListKnowledgeCollectionsInputSchema.safeParse(rawInput)
    if (!parsed.success) {
      throw new DaemonError(
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid collection list query',
        { statusCode: 400 },
      )
    }
    const input = parsed.data
    let resolvedBot: { id: string; workspaceId?: string } | null = null
    if (input.botId) {
      resolvedBot = await this.resolveActiveBot(input.botId, input.scopeKind === 'workspace')
    } else if (input.scopeKind === 'bot' || input.scopeKind === 'workspace') {
      throw new DaemonError('VALIDATION_ERROR', 'botId is required for bot or workspace scope', {
        statusCode: 400,
      })
    }

    const includeUserWide = input.scopeKind === 'user' || input.includeUserWide
    const auth: KnowledgeAuthContext = {
      actorId: DAEMON_KNOWLEDGE_ACTOR_ID,
      userId: LOCAL_USER_ID,
      botId: resolvedBot?.id,
      workspaceId: resolvedBot?.workspaceId,
      allowUserWideRead: includeUserWide,
      allowUserWideWrite: false,
    }

    try {
      const cols = this.repo.listCollections(auth, { includeUserWide })
      const filtered = input.scopeKind ? cols.filter((c) => c.scope.kind === input.scopeKind) : cols
      return { collections: filtered.map(toCollectionDto) }
    } catch (err) {
      throw mapKnowledgeError(err)
    }
  }

  async createCollection(rawInput: CreateKnowledgeCollectionInput): Promise<KnowledgeCollectionDto> {
    this.assertOpen()
    if (!this.settingsRepo.getSettings().knowledge.enabled) {
      throw new DaemonError('KNOWLEDGE_DISABLED', 'Knowledge storage is disabled in Settings.', {
        statusCode: 409,
      })
    }
    const parsed = CreateKnowledgeCollectionInputSchema.safeParse(rawInput)
    if (!parsed.success) {
      throw new DaemonError(
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid create collection payload',
        { statusCode: 400 },
      )
    }
    const { scope, auth } = await this.resolveScopeAndWriteAuth(parsed.data.scope)
    try {
      const created = this.repo.createCollection(auth, {
        scope,
        name: parsed.data.name,
        description: parsed.data.description,
      })
      this.writeAudit('knowledge.collection.create', created.id, 'ok', {
        scopeKind: created.scope.kind,
      })
      return toCollectionDto(created)
    } catch (err) {
      throw mapKnowledgeError(err)
    }
  }

  async listDocuments(
    rawInput: Partial<ListKnowledgeDocsInput> = {},
  ): Promise<ListKnowledgeDocsResponse> {
    this.assertOpen()
    const parsed = ListKnowledgeDocsInputSchema.safeParse(rawInput)
    if (!parsed.success) {
      throw new DaemonError(
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid document list query',
        { statusCode: 400 },
      )
    }
    const input = parsed.data
    let resolvedBot: { id: string; workspaceId?: string } | null = null
    if (input.botId) {
      resolvedBot = await this.resolveActiveBot(input.botId, input.scopeKind === 'workspace')
    } else if (input.scopeKind === 'bot' || input.scopeKind === 'workspace') {
      throw new DaemonError('VALIDATION_ERROR', 'botId is required for bot or workspace scope', {
        statusCode: 400,
      })
    }

    const includeUserWide = input.scopeKind === 'user' || input.includeUserWide
    const auth: KnowledgeAuthContext = {
      actorId: DAEMON_KNOWLEDGE_ACTOR_ID,
      userId: LOCAL_USER_ID,
      botId: resolvedBot?.id,
      workspaceId: resolvedBot?.workspaceId,
      allowUserWideRead: includeUserWide,
      allowUserWideWrite: false,
      allowArchivedRead: input.includeArchived,
    }

    try {
      const res = this.repo.listDocuments(auth, {
        scopeKinds: input.scopeKind ? [input.scopeKind] : undefined,
        collectionId: input.collectionId,
        includeUserWide,
        includeArchived: input.includeArchived,
        limit: input.limit,
        offset: input.offset,
      })
      return {
        documents: res.items.map((d) => toDocumentDto(d)),
        total: res.total,
        hasMore: res.offset + res.items.length < res.total,
      }
    } catch (err) {
      throw mapKnowledgeError(err)
    }
  }

  async searchDocuments(rawInput: SearchKnowledgeDocsInput): Promise<SearchKnowledgeDocsResponse> {
    this.assertOpen()
    const parsed = SearchKnowledgeDocsInputSchema.safeParse(rawInput)
    if (!parsed.success) {
      throw new DaemonError(
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid document search query',
        { statusCode: 400 },
      )
    }
    const input = parsed.data
    let resolvedBot: { id: string; workspaceId?: string } | null = null
    if (input.botId) {
      resolvedBot = await this.resolveActiveBot(input.botId, input.scopeKind === 'workspace')
    } else if (input.scopeKind === 'bot' || input.scopeKind === 'workspace') {
      throw new DaemonError('VALIDATION_ERROR', 'botId is required for bot or workspace scope', {
        statusCode: 400,
      })
    }

    const includeUserWide = input.scopeKind === 'user' || input.includeUserWide
    const auth: KnowledgeAuthContext = {
      actorId: DAEMON_KNOWLEDGE_ACTOR_ID,
      userId: LOCAL_USER_ID,
      botId: resolvedBot?.id,
      workspaceId: resolvedBot?.workspaceId,
      allowUserWideRead: includeUserWide,
      allowUserWideWrite: false,
    }

    try {
      const res = this.repo.search(auth, {
        query: input.query,
        scopeKinds: input.scopeKind ? [input.scopeKind] : undefined,
        collectionId: input.collectionId,
        includeUserWide,
        limit: input.limit,
      })
      const citationByChunkId = new Map(res.citations.map((c) => [c.chunkId, c]))
      const matches = res.items.flatMap((m) => {
        const cit = citationByChunkId.get(m.chunk.id)
        if (!cit) return []
        return [
          {
            document: toDocumentDto(m.document),
            citation: toCitationDto(cit),
            score: m.score,
          },
        ]
      })
      return {
        matches,
        engine: res.engine,
        total: matches.length,
      }
    } catch (err) {
      throw mapKnowledgeError(err)
    }
  }

  async ingestText(rawInput: IngestKnowledgeTextInput): Promise<KnowledgeDocumentDto> {
    this.assertOpen()
    if (!this.settingsRepo.getSettings().knowledge.enabled) {
      throw new DaemonError('KNOWLEDGE_DISABLED', 'Knowledge storage is disabled in Settings.', {
        statusCode: 409,
      })
    }
    const parsed = IngestKnowledgeTextInputSchema.safeParse(rawInput)
    if (!parsed.success) {
      throw new DaemonError(
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid document ingestion payload',
        { statusCode: 400 },
      )
    }
    const input = parsed.data
    const { scope, auth } = await this.resolveScopeAndWriteAuth(input.scope)
    try {
      const persisted = this.pipeline.ingestText(auth, {
        scope,
        collectionId: input.collectionId,
        title: input.title,
        sourceType: input.sourceType,
        text: input.text,
        tags: input.tags,
      })
      this.writeAudit('knowledge.doc.ingest_text', persisted.document.id, 'ok', {
        scopeKind: persisted.document.scope.kind,
        revisionNumber: persisted.revision.revisionNumber,
        chunkCount: persisted.chunks.length,
      })
      return toDocumentDto(persisted.document, {
        revisionNumber: persisted.revision.revisionNumber,
        chunkCount: persisted.chunks.length,
      })
    } catch (err) {
      throw mapKnowledgeError(err)
    }
  }

  async ingestAuthorizedFile(params: {
    scope: { kind: 'user' } | { kind: 'bot'; botId: string } | { kind: 'workspace'; botId: string }
    collectionId: string | null
    tags: string[]
    allowedRootDir: string
    filePath: string
  }): Promise<KnowledgeDocumentDto> {
    this.assertOpen()
    if (!this.settingsRepo.getSettings().knowledge.enabled) {
      throw new DaemonError('KNOWLEDGE_DISABLED', 'Knowledge storage is disabled in Settings.', {
        statusCode: 409,
      })
    }
    const { scope, auth } = await this.resolveScopeAndWriteAuth(params.scope)
    const ext = extname(params.filePath).toLowerCase()
    if (ext !== '.md' && ext !== '.markdown' && ext !== '.txt') {
      throw new DaemonError(
        'KNOWLEDGE_UNSUPPORTED_FORMAT',
        `Unsupported document file extension "${ext || '(none)'}". Only UTF-8 .txt and .md/.markdown are supported.`,
        { statusCode: 400 },
      )
    }
    const fileName = basename(params.filePath)
    try {
      const persisted = await this.pipeline.ingestFile(auth, {
        scope,
        collectionId: params.collectionId,
        title: fileName,
        tags: params.tags,
        allowedRootDir: params.allowedRootDir,
        filePath: params.filePath,
      })
      this.writeAudit('knowledge.doc.ingest_file', persisted.document.id, 'ok', {
        scopeKind: persisted.document.scope.kind,
        revisionNumber: persisted.revision.revisionNumber,
        chunkCount: persisted.chunks.length,
      })
      return toDocumentDto(persisted.document, {
        revisionNumber: persisted.revision.revisionNumber,
        chunkCount: persisted.chunks.length,
      })
    } catch (err) {
      throw mapKnowledgeError(err)
    }
  }

  private async resolveDocumentWriteAuth(
    id: string,
    requireActiveBot: boolean,
  ): Promise<{ auth: KnowledgeAuthContext; scope: KnowledgeScope }> {
    const idCheck = KnowledgeIdParamSchema.safeParse({ id })
    if (!idCheck.success) {
      throw new DaemonError('VALIDATION_ERROR', 'Invalid document identifier', { statusCode: 400 })
    }
    const row = this.dbHandle.sqlite
      .prepare('SELECT id, scope_kind, user_id, bot_id, workspace_id FROM knowledge_documents WHERE id = ?')
      .get(idCheck.data.id) as
      | {
          id: string
          scope_kind: string
          user_id: string
          bot_id: string | null
          workspace_id: string | null
        }
      | undefined

    if (!row || row.user_id !== LOCAL_USER_ID) {
      throw new DaemonError('KNOWLEDGE_NOT_FOUND', 'Knowledge document was not found', {
        statusCode: 404,
      })
    }

    if (row.scope_kind === 'user') {
      return {
        scope: { kind: 'user', userId: LOCAL_USER_ID },
        auth: {
          actorId: DAEMON_KNOWLEDGE_ACTOR_ID,
          userId: LOCAL_USER_ID,
          allowUserWideRead: true,
          allowUserWideWrite: true,
          allowArchivedRead: true,
        },
      }
    }

    if (row.scope_kind === 'bot' && row.bot_id) {
      if (requireActiveBot) {
        await this.resolveActiveBot(row.bot_id)
      }
      return {
        scope: { kind: 'bot', userId: LOCAL_USER_ID, botId: row.bot_id },
        auth: {
          actorId: DAEMON_KNOWLEDGE_ACTOR_ID,
          userId: LOCAL_USER_ID,
          botId: row.bot_id,
          allowUserWideRead: false,
          allowUserWideWrite: false,
          allowArchivedRead: true,
        },
      }
    }

    if (row.scope_kind === 'workspace' && row.workspace_id) {
      return {
        scope: { kind: 'workspace', userId: LOCAL_USER_ID, workspaceId: row.workspace_id },
        auth: {
          actorId: DAEMON_KNOWLEDGE_ACTOR_ID,
          userId: LOCAL_USER_ID,
          workspaceId: row.workspace_id,
          allowUserWideRead: false,
          allowUserWideWrite: false,
          allowArchivedRead: true,
        },
      }
    }

    throw new DaemonError('KNOWLEDGE_NOT_FOUND', 'Knowledge document was not found', {
      statusCode: 404,
    })
  }

  async updateDocument(rawInput: UpdateKnowledgeDocInput): Promise<KnowledgeDocumentDto> {
    this.assertOpen()
    if (!this.settingsRepo.getSettings().knowledge.enabled) {
      throw new DaemonError('KNOWLEDGE_DISABLED', 'Knowledge storage is disabled in Settings.', {
        statusCode: 409,
      })
    }
    const parsed = UpdateKnowledgeDocInputSchema.safeParse(rawInput)
    if (!parsed.success) {
      throw new DaemonError(
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid document update payload',
        { statusCode: 400 },
      )
    }
    const { auth } = await this.resolveDocumentWriteAuth(parsed.data.id, true)
    try {
      const updated = this.repo.updateDocumentMetadata(auth, parsed.data.id, {
        title: parsed.data.title,
        tags: parsed.data.tags,
        collectionId: parsed.data.collectionId,
      })
      this.writeAudit('knowledge.doc.update', updated.id, 'ok', {
        scopeKind: updated.scope.kind,
      })
      return toDocumentDto(updated)
    } catch (err) {
      throw mapKnowledgeError(err)
    }
  }

  async replaceDocumentText(rawInput: ReplaceKnowledgeDocTextInput): Promise<KnowledgeDocumentDto> {
    this.assertOpen()
    if (!this.settingsRepo.getSettings().knowledge.enabled) {
      throw new DaemonError('KNOWLEDGE_DISABLED', 'Knowledge storage is disabled in Settings.', {
        statusCode: 409,
      })
    }
    const parsed = ReplaceKnowledgeDocTextInputSchema.safeParse(rawInput)
    if (!parsed.success) {
      throw new DaemonError(
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid document replacement payload',
        { statusCode: 400 },
      )
    }
    const input = parsed.data
    const { auth, scope } = await this.resolveDocumentWriteAuth(input.id, true)
    const existing = this.repo.getDocumentById(auth, input.id, { includeUserWide: true })
    if (!existing) {
      throw new DaemonError('KNOWLEDGE_NOT_FOUND', 'Knowledge document was not found', {
        statusCode: 404,
      })
    }
    try {
      const replaced = this.pipeline.replaceWithBytes(
        auth,
        input.id,
        Buffer.from(input.text, 'utf8'),
        {
          scope,
          collectionId: existing.collectionId,
          title: input.title ?? existing.title,
          sourceType: input.sourceType,
          mediaType: input.sourceType === 'markdown' ? 'text/markdown' : 'text/plain',
          displayFilename: existing.displayFilename,
          tags: input.tags ?? [...existing.tags],
        },
      )
      this.writeAudit('knowledge.doc.replace', replaced.document.id, 'ok', {
        revisionNumber: replaced.revision.revisionNumber,
        chunkCount: replaced.chunks.length,
      })
      return toDocumentDto(replaced.document, {
        revisionNumber: replaced.revision.revisionNumber,
        chunkCount: replaced.chunks.length,
      })
    } catch (err) {
      throw mapKnowledgeError(err)
    }
  }

  async archiveDocument(id: string): Promise<KnowledgeDocumentDto> {
    this.assertOpen()
    const { auth } = await this.resolveDocumentWriteAuth(id, false)
    try {
      const archived = this.repo.archiveDocument(auth, id)
      this.writeAudit('knowledge.doc.archive', archived.id, 'ok', {
        scopeKind: archived.scope.kind,
      })
      return toDocumentDto(archived)
    } catch (err) {
      throw mapKnowledgeError(err)
    }
  }

  async deleteDocument(id: string): Promise<{ deletedId: string }> {
    this.assertOpen()
    const { auth } = await this.resolveDocumentWriteAuth(id, false)
    try {
      const deleted = this.repo.deleteDocument(auth, id)
      if (!deleted) {
        throw new DaemonError('KNOWLEDGE_NOT_FOUND', 'Knowledge document was not found', {
          statusCode: 404,
        })
      }
      this.writeAudit('knowledge.doc.delete', id, 'ok', {})
      return { deletedId: id }
    } catch (err) {
      throw mapKnowledgeError(err)
    }
  }

  async resolveCitation(rawInput: ResolveKnowledgeCitationInput): Promise<ResolveKnowledgeCitationResponse> {
    this.assertOpen()
    const parsed = ResolveKnowledgeCitationInputSchema.safeParse(rawInput)
    if (!parsed.success) {
      throw new DaemonError(
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid citation query',
        { statusCode: 400 },
      )
    }
    const input = parsed.data
    const resolvedBot = input.botId ? await this.resolveActiveBot(input.botId, false) : null
    const auth: KnowledgeAuthContext = {
      actorId: DAEMON_KNOWLEDGE_ACTOR_ID,
      userId: LOCAL_USER_ID,
      botId: resolvedBot?.id,
      workspaceId: resolvedBot?.workspaceId,
      allowUserWideRead: input.includeUserWide,
      allowUserWideWrite: false,
    }
    try {
      const cit = this.repo.resolveCitation(auth, {
        documentId: input.documentId,
        revisionId: input.revisionId,
        chunkId: input.chunkId,
      })
      if (!cit) {
        return {
          available: false,
          reason: 'Citation is unauthorized, archived, deleted, or superseded by a newer revision.',
          citation: null,
        }
      }
      return {
        available: true,
        citation: toCitationDto(cit),
      }
    } catch (err) {
      throw mapKnowledgeError(err)
    }
  }

  /**
   * Archives active bot-scoped collections and documents inside an active caller transaction.
   * Never touches user-wide or shared workspace documents.
   */
  archiveKnowledgeForBotInTx(botId: string, now = new Date().toISOString()): number {
    this.assertOpen()
    const docRows = this.dbHandle.sqlite
      .prepare(
        `SELECT id FROM knowledge_documents
         WHERE user_id = ? AND scope_kind = 'bot' AND bot_id = ? AND status = 'ready'`,
      )
      .all(LOCAL_USER_ID, botId) as Array<{ id: string }>

    for (const row of docRows) {
      this.dbHandle.sqlite.prepare('DELETE FROM knowledge_chunks_fts WHERE document_id = ?').run(row.id)
    }

    const docRes = this.dbHandle.sqlite
      .prepare(
        `UPDATE knowledge_documents
         SET status = 'archived', archived_at = ?, updated_at = ?
         WHERE user_id = ? AND scope_kind = 'bot' AND bot_id = ? AND status = 'ready'`,
      )
      .run(now, now, LOCAL_USER_ID, botId)

    this.dbHandle.sqlite
      .prepare(
        `UPDATE knowledge_collections
         SET status = 'archived', archived_at = ?, updated_at = ?
         WHERE user_id = ? AND scope_kind = 'bot' AND bot_id = ? AND status = 'active'`,
      )
      .run(now, now, LOCAL_USER_ID, botId)

    const count = Number(docRes.changes ?? 0)
    if (count > 0) {
      this.writeAudit('knowledge.archive_bot', botId, 'ok', { archivedCount: count })
    }
    return count
  }

  /**
   * Prepares bounded, revalidated untrusted Knowledge context at the dispatch boundary.
   */
  async prepareExecutionContext(params: {
    sessionId: string
    agentId: string
    runtimeId: string
    queryText: string
    isMock: boolean
    maxBytesBudget?: number
  }): Promise<PreparedExecutionKnowledgeContext> {
    this.assertOpen()
    const settings = this.settingsRepo.getSettings().knowledge
    if (!settings.enabled || !settings.automaticRetrieval) {
      return {
        status: 'disabled',
        mechanism: 'none',
        envelopeJson: null,
        selectedDocuments: 0,
        selectedChunks: 0,
        totalBytes: 0,
        truncated: false,
        citations: [],
      }
    }

    const cap = MEMORY_RUNTIME_CAPABILITIES[params.runtimeId]
    if (!cap || !cap.supported) {
      return {
        status: 'unsupported_runtime',
        mechanism: 'unsupported',
        envelopeJson: null,
        selectedDocuments: 0,
        selectedChunks: 0,
        totalBytes: 0,
        truncated: false,
        citations: [],
      }
    }

    if (!params.isMock && !settings.externalProviderConsent) {
      return {
        status: 'consent_required',
        mechanism: cap.mechanism,
        envelopeJson: null,
        selectedDocuments: 0,
        selectedChunks: 0,
        totalBytes: 0,
        truncated: false,
        citations: [],
      }
    }

    const sessionRow = this.dbHandle.sqlite
      .prepare('SELECT id, agent_id, archived_at FROM sessions WHERE id = ?')
      .get(params.sessionId) as
      | { id: string; agent_id: string; archived_at: string | null }
      | undefined

    if (!sessionRow || sessionRow.archived_at !== null || sessionRow.agent_id !== params.agentId) {
      throw new DaemonError(
        'KNOWLEDGE_AUTHORIZATION_FAILED',
        'Session ownership check failed for knowledge context',
        { statusCode: 403 },
      )
    }

    const resolvedBot = await this.resolveActiveBot(params.agentId)
    const auth: KnowledgeAuthContext = {
      actorId: DAEMON_KNOWLEDGE_ACTOR_ID,
      userId: LOCAL_USER_ID,
      botId: resolvedBot.id,
      workspaceId: resolvedBot.workspaceId,
      allowUserWideRead: settings.includeUserWide,
      allowUserWideWrite: false,
    }

    const trimmedQuery = params.queryText.trim().slice(0, 256)
    if (!trimmedQuery) {
      return {
        status: 'empty',
        mechanism: cap.mechanism,
        envelopeJson: null,
        selectedDocuments: 0,
        selectedChunks: 0,
        totalBytes: 0,
        truncated: false,
        citations: [],
      }
    }

    const searchResult = this.repo.search(auth, {
      query: trimmedQuery,
      includeUserWide: settings.includeUserWide,
      limit: 12,
    })

    if (searchResult.items.length === 0) {
      return {
        status: 'empty',
        mechanism: cap.mechanism,
        envelopeJson: null,
        selectedDocuments: 0,
        selectedChunks: 0,
        totalBytes: 0,
        truncated: false,
        citations: [],
      }
    }

    const maxBytes = Math.max(512, Math.min(params.maxBytesBudget ?? 8192, 16384))
    const assembled = buildValidatedKnowledgeContext(
      this.repo,
      auth,
      searchResult.items.map((m) => ({
        document: m.document,
        chunk: m.chunk,
        score: m.score,
      })),
      {
        includeUserWide: settings.includeUserWide,
        maxDocuments: 3,
        maxChunks: 5,
        maxChars: maxBytes,
        maxBytes,
      },
    )

    if (assembled.metadata.selectedChunkCount === 0) {
      return {
        status: 'empty',
        mechanism: cap.mechanism,
        envelopeJson: null,
        selectedDocuments: 0,
        selectedChunks: 0,
        totalBytes: 0,
        truncated: assembled.metadata.skippedCount > 0,
        citations: [],
      }
    }

    return {
      status: 'attached',
      mechanism: cap.mechanism,
      envelopeJson: assembled.serialized,
      selectedDocuments: assembled.metadata.selectedDocumentCount,
      selectedChunks: assembled.metadata.selectedChunkCount,
      totalBytes: assembled.metadata.bytes,
      truncated: assembled.metadata.skippedCount > 0,
      citations: assembled.citations.map(toCitationDto),
    }
  }
}
