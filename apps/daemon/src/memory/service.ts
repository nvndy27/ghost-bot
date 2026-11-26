import { createHash, randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import {
  buildMemoryContext,
  createBorrowedMemoryDatabaseHandle,
  MemoryAuthorizationError,
  MemoryCredentialError,
  MemoryDuplicateError,
  MemoryError,
  MemoryNotFoundError,
  MemoryUnsupportedOriginError,
  MemoryValidationError,
  SqliteMemoryRepository,
  type MemoryAuthContext,
  type MemoryRecord,
  type MemoryScope,
} from '@ghost-bot/memory'
import {
  CreateMemoryIpcInputSchema,
  ListMemoriesIpcInputSchema,
  MemoryIdParamSchema,
  SearchMemoriesIpcInputSchema,
  UpdateMemoryIpcInputSchema,
  type CreateMemoryIpcInput,
  type ListMemoriesIpcInput,
  type ListMemoriesResponse,
  type MemoryRecordDto,
  type SearchMemoriesIpcInput,
  type SearchMemoriesResponse,
  type UpdateMemoryIpcInput,
} from '@ghost-bot/shared-types/ipc'
import type { DatabaseHandle } from '../db/client.ts'
import { DaemonError, redactSecrets } from '../errors.ts'
import type { SettingsRepository } from '../settings/repository.ts'

export const LOCAL_USER_ID = 'local-user'
const DAEMON_MEMORY_ACTOR_ID = 'daemon_memory'

export interface MemoryRuntimeCapability {
  supported: boolean
  mechanism: 'mock_untrusted_reference_data' | 'codex_turn_input_reference_item' | 'unsupported'
}

export const MEMORY_RUNTIME_CAPABILITIES: Readonly<Record<string, MemoryRuntimeCapability>> = {
  mock: { supported: true, mechanism: 'mock_untrusted_reference_data' },
  'mock-offline': { supported: true, mechanism: 'mock_untrusted_reference_data' },
  codex: { supported: true, mechanism: 'codex_turn_input_reference_item' },
  openclaw: { supported: false, mechanism: 'unsupported' },
  ollama: { supported: false, mechanism: 'unsupported' },
}

export interface PreparedExecutionMemoryContext {
  status: 'attached' | 'empty' | 'disabled' | 'consent_required' | 'unsupported_runtime' | 'error_omitted'
  mechanism: MemoryRuntimeCapability['mechanism'] | 'none'
  envelopeJson: string | null
  selectedCount: number
  totalBytes: number
  truncated: boolean
}

export function deriveWorkspaceId(canonicalWorkspacePath: string): string {
  return `ws_${createHash('sha256').update(canonicalWorkspacePath, 'utf8').digest('hex').slice(0, 24)}`
}

function toMemoryDto(record: MemoryRecord): MemoryRecordDto {
  return {
    id: record.id,
    scopeKind: record.scope.kind,
    botId: record.scope.kind === 'bot' ? record.scope.botId : null,
    workspaceId: record.scope.kind === 'workspace' ? record.scope.workspaceId : null,
    origin: record.origin,
    category: record.category,
    content: record.content,
    tags: [...record.tags],
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    archivedAt: record.archivedAt,
    expiresAt: record.expiresAt,
  }
}

function mapMemoryError(err: unknown): DaemonError {
  if (err instanceof DaemonError) return err
  if (err instanceof MemoryNotFoundError) {
    return new DaemonError('MEMORY_NOT_FOUND', 'Memory record was not found', { statusCode: 404 })
  }
  if (err instanceof MemoryDuplicateError) {
    return new DaemonError('MEMORY_DUPLICATE', err.message, { statusCode: 409 })
  }
  if (err instanceof MemoryCredentialError) {
    return new DaemonError('MEMORY_CREDENTIAL_REJECTED', err.message, { statusCode: 400 })
  }
  if (err instanceof MemoryAuthorizationError) {
    return new DaemonError('MEMORY_FORBIDDEN', err.message, { statusCode: 403 })
  }
  if (err instanceof MemoryValidationError || err instanceof MemoryUnsupportedOriginError) {
    return new DaemonError('VALIDATION_ERROR', err.message, { statusCode: 400 })
  }
  if (err instanceof MemoryError) {
    return new DaemonError('MEMORY_ERROR', redactSecrets(err.message), { statusCode: 500 })
  }
  return new DaemonError(
    'MEMORY_ERROR',
    redactSecrets(err instanceof Error ? err.message : String(err)),
    { statusCode: 500 },
  )
}

export class MemoryService {
  private readonly dbHandle: DatabaseHandle
  private readonly settingsRepo: SettingsRepository
  private readonly repo: SqliteMemoryRepository
  private closed = false

  constructor(dbHandle: DatabaseHandle, settingsRepo: SettingsRepository) {
    this.dbHandle = dbHandle
    this.settingsRepo = settingsRepo
    const borrowed = createBorrowedMemoryDatabaseHandle(dbHandle.sqlite, {
      dbLabel: dbHandle.dbPath,
    })
    this.repo = new SqliteMemoryRepository(borrowed)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.repo.close()
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new DaemonError('MEMORY_UNAVAILABLE', 'Memory service is closed', { statusCode: 503 })
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
          'MEMORY_SCOPE_UNAVAILABLE',
          'Bot workspace path is unavailable for workspace-scoped memory',
          { statusCode: 409 },
        )
      }
    }

    return {
      id: row.id,
      workspaceId,
    }
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

  async listMemories(rawInput: Partial<ListMemoriesIpcInput> = {}): Promise<ListMemoriesResponse> {
    this.assertOpen()
    const parsed = ListMemoriesIpcInputSchema.safeParse(rawInput)
    if (!parsed.success) {
      throw new DaemonError(
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid memory list query',
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
    const auth: MemoryAuthContext = {
      actorId: DAEMON_MEMORY_ACTOR_ID,
      userId: LOCAL_USER_ID,
      botId: resolvedBot?.id,
      workspaceId: resolvedBot?.workspaceId,
      allowUserWideRead: includeUserWide,
      allowUserWideWrite: false,
      allowArchivedRead: input.includeArchived,
    }

    try {
      const result = this.repo.list(auth, {
        scopeKinds: input.scopeKind ? [input.scopeKind] : undefined,
        includeUserWide,
        includeArchived: input.includeArchived,
        includeExpired: false,
        category: input.category,
        limit: input.limit,
        offset: input.offset,
      })
      return {
        records: result.items.map(toMemoryDto),
        total: result.total,
        hasMore: result.offset + result.items.length < result.total,
      }
    } catch (err) {
      throw mapMemoryError(err)
    }
  }

  async searchMemories(rawInput: SearchMemoriesIpcInput): Promise<SearchMemoriesResponse> {
    this.assertOpen()
    const parsed = SearchMemoriesIpcInputSchema.safeParse(rawInput)
    if (!parsed.success) {
      throw new DaemonError(
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid memory search query',
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
    const auth: MemoryAuthContext = {
      actorId: DAEMON_MEMORY_ACTOR_ID,
      userId: LOCAL_USER_ID,
      botId: resolvedBot?.id,
      workspaceId: resolvedBot?.workspaceId,
      allowUserWideRead: includeUserWide,
      allowUserWideWrite: false,
    }

    try {
      const result = this.repo.search(auth, {
        query: input.query,
        scopeKinds: input.scopeKind ? [input.scopeKind] : undefined,
        includeUserWide,
        limit: input.limit,
        deduplicateAcrossScopes: true,
      })
      return {
        matches: result.items.map((m) => ({
          record: toMemoryDto(m.record),
          score: m.score,
        })),
        engine: result.engine,
        total: result.items.length,
      }
    } catch (err) {
      throw mapMemoryError(err)
    }
  }

  async createMemory(rawInput: CreateMemoryIpcInput): Promise<MemoryRecordDto> {
    this.assertOpen()
    if (!this.settingsRepo.getSettings().memory.enabled) {
      throw new DaemonError('MEMORY_DISABLED', 'Memory storage is disabled in Settings.', {
        statusCode: 409,
      })
    }

    const parsed = CreateMemoryIpcInputSchema.safeParse(rawInput)
    if (!parsed.success) {
      throw new DaemonError(
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid create memory payload',
        { statusCode: 400 },
      )
    }

    const input = parsed.data
    let scope: MemoryScope
    let auth: MemoryAuthContext

    if (input.scope.kind === 'user') {
      scope = { kind: 'user', userId: LOCAL_USER_ID }
      auth = {
        actorId: DAEMON_MEMORY_ACTOR_ID,
        userId: LOCAL_USER_ID,
        allowUserWideRead: true,
        allowUserWideWrite: true,
      }
    } else if (input.scope.kind === 'bot') {
      const resolved = await this.resolveActiveBot(input.scope.botId)
      scope = { kind: 'bot', userId: LOCAL_USER_ID, botId: resolved.id }
      auth = {
        actorId: DAEMON_MEMORY_ACTOR_ID,
        userId: LOCAL_USER_ID,
        botId: resolved.id,
        allowUserWideRead: false,
        allowUserWideWrite: false,
      }
    } else {
      const resolved = await this.resolveActiveBot(input.scope.botId, true)
      if (!resolved.workspaceId) {
        throw new DaemonError(
          'MEMORY_SCOPE_UNAVAILABLE',
          'Bot workspace path is unavailable for workspace-scoped memory',
          { statusCode: 409 },
        )
      }
      scope = { kind: 'workspace', userId: LOCAL_USER_ID, workspaceId: resolved.workspaceId }
      auth = {
        actorId: DAEMON_MEMORY_ACTOR_ID,
        userId: LOCAL_USER_ID,
        botId: resolved.id,
        workspaceId: resolved.workspaceId,
        allowUserWideRead: false,
        allowUserWideWrite: false,
      }
    }

    try {
      const created = this.repo.create(auth, {
        scope,
        origin: 'explicit',
        category: input.category,
        content: input.content,
        tags: input.tags,
        expiresAt: input.expiresAt ?? null,
        sourceRefs: [{ kind: 'user_input', refId: 'settings_memory' }],
      })
      this.writeAudit('memory.create', created.id, 'ok', {
        scopeKind: created.scope.kind,
        category: created.category,
      })
      return toMemoryDto(created)
    } catch (err) {
      throw mapMemoryError(err)
    }
  }

  private async resolveRecordWriteAuth(id: string, requireActiveBot: boolean): Promise<MemoryAuthContext> {
    const idCheck = MemoryIdParamSchema.safeParse({ id })
    if (!idCheck.success) {
      throw new DaemonError('VALIDATION_ERROR', 'Invalid memory identifier', { statusCode: 400 })
    }

    const row = this.dbHandle.sqlite
      .prepare('SELECT id, scope_kind, user_id, bot_id, workspace_id FROM memories WHERE id = ?')
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
      throw new DaemonError('MEMORY_NOT_FOUND', 'Memory record was not found', { statusCode: 404 })
    }

    if (row.scope_kind === 'user') {
      return {
        actorId: DAEMON_MEMORY_ACTOR_ID,
        userId: LOCAL_USER_ID,
        allowUserWideRead: true,
        allowUserWideWrite: true,
        allowArchivedRead: true,
      }
    }

    if (row.scope_kind === 'bot' && row.bot_id) {
      if (requireActiveBot) {
        await this.resolveActiveBot(row.bot_id)
      }
      return {
        actorId: DAEMON_MEMORY_ACTOR_ID,
        userId: LOCAL_USER_ID,
        botId: row.bot_id,
        allowUserWideRead: false,
        allowUserWideWrite: false,
        allowArchivedRead: true,
      }
    }

    if (row.scope_kind === 'workspace' && row.workspace_id) {
      return {
        actorId: DAEMON_MEMORY_ACTOR_ID,
        userId: LOCAL_USER_ID,
        workspaceId: row.workspace_id,
        allowUserWideRead: false,
        allowUserWideWrite: false,
        allowArchivedRead: true,
      }
    }

    throw new DaemonError('MEMORY_NOT_FOUND', 'Memory record was not found', { statusCode: 404 })
  }

  async updateMemory(rawInput: UpdateMemoryIpcInput): Promise<MemoryRecordDto> {
    this.assertOpen()
    if (!this.settingsRepo.getSettings().memory.enabled) {
      throw new DaemonError('MEMORY_DISABLED', 'Memory storage is disabled in Settings.', {
        statusCode: 409,
      })
    }
    const parsed = UpdateMemoryIpcInputSchema.safeParse(rawInput)
    if (!parsed.success) {
      throw new DaemonError(
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid update memory payload',
        { statusCode: 400 },
      )
    }

    const input = parsed.data
    const auth = await this.resolveRecordWriteAuth(input.id, true)
    try {
      const updated = this.repo.update(auth, input.id, {
        content: input.content,
        category: input.category,
        tags: input.tags,
        expiresAt: input.expiresAt,
      })
      this.writeAudit('memory.update', updated.id, 'ok', {
        scopeKind: updated.scope.kind,
        category: updated.category,
      })
      return toMemoryDto(updated)
    } catch (err) {
      throw mapMemoryError(err)
    }
  }

  async archiveMemory(id: string): Promise<MemoryRecordDto> {
    this.assertOpen()
    const auth = await this.resolveRecordWriteAuth(id, false)
    try {
      const archived = this.repo.archive(auth, id)
      this.writeAudit('memory.archive', archived.id, 'ok', {
        scopeKind: archived.scope.kind,
      })
      return toMemoryDto(archived)
    } catch (err) {
      throw mapMemoryError(err)
    }
  }

  async deleteMemory(id: string): Promise<{ deletedId: string }> {
    this.assertOpen()
    const auth = await this.resolveRecordWriteAuth(id, false)
    try {
      const deleted = this.repo.delete(auth, id)
      if (!deleted) {
        throw new DaemonError('MEMORY_NOT_FOUND', 'Memory record was not found', { statusCode: 404 })
      }
      this.writeAudit('memory.delete', id, 'ok', {})
      return { deletedId: id }
    } catch (err) {
      throw mapMemoryError(err)
    }
  }

  /**
   * Archives active bot-scoped memories inside an active caller transaction.
   * Never touches user-wide memories.
   */
  archiveMemoriesForBotInTx(botId: string, now = new Date().toISOString()): number {
    this.assertOpen()
    const result = this.dbHandle.sqlite
      .prepare(
        `UPDATE memories
         SET status = 'archived', archived_at = ?, updated_at = ?
         WHERE user_id = ? AND scope_kind = 'bot' AND bot_id = ? AND status = 'active'`,
      )
      .run(now, now, LOCAL_USER_ID, botId)
    const count = Number(result.changes ?? 0)
    if (count > 0) {
      this.writeAudit('memory.archive_bot', botId, 'ok', { archivedCount: count })
    }
    return count
  }

  /**
   * Archives active bot-scoped memories when a bot is soft-archived/deleted.
   * Never touches user-wide memories.
   */
  archiveMemoriesForBot(botId: string): number {
    this.assertOpen()
    const now = new Date().toISOString()
    return this.dbHandle.transaction(() => this.archiveMemoriesForBotInTx(botId, now))
  }

  /**
   * Prepares bounded, revalidated untrusted memory context at the exact execution dispatch boundary.
   */
  async prepareExecutionContext(params: {
    sessionId: string
    agentId: string
    runtimeId: string
    queryText: string
    isMock: boolean
  }): Promise<PreparedExecutionMemoryContext> {
    this.assertOpen()
    const settings = this.settingsRepo.getSettings().memory
    if (!settings.enabled || !settings.automaticRetrieval) {
      return {
        status: 'disabled',
        mechanism: 'none',
        envelopeJson: null,
        selectedCount: 0,
        totalBytes: 0,
        truncated: false,
      }
    }

    const cap = MEMORY_RUNTIME_CAPABILITIES[params.runtimeId]
    if (!cap || !cap.supported) {
      return {
        status: 'unsupported_runtime',
        mechanism: 'unsupported',
        envelopeJson: null,
        selectedCount: 0,
        totalBytes: 0,
        truncated: false,
      }
    }

    if (!params.isMock && !settings.externalProviderConsent) {
      return {
        status: 'consent_required',
        mechanism: cap.mechanism,
        envelopeJson: null,
        selectedCount: 0,
        totalBytes: 0,
        truncated: false,
      }
    }

    const sessionRow = this.dbHandle.sqlite
      .prepare('SELECT id, agent_id, archived_at FROM sessions WHERE id = ?')
      .get(params.sessionId) as
      | { id: string; agent_id: string; archived_at: string | null }
      | undefined

    if (!sessionRow || sessionRow.archived_at !== null || sessionRow.agent_id !== params.agentId) {
      throw new DaemonError(
        'MEMORY_AUTHORIZATION_FAILED',
        'Session ownership check failed for memory context',
        { statusCode: 403 },
      )
    }

    const resolvedBot = await this.resolveActiveBot(params.agentId)
    const auth: MemoryAuthContext = {
      actorId: DAEMON_MEMORY_ACTOR_ID,
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
        selectedCount: 0,
        totalBytes: 0,
        truncated: false,
      }
    }

    const searchResult = this.repo.search(auth, {
      query: trimmedQuery,
      includeUserWide: settings.includeUserWide,
      limit: 8,
      deduplicateAcrossScopes: true,
    })

    if (searchResult.items.length === 0) {
      return {
        status: 'empty',
        mechanism: cap.mechanism,
        envelopeJson: null,
        selectedCount: 0,
        totalBytes: 0,
        truncated: false,
      }
    }

    // Revalidate every candidate from current repository state right before dispatch.
    const revalidated: MemoryRecord[] = []
    for (const match of searchResult.items) {
      const fresh = this.repo.getById(auth, match.record.id, {
        includeUserWide: settings.includeUserWide,
      })
      if (fresh) {
        revalidated.push(fresh)
      }
    }

    if (revalidated.length === 0) {
      return {
        status: 'empty',
        mechanism: cap.mechanism,
        envelopeJson: null,
        selectedCount: 0,
        totalBytes: 0,
        truncated: false,
      }
    }

    const assembled = buildMemoryContext(auth, revalidated, {
      includeUserWide: settings.includeUserWide,
      maxRecords: 6,
      maxChars: 3000,
      maxBytes: 8192,
      deduplicate: true,
    })

    if (assembled.metadata.selectedCount === 0) {
      return {
        status: 'empty',
        mechanism: cap.mechanism,
        envelopeJson: null,
        selectedCount: 0,
        totalBytes: 0,
        truncated: assembled.metadata.skippedCount > 0,
      }
    }

    return {
      status: 'attached',
      mechanism: cap.mechanism,
      envelopeJson: assembled.serialized,
      selectedCount: assembled.metadata.selectedCount,
      totalBytes: assembled.metadata.bytes,
      truncated: assembled.metadata.skippedCount > 0,
    }
  }
}
