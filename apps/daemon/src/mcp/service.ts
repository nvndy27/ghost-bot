import {
  buildCapabilityKey,
  createBorrowedMcpDatabaseHandle,
  McpAuthorizationError,
  McpCancelledError,
  McpConnectionManager,
  McpCredentialError,
  McpDuplicateError,
  McpError,
  McpNotFoundError,
  McpTimeoutError,
  McpToolExecutionError,
  McpTransportError,
  McpTrustError,
  McpUnsafePathError,
  McpValidationError,
  SqliteMcpRegistry,
  validateMcpAuthContext,
  type McpAuthContext,
  type McpCapabilitySnapshot,
  type McpConnectionInfo,
  type McpDatabaseHandle,
  type McpScope,
  type McpServerConfig,
  type McpToolInvocationResult,
  type ParsedMcpAuthContext,
} from '@ghost-bot/mcp'
import {
  GetMcpPromptInputSchema,
  ListMcpServersInputSchema,
  McpServerIdParamSchema,
  ReadMcpResourceInputSchema,
  RegisterMcpServerIpcInputSchema,
  SetMcpServerEnabledInputSchema,
  UpdateMcpServerIpcInputSchema,
  type GetMcpPromptInput,
  type GetMcpPromptResponse,
  type ListMcpServersInput,
  type ListMcpServersResponse,
  type McpCapabilitySnapshotDto,
  type McpConnectionStatusDto,
  type McpScopeInput,
  type McpServerDto,
  type ReadMcpResourceInput,
  type ReadMcpResourceResponse,
  type RegisterMcpServerIpcInput,
  type SetMcpServerEnabledInput,
  type UpdateMcpServerIpcInput,
} from '@ghost-bot/shared-types/ipc'
import type { PermissionMode } from '@ghost-bot/shared-types/runtime'
import type { DatabaseHandle } from '../db/client.ts'
import { DaemonError, redactSecrets } from '../errors.ts'
import { deriveWorkspaceId, LOCAL_USER_ID } from '../memory/service.ts'
import type { RuntimePolicyBroker } from '../runtime/policy-broker.ts'
import type { SettingsRepository } from '../settings/repository.ts'

const DAEMON_MCP_ACTOR_ID = 'daemon_mcp'

export type McpSecretResolver = (server: McpServerConfig) => Record<string, string>

export function createDefaultMcpSecretResolver(): McpSecretResolver {
  return (server) => {
    if (server.transport.secretRefs.length > 0) {
      throw new McpCredentialError(
        'OS secret store is unavailable; cannot resolve MCP server secret references',
      )
    }
    return {}
  }
}

export interface McpServiceOptions {
  db: DatabaseHandle
  settingsRepo: SettingsRepository
  policyBroker: RuntimePolicyBroker
  secretResolver?: McpSecretResolver
  hostEnv?: Record<string, string | undefined>
  gracefulShutdownMs?: number
}

function toScopeInput(scope: McpScope): McpScopeInput {
  if (scope.kind === 'user') return { kind: 'user' }
  if (scope.kind === 'bot') return { kind: 'bot', botId: scope.botId }
  return { kind: 'workspace', workspacePath: scope.workspaceId }
}

function toMcpScope(scope: McpScopeInput): McpScope {
  if (scope.kind === 'user') {
    return { kind: 'user', userId: LOCAL_USER_ID }
  }
  if (scope.kind === 'bot') {
    return { kind: 'bot', userId: LOCAL_USER_ID, botId: scope.botId }
  }
  return {
    kind: 'workspace',
    userId: LOCAL_USER_ID,
    workspaceId: deriveWorkspaceId(scope.workspacePath),
  }
}

function toServerDto(server: McpServerConfig, conn: McpConnectionInfo | null): McpServerDto {
  return {
    id: server.id,
    scope: toScopeInput(server.scope),
    displayName: server.displayName,
    description: server.description,
    transport: server.transport,
    enabled: server.enabled,
    trustState: server.trustState,
    configFingerprint: server.configFingerprint,
    trustedFingerprint: server.trustedFingerprint,
    trustedBinaryDigest: server.trustedBinaryDigest,
    connectTimeoutMs: server.connectTimeoutMs,
    requestTimeoutMs: server.requestTimeoutMs,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
    connectionState: conn?.state ?? 'disconnected',
    lastError: conn?.lastError ?? null,
    pid: conn?.pid ?? null,
    generation: conn?.generation ?? 0,
  }
}

function toConnectionStatusDto(serverId: string, conn: McpConnectionInfo | null, fallbackFingerprint = ''): McpConnectionStatusDto {
  return {
    serverId,
    state: conn?.state ?? 'disconnected',
    generation: conn?.generation ?? 0,
    configFingerprint: conn?.configFingerprint ?? fallbackFingerprint,
    pid: conn?.pid ?? null,
    lastError: conn?.lastError ?? null,
    hasCapabilities: conn?.hasCapabilities ?? false,
  }
}

function toCapabilityDto(snapshot: McpCapabilitySnapshot): McpCapabilitySnapshotDto {
  return {
    serverId: snapshot.serverId,
    discoveredAt: snapshot.discoveredAt,
    configFingerprint: snapshot.configFingerprint,
    tools: snapshot.tools,
    resources: snapshot.resources,
    resourceTemplates: snapshot.resourceTemplates,
    prompts: snapshot.prompts,
  }
}

function mapMcpError(err: unknown): DaemonError {
  if (err instanceof DaemonError) return err
  if (err instanceof McpNotFoundError) {
    return new DaemonError('MCP_NOT_FOUND', redactSecrets(err.message), { statusCode: 404 })
  }
  if (err instanceof McpDuplicateError) {
    return new DaemonError('MCP_DUPLICATE', redactSecrets(err.message), { statusCode: 409 })
  }
  if (err instanceof McpAuthorizationError) {
    return new DaemonError('MCP_FORBIDDEN', redactSecrets(err.message), { statusCode: 403 })
  }
  if (err instanceof McpTrustError) {
    return new DaemonError('MCP_UNTRUSTED', redactSecrets(err.message), { statusCode: 403 })
  }
  if (err instanceof McpCredentialError) {
    return new DaemonError('MCP_SECRET_UNAVAILABLE', redactSecrets(err.message), { statusCode: 400 })
  }
  if (err instanceof McpUnsafePathError || err instanceof McpValidationError) {
    return new DaemonError('VALIDATION_ERROR', redactSecrets(err.message), { statusCode: 400 })
  }
  if (err instanceof McpTimeoutError) {
    return new DaemonError('MCP_TIMEOUT', redactSecrets(err.message), { statusCode: 504 })
  }
  if (err instanceof McpCancelledError) {
    return new DaemonError('MCP_CANCELLED', redactSecrets(err.message), { statusCode: 499 })
  }
  if (err instanceof McpToolExecutionError || err instanceof McpTransportError || err instanceof McpError) {
    return new DaemonError('MCP_EXECUTION_ERROR', redactSecrets(err.message), { statusCode: 502 })
  }
  return new DaemonError(
    'MCP_INTERNAL_ERROR',
    redactSecrets(err instanceof Error ? err.message : 'Unexpected MCP error'),
    { statusCode: 500 },
  )
}

export class McpService {
  private readonly db: DatabaseHandle
  private readonly settingsRepo: SettingsRepository
  private readonly policyBroker: RuntimePolicyBroker
  private readonly mcpHandle: McpDatabaseHandle
  private readonly registry: SqliteMcpRegistry
  private readonly connectionManager: McpConnectionManager
  private readonly capabilitiesCache = new Map<string, McpCapabilitySnapshot>()
  private readonly activeRunPermissionByServer = new Map<string, PermissionMode>()

  constructor(options: McpServiceOptions) {
    this.db = options.db
    this.settingsRepo = options.settingsRepo
    this.policyBroker = options.policyBroker
    this.mcpHandle = createBorrowedMcpDatabaseHandle(options.db.sqlite)
    this.registry = new SqliteMcpRegistry(this.mcpHandle)

    const resolveSecrets = options.secretResolver ?? createDefaultMcpSecretResolver()
    this.connectionManager = new McpConnectionManager({
      registry: this.registry,
      hostEnv: options.hostEnv ?? {},
      resolveSecrets,
      gracefulShutdownMs: options.gracefulShutdownMs,
      hostPolicy: {
        evaluateLaunch: (auth, server) => this.evaluateHostPolicy('launch', server),
        evaluateToolInvocation: (auth, server) => this.evaluateHostPolicy('tool', server),
      },
    })
  }

  private evaluateHostPolicy(action: 'launch' | 'tool', server: McpServerConfig) {
    if (!this.settingsRepo.getSettings().mcp.enabled) {
      return { allowed: false, reason: 'MCP integration is disabled in settings' }
    }
    const mode = this.resolveEffectivePermissionMode(server)
    const adapter = this.policyBroker.createMcpPolicyAdapter(mode)
    const parsedAuth = validateMcpAuthContext(this.buildAuthForServer(server))
    return action === 'launch'
      ? adapter.evaluateLaunch(parsedAuth, server)
      : adapter.evaluateToolInvocation(parsedAuth, server, '')
  }

  private resolveEffectivePermissionMode(server: McpServerConfig): PermissionMode {
    const runOverride = this.activeRunPermissionByServer.get(server.id)
    if (runOverride) return runOverride

    if (server.scope.kind === 'bot') {
      const row = this.db.sqlite
        .prepare('SELECT permission_mode FROM agents WHERE id = ?')
        .get(server.scope.botId) as { permission_mode?: string } | undefined
      if (row?.permission_mode) {
        return row.permission_mode as PermissionMode
      }
    }

    return 'ask-approval'
  }

  private assertMcpEnabled(): void {
    if (!this.settingsRepo.getSettings().mcp.enabled) {
      throw new DaemonError('MCP_DISABLED', 'MCP integration is disabled in settings', { statusCode: 403 })
    }
  }

  private assertBotExists(botId: string): void {
    const row = this.db.sqlite.prepare('SELECT id FROM agents WHERE id = ?').get(botId) as { id?: string } | undefined
    if (!row?.id) {
      throw new DaemonError('NOT_FOUND', `Bot "${botId}" not found`, { statusCode: 404 })
    }
  }

  private buildManagementAuth(options?: {
    botId?: string
    workspacePath?: string
    allowedTools?: string[]
    allowedToolHashes?: Record<string, string>
    allowedResources?: string[]
    allowedPrompts?: string[]
  }): McpAuthContext {
    return {
      host: {
        userId: LOCAL_USER_ID,
        actorId: DAEMON_MCP_ACTOR_ID,
        allowUserWideRead: true,
        allowUserWideWrite: true,
        ...(options?.botId ? { botId: options.botId } : {}),
        ...(options?.workspacePath ? { workspaceId: deriveWorkspaceId(options.workspacePath) } : {}),
      },
      permissions: {
        canReadConfig: true,
        canManageConfig: true,
        canLaunch: true,
        canDiscover: true,
        allowedTools: options?.allowedTools ?? [],
        ...(options?.allowedToolHashes ? { allowedToolHashes: options.allowedToolHashes } : {}),
        allowedResources: options?.allowedResources ?? [],
        allowedPrompts: options?.allowedPrompts ?? [],
      },
    }
  }

  private getServerUnscopedForDaemon(serverId: string): McpServerConfig {
    const parsedId = McpServerIdParamSchema.parse({ id: serverId })
    const row = this.db.sqlite
      .prepare('SELECT scope_kind, bot_id, workspace_id FROM mcp_servers WHERE id = ?')
      .get(parsedId.id) as { scope_kind?: string; bot_id?: string | null; workspace_id?: string | null } | undefined
    if (!row) {
      throw new DaemonError('MCP_NOT_FOUND', 'MCP server not found', { statusCode: 404 })
    }
    const auth = this.buildManagementAuth({
      botId: row.bot_id ?? undefined,
    })
    if (row.scope_kind === 'workspace' && row.workspace_id) {
      auth.host.workspaceId = row.workspace_id
    }
    const server = this.registry.getById(auth, parsedId.id, { includeUserWide: true })
    if (!server) {
      throw new DaemonError('MCP_NOT_FOUND', 'MCP server not found', { statusCode: 404 })
    }
    return server
  }

  private buildAuthForServer(
    server: McpServerConfig,
    overrides?: {
      allowedTools?: string[]
      allowedToolHashes?: Record<string, string>
      allowedResources?: string[]
      allowedPrompts?: string[]
    },
  ): McpAuthContext {
    return {
      host: {
        userId: LOCAL_USER_ID,
        actorId: DAEMON_MCP_ACTOR_ID,
        allowUserWideRead: true,
        allowUserWideWrite: true,
        ...(server.scope.kind === 'bot' ? { botId: server.scope.botId } : {}),
        ...(server.scope.kind === 'workspace' ? { workspaceId: server.scope.workspaceId } : {}),
      },
      permissions: {
        canReadConfig: true,
        canManageConfig: true,
        canLaunch: true,
        canDiscover: true,
        allowedTools: overrides?.allowedTools ?? [],
        ...(overrides?.allowedToolHashes ? { allowedToolHashes: overrides.allowedToolHashes } : {}),
        allowedResources: overrides?.allowedResources ?? [],
        allowedPrompts: overrides?.allowedPrompts ?? [],
      },
    }
  }

  listServers(rawInput: Partial<ListMcpServersInput> = {}): ListMcpServersResponse {
    try {
      const input = ListMcpServersInputSchema.parse(rawInput)
      const rows = this.db.sqlite
        .prepare('SELECT id, scope_kind, bot_id, workspace_id FROM mcp_servers WHERE user_id = ? ORDER BY updated_at DESC, id ASC')
        .all(LOCAL_USER_ID) as Array<{ id: string; scope_kind: string; bot_id: string | null; workspace_id: string | null }>

      const servers: McpServerDto[] = []
      for (const row of rows) {
        if (input.scopeKinds && !input.scopeKinds.includes(row.scope_kind as 'user' | 'bot' | 'workspace')) {
          continue
        }
        if (row.scope_kind === 'user' && !input.includeUserWide) {
          continue
        }
        if (input.botId && row.scope_kind === 'bot' && row.bot_id !== input.botId) {
          continue
        }
        const server = this.getServerUnscopedForDaemon(row.id)
        if (input.enabledOnly && !server.enabled) continue
        servers.push(toServerDto(server, this.connectionManager.getConnectionInfo(server.id)))
      }

      return {
        servers: servers.slice(input.offset, input.offset + input.limit),
        total: servers.length,
      }
    } catch (err) {
      throw mapMcpError(err)
    }
  }

  getServerById(id: string): McpServerDto {
    try {
      const server = this.getServerUnscopedForDaemon(id)
      return toServerDto(server, this.connectionManager.getConnectionInfo(server.id))
    } catch (err) {
      throw mapMcpError(err)
    }
  }

  registerServer(rawInput: RegisterMcpServerIpcInput): McpServerDto {
    try {
      const input = RegisterMcpServerIpcInputSchema.parse(rawInput)
      if (input.scope.kind === 'bot') {
        this.assertBotExists(input.scope.botId)
      }
      const scope = toMcpScope(input.scope)
      const auth: McpAuthContext = {
        host: {
          userId: LOCAL_USER_ID,
          actorId: DAEMON_MCP_ACTOR_ID,
          allowUserWideRead: true,
          allowUserWideWrite: true,
          ...(scope.kind === 'bot' ? { botId: scope.botId } : {}),
          ...(scope.kind === 'workspace' ? { workspaceId: scope.workspaceId } : {}),
        },
        permissions: {
          canReadConfig: true,
          canManageConfig: true,
          canLaunch: true,
          canDiscover: true,
          allowedTools: [],
          allowedResources: [],
          allowedPrompts: [],
        },
      }
      const created = this.registry.register(auth, {
        ...(input.id ? { id: input.id } : {}),
        scope,
        displayName: input.displayName,
        description: input.description,
        transport: input.transport,
        ...(input.connectTimeoutMs !== undefined ? { connectTimeoutMs: input.connectTimeoutMs } : {}),
        ...(input.requestTimeoutMs !== undefined ? { requestTimeoutMs: input.requestTimeoutMs } : {}),
      })
      return toServerDto(created, this.connectionManager.getConnectionInfo(created.id))
    } catch (err) {
      throw mapMcpError(err)
    }
  }

  updateServer(rawInput: UpdateMcpServerIpcInput): McpServerDto {
    try {
      const input = UpdateMcpServerIpcInputSchema.parse(rawInput)
      const existing = this.getServerUnscopedForDaemon(input.id)
      const auth = this.buildAuthForServer(existing)
      const updated = this.registry.update(auth, input.id, {
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.transport !== undefined ? { transport: input.transport } : {}),
        ...(input.connectTimeoutMs !== undefined ? { connectTimeoutMs: input.connectTimeoutMs } : {}),
        ...(input.requestTimeoutMs !== undefined ? { requestTimeoutMs: input.requestTimeoutMs } : {}),
      })
      this.capabilitiesCache.delete(input.id)
      return toServerDto(updated, this.connectionManager.getConnectionInfo(updated.id))
    } catch (err) {
      throw mapMcpError(err)
    }
  }

  approveTrust(id: string): McpServerDto {
    try {
      const existing = this.getServerUnscopedForDaemon(id)
      const auth = this.buildAuthForServer(existing)
      const updated = this.registry.approveTrust(auth, existing.id)
      return toServerDto(updated, this.connectionManager.getConnectionInfo(updated.id))
    } catch (err) {
      throw mapMcpError(err)
    }
  }

  async revokeTrust(id: string): Promise<McpServerDto> {
    try {
      const existing = this.getServerUnscopedForDaemon(id)
      const auth = this.buildAuthForServer(existing)
      const updated = this.registry.revokeTrust(auth, existing.id)
      this.capabilitiesCache.delete(existing.id)
      await this.connectionManager.disconnect(existing.id)
      return toServerDto(updated, this.connectionManager.getConnectionInfo(updated.id))
    } catch (err) {
      throw mapMcpError(err)
    }
  }

  async setEnabled(rawInput: SetMcpServerEnabledInput): Promise<McpServerDto> {
    try {
      const input = SetMcpServerEnabledInputSchema.parse(rawInput)
      const existing = this.getServerUnscopedForDaemon(input.id)
      const auth = this.buildAuthForServer(existing)
      const updated = input.enabled
        ? this.registry.enable(auth, input.id)
        : this.registry.disable(auth, input.id)
      if (!input.enabled) {
        this.capabilitiesCache.delete(input.id)
        await this.connectionManager.disconnect(input.id)
      }
      return toServerDto(updated, this.connectionManager.getConnectionInfo(updated.id))
    } catch (err) {
      throw mapMcpError(err)
    }
  }

  async deleteServer(id: string): Promise<{ deletedId: string }> {
    try {
      const existing = this.getServerUnscopedForDaemon(id)
      const auth = this.buildAuthForServer(existing)
      this.capabilitiesCache.delete(existing.id)
      await this.connectionManager.disconnect(existing.id)
      const deleted = this.registry.delete(auth, existing.id)
      if (!deleted) {
        throw new DaemonError('MCP_NOT_FOUND', 'MCP server not found', { statusCode: 404 })
      }
      return { deletedId: existing.id }
    } catch (err) {
      throw mapMcpError(err)
    }
  }

  async connectServer(id: string, signal?: AbortSignal): Promise<McpConnectionStatusDto> {
    try {
      this.assertMcpEnabled()
      const existing = this.getServerUnscopedForDaemon(id)
      const auth = this.buildAuthForServer(existing)
      const info = await this.connectionManager.connect(auth, existing.id, signal)
      const snapshot = await this.connectionManager.discover(auth, existing.id, signal)
      this.capabilitiesCache.set(existing.id, snapshot)
      return toConnectionStatusDto(existing.id, this.connectionManager.getConnectionInfo(existing.id) ?? info, existing.configFingerprint)
    } catch (err) {
      throw mapMcpError(err)
    }
  }

  async disconnectServer(id: string): Promise<McpConnectionStatusDto> {
    try {
      const existing = this.getServerUnscopedForDaemon(id)
      this.capabilitiesCache.delete(existing.id)
      await this.connectionManager.disconnect(existing.id)
      return toConnectionStatusDto(existing.id, this.connectionManager.getConnectionInfo(existing.id), existing.configFingerprint)
    } catch (err) {
      throw mapMcpError(err)
    }
  }

  getCapabilities(id: string): McpCapabilitySnapshotDto | null {
    try {
      const existing = this.getServerUnscopedForDaemon(id)
      const info = this.connectionManager.getConnectionInfo(existing.id)
      if (!info || info.state !== 'ready' || info.configFingerprint !== existing.configFingerprint) {
        return null
      }
      const cached = this.capabilitiesCache.get(existing.id)
      if (!cached || cached.configFingerprint !== existing.configFingerprint || cached.connectionGeneration !== info.generation) {
        return null
      }
      return toCapabilityDto(cached)
    } catch (err) {
      throw mapMcpError(err)
    }
  }

  async readResource(rawInput: ReadMcpResourceInput, signal?: AbortSignal): Promise<ReadMcpResourceResponse> {
    try {
      this.assertMcpEnabled()
      const input = ReadMcpResourceInputSchema.parse(rawInput)
      const existing = this.getServerUnscopedForDaemon(input.serverId)
      const auth = this.buildAuthForServer(existing, { allowedResources: [input.uri] })
      const info = this.connectionManager.getConnectionInfo(existing.id)
      if (!info || info.state !== 'ready') {
        await this.connectServer(existing.id, signal)
      }
      const result = await this.connectionManager.readResource(auth, existing.id, {
        uri: input.uri,
        signal,
      })
      return {
        serverId: existing.id,
        uri: input.uri,
        contents: [...result.contents],
      }
    } catch (err) {
      throw mapMcpError(err)
    }
  }

  async getPrompt(rawInput: GetMcpPromptInput, signal?: AbortSignal): Promise<GetMcpPromptResponse> {
    try {
      this.assertMcpEnabled()
      const input = GetMcpPromptInputSchema.parse(rawInput)
      const existing = this.getServerUnscopedForDaemon(input.serverId)
      const capKey = buildCapabilityKey(existing.id, input.name)
      const auth = this.buildAuthForServer(existing, { allowedPrompts: [capKey] })
      const info = this.connectionManager.getConnectionInfo(existing.id)
      if (!info || info.state !== 'ready') {
        await this.connectServer(existing.id, signal)
      }
      const result = await this.connectionManager.getPrompt(auth, existing.id, {
        name: input.name,
        arguments: input.args,
        signal,
      })
      return {
        serverId: existing.id,
        name: input.name,
        ...(result.description ? { description: result.description } : {}),
        messages: result.messages.map((msg) => ({
          role: msg.reportedRole,
          content: {
            type: 'text',
            text: msg.text,
          },
        })),
      }
    } catch (err) {
      throw mapMcpError(err)
    }
  }

  /**
   * Lists enabled + trusted MCP servers and their discovered tools that belong to a run's scope.
   */
  listAuthorizedToolsForRun(params: {
    botId: string
    workspacePath?: string | null
  }): Array<{ server: McpServerConfig; connection: McpConnectionInfo | null; capabilities: McpCapabilitySnapshot | null }> {
    if (!this.settingsRepo.getSettings().mcp.enabled) return []
    const workspaceId = params.workspacePath ? deriveWorkspaceId(params.workspacePath) : null
    const rows = this.db.sqlite
      .prepare('SELECT id, scope_kind, bot_id, workspace_id FROM mcp_servers WHERE user_id = ? AND enabled = 1 AND trust_state = ?')
      .all(LOCAL_USER_ID, 'trusted') as Array<{
      id: string
      scope_kind: string
      bot_id: string | null
      workspace_id: string | null
    }>

    const results: Array<{
      server: McpServerConfig
      connection: McpConnectionInfo | null
      capabilities: McpCapabilitySnapshot | null
    }> = []

    for (const row of rows) {
      const inScope =
        row.scope_kind === 'user' ||
        (row.scope_kind === 'bot' && row.bot_id === params.botId) ||
        (row.scope_kind === 'workspace' && workspaceId !== null && row.workspace_id === workspaceId)
      if (!inScope) continue
      const server = this.getServerUnscopedForDaemon(row.id)
      const connection = this.connectionManager.getConnectionInfo(server.id)
      const capabilities = this.capabilitiesCache.get(server.id) ?? null
      results.push({ server, connection, capabilities })
    }

    return results
  }

  /**
   * Prepares an approved MCP tool call by ensuring the server is connected, discovered,
   * policy-allowed, and returns exact binding metadata for durable approval.
   */
  async prepareToolCallForRun(params: {
    serverId: string
    toolName: string
    botId: string
    workspacePath?: string | null
    permissionMode: PermissionMode
    signal?: AbortSignal
  }): Promise<{
    server: McpServerConfig
    definitionHash: string
    connectionGeneration: number
    configFingerprint: string
  }> {
    try {
      this.assertMcpEnabled()
      const server = this.getServerUnscopedForDaemon(params.serverId)
      const parsedAuth: ParsedMcpAuthContext = validateMcpAuthContext(
        this.buildManagementAuth({ botId: params.botId, workspacePath: params.workspacePath ?? undefined }),
      )
      const policyDecision = this.policyBroker
        .createMcpPolicyAdapter(params.permissionMode)
        .evaluateToolInvocation(parsedAuth, server, params.toolName)
      if (!policyDecision.allowed) {
        throw new DaemonError('MCP_FORBIDDEN', policyDecision.reason ?? 'Host policy denied MCP tool invocation', {
          statusCode: 403,
        })
      }

      this.assertServerInRunScope(server, params.botId, params.workspacePath ?? null)
      if (!server.enabled || server.trustState !== 'trusted') {
        throw new DaemonError('MCP_UNTRUSTED', 'MCP server must be enabled and trusted before execution', {
          statusCode: 403,
        })
      }

      this.activeRunPermissionByServer.set(server.id, params.permissionMode)
      try {
        let info = this.connectionManager.getConnectionInfo(server.id)
        let snapshot = this.capabilitiesCache.get(server.id)
        if (!info || info.state !== 'ready' || info.configFingerprint !== server.configFingerprint || !snapshot || snapshot.connectionGeneration !== info.generation) {
          const auth = this.buildAuthForServer(server)
          info = await this.connectionManager.connect(auth, server.id, params.signal)
          snapshot = await this.connectionManager.discover(auth, server.id, params.signal)
          this.capabilitiesCache.set(server.id, snapshot)
        }
        const tool = snapshot.tools.find((t) => t.name === params.toolName)
        if (!tool) {
          throw new DaemonError('MCP_NOT_FOUND', `MCP tool "${params.toolName}" not found on server "${server.id}"`, {
            statusCode: 404,
          })
        }
        return {
          server,
          definitionHash: tool.definitionHash,
          connectionGeneration: info.generation,
          configFingerprint: server.configFingerprint,
        }
      } finally {
        this.activeRunPermissionByServer.delete(server.id)
      }
    } catch (err) {
      throw mapMcpError(err)
    }
  }

  /**
   * Executes a previously approved MCP tool call, enforcing config fingerprint,
   * capability definition hash, connection generation, and host policy.
   */
  async invokeApprovedTool(params: {
    serverId: string
    toolName: string
    args: Record<string, unknown>
    botId: string
    workspacePath?: string | null
    permissionMode: PermissionMode
    expectedConfigFingerprint: string
    expectedDefinitionHash: string
    expectedConnectionGeneration: number
    signal?: AbortSignal
  }): Promise<McpToolInvocationResult> {
    try {
      this.assertMcpEnabled()
      const server = this.getServerUnscopedForDaemon(params.serverId)
      this.assertServerInRunScope(server, params.botId, params.workspacePath ?? null)

      if (!server.enabled || server.trustState !== 'trusted') {
        throw new DaemonError('MCP_UNTRUSTED', 'MCP server is no longer enabled and trusted', { statusCode: 403 })
      }
      if (server.configFingerprint !== params.expectedConfigFingerprint) {
        throw new DaemonError('MCP_STALE_APPROVAL', 'MCP server configuration changed since approval', {
          statusCode: 409,
        })
      }

      const parsedAuth: ParsedMcpAuthContext = validateMcpAuthContext(
        this.buildManagementAuth({ botId: params.botId, workspacePath: params.workspacePath ?? undefined }),
      )
      const policyDecision = this.policyBroker
        .createMcpPolicyAdapter(params.permissionMode)
        .evaluateToolInvocation(parsedAuth, server, params.toolName)
      if (!policyDecision.allowed) {
        throw new DaemonError('MCP_FORBIDDEN', policyDecision.reason ?? 'Host policy denied MCP tool invocation', {
          statusCode: 403,
        })
      }

      const info = this.connectionManager.getConnectionInfo(server.id)
      const snapshot = this.capabilitiesCache.get(server.id)
      if (!info || info.state !== 'ready' || info.generation !== params.expectedConnectionGeneration || !snapshot) {
        throw new DaemonError(
          'MCP_STALE_APPROVAL',
          'MCP server connection generation changed or disconnected since approval',
          { statusCode: 409 },
        )
      }

      const tool = snapshot.tools.find((t) => t.name === params.toolName)
      if (!tool || tool.definitionHash !== params.expectedDefinitionHash) {
        throw new DaemonError('MCP_STALE_APPROVAL', 'MCP tool definition changed since approval', {
          statusCode: 409,
        })
      }

      const capKey = buildCapabilityKey(server.id, params.toolName)
      const auth = this.buildAuthForServer(server, {
        allowedTools: [capKey],
        allowedToolHashes: { [capKey]: params.expectedDefinitionHash },
      })

      this.activeRunPermissionByServer.set(server.id, params.permissionMode)
      try {
        return await this.connectionManager.invokeTool(auth, server.id, {
          toolName: params.toolName,
          args: params.args,
          signal: params.signal,
        })
      } finally {
        this.activeRunPermissionByServer.delete(server.id)
      }
    } catch (err) {
      throw mapMcpError(err)
    }
  }

  private assertServerInRunScope(server: McpServerConfig, botId: string, workspacePath: string | null): void {
    if (server.scope.kind === 'user') return
    if (server.scope.kind === 'bot' && server.scope.botId === botId) return
    if (server.scope.kind === 'workspace' && workspacePath && server.scope.workspaceId === deriveWorkspaceId(workspacePath)) {
      return
    }
    throw new DaemonError('MCP_FORBIDDEN', 'MCP server is outside the current bot/workspace scope', {
      statusCode: 403,
    })
  }

  /**
   * Runs inside the DELETE /bots/:id SQLite transaction to remove bot-scoped MCP servers.
   * Returns affected server IDs so connections can be torn down after commit.
   */
  archiveMcpForBotInTx(botId: string): string[] {
    const rows = this.db.sqlite
      .prepare("SELECT id FROM mcp_servers WHERE scope_kind = 'bot' AND bot_id = ?")
      .all(botId) as Array<{ id: string }>
    if (rows.length === 0) return []
    this.db.sqlite
      .prepare("DELETE FROM mcp_servers WHERE scope_kind = 'bot' AND bot_id = ?")
      .run(botId)
    return rows.map((r) => r.id)
  }

  async invalidateBotConnections(serverIds: string[]): Promise<void> {
    for (const id of serverIds) {
      this.capabilitiesCache.delete(id)
      await this.connectionManager.disconnect(id)
    }
  }

  async close(): Promise<void> {
    this.capabilitiesCache.clear()
    await this.connectionManager.close()
    this.mcpHandle.close()
  }
}
