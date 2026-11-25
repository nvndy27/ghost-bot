import { randomUUID } from 'node:crypto'
import type { SQLInputValue } from 'node:sqlite'
import { sanitizeErrorMessage } from '@ghost-bot/memory'
import {
  McpDuplicateError,
  McpError,
  McpNotFoundError,
  McpStorageCorruptionError,
  McpStorageError,
  McpValidationError,
} from '../contracts/errors.ts'
import { MCP_LIMITS, MCP_SCHEMA_VERSION } from '../contracts/limits.ts'
import {
  ListMcpServersQuerySchema,
  McpServerConfigSchema,
  McpServerIdSchema,
  RegisterMcpServerInputSchema,
  UpdateMcpServerInputSchema,
} from '../contracts/schemas.ts'
import type {
  Clock,
  IdGenerator,
  ListMcpServersQuery,
  McpAuthContext,
  McpScope,
  McpServerConfig,
  RegisterMcpServerInput,
  UpdateMcpServerInput,
} from '../contracts/types.ts'
import { computeServerConfigFingerprint } from '../registry/fingerprint.ts'
import type { McpRegistryRepository, McpServerListResult } from '../registry/interface.ts'
import {
  authorizeMcpRegister,
  canManageMcpServer,
  canReadMcpServer,
  getScopeKey,
  resolveAuthorizedMcpScopes,
  validateMcpAuthContext,
} from '../security/authorization.ts'
import { assertNoCredentialsInServerInput } from '../security/redaction.ts'
import { computeLaunchBinaryDigestSync } from '../security/path-guard.ts'
import type { McpDatabaseHandle } from './sqlite-client.ts'

export interface SqliteMcpRegistryOptions {
  clock?: Clock
  idGenerator?: IdGenerator
}

function buildScopeFromRow(row: Record<string, unknown>): McpScope {
  if (row.scope_kind === 'user') return { kind: 'user', userId: String(row.user_id) }
  if (row.scope_kind === 'bot') return { kind: 'bot', userId: String(row.user_id), botId: String(row.bot_id) }
  if (row.scope_kind === 'workspace') {
    return { kind: 'workspace', userId: String(row.user_id), workspaceId: String(row.workspace_id) }
  }
  throw new McpStorageCorruptionError('Stored MCP server row has invalid scope_kind')
}

function decodeServerRow(row: Record<string, unknown>): McpServerConfig {
  let transport: unknown
  try {
    if (typeof row.transport_json !== 'string') throw new Error('Missing transport_json')
    transport = JSON.parse(row.transport_json)
  } catch {
    throw new McpStorageCorruptionError('Stored MCP server row contains invalid JSON transport')
  }

  const parsed = McpServerConfigSchema.safeParse({
    schemaVersion: row.schema_version,
    id: row.id,
    scope: buildScopeFromRow(row),
    displayName: row.display_name,
    description: row.description,
    transport,
    enabled: row.enabled === 1,
    trustState: row.trust_state,
    configFingerprint: row.config_fingerprint,
    trustedFingerprint: row.trusted_fingerprint ?? null,
    trustedBinaryDigest: row.trusted_binary_digest ?? null,
    connectTimeoutMs: row.connect_timeout_ms,
    requestTimeoutMs: row.request_timeout_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
  if (!parsed.success) {
    throw new McpStorageCorruptionError('Stored MCP server row failed contract validation')
  }
  const server = parsed.data
  const fingerprint = computeServerConfigFingerprint(server.scope, server.transport)
  if (row.scope_key !== getScopeKey(server.scope) || server.configFingerprint !== fingerprint ||
      (server.trustState === 'trusted' ? server.trustedFingerprint !== fingerprint : server.trustedFingerprint !== null) ||
      (server.enabled && server.trustState !== 'trusted')) {
    throw new McpStorageCorruptionError('Stored MCP server row has inconsistent scope or trust')
  }
  return server
}

function isUniqueConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('UNIQUE constraint failed') || (msg.includes('ERR_SQLITE_ERROR') && msg.includes('UNIQUE'))
}

export class SqliteMcpRegistry implements McpRegistryRepository {
  private readonly handle: McpDatabaseHandle
  private readonly clock: Clock
  private readonly idGenerator: IdGenerator
  private closed = false

  constructor(handle: McpDatabaseHandle, options: SqliteMcpRegistryOptions = {}) {
    this.handle = handle
    this.clock = options.clock ?? (() => new Date())
    this.idGenerator = options.idGenerator ?? (() => randomUUID())
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new McpStorageError('MCP registry is closed')
    }
  }

  private nowIso(): string {
    const d = this.clock()
    if (!(d instanceof Date) || !Number.isFinite(d.getTime())) {
      throw new McpValidationError('Registry clock returned an invalid Date')
    }
    return d.toISOString()
  }

  register(rawAuth: McpAuthContext, rawInput: RegisterMcpServerInput): McpServerConfig {
    this.assertOpen()
    const auth = validateMcpAuthContext(rawAuth)
    const parsed = RegisterMcpServerInputSchema.safeParse(rawInput)
    if (!parsed.success) {
      throw new McpValidationError(
        `Invalid register MCP server input: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
      )
    }
    const input = parsed.data
    authorizeMcpRegister(auth, input.scope)
    assertNoCredentialsInServerInput({
      displayName: input.displayName,
      description: input.description,
      transport: input.transport,
    })

    const rawId = input.id ?? this.idGenerator()
    const idParsed = McpServerIdSchema.safeParse(rawId)
    if (!idParsed.success) {
      throw new McpValidationError('Generated or supplied MCP server ID is invalid')
    }

    const now = this.nowIso()
    const scopeKey = getScopeKey(input.scope)
    const configFingerprint = computeServerConfigFingerprint(input.scope, input.transport)

    const server = McpServerConfigSchema.parse({
      schemaVersion: MCP_SCHEMA_VERSION,
      id: idParsed.data,
      scope: input.scope,
      displayName: input.displayName,
      description: input.description,
      transport: input.transport,
      enabled: false,
      trustState: 'untrusted',
      configFingerprint,
      trustedFingerprint: null,
      trustedBinaryDigest: null,
      connectTimeoutMs: input.connectTimeoutMs ?? MCP_LIMITS.defaultConnectTimeoutMs,
      requestTimeoutMs: input.requestTimeoutMs ?? MCP_LIMITS.defaultRequestTimeoutMs,
      createdAt: now,
      updatedAt: now,
    })

    try {
      this.handle.transaction(() => {
        const existingId = this.handle.sqlite
          .prepare('SELECT id FROM mcp_servers WHERE id = ?')
          .get(server.id)
        if (existingId) {
          throw new McpValidationError('MCP server ID already exists')
        }

        this.handle.sqlite
          .prepare(
            `INSERT INTO mcp_servers (
              id, schema_version, scope_kind, user_id, bot_id, workspace_id, scope_key,
              display_name, description, transport_json, enabled, trust_state,
              config_fingerprint, trusted_fingerprint, trusted_binary_digest, connect_timeout_ms, request_timeout_ms,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            server.id,
            server.schemaVersion,
            server.scope.kind,
            server.scope.userId,
            server.scope.kind === 'bot' ? server.scope.botId : null,
            server.scope.kind === 'workspace' ? server.scope.workspaceId : null,
            scopeKey,
            server.displayName,
            server.description,
            JSON.stringify(server.transport),
            0,
            server.trustState,
            server.configFingerprint,
            server.trustedFingerprint,
            server.trustedBinaryDigest,
            server.connectTimeoutMs,
            server.requestTimeoutMs,
            server.createdAt,
            server.updatedAt,
          )
      })
    } catch (err) {
      if (err instanceof McpError) throw err
      if (isUniqueConstraintError(err)) {
        throw new McpDuplicateError()
      }
      throw new McpStorageError(`Failed to register MCP server: ${sanitizeErrorMessage(err)}`)
    }

    return server
  }

  getById(
    rawAuth: McpAuthContext,
    serverId: string,
    options?: { includeUserWide?: boolean },
  ): McpServerConfig | null {
    this.assertOpen()
    const auth = validateMcpAuthContext(rawAuth)
    if (!McpServerIdSchema.safeParse(serverId).success) return null

    const row = this.handle.sqlite
      .prepare('SELECT * FROM mcp_servers WHERE id = ?')
      .get(serverId) as Record<string, unknown> | undefined
    if (!row) return null
    const server = decodeServerRow(row)

    const includeUserWide = options?.includeUserWide ?? false
    if (!canReadMcpServer(auth, server.scope, { includeUserWide })) {
      return null
    }
    return server
  }

  list(rawAuth: McpAuthContext, rawQuery: ListMcpServersQuery = {}): McpServerListResult {
    this.assertOpen()
    const auth = validateMcpAuthContext(rawAuth)
    const parsed = ListMcpServersQuerySchema.safeParse(rawQuery)
    if (!parsed.success) {
      throw new McpValidationError(
        `Invalid list MCP servers query: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
      )
    }
    const query = parsed.data
    const allowedScopes = resolveAuthorizedMcpScopes(auth, query.scopeKinds, query.includeUserWide)
    if (allowedScopes.length === 0) {
      return { items: [], total: 0, limit: query.limit, offset: query.offset }
    }

    const scopeKeys = allowedScopes.map(getScopeKey)
    const placeholders = scopeKeys.map(() => '?').join(', ')
    const where = [`scope_key IN (${placeholders})`, 'user_id = ?']
    const params: SQLInputValue[] = [...scopeKeys, auth.host.userId]

    if (query.enabledOnly) {
      where.push('enabled = 1')
    }

    const rows = this.handle.sqlite
      .prepare(`SELECT * FROM mcp_servers WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id ASC`)
      .all(...params) as unknown as Array<Record<string, unknown>>

    const servers = rows
      .map(decodeServerRow)
      .filter((s) => canReadMcpServer(auth, s.scope, { includeUserWide: query.includeUserWide }))

    return {
      items: servers.slice(query.offset, query.offset + query.limit),
      total: servers.length,
      limit: query.limit,
      offset: query.offset,
    }
  }

  update(rawAuth: McpAuthContext, serverId: string, rawInput: UpdateMcpServerInput): McpServerConfig {
    this.assertOpen()
    const auth = validateMcpAuthContext(rawAuth)
    if (!McpServerIdSchema.safeParse(serverId).success) {
      throw new McpValidationError('Invalid MCP server ID')
    }
    const parsed = UpdateMcpServerInputSchema.safeParse(rawInput)
    if (!parsed.success) {
      throw new McpValidationError(
        `Invalid update MCP server input: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
      )
    }
    const input = parsed.data
    assertNoCredentialsInServerInput({
      displayName: input.displayName,
      description: input.description,
      transport: input.transport,
    })

    const now = this.nowIso()
    try {
      return this.handle.transaction(() => {
        const row = this.handle.sqlite
          .prepare('SELECT * FROM mcp_servers WHERE id = ?')
          .get(serverId) as Record<string, unknown> | undefined
        if (!row) throw new McpNotFoundError()
        const existing = decodeServerRow(row)
        if (!canManageMcpServer(auth, existing.scope)) {
          throw new McpNotFoundError()
        }

        const nextTransport = input.transport ?? existing.transport
        const nextFingerprint = computeServerConfigFingerprint(existing.scope, nextTransport)
        const configChanged = nextFingerprint !== existing.configFingerprint

        const updated = McpServerConfigSchema.parse({
          ...existing,
          displayName: input.displayName ?? existing.displayName,
          description: input.description ?? existing.description,
          transport: nextTransport,
          configFingerprint: nextFingerprint,
          enabled: configChanged ? false : existing.enabled,
          trustState: configChanged ? 'untrusted' : existing.trustState,
          trustedFingerprint: configChanged ? null : existing.trustedFingerprint,
          trustedBinaryDigest: configChanged ? null : existing.trustedBinaryDigest,
          connectTimeoutMs: input.connectTimeoutMs ?? existing.connectTimeoutMs,
          requestTimeoutMs: input.requestTimeoutMs ?? existing.requestTimeoutMs,
          updatedAt: now,
        })

        this.handle.sqlite
          .prepare(
            `UPDATE mcp_servers SET
              display_name = ?, description = ?, transport_json = ?,
              enabled = ?, trust_state = ?, config_fingerprint = ?, trusted_fingerprint = ?, trusted_binary_digest = ?,
              connect_timeout_ms = ?, request_timeout_ms = ?, updated_at = ?
            WHERE id = ?`,
          )
          .run(
            updated.displayName,
            updated.description,
            JSON.stringify(updated.transport),
            updated.enabled ? 1 : 0,
            updated.trustState,
            updated.configFingerprint,
            updated.trustedFingerprint,
            updated.trustedBinaryDigest,
            updated.connectTimeoutMs,
            updated.requestTimeoutMs,
            updated.updatedAt,
            updated.id,
          )

        return updated
      })
    } catch (err) {
      if (err instanceof McpError) throw err
      if (isUniqueConstraintError(err)) {
        throw new McpDuplicateError()
      }
      throw new McpStorageError(`Failed to update MCP server: ${sanitizeErrorMessage(err)}`)
    }
  }

  enable(rawAuth: McpAuthContext, serverId: string): McpServerConfig {
    return this.mutateState(rawAuth, serverId, (existing, now) => ({
      ...existing,
      enabled: true,
      updatedAt: now,
    }))
  }

  disable(rawAuth: McpAuthContext, serverId: string): McpServerConfig {
    return this.mutateState(rawAuth, serverId, (existing, now) => ({
      ...existing,
      enabled: false,
      updatedAt: now,
    }))
  }

  approveTrust(rawAuth: McpAuthContext, serverId: string): McpServerConfig {
    return this.mutateState(rawAuth, serverId, (existing, now) => ({
      ...existing,
      trustState: 'trusted',
      trustedFingerprint: existing.configFingerprint,
      trustedBinaryDigest: computeLaunchBinaryDigestSync(
        existing.transport.executablePath,
        existing.transport.args,
      ),
      updatedAt: now,
    }))
  }

  revokeTrust(rawAuth: McpAuthContext, serverId: string): McpServerConfig {
    return this.mutateState(rawAuth, serverId, (existing, now) => ({
      ...existing,
      enabled: false,
      trustState: 'revoked',
      trustedFingerprint: null,
      trustedBinaryDigest: null,
      updatedAt: now,
    }))
  }

  private mutateState(
    rawAuth: McpAuthContext,
    serverId: string,
    transform: (existing: McpServerConfig, now: string) => McpServerConfig,
  ): McpServerConfig {
    this.assertOpen()
    const auth = validateMcpAuthContext(rawAuth)
    if (!McpServerIdSchema.safeParse(serverId).success) {
      throw new McpValidationError('Invalid MCP server ID')
    }
    const now = this.nowIso()

    return this.handle.transaction(() => {
      const row = this.handle.sqlite
        .prepare('SELECT * FROM mcp_servers WHERE id = ?')
        .get(serverId) as Record<string, unknown> | undefined
      if (!row) throw new McpNotFoundError()
      const existing = decodeServerRow(row)
      if (!canManageMcpServer(auth, existing.scope)) {
        throw new McpNotFoundError()
      }

      const next = McpServerConfigSchema.parse(transform(existing, now))
      this.handle.sqlite
        .prepare(
          'UPDATE mcp_servers SET enabled = ?, trust_state = ?, trusted_fingerprint = ?, trusted_binary_digest = ?, updated_at = ? WHERE id = ?',
        )
        .run(
          next.enabled ? 1 : 0,
          next.trustState,
          next.trustedFingerprint,
          next.trustedBinaryDigest,
          next.updatedAt,
          next.id,
        )
      return next
    })
  }

  delete(rawAuth: McpAuthContext, serverId: string): boolean {
    this.assertOpen()
    const auth = validateMcpAuthContext(rawAuth)
    if (!McpServerIdSchema.safeParse(serverId).success) {
      throw new McpValidationError('Invalid MCP server ID')
    }

    return this.handle.transaction(() => {
      const row = this.handle.sqlite
        .prepare('SELECT * FROM mcp_servers WHERE id = ?')
        .get(serverId) as Record<string, unknown> | undefined
      if (!row) throw new McpNotFoundError()
      const existing = decodeServerRow(row)
      if (!canManageMcpServer(auth, existing.scope)) {
        throw new McpNotFoundError()
      }

      const res = this.handle.sqlite.prepare('DELETE FROM mcp_servers WHERE id = ?').run(existing.id)
      return res.changes > 0
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.handle.close()
  }
}
