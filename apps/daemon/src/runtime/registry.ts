import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  ANTHROPIC_API_VERSION,
  APPROVED_ANTHROPIC_ORIGIN,
  AnthropicClaudeApiAdapter,
} from '@ghost-bot/runtime-adapters/claude'
import { CodexAppServerAdapter } from '@ghost-bot/runtime-adapters/codex'
import type { CodexAccountSummary } from '@ghost-bot/runtime-adapters/codex'
import {
  APPROVED_GEMINI_ORIGIN,
  GEMINI_API_VERSION,
  GoogleGeminiApiAdapter,
} from '@ghost-bot/runtime-adapters/gemini'
import { KimiAcpAdapter } from '@ghost-bot/runtime-adapters/kimi'
import { DEFAULT_LLAMACPP_BASE_URL, LlamaCppLocalAdapter } from '@ghost-bot/runtime-adapters/llamacpp'
import { DEFAULT_LMSTUDIO_BASE_URL, LmStudioLocalAdapter } from '@ghost-bot/runtime-adapters/lmstudio'
import {
  APPROVED_OPENROUTER_BASE_URL,
  OpenRouterApiAdapter,
} from '@ghost-bot/runtime-adapters/openrouter'
import { MockRuntimeAdapter } from '@ghost-bot/runtime-adapters/mock'
import { OllamaLocalAdapter } from '@ghost-bot/runtime-adapters/ollama'
import { OpenClawGatewayAdapter } from '@ghost-bot/runtime-adapters/openclaw'
import { RuntimePolicyBroker } from './policy-broker.ts'
import type {
  ProviderSummary,
  RuntimeLifecycleState,
  RuntimeSnapshot,
} from '@ghost-bot/shared-types/ipc'
import type {
  AgentEvent,
  AgentRequest,
  AgentRuntime,
  ApprovalDecision,
  ModelInfo,
  Session,
  SessionConfig,
  UsageSnapshot,
} from '@ghost-bot/shared-types/runtime'
import { DaemonError, redactSecrets } from '../errors.ts'
import { resolveCodexVerifiedEvidence } from './policy-broker.ts'

const execFileAsync = promisify(execFile)
const DEFAULT_CACHE_TTL_MS = 30_000
const REFRESH_COOLDOWN_MS = 2_000

export interface CodexMetadataClient {
  getAccountSummary(refreshToken?: boolean): Promise<CodexAccountSummary>
  listModels(): Promise<ModelInfo[]>
  getUsage(): Promise<UsageSnapshot | null>
  close(): Promise<void>
  createSession?(config: SessionConfig): Promise<Session>
  resumeSession?(threadId: string, config: SessionConfig): Promise<Session>
  run?(request: AgentRequest): AsyncIterable<AgentEvent>
  cancel?(runId: string): Promise<void>
  resolveApproval?(decision: ApprovalDecision): Promise<void>
}

export interface CodexExecutionClient extends CodexMetadataClient {
  createSession(config: SessionConfig): Promise<Session>
  resumeSession(threadId: string, config: SessionConfig): Promise<Session>
  readThread?(threadId: string): Promise<{ accessible: boolean; reason?: string }>
  run(request: AgentRequest): AsyncIterable<AgentEvent>
  cancel(runId: string): Promise<void>
}

export interface RuntimeRegistryOptions {
  runtimeMode: 'codex' | 'mock'
  codexCommand?: string
  codexVersionOverride?: string | null
  codexClientFactory?: (version: string | null) => CodexMetadataClient
  openclawAdapter?: OpenClawGatewayAdapter
  ollamaAdapter?: OllamaLocalAdapter
  claudeAdapter?: AnthropicClaudeApiAdapter
  geminiAdapter?: GoogleGeminiApiAdapter
  kimiAdapter?: KimiAcpAdapter
  lmstudioAdapter?: LmStudioLocalAdapter
  llamacppAdapter?: LlamaCppLocalAdapter
  openrouterAdapter?: OpenRouterApiAdapter
  cacheTtlMs?: number
}

export async function detectCodexVersion(command = 'codex'): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, ['--version'], {
      timeout: 3000,
      env: { PATH: process.env.PATH },
    })
    const match = /(\d+\.\d+\.\d+)/.exec(stdout)
    return match ? match[1] : stdout.trim() || null
  } catch {
    return null
  }
}

/**
 * Daemon-owned runtime registry.
 * Manages runtime discovery, metadata caching, request deduplication,
 * and lifecycle shutdown without initiating model inference.
 */
export class RuntimeRegistry {
  private readonly options: RuntimeRegistryOptions
  private readonly mock = new MockRuntimeAdapter()
  private codexClient: CodexMetadataClient | null = null
  private codexVersion: string | null | undefined = undefined
  private generation = 0
  private lastAccountKey: string | null = null
  private cachedSnapshot: RuntimeSnapshot | null = null
  private cachedAtMs = 0
  private lastRefreshRequestMs = 0
  private inFlight: Promise<RuntimeSnapshot> | null = null
  private reconnectInFlight: Promise<RuntimeSnapshot> | null = null
  private lifecycleState: RuntimeLifecycleState = 'disconnected'
  private stopped = false
  private readonly persistentAdapters = new Map<string, AgentRuntime>()

  constructor(options: RuntimeRegistryOptions) {
    this.options = options
  }

  getRuntimeMode(): 'codex' | 'mock' {
    return this.options.runtimeMode
  }

  getGeneration(): number {
    return this.generation
  }

  getLifecycleState(): RuntimeLifecycleState {
    return this.lifecycleState
  }

  /**
   * Explicitly closes the owned Codex client, increments runtime generation,
   * and invalidates cached metadata so any quarantined execution context can
   * be safely reconciled without leaving orphan provider processes.
   */
  async closeOwnedClient(): Promise<number> {
    this.generation += 1
    this.cachedSnapshot = null
    this.cachedAtMs = 0
    this.lastAccountKey = null
    if (this.codexClient) {
      const client = this.codexClient
      try {
        await client.close()
        this.codexClient = null
      } catch (err) {
        this.lifecycleState = 'failed'
        throw new DaemonError(
          'RUNTIME_TERMINATION_FAILED',
          err instanceof Error
            ? `Failed to terminate owned runtime process: ${err.message}`
            : 'Failed to terminate owned runtime process',
          { statusCode: 503, retryable: true },
        )
      }
    }
    this.lifecycleState = 'disconnected'
    return this.generation
  }

  async reconnect(): Promise<RuntimeSnapshot> {
    if (this.stopped) {
      throw new DaemonError('RUNTIME_STOPPED', 'RuntimeRegistry is stopped', { statusCode: 503 })
    }
    if (this.reconnectInFlight) {
      return this.reconnectInFlight
    }

    this.reconnectInFlight = (async () => {
      this.lifecycleState = 'reconnecting'
      await this.closeOwnedClient()
      this.lifecycleState = 'connecting'
      const snap = await this.fetchSnapshot(true)
      return snap
    })().finally(() => {
      this.reconnectInFlight = null
    })

    return this.reconnectInFlight
  }

  async getExecutionAdapter(): Promise<{
    adapter: CodexExecutionClient
    generation: number
    codexVersion: string | null
    snapshot: RuntimeSnapshot
  }> {
    if (this.stopped) {
      throw new DaemonError('RUNTIME_STOPPED', 'RuntimeRegistry is stopped', { statusCode: 503 })
    }
    if (this.options.runtimeMode !== 'codex') {
      throw new DaemonError(
        'LIVE_INFERENCE_DISABLED',
        'Live Codex execution is unavailable when daemon is running in mock mode.',
        { statusCode: 501 },
      )
    }

    const snapshot = await this.getSnapshot(false)
    if (snapshot.status !== 'available' || snapshot.authStatus !== 'connected') {
      throw new DaemonError('RUNTIME_UNAVAILABLE', snapshot.detail, { statusCode: 503 })
    }

    const client = this.codexClient
    if (
      !client ||
      typeof client.createSession !== 'function' ||
      typeof client.resumeSession !== 'function' ||
      typeof client.run !== 'function' ||
      typeof client.cancel !== 'function'
    ) {
      throw new DaemonError(
        'RUNTIME_ADAPTER_UNAVAILABLE',
        'Codex execution adapter is not initialized',
        { statusCode: 503 },
      )
    }

    // Execution-time live account verification: never rely solely on 30s cached snapshot metadata.
    const liveAccount = await client.getAccountSummary(false)
    if (!liveAccount.accountPresent || liveAccount.accountType !== 'chatgpt') {
      throw new DaemonError(
        'AUTH_REQUIRED',
        liveAccount.accountType === 'apiKey'
          ? 'API-key accounts are blocked; ChatGPT subscription authentication is required.'
          : 'ChatGPT subscription authentication is required before live execution.',
        { statusCode: 401 },
      )
    }

    return {
      adapter: client as CodexExecutionClient,
      generation: this.generation,
      codexVersion: this.codexVersion ?? null,
      snapshot,
    }
  }

  registerPersistentAdapter(runtimeId: string, adapter: AgentRuntime): void {
    this.persistentAdapters.set(runtimeId, adapter)
  }

  getPersistentAdapter<T extends AgentRuntime = AgentRuntime>(runtimeId: string): T | null {
    return (this.persistentAdapters.get(runtimeId) as T | undefined) ?? null
  }

  async getUnifiedExecutionAdapter(runtimeId: string): Promise<{
    adapter: AgentRuntime
    generation: number
  }> {
    if (this.stopped) {
      throw new DaemonError('RUNTIME_STOPPED', 'RuntimeRegistry is stopped', { statusCode: 503 })
    }
    const existing = this.persistentAdapters.get(runtimeId)
    if (existing) {
      return { adapter: existing, generation: this.generation }
    }
    if (runtimeId === 'openclaw') {
      const adapter = this.options.openclawAdapter ?? new OpenClawGatewayAdapter({ timeoutMs: 2000 })
      this.persistentAdapters.set(runtimeId, adapter)
      return { adapter, generation: this.generation }
    }
    if (runtimeId === 'ollama') {
      const adapter = this.options.ollamaAdapter ?? new OllamaLocalAdapter({ timeoutMs: 2000 })
      this.persistentAdapters.set(runtimeId, adapter)
      return { adapter, generation: this.generation }
    }
    if (runtimeId === 'claude-api') {
      const adapter = this.options.claudeAdapter ?? new AnthropicClaudeApiAdapter()
      this.persistentAdapters.set(runtimeId, adapter)
      return { adapter, generation: this.generation }
    }
    if (runtimeId === 'gemini-api') {
      const adapter = this.options.geminiAdapter ?? new GoogleGeminiApiAdapter()
      this.persistentAdapters.set(runtimeId, adapter)
      return { adapter, generation: this.generation }
    }
    if (runtimeId === 'kimi-acp') {
      const adapter = this.options.kimiAdapter ?? new KimiAcpAdapter()
      this.persistentAdapters.set(runtimeId, adapter)
      return { adapter, generation: this.generation }
    }
    if (runtimeId === 'lmstudio') {
      const adapter = this.options.lmstudioAdapter ?? new LmStudioLocalAdapter()
      this.persistentAdapters.set(runtimeId, adapter)
      return { adapter, generation: this.generation }
    }
    if (runtimeId === 'llamacpp') {
      const adapter = this.options.llamacppAdapter ?? new LlamaCppLocalAdapter()
      this.persistentAdapters.set(runtimeId, adapter)
      return { adapter, generation: this.generation }
    }
    if (runtimeId === 'openrouter') {
      const adapter = this.options.openrouterAdapter ?? new OpenRouterApiAdapter()
      this.persistentAdapters.set(runtimeId, adapter)
      return { adapter, generation: this.generation }
    }
    throw new DaemonError(
      'RUNTIME_ADAPTER_UNAVAILABLE',
      `No execution adapter registered for runtime "${runtimeId}"`,
      { statusCode: 501 },
    )
  }

  async getSnapshot(refresh = false): Promise<RuntimeSnapshot> {
    if (this.stopped) {
      throw new Error('RuntimeRegistry is stopped')
    }

    const now = Date.now()
    const ttl = this.options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    const cacheFresh = this.cachedSnapshot !== null && now - this.cachedAtMs < ttl

    if (!refresh && cacheFresh && this.cachedSnapshot) {
      return { ...this.cachedSnapshot, cached: true }
    }

    // Enforce cooldown on explicit refresh unless cache is empty.
    if (refresh && this.cachedSnapshot && now - this.lastRefreshRequestMs < REFRESH_COOLDOWN_MS) {
      return {
        ...this.cachedSnapshot,
        status: cacheFresh ? this.cachedSnapshot.status : 'stale',
        cached: true,
      }
    }

    if (this.inFlight) {
      return this.inFlight
    }

    if (refresh) {
      this.lastRefreshRequestMs = now
    }

    this.inFlight = this.fetchSnapshot(refresh).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  async getOpenClawStatus(): Promise<import('@ghost-bot/shared-types/ipc').OpenClawStatusDto> {
    const openclaw = this.options.openclawAdapter ?? new OpenClawGatewayAdapter({ timeoutMs: 2000 })
    const [summary, caps] = await Promise.all([
      openclaw.inspectGateway(),
      openclaw.capabilities().catch(() => ({
        streaming: false,
        cancellation: false,
        resume: false,
        approvals: false,
        usage: false,
        sandbox: false,
        models: [],
      })),
    ])
    const models = summary.available ? caps.models : []

    const policyBroker = new RuntimePolicyBroker()
    const readOnlyDecision = policyBroker.authorizeOpenClawExecution({
      requestedPermission: 'read-only',
      canonicalWorkspace: '/tmp',
      openClawVersion: summary.runtimeVersion,
      openClawExecutionAuthorized: false,
      openClawLoopbackVerified: summary.available,
      openClawSandboxVerified: false,
    })

    return {
      available: summary.available,
      gatewayUrl: summary.gatewayUrl,
      runtimeVersion: summary.runtimeVersion,
      supportedVersion: summary.supportedVersion,
      hostDesktopEnabled: summary.hostDesktopEnabled,
      pluginsLoaded: summary.pluginsLoaded,
      authStatus: summary.authState.status,
      authDetail: summary.authState.detail ?? '',
      detail: summary.detail,
      capabilities: {
        streaming: caps.streaming,
        cancellation: caps.cancellation,
        resume: caps.resume,
        approvals: caps.approvals,
        usage: caps.usage,
        sandbox: caps.sandbox,
      },
      models: models.slice(0, 100).map((m) => ({
        id: m.id,
        label: m.label,
        efforts: m.efforts,
      })),
      policyCompatibility: {
        readOnlyAllowed: readOnlyDecision.allowed,
        askApprovalAllowed: false,
        workspaceAllowed: false,
        fullAccessAllowed: false,
        gatedReason: readOnlyDecision.allowed ? null : readOnlyDecision.reason,
      },
    }
  }

  async getOllamaStatus(): Promise<import('@ghost-bot/shared-types/ipc').OllamaStatusDto> {
    const ollama = this.options.ollamaAdapter ?? new OllamaLocalAdapter({ timeoutMs: 2000 })
    const summary = await ollama.inspectLocalRuntime()
    const policyBroker = new RuntimePolicyBroker()
    const readOnlyDecision = policyBroker.authorizeOllamaExecution({
      requestedPermission: 'read-only',
      canonicalWorkspace: '/tmp',
      ollamaExecutionAuthorized: false,
      ollamaAvailable: summary.available,
      ollamaLoopbackVerified: true,
      ollamaLocalOnlyVerified: summary.localOnlyVerified,
    })

    return {
      available: summary.available,
      baseUrl: summary.baseUrl,
      runtimeVersion: summary.version,
      authStatus: summary.authStatus,
      detail: summary.detail,
      localOnlyVerified: summary.localOnlyVerified,
      capabilities: {
        streaming: true,
        cancellation: true,
        resume: false,
        approvals: false,
        usage: false,
        sandbox: false,
      },
      models: summary.models.slice(0, 100),
      runningModels: summary.runningModels.slice(0, 50),
      resourceLimits: summary.resourceLimits,
      diagnostics: summary.diagnostics,
      policyCompatibility: {
        readOnlyAllowed: readOnlyDecision.allowed,
        askApprovalAllowed: false,
        workspaceAllowed: false,
        fullAccessAllowed: false,
        gatedReason: readOnlyDecision.allowed ? null : readOnlyDecision.reason,
      },
    }
  }

  async getClaudeStatus(input: {
    keyringAvailable: boolean
    keyringLocked: boolean
    keyringReason: string | null
    credentialConfigured: boolean
    accountRef: string
    maskedKeyHint: string | null
    credentialGeneration: number
    executionAuthorized: boolean
    models?: Array<{ id: string; label: string }>
  }): Promise<import('@ghost-bot/shared-types/ipc').ClaudeStatusDto> {
    const adapter =
      this.options.claudeAdapter ??
      new AnthropicClaudeApiAdapter({
        isExecutionAuthorized: () => input.executionAuthorized,
        getCredentialGeneration: () => input.credentialGeneration,
      })
    const policyBroker = new RuntimePolicyBroker()
    const readOnlyDecision = policyBroker.authorizeClaudeApiExecution({
      requestedPermission: 'read-only',
      canonicalWorkspace: '/tmp',
      claudeExecutionAuthorized: input.executionAuthorized,
      claudeCredentialConfigured: input.credentialConfigured,
      claudeKeyringAvailable: input.keyringAvailable,
      claudeEndpointVerified: adapter.getEndpointOrigin() === APPROVED_ANTHROPIC_ORIGIN,
    })

    const diagnostics: string[] = [
      'Uses official Anthropic Messages API (x-api-key + anthropic-version: 2023-06-01); never Claude.ai subscription tokens or browser cookies.',
      'Initial execution is tool-free read-only chat; Claude Code CLI is not invoked.',
    ]
    if (!input.keyringAvailable) {
      diagnostics.push(input.keyringReason ?? 'OS Secret Service keyring is unavailable or locked.')
    }

    const authStatus: 'connected' | 'disconnected' | 'pending' | 'error' = !input.keyringAvailable
      ? 'error'
      : input.credentialConfigured
        ? 'connected'
        : 'disconnected'

    return {
      available: input.keyringAvailable && input.credentialConfigured,
      endpoint: APPROVED_ANTHROPIC_ORIGIN,
      apiVersion: ANTHROPIC_API_VERSION,
      billingMode: 'api-key-billed',
      authStatus,
      detail: !input.keyringAvailable
        ? (input.keyringReason ?? 'OS Secret Service unavailable or locked')
        : input.credentialConfigured
          ? input.executionAuthorized
            ? 'Anthropic API key configured and authorized for bounded API-billed read-only chat'
            : 'Anthropic API key configured in OS Secret Service (execution gated until opt-in)'
          : 'No Anthropic API key configured in OS Secret Service',
      keyringAvailable: input.keyringAvailable,
      keyringLocked: input.keyringLocked,
      credentialConfigured: input.credentialConfigured,
      accountRef: input.accountRef,
      maskedKeyHint: input.maskedKeyHint,
      credentialGeneration: input.credentialGeneration,
      executionAuthorized: input.executionAuthorized,
      capabilities: {
        streaming: true,
        cancellation: true,
        resume: false,
        approvals: false,
        usage: true,
        sandbox: false,
        tools: false,
        claudeCodeCli: false,
      },
      models: input.models ?? [],
      resourceLimits: adapter.getResourceLimits(),
      diagnostics,
      policyCompatibility: {
        readOnlyAllowed: readOnlyDecision.allowed,
        askApprovalAllowed: false,
        workspaceAllowed: false,
        fullAccessAllowed: false,
        gatedReason: readOnlyDecision.allowed ? null : readOnlyDecision.reason,
      },
    }
  }

  async getGeminiStatus(input: {
    keyringAvailable: boolean
    keyringLocked: boolean
    keyringReason: string | null
    credentialConfigured: boolean
    accountRef: string
    maskedKeyHint: string | null
    credentialGeneration: number
    executionAuthorized: boolean
    models?: Array<{ id: string; label: string }>
  }): Promise<import('@ghost-bot/shared-types/ipc').GeminiStatusDto> {
    const adapter =
      this.options.geminiAdapter ??
      new GoogleGeminiApiAdapter({
        isExecutionAuthorized: () => input.executionAuthorized,
        getCredentialGeneration: () => input.credentialGeneration,
        getAccountRef: () => input.accountRef,
      })
    const policyBroker = new RuntimePolicyBroker()
    const readOnlyDecision = policyBroker.authorizeGeminiApiExecution({
      requestedPermission: 'read-only',
      canonicalWorkspace: '/tmp',
      geminiExecutionAuthorized: input.executionAuthorized,
      geminiCredentialConfigured: input.credentialConfigured,
      geminiKeyringAvailable: input.keyringAvailable,
      geminiEndpointVerified: adapter.getEndpointOrigin() === APPROVED_GEMINI_ORIGIN,
    })

    const diagnostics: string[] = [
      'Uses official Gemini API v1beta streamGenerateContent (x-goog-api-key header, never query params or Google account cookies).',
      'Initial execution is tool-free read-only chat; Gemini CLI and Google AI subscription login are disabled.',
    ]
    if (!input.keyringAvailable) {
      diagnostics.push(input.keyringReason ?? 'OS Secret Service keyring is unavailable or locked.')
    }

    const authStatus: 'connected' | 'disconnected' | 'pending' | 'error' = !input.keyringAvailable
      ? 'error'
      : input.credentialConfigured
        ? 'connected'
        : 'disconnected'

    return {
      available: input.keyringAvailable && input.credentialConfigured,
      endpoint: APPROVED_GEMINI_ORIGIN,
      apiVersion: GEMINI_API_VERSION,
      billingMode: 'api-key',
      authStatus,
      detail: !input.keyringAvailable
        ? (input.keyringReason ?? 'OS Secret Service unavailable or locked')
        : input.credentialConfigured
          ? input.executionAuthorized
            ? 'Gemini API key configured and authorized for bounded read-only chat'
            : 'Gemini API key configured in OS Secret Service (execution gated until opt-in)'
          : 'No Gemini API key configured in OS Secret Service',
      keyringAvailable: input.keyringAvailable,
      keyringLocked: input.keyringLocked,
      credentialConfigured: input.credentialConfigured,
      accountRef: input.accountRef,
      maskedKeyHint: input.maskedKeyHint,
      credentialGeneration: input.credentialGeneration,
      executionAuthorized: input.executionAuthorized,
      capabilities: {
        streaming: true,
        cancellation: true,
        resume: false,
        approvals: false,
        usage: true,
        sandbox: false,
        tools: false,
        geminiCli: false,
      },
      models: input.models ?? [],
      resourceLimits: adapter.getResourceLimits(),
      diagnostics,
      policyCompatibility: {
        readOnlyAllowed: readOnlyDecision.allowed,
        askApprovalAllowed: false,
        workspaceAllowed: false,
        fullAccessAllowed: false,
        gatedReason: readOnlyDecision.allowed ? null : readOnlyDecision.reason,
      },
    }
  }

  async getKimiStatus(): Promise<import('@ghost-bot/shared-types/ipc').KimiStatusDto> {
    const kimi = this.options.kimiAdapter ?? new KimiAcpAdapter()
    const info = await kimi.inspectRuntime()
    const policyBroker = new RuntimePolicyBroker()
    const readOnlyDecision = policyBroker.authorizeKimiAcpExecution({
      requestedPermission: 'read-only',
      canonicalWorkspace: '/tmp',
      kimiExecutionAuthorized: false,
      kimiCliAvailable: info.cliAvailable,
      kimiAcpProtocolVerified: info.acpProtocolSupported,
      kimiAuthenticated: info.authenticated,
      kimiContainmentVerified: false,
    })

    const authStatus: 'connected' | 'disconnected' | 'pending' | 'error' = !info.cliAvailable
      ? 'disconnected'
      : info.authenticated
        ? 'connected'
        : 'pending'

    return {
      cliAvailable: info.cliAvailable,
      cliVersion: info.cliVersion,
      protocolVersion: info.protocolVersion,
      acpProtocolSupported: info.acpProtocolSupported,
      authenticated: info.authenticated,
      authStatus,
      detail: info.detail,
      loginGuidance: 'Run `kimi login` in your local terminal (Ghost Bot never reads Kimi token files).',
      capabilities: {
        streaming: true,
        cancellation: true,
        resume: info.loadSessionSupported,
        approvals: true,
        usage: true,
        clientFsSupported: false,
        clientTerminalSupported: false,
      },
      models: info.models.map((m) => ({ id: m.id, label: m.label })),
      diagnostics: [
        'ACP protocol v1 over stdio (`kimi acp`); client fs/* and terminal/* callbacks disabled.',
        'allow_always permission options are rejected; single-use approvals only.',
      ],
      policyCompatibility: {
        readOnlyAllowed: readOnlyDecision.allowed,
        askApprovalAllowed: false,
        workspaceAllowed: false,
        fullAccessAllowed: false,
        gatedReason: readOnlyDecision.allowed ? null : readOnlyDecision.reason,
      },
    }
  }

  getOfflineDiscussionRuntime(): AgentRuntime | null {
    return this.getRuntimeMode() === 'mock' && !this.stopped ? this.mock : null
  }

  async getTeamRoutingCatalogs(): Promise<import('@ghost-bot/shared-types/ipc').TeamMemberRoutingDto['catalogs']> {
    const snapshot = await this.getSnapshot(false)
    if (snapshot.runtimeMode === 'mock') {
      const models = [...snapshot.models,
        { id: 'gpt-6.2-mock', label: 'GPT-6.2 (Mock)', efforts: ['low', 'medium', 'high'] },
        { id: 'codex-mock', label: 'Codex (Mock)', efforts: ['low', 'medium', 'high'] },
      ]
      return ['mock-offline', 'mock'].map((runtimeId) => ({ runtimeId, accountId: 'mock-account', models }))
    }
    if (snapshot.status === 'available' && snapshot.authStatus === 'connected' &&
        snapshot.authMethod === 'chatgpt' && this.lastAccountKey) {
      return [{ runtimeId: 'codex', accountId: this.lastAccountKey, models: snapshot.models }]
    }
    return []
  }

  async listProviders(): Promise<ProviderSummary[]> {
    const snap = await this.getSnapshot(false)
    if (snap.runtimeMode === 'mock') {
      return [
        {
          id: this.mock.id,
          label: 'Mock Offline Runtime',
          kind: 'mock',
          status: 'mock',
          detail: 'Explicit offline mock runtime (no real provider calls)',
        },
      ]
    }

    const openclaw = this.options.openclawAdapter ?? new OpenClawGatewayAdapter({ timeoutMs: 1500 })
    const ollama = this.options.ollamaAdapter ?? new OllamaLocalAdapter({ timeoutMs: 1000 })
    const [ocStatus, olStatus] = await Promise.all([
      openclaw.inspectGateway().catch((err) => ({
        available: false,
        runtimeVersion: null,
        authState: { status: 'error' as const, detail: err instanceof Error ? err.message : 'Error' },
        detail: err instanceof Error ? err.message : 'OpenClaw Gateway unavailable',
        verifiedModes: [] as ('read-only' | 'ask-approval' | 'workspace')[],
      })),
      ollama.checkAvailability().catch(() => ({
        available: false,
        version: null,
        detail: 'Local service not detected at http://127.0.0.1:11434',
      })),
    ])

    return [
      {
        id: 'codex-app-server',
        label: 'OpenAI Codex (ChatGPT Subscription)',
        kind: 'subscription',
        status:
          snap.authStatus === 'connected'
            ? 'connected'
            : snap.status === 'unavailable'
              ? 'unavailable'
              : 'disconnected',
        detail: snap.detail,
      },
      {
        id: 'openclaw',
        label: 'OpenClaw Gateway',
        kind: 'local',
        status: ocStatus.available ? 'connected' : 'unavailable',
        detail: ocStatus.detail,
      },
      {
        id: 'ollama',
        label: 'Ollama Local',
        kind: 'local',
        status: olStatus.available ? 'connected' : 'unavailable',
        detail: olStatus.detail,
      },
    ]
  }

  abortProviderRuns(runtimeId: 'claude-api' | 'gemini-api' | 'openrouter' | 'lmstudio' | 'llamacpp'): void {
    const persistent = this.persistentAdapters.get(runtimeId) as
      | { abortActiveRuns?: () => void }
      | undefined
    persistent?.abortActiveRuns?.()
    if (runtimeId === 'claude-api') {
      this.options.claudeAdapter?.abortActiveRuns()
    } else if (runtimeId === 'gemini-api') {
      this.options.geminiAdapter?.abortActiveRuns()
    } else if (runtimeId === 'openrouter') {
      this.options.openrouterAdapter?.abortActiveRuns()
    } else if (runtimeId === 'lmstudio') {
      this.options.lmstudioAdapter?.abortActiveRuns()
    } else if (runtimeId === 'llamacpp') {
      this.options.llamacppAdapter?.abortActiveRuns()
    }
  }

  async getLocalOpenAiCompatStatus(input: {
    id: 'lmstudio' | 'llamacpp'
    baseUrl?: string
    executionAuthorized: boolean
  }): Promise<import('@ghost-bot/shared-types/ipc').LocalOpenAiCompatStatusDto> {
    const isLm = input.id === 'lmstudio'
    const defaultUrl = isLm ? DEFAULT_LMSTUDIO_BASE_URL : DEFAULT_LLAMACPP_BASE_URL
    const persistent = this.persistentAdapters.get(input.id) as
      | LmStudioLocalAdapter
      | LlamaCppLocalAdapter
      | undefined
    const adapter =
      persistent ??
      (isLm
        ? (this.options.lmstudioAdapter ??
          new LmStudioLocalAdapter({
            baseUrl: input.baseUrl ?? defaultUrl,
            isExecutionAuthorized: () => input.executionAuthorized,
          }))
        : (this.options.llamacppAdapter ??
          new LlamaCppLocalAdapter({
            baseUrl: input.baseUrl ?? defaultUrl,
            isExecutionAuthorized: () => input.executionAuthorized,
          })))
    const avail = await adapter.checkAvailability()
    const policyBroker = new RuntimePolicyBroker()
    const readOnlyDecision = policyBroker.authorizeLocalOpenAiCompatExecution({
      providerLabel: isLm ? 'LM Studio' : 'llama.cpp',
      requestedPermission: 'read-only',
      canonicalWorkspace: '/tmp',
      executionAuthorized: input.executionAuthorized,
      available: avail.available,
      loopbackVerified: true,
    })
    return {
      id: input.id,
      available: avail.available,
      baseUrl: adapter.getBaseUrl(),
      authStatus: avail.available ? 'connected' : 'disconnected',
      detail: avail.detail,
      loopbackVerified: true,
      executionAuthorized: input.executionAuthorized,
      capabilities: {
        streaming: true,
        cancellation: true,
        usage: true,
        tools: false,
      },
      models: avail.models.slice(0, 100).map((m) => ({ id: m.id, label: m.label })),
      resourceLimits: adapter.getResourceLimits(),
      diagnostics: [
        'Loopback-only OpenAI-compatible HTTP transport; transport locality does not prove upstream routing.',
        'Initial execution is tool-free read-only chat; no cloud fallback.',
      ],
      policyCompatibility: {
        readOnlyAllowed: readOnlyDecision.allowed,
        askApprovalAllowed: false,
        workspaceAllowed: false,
        fullAccessAllowed: false,
        gatedReason: readOnlyDecision.allowed ? null : readOnlyDecision.reason,
      },
    }
  }

  async getOpenRouterStatus(input: {
    keyringAvailable: boolean
    keyringLocked: boolean
    keyringReason: string | null
    credentialConfigured: boolean
    accountRef: string
    maskedKeyHint: string | null
    credentialGeneration: number
    executionAuthorized: boolean
    models?: Array<{ id: string; label: string }>
  }): Promise<import('@ghost-bot/shared-types/ipc').OpenRouterStatusDto> {
    const adapter =
      this.options.openrouterAdapter ??
      new OpenRouterApiAdapter({
        isExecutionAuthorized: () => input.executionAuthorized,
        getCredentialGeneration: () => input.credentialGeneration,
        getAccountRef: () => input.accountRef,
      })
    const policyBroker = new RuntimePolicyBroker()
    const readOnlyDecision = policyBroker.authorizeOpenRouterExecution({
      requestedPermission: 'read-only',
      canonicalWorkspace: '/tmp',
      openRouterExecutionAuthorized: input.executionAuthorized,
      openRouterCredentialConfigured: input.credentialConfigured,
      openRouterKeyringAvailable: input.keyringAvailable,
      openRouterEndpointVerified: adapter.getBaseUrl() === APPROVED_OPENROUTER_BASE_URL,
    })

    const diagnostics: string[] = [
      'Pinned to https://openrouter.ai/api/v1 with provider.allow_fallbacks=false; not a ChatGPT/Claude/Gemini subscription.',
      'Initial execution is tool-free read-only chat.',
    ]
    if (!input.keyringAvailable) {
      diagnostics.push(input.keyringReason ?? 'OS Secret Service keyring is unavailable or locked.')
    }

    const authStatus: 'connected' | 'disconnected' | 'pending' | 'error' = !input.keyringAvailable
      ? 'error'
      : input.credentialConfigured
        ? 'connected'
        : 'disconnected'

    return {
      available: input.keyringAvailable && input.credentialConfigured,
      endpoint: APPROVED_OPENROUTER_BASE_URL,
      billingMode: 'api-key-billed',
      authStatus,
      detail: !input.keyringAvailable
        ? (input.keyringReason ?? 'OS Secret Service unavailable or locked')
        : input.credentialConfigured
          ? input.executionAuthorized
            ? 'OpenRouter API key configured and authorized for bounded API-billed read-only chat'
            : 'OpenRouter API key configured in OS Secret Service (execution gated until opt-in)'
          : 'No OpenRouter API key configured in OS Secret Service',
      keyringAvailable: input.keyringAvailable,
      keyringLocked: input.keyringLocked,
      credentialConfigured: input.credentialConfigured,
      accountRef: input.accountRef,
      maskedKeyHint: input.maskedKeyHint,
      credentialGeneration: input.credentialGeneration,
      executionAuthorized: input.executionAuthorized,
      capabilities: {
        streaming: true,
        cancellation: true,
        usage: true,
        tools: false,
        fallbacksDisabled: true,
      },
      models: input.models ?? [],
      resourceLimits: adapter.getResourceLimits(),
      diagnostics,
      policyCompatibility: {
        readOnlyAllowed: readOnlyDecision.allowed,
        askApprovalAllowed: false,
        workspaceAllowed: false,
        fullAccessAllowed: false,
        gatedReason: readOnlyDecision.allowed ? null : readOnlyDecision.reason,
      },
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.lifecycleState = 'disconnected'
    this.generation += 1
    this.cachedSnapshot = null
    this.lastAccountKey = null
    await this.mock.disconnect()
    for (const adapter of this.persistentAdapters.values()) {
      await adapter.disconnect().catch(() => {})
    }
    this.persistentAdapters.clear()
    if (this.codexClient) {
      const client = this.codexClient
      this.codexClient = null
      await client.close().catch(() => undefined)
    }
  }

  private async fetchSnapshot(forceVersionCheck = false): Promise<RuntimeSnapshot> {
    const gen = this.generation
    const observedAt = new Date().toISOString()

    if (this.options.runtimeMode === 'mock') {
      const models = await this.mock.listModels()
      const snap: RuntimeSnapshot = {
        runtimeMode: 'mock',
        codexVersion: null,
        status: 'mock',
        authStatus: 'connected',
        authMethod: 'mock',
        planType: null,
        workspaceName: null,
        detail: 'Offline mock runtime active (sample UI mode; not real account data)',
        models: models.map((m) => ({ id: m.id, label: m.label, efforts: m.efforts })),
        usageStatus: 'mock',
        usageWindows: [],
        usageObservedAt: null,
        verifiedPermissionModes: [],
        observedAt,
        cached: false,
      }
      if (gen === this.generation && !this.stopped) {
        this.cachedSnapshot = snap
        this.cachedAtMs = Date.now()
      }
      return snap
    }

    if (this.codexVersion === undefined || (forceVersionCheck && this.options.codexVersionOverride === undefined)) {
      const detected =
        this.options.codexVersionOverride !== undefined
          ? this.options.codexVersionOverride
          : await detectCodexVersion(this.options.codexCommand ?? 'codex')
      if (this.codexVersion !== undefined && detected !== this.codexVersion) {
        // Runtime version changed: invalidate old client and cached permission evidence.
        this.generation += 1
        this.cachedSnapshot = null
        this.lastAccountKey = null
        if (this.codexClient) {
          const old = this.codexClient
          this.codexClient = null
          await old.close().catch(() => undefined)
        }
      }
      this.codexVersion = detected
    }
    const activeGen = this.generation

    if (!this.codexVersion) {
      const snap: RuntimeSnapshot = {
        runtimeMode: 'codex',
        codexVersion: null,
        status: 'unavailable',
        authStatus: 'disconnected',
        authMethod: 'none',
        planType: null,
        workspaceName: null,
        detail: 'Codex CLI is not installed or not found on PATH.',
        models: [],
        usageStatus: 'unavailable',
        usageWindows: [],
        usageObservedAt: null,
        verifiedPermissionModes: [],
        observedAt,
        cached: false,
      }
      this.cachedSnapshot = snap
      this.cachedAtMs = Date.now()
      return snap
    }

    const evidence = resolveCodexVerifiedEvidence(this.codexVersion)
    const verifiedModes = (evidence?.verifiedModes ?? []).filter(
      (m): m is 'read-only' | 'ask-approval' | 'workspace' => m !== 'full-access',
    )

    if (!evidence) {
      const snap: RuntimeSnapshot = {
        runtimeMode: 'codex',
        codexVersion: this.codexVersion,
        status: 'unsupported',
        authStatus: 'disconnected',
        authMethod: 'none',
        planType: null,
        workspaceName: null,
        detail: `Codex ${this.codexVersion} is below the verified >= 0.172.0 baseline.`,
        models: [],
        usageStatus: 'unsupported',
        usageWindows: [],
        usageObservedAt: null,
        verifiedPermissionModes: [],
        observedAt,
        cached: false,
      }
      this.cachedSnapshot = snap
      this.cachedAtMs = Date.now()
      return snap
    }

    try {
      if (!this.codexClient) {
        this.codexClient = this.options.codexClientFactory
          ? this.options.codexClientFactory(this.codexVersion)
          : new CodexAppServerAdapter({
              command: this.options.codexCommand,
              permissionEvidence: evidence,
              fullAccessOptIn: false,
            })
      }

      const account = await this.codexClient.getAccountSummary(false)
      const models = await this.codexClient.listModels()

      if (!account.accountPresent) {
        this.lastAccountKey = null
        const snap: RuntimeSnapshot = {
          runtimeMode: 'codex',
          codexVersion: this.codexVersion,
          status: 'auth-required',
          authStatus: 'disconnected',
          authMethod: 'none',
          planType: null,
          workspaceName: null,
          detail:
            'Codex profile is not signed in. Sign in manually with: CODEX_HOME=~/.config/ghost-bot/codex-profile codex login --device-auth',
          models: models.map((m) => ({ id: m.id, label: m.label, efforts: m.efforts })),
          usageStatus: 'auth-required',
          usageWindows: [],
          usageObservedAt: null,
          verifiedPermissionModes: verifiedModes,
          observedAt,
          cached: false,
        }
        if (activeGen === this.generation && !this.stopped) {
          this.cachedSnapshot = snap
          this.cachedAtMs = Date.now()
        }
        return snap
      }

      if (account.accountType === 'apiKey') {
        this.lastAccountKey = 'apiKey'
        const snap: RuntimeSnapshot = {
          runtimeMode: 'codex',
          codexVersion: this.codexVersion,
          status: 'unsupported',
          authStatus: 'error',
          authMethod: 'apiKey',
          planType: null,
          workspaceName: null,
          detail:
            'API-key account detected; subscription-first policy blocks silent paid API usage.',
          models: models.map((m) => ({ id: m.id, label: m.label, efforts: m.efforts })),
          usageStatus: 'unsupported',
          usageWindows: [],
          usageObservedAt: null,
          verifiedPermissionModes: verifiedModes,
          observedAt,
          cached: false,
        }
        if (activeGen === this.generation && !this.stopped) {
          this.cachedSnapshot = snap
          this.cachedAtMs = Date.now()
        }
        return snap
      }

      const accountKey = `${account.accountType ?? 'unknown'}:${account.planType ?? ''}:${account.workspaceName ?? ''}`
      if (this.lastAccountKey !== null && this.lastAccountKey !== accountKey) {
        // Account changed: clear prior account's cached snapshot.
        this.cachedSnapshot = null
      }
      this.lastAccountKey = accountKey

      let usage: UsageSnapshot | null = null
      let usageStatus: RuntimeSnapshot['usageStatus'] = 'unavailable'
      try {
        usage = await this.codexClient.getUsage()
        usageStatus = usage && usage.windows.length > 0 ? 'available' : 'unavailable'
      } catch {
        usageStatus = 'unavailable'
      }

      this.lifecycleState = 'connected'
      const snap: RuntimeSnapshot = {
        runtimeMode: 'codex',
        codexVersion: this.codexVersion,
        status: 'available',
        lifecycleState: 'connected',
        authStatus: 'connected',
        authMethod: 'chatgpt',
        planType: account.planType,
        workspaceName: account.workspaceName,
        detail: `Codex ${this.codexVersion} connected (${account.planType ?? 'chatgpt'})`,
        models: models.map((m) => ({ id: m.id, label: m.label, efforts: m.efforts })),
        usageStatus,
        usageWindows: usage?.windows ?? [],
        usageObservedAt: usage?.observedAt ?? null,
        verifiedPermissionModes: verifiedModes,
        observedAt,
        cached: false,
      }
      if (activeGen === this.generation && !this.stopped) {
        this.cachedSnapshot = snap
        this.cachedAtMs = Date.now()
      }
      return snap
    } catch (err) {
      // Close potentially broken adapter process so next refresh spawns cleanly.
      if (this.codexClient) {
        const client = this.codexClient
        this.codexClient = null
        await client.close().catch(() => undefined)
      }

      const safeMessage = redactSecrets(
        err instanceof Error ? err.message : 'Codex runtime query failed',
      )

      if (
        activeGen === this.generation &&
        !this.stopped &&
        this.cachedSnapshot &&
        this.cachedSnapshot.status === 'available'
      ) {
        return {
          ...this.cachedSnapshot,
          status: 'stale',
          usageStatus: 'stale',
          detail: `Showing cached metadata; latest refresh failed: ${safeMessage}`,
          cached: true,
        }
      }

      this.lifecycleState = 'failed'
      return {
        runtimeMode: 'codex',
        codexVersion: this.codexVersion,
        status: 'error',
        lifecycleState: 'failed',
        authStatus: 'error',
        authMethod: 'none',
        planType: null,
        workspaceName: null,
        detail: safeMessage,
        models: [],
        usageStatus: 'error',
        usageWindows: [],
        usageObservedAt: null,
        verifiedPermissionModes: verifiedModes,
        observedAt,
        cached: false,
      }
    }
  }
}
