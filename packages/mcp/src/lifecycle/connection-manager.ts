import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker-provider.js'
import { sanitizeErrorMessage } from '@ghost-bot/memory'
import {
  McpAuthorizationError,
  McpNotFoundError,
  McpTransportError,
  McpTrustError,
  McpValidationError,
} from '../contracts/errors.ts'
import { MCP_LIMITS } from '../contracts/limits.ts'
import type {
  Clock,
  McpAuthContext,
  McpCapabilitySnapshot,
  McpConnectionState,
  McpServerConfig,
} from '../contracts/types.ts'
import { buildCapabilityKey, discoverServerCapabilities } from '../discovery/discoverer.ts'
import { invokeMcpTool, type McpToolInvocationResult } from '../invocation/invoker.ts'
import {
  getMcpPrompt,
  readMcpResource,
  type McpPromptGetResult,
  type McpResourceReadResult,
} from '../invocation/resources.ts'
import { DEFAULT_PERMISSIVE_HOST_POLICY, type HostMcpPolicyAdapter } from '../policy/host-policy.ts'
import type { McpRegistryRepository } from '../registry/interface.ts'
import {
  authorizeMcpDiscovery,
  authorizeMcpLaunch,
  authorizeMcpPromptGet,
  authorizeMcpResourceRead,
  authorizeMcpToolInvocation,
  validateMcpAuthContext,
} from '../security/authorization.ts'
import { computeLaunchBinaryDigestSync, validateStdioLaunchPaths } from '../security/path-guard.ts'
import { buildMinimalChildEnv } from '../security/redaction.ts'
import { assertServerTrustedForLaunch } from '../security/trust.ts'
import { BoundedStdioClientTransport } from '../transport/bounded-stdio.ts'

export interface McpConnectionManagerOptions {
  readonly registry: McpRegistryRepository
  readonly hostPolicy?: HostMcpPolicyAdapter
  readonly hostEnv?: Readonly<Record<string, string | undefined>>
  readonly resolveSecrets?: (server: McpServerConfig) => Record<string, string>
  readonly clock?: Clock
  readonly maxMessageBytes?: number
  readonly maxStderrBytes?: number
  readonly gracefulShutdownMs?: number
}

export interface McpConnectionInfo {
  readonly serverId: string
  readonly state: McpConnectionState
  readonly generation: number
  readonly configFingerprint: string
  readonly pid: number | null
  readonly lastError: string | null
  readonly hasCapabilities: boolean
}

interface ManagedConnection {
  readonly serverId: string
  readonly generation: number
  readonly configFingerprint: string
  state: McpConnectionState
  client: Client | null
  transport: BoundedStdioClientTransport | null
  capabilityRevision: number
  capabilities: McpCapabilitySnapshot | null
  lastError: string | null
}

export class McpConnectionManager {
  private readonly registry: McpRegistryRepository
  private readonly hostPolicy: HostMcpPolicyAdapter
  private readonly hostEnv: Readonly<Record<string, string | undefined>>
  private readonly resolveSecrets?: (server: McpServerConfig) => Record<string, string>
  private readonly clock: Clock
  private readonly maxMessageBytes?: number
  private readonly maxStderrBytes?: number
  private readonly gracefulShutdownMs?: number

  private readonly connections = new Map<string, ManagedConnection>()
  private generationCounter = 0
  private closed = false

  constructor(options: McpConnectionManagerOptions) {
    this.registry = options.registry
    this.hostPolicy = options.hostPolicy ?? DEFAULT_PERMISSIVE_HOST_POLICY
    this.hostEnv = options.hostEnv ?? {}
    this.resolveSecrets = options.resolveSecrets
    this.clock = options.clock ?? (() => new Date())
    this.maxMessageBytes = options.maxMessageBytes
    this.maxStderrBytes = options.maxStderrBytes
    this.gracefulShutdownMs = options.gracefulShutdownMs
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new McpTransportError('McpConnectionManager is closed')
    }
  }

  private nowIso(): string {
    const d = this.clock()
    if (!(d instanceof Date) || !Number.isFinite(d.getTime())) {
      throw new McpValidationError('Connection manager clock returned an invalid Date')
    }
    return d.toISOString()
  }

  getConnectionInfo(serverId: string): McpConnectionInfo | null {
    const entry = this.connections.get(serverId)
    if (!entry) return null
    return {
      serverId: entry.serverId,
      state: entry.state,
      generation: entry.generation,
      configFingerprint: entry.configFingerprint,
      pid: entry.transport?.pid ?? null,
      lastError: entry.lastError,
      hasCapabilities: entry.capabilities !== null,
    }
  }

  async connect(rawAuth: McpAuthContext, serverId: string, signal?: AbortSignal): Promise<McpConnectionInfo> {
    this.assertOpen()
    const auth = validateMcpAuthContext(rawAuth)
    const server = this.registry.getById(auth, serverId, { includeUserWide: true })
    if (!server) {
      throw new McpNotFoundError()
    }
    authorizeMcpLaunch(auth, server.scope)
    assertServerTrustedForLaunch(server)

    const policyDecision = this.hostPolicy.evaluateLaunch(auth, server)
    if (!policyDecision.allowed) {
      throw new McpAuthorizationError(policyDecision.reason ?? 'Host policy denied MCP server launch')
    }

    const existing = this.connections.get(serverId)
    if (existing) {
      if (existing.state === 'connecting' || existing.state === 'disconnecting') {
        throw new McpTransportError(`MCP server "${serverId}" transition already in progress (${existing.state})`)
      }
      if (existing.state === 'ready' && existing.configFingerprint === server.configFingerprint) {
        return this.getConnectionInfo(serverId)!
      }
      await this.disconnect(serverId)
    }

    const { executablePath, cwd } = await validateStdioLaunchPaths(
      server.transport.executablePath,
      server.transport.cwd,
    )
    const assertCurrentLaunch = () => {
      this.assertOpen()
      if (signal?.aborted) throw new McpTransportError('MCP connection was cancelled')
      const current = this.registry.getById(auth, serverId, { includeUserWide: true })
      if (!current) throw new McpNotFoundError()
      authorizeMcpLaunch(auth, current.scope)
      assertServerTrustedForLaunch(current)
      if (current.configFingerprint !== server.configFingerprint) {
        throw new McpTrustError('MCP configuration changed during connection')
      }
      if (current.trustedBinaryDigest !== null) {
        const actualDigest = computeLaunchBinaryDigestSync(executablePath, current.transport.args)
        if (!actualDigest || actualDigest !== current.trustedBinaryDigest) {
          throw new McpTrustError(
            'Trusted MCP executable or script content changed since approval; reauthorization required',
          )
        }
      }
      const decision = this.hostPolicy.evaluateLaunch(auth, current)
      if (!decision.allowed) {
        throw new McpAuthorizationError(decision.reason ?? 'Host policy denied MCP server launch')
      }
    }
    assertCurrentLaunch()
    if (this.connections.has(serverId)) {
      throw new McpTransportError('MCP server connection was started concurrently')
    }
    const activeCount = [...this.connections.values()].filter(
      (c) => c.state === 'ready' || c.state === 'connecting' || c.state === 'disconnecting',
    ).length
    if (activeCount >= MCP_LIMITS.maxConcurrentConnections) {
      throw new McpTransportError(
        `Maximum concurrent MCP connections reached (${MCP_LIMITS.maxConcurrentConnections})`,
      )
    }
    const candidateSecrets = this.resolveSecrets?.(server) ?? {}
    const declaredKeys = new Set(server.transport.secretRefs.map((ref) => ref.envVar))
    const resolvedSecrets = Object.fromEntries(
      Object.entries(candidateSecrets).filter(([key]) => declaredKeys.has(key)),
    )
    const env = buildMinimalChildEnv(server.transport.envAllowlist, this.hostEnv, resolvedSecrets)

    const generation = ++this.generationCounter
    const transport = new BoundedStdioClientTransport({
      executablePath,
      args: server.transport.args,
      cwd,
      env,
      maxMessageBytes: this.maxMessageBytes,
      maxStderrBytes: this.maxStderrBytes,
      gracefulShutdownMs: this.gracefulShutdownMs,
    })

    const entry: ManagedConnection = {
      serverId,
      generation,
      configFingerprint: server.configFingerprint,
      state: 'connecting',
      client: null,
      transport,
      capabilityRevision: 0,
      capabilities: null,
      lastError: null,
    }
    this.connections.set(serverId, entry)

    const client = new Client(
      { name: 'ghost-bot-mcp', version: '0.1.0' },
      {
        capabilities: {},
        jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
        listChanged: {
          tools: {
            onChanged: () => {
              if (this.connections.get(serverId)?.generation === generation) {
                entry.capabilityRevision++
                entry.capabilities = null
              }
            },
          },
          resources: {
            onChanged: () => {
              if (this.connections.get(serverId)?.generation === generation) {
                entry.capabilityRevision++
                entry.capabilities = null
              }
            },
          },
          prompts: {
            onChanged: () => {
              if (this.connections.get(serverId)?.generation === generation) {
                entry.capabilityRevision++
                entry.capabilities = null
              }
            },
          },
        },
      },
    )
    entry.client = client

    client.onclose = () => {
      const current = this.connections.get(serverId)
      if (!current || current.generation !== generation) return
      if (current.state !== 'disconnecting' && current.state !== 'disconnected') {
        current.state = current.lastError ? 'failed' : 'disconnected'
        current.capabilities = null
      }
    }

    client.onerror = (err) => {
      const current = this.connections.get(serverId)
      if (!current || current.generation !== generation) return
      current.lastError = sanitizeErrorMessage(err)
      if (current.state === 'connecting') {
        current.state = 'failed'
      }
    }

    try {
      await client.connect(transport, { timeout: server.connectTimeoutMs, signal })
      if (this.connections.get(serverId) !== entry || entry.state !== 'connecting' || this.closed) {
        await transport.close()
        throw new McpTransportError('MCP connection superseded or manager closed during connect')
      }
      assertCurrentLaunch()
      entry.state = 'ready'
      return this.getConnectionInfo(serverId)!
    } catch (err) {
      entry.state = 'failed'
      entry.lastError = sanitizeErrorMessage(err)
      try {
        await transport.close()
      } catch {
        // Ignore cleanup error.
      }
      throw err instanceof McpTransportError
        ? err
        : new McpTransportError(`MCP initialization failed: ${sanitizeErrorMessage(err)}`)
    }
  }

  private requireReadyAuthorizedServer(
    rawAuth: McpAuthContext,
    serverId: string,
  ): { auth: ReturnType<typeof validateMcpAuthContext>; server: McpServerConfig; entry: ManagedConnection; client: Client } {
    this.assertOpen()
    const auth = validateMcpAuthContext(rawAuth)
    const server = this.registry.getById(auth, serverId, { includeUserWide: true })
    if (!server) {
      throw new McpNotFoundError()
    }
    assertServerTrustedForLaunch(server)

    const entry = this.connections.get(serverId)
    if (!entry || entry.state !== 'ready' || !entry.client) {
      throw new McpTransportError(`MCP server "${serverId}" is not connected/ready`)
    }
    if (entry.configFingerprint !== server.configFingerprint) {
      throw new McpTrustError('Active MCP connection does not match current server configuration revision')
    }
    return { auth, server, entry, client: entry.client }
  }

  async ping(rawAuth: McpAuthContext, serverId: string, signal?: AbortSignal): Promise<void> {
    const { server, client } = this.requireReadyAuthorizedServer(rawAuth, serverId)
    authorizeMcpDiscovery(validateMcpAuthContext(rawAuth), server.scope)
    await client.ping({ timeout: server.requestTimeoutMs, signal })
  }

  async discover(rawAuth: McpAuthContext, serverId: string, signal?: AbortSignal): Promise<McpCapabilitySnapshot> {
    const { auth, server, entry, client } = this.requireReadyAuthorizedServer(rawAuth, serverId)
    authorizeMcpDiscovery(auth, server.scope)

    const revision = ++entry.capabilityRevision
    const snapshot = await discoverServerCapabilities(client, {
      serverId: server.id,
      configFingerprint: server.configFingerprint,
      connectionGeneration: entry.generation,
      discoveredAt: this.nowIso(),
      timeoutMs: server.requestTimeoutMs,
      signal,
    })

    if (this.connections.get(serverId)?.generation !== entry.generation) {
      throw new McpTransportError('MCP connection generation changed during discovery')
    }
    this.requireReadyAuthorizedServer(rawAuth, serverId)
    if (entry.capabilityRevision !== revision) {
      throw new McpTrustError('MCP discovery was invalidated before completion')
    }
    entry.capabilities = snapshot
    return structuredClone(snapshot)
  }

  async invokeTool(
    rawAuth: McpAuthContext,
    serverId: string,
    params: { toolName: string; args: Record<string, unknown>; signal?: AbortSignal },
  ): Promise<McpToolInvocationResult> {
    const { auth, server, entry, client } = this.requireReadyAuthorizedServer(rawAuth, serverId)
    const capabilityKey = buildCapabilityKey(server.id, params.toolName)
    const definitionHash = entry.capabilities?.tools.find((tool) => tool.name === params.toolName)?.definitionHash
    authorizeMcpToolInvocation(auth, server.scope, capabilityKey, params.toolName, definitionHash)

    const policyDecision = this.hostPolicy.evaluateToolInvocation(auth, server, params.toolName)
    if (!policyDecision.allowed) {
      throw new McpAuthorizationError(policyDecision.reason ?? 'Host policy denied MCP tool invocation')
    }

    if (!entry.capabilities || entry.capabilities.connectionGeneration !== entry.generation) {
      throw new McpTrustError('MCP capabilities have not been discovered for the active connection generation')
    }

    return invokeMcpTool(client, entry.capabilities, {
      toolName: params.toolName,
      args: params.args,
      timeoutMs: server.requestTimeoutMs,
      signal: params.signal,
    })
  }

  async readResource(
    rawAuth: McpAuthContext,
    serverId: string,
    params: { uri: string; signal?: AbortSignal },
  ): Promise<McpResourceReadResult> {
    const { auth, server, entry, client } = this.requireReadyAuthorizedServer(rawAuth, serverId)
    authorizeMcpResourceRead(auth, server.scope, params.uri)

    if (!entry.capabilities || entry.capabilities.connectionGeneration !== entry.generation) {
      throw new McpTrustError('MCP capabilities have not been discovered for the active connection generation')
    }

    return readMcpResource(client, entry.capabilities, {
      uri: params.uri,
      timeoutMs: server.requestTimeoutMs,
      signal: params.signal,
    })
  }

  async getPrompt(
    rawAuth: McpAuthContext,
    serverId: string,
    params: { name: string; arguments?: Record<string, string>; signal?: AbortSignal },
  ): Promise<McpPromptGetResult> {
    const { auth, server, entry, client } = this.requireReadyAuthorizedServer(rawAuth, serverId)
    const capabilityKey = buildCapabilityKey(server.id, params.name)
    authorizeMcpPromptGet(auth, server.scope, capabilityKey, params.name)

    if (!entry.capabilities || entry.capabilities.connectionGeneration !== entry.generation) {
      throw new McpTrustError('MCP capabilities have not been discovered for the active connection generation')
    }

    return getMcpPrompt(client, entry.capabilities, {
      name: params.name,
      arguments: params.arguments,
      timeoutMs: server.requestTimeoutMs,
      signal: params.signal,
    })
  }

  async disconnect(serverId: string): Promise<void> {
    const entry = this.connections.get(serverId)
    if (!entry) return
    if (entry.state === 'disconnected') {
      this.connections.delete(serverId)
      return
    }
    entry.state = 'disconnecting'
    entry.capabilities = null
    try {
      await entry.transport?.close()
    } finally {
      entry.state = 'disconnected'
      if (this.connections.get(serverId) === entry) this.connections.delete(serverId)
    }
  }

  async disconnectAll(): Promise<void> {
    const ids = [...this.connections.keys()]
    await Promise.all(ids.map((id) => this.disconnect(id)))
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.disconnectAll()
  }
}
