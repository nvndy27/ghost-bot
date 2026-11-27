import { timingSafeEqual } from 'node:crypto'
import { chmod, open, readFile, realpath, unlink } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { sanitizeCustomSvg } from '@ghost-bot/avatar/svg-sanitizer'
import {
  AppearanceSettingsSchema,
  AppSettingsPatchSchema,
  BotIdSchema,
  ComputerUseEmergencyStopInputSchema,
  ComputerUseObserveInputSchema,
  ComputerUseSessionIdParamSchema,
  ComputerUseSessionListParamSchema,
  CreateBotInputSchema,
  CreateComputerUseSessionInputSchema,
  CreateKnowledgeCollectionInputSchema,
  CreateMemoryIpcInputSchema,
  CreateRoutineIpcInputSchema,
  CreateSessionInputSchema,
  CreateTeamIpcInputSchema,
  ExecuteComputerUseActionInputSchema,
  GetMcpPromptInputSchema,
  ImportAvatarSvgInputSchema,
  ImportRoutineIpcInputSchema,
  IngestKnowledgeTextInputSchema,
  KnowledgeIdParamSchema,
  ListComputerUseSessionsInputSchema,
  ListKnowledgeCollectionsInputSchema,
  ListKnowledgeDocsInputSchema,
  ListMcpServersInputSchema,
  ListMemoriesIpcInputSchema,
  ListRoutineNotificationsIpcInputSchema,
  ListRoutinesIpcInputSchema,
  ListTeamMessagesIpcInputSchema,
  ListTeamsInputSchema,
  McpServerIdParamSchema,
  MemoryIdParamSchema,
  PreviewTeamPlanIpcInputSchema,
  ReadMcpResourceInputSchema,
  RegisterMcpServerIpcInputSchema,
  RenameSessionInputSchema,
  ReplaceKnowledgeDocTextInputSchema,
  RequestComputerUseApprovalInputSchema,
  ResolveApprovalInputSchema,
  ResolveComputerUseApprovalInputSchema,
  ResolveKnowledgeCitationInputSchema,
  RetryRunInputSchema,
  RoutineCountParamSchema,
  RoutineNotificationParamSchema,
  RoutineScopeParamSchema,
  RoutineTaskParamSchema,
  RunIdSchema,
  SearchKnowledgeDocsInputSchema,
  SearchMemoriesIpcInputSchema,
  SessionIdSchema,
  DeleteMcpServerSecretInputSchema,
  DiscoverLocalSkillsInputSchema,
  ListTerminalCommandsInputSchema,
  RequestTerminalCommandInputSchema,
  ResolveTerminalCommandInputSchema,
  SetActiveBotParamsSchema,
  SetActiveSessionInputSchema,
  SetMcpServerEnabledInputSchema,
  SetClaudeAuthInputSchema,
  SetClaudeCredentialInputSchema,
  SetGeminiAuthInputSchema,
  SetGeminiCredentialInputSchema,
  SetLocalCompatConfigInputSchema,
  SetOpenRouterAuthInputSchema,
  SetOpenRouterCredentialInputSchema,
  SetMcpServerSecretInputSchema,
  SetSkillEnabledInputSchema,
  SkillIdParamSchema,
  TerminalCommandIdParamSchema,
  StartRunInputSchema,
  StartTeamRunIpcInputSchema,
  TeamIdParamSchema,
  TeamRunIdParamSchema,
  TriggerRoutineIpcInputSchema,
  UpdateBotInputSchema,
  UpdateKnowledgeDocInputSchema,
  UpdateMcpServerIpcInputSchema,
  UpdateMemoryIpcInputSchema,
  UpdateRoutineIpcInputSchema,
  UpdateSidebarOrganizationInputSchema,
  UpdateTeamIpcInputSchema,
  UpdateTeamMembersIpcInputSchema,
  WorkspaceGitInspectSchema,
  WorkspaceGitOperationSchema,
  WorkspaceListDirectoryIpcInputSchema,
  WorkspaceReadFileIpcInputSchema,
  WorkspaceReadGrantSchema,
  WorkspaceDiscoveryOperationSchema,
  WorkspacePreviewInputSchema,
  WorkspaceSearchInputSchema,
  type PersonalWorkspaceAccessSchema,
  WorkspaceSelectorIpcSchema,
} from '@ghost-bot/shared-types/ipc'
import { z } from 'zod'
import type { DaemonHealthResponse } from '@ghost-bot/shared-types/ipc'
import { BotRepository } from './bots/repository.ts'
import { openGhostBotDatabase } from './db/client.ts'
import type { DatabaseHandle } from './db/client.ts'
import { seedInitialBotsIfNeeded } from './db/seed.ts'
import { DaemonError, normalizeDaemonError } from './errors.ts'
import { RunOrchestrator } from './execution/orchestrator.ts'
import { KnowledgeService } from './knowledge/service.ts'
import { McpService, type McpSecretResolver } from './mcp/service.ts'
import { MemoryService } from './memory/service.ts'
import { RuntimePolicyBroker } from './runtime/policy-broker.ts'
import { RuntimeRegistry } from './runtime/registry.ts'
import { DaemonRoutineDispatcher } from './scheduler/execution-bridge.ts'
import { SchedulerService } from './scheduler/service.ts'
import { SessionRepository } from './sessions/repository.ts'
import { SettingsRepository } from './settings/repository.ts'
import { SidebarOrganizationRepository } from './sidebar/repository.ts'
import { TeamsExecutionBridge } from './teams/execution-bridge.ts'
import { TeamsService } from './teams/service.ts'
import { ComputerUseService } from './computer-use/service.ts'
import { assertLoopbackOpenAiCompatBaseUrl } from '@ghost-bot/runtime-adapters/openai-compat'
import { DEFAULT_LMSTUDIO_BASE_URL, LmStudioLocalAdapter } from '@ghost-bot/runtime-adapters/lmstudio'
import { DEFAULT_LLAMACPP_BASE_URL, LlamaCppLocalAdapter } from '@ghost-bot/runtime-adapters/llamacpp'
import { OpenRouterApiAdapter } from '@ghost-bot/runtime-adapters/openrouter'
import { AnthropicClaudeApiAdapter } from '@ghost-bot/runtime-adapters/claude'
import { GoogleGeminiApiAdapter } from '@ghost-bot/runtime-adapters/gemini'
import { OllamaLocalAdapter } from '@ghost-bot/runtime-adapters/ollama'
import { OpenClawGatewayAdapter } from '@ghost-bot/runtime-adapters/openclaw'
import { KimiAcpAdapter } from '@ghost-bot/runtime-adapters/kimi'
import type { AgentRuntime } from '@ghost-bot/shared-types/runtime'
import { ScopedTerminalService } from './terminal/service.ts'
import { LocalSkillsService } from './skills/service.ts'
import { createDefaultSecretStore, type SecretStore } from './secrets/store.ts'
import { LOCAL_USER_ID } from './memory/service.ts'
import { WorkspaceDiscoveryOperations } from './workspace/discovery-operations.ts'
import { WorkspaceGitService } from './workspace/git-service.ts'
import { WorkspaceOutputService } from './workspace/output-service.ts'
import { WorkspaceFilesService } from './workspace/files-service.ts'

export interface DaemonServerOptions {
  authToken: string
  socketPath?: string
  port?: number
  dataDir?: string
  runtimeMode?: 'codex' | 'mock'
  codexVersion?: string | null
  mcpSecretResolver?: McpSecretResolver
  mcpGracefulShutdownMs?: number
  secretStore?: SecretStore
  /** Test-only persistent adapter overrides for offline unified execution tests. */
  testProviderAdapters?: Record<string, AgentRuntime>
}

function constantTimeTokenMatch(headerValue: string | undefined, expectedToken: string): boolean {
  if (!headerValue || !headerValue.startsWith('Bearer ')) return false
  const provided = headerValue.slice('Bearer '.length)
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expectedToken, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(payload))
}

const MAX_BODY_BYTES = 64 * 1024
const MAX_KNOWLEDGE_BODY_BYTES = 600 * 1024

async function readJsonBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > maxBytes) {
      throw new DaemonError('PAYLOAD_TOO_LARGE', `Request body exceeds ${maxBytes} bytes limit`, {
        statusCode: 413,
      })
    }
    chunks.push(buf)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new DaemonError('INVALID_JSON', 'Malformed JSON request body', { statusCode: 400 })
  }
}

async function readWorkspaceRequest<T>(req: IncomingMessage, schema: z.ZodType<T>): Promise<T> {
  const result = schema.safeParse(await readJsonBody(req))
  if (!result.success) {
    throw new DaemonError('VALIDATION_ERROR', 'Invalid workspace request', { statusCode: 400 })
  }
  return result.data
}

const ACTIVE_DAEMON_LOCKS = new Set<string>()

export class GhostBotDaemon {
  private readonly options: DaemonServerOptions
  private readonly runtimeMode: 'codex' | 'mock'
  private readonly runtimeRegistry: RuntimeRegistry
  private dbHandle: DatabaseHandle | null = null
  private botRepo: BotRepository | null = null
  private settingsRepo: SettingsRepository | null = null
  private sessionRepo: SessionRepository | null = null
  private sidebarRepo: SidebarOrganizationRepository | null = null
  private memoryService: MemoryService | null = null
  private knowledgeService: KnowledgeService | null = null
  private mcpService: McpService | null = null
  private teamsService: TeamsService | null = null
  private schedulerService: SchedulerService | null = null
  private computerUseService: ComputerUseService | null = null
  private terminalService: ScopedTerminalService | null = null
  private skillsService: LocalSkillsService | null = null
  private workspaceDiscovery: WorkspaceDiscoveryOperations | null = null
  private readonly workspaceReadGrants = new Map<string, { workspaceId: string; authGeneration: string }>()
  private workspaceGitService: WorkspaceGitService | null = null
  private workspaceOutputService: WorkspaceOutputService | null = null
  private workspaceFilesService: WorkspaceFilesService | null = null
  private providerSecretStore: SecretStore | null = null
  private runOrchestrator: RunOrchestrator | null = null
  private lockFilePath: string | null = null
  private server: Server | null = null
  private readonly startedAt = Date.now()

  constructor(options: DaemonServerOptions) {
    if (!options.authToken || options.authToken.length < 16) {
      throw new DaemonError('INVALID_CONFIG', 'Daemon requires a strong authToken (>=16 chars)')
    }
    this.options = options
    this.runtimeMode = options.runtimeMode ?? 'codex'
    this.runtimeRegistry = new RuntimeRegistry({
      runtimeMode: this.runtimeMode,
      codexVersionOverride: options.codexVersion,
    })
  }

  private async acquireDaemonLock(lockPath: string): Promise<void> {
    if (ACTIVE_DAEMON_LOCKS.has(lockPath)) {
      throw new DaemonError(
        'DAEMON_ALREADY_RUNNING',
        `Another Ghost Bot daemon (pid ${process.pid}) already owns ${dirname(lockPath)}`,
        { statusCode: 409 },
      )
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(lockPath, 'wx', 0o600)
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8')
        } finally {
          await handle.close()
        }
        ACTIVE_DAEMON_LOCKS.add(lockPath)
        this.lockFilePath = lockPath
        return
      } catch (err) {
        const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : ''
        if (code !== 'EEXIST') throw err

        let existingPid: number | null = null
        try {
          const raw = await readFile(lockPath, 'utf8')
          const parsed = JSON.parse(raw) as { pid?: unknown }
          if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0) {
            existingPid = parsed.pid
          }
        } catch {
          // Malformed or empty lock file -> treat as stale if unreadable
        }

        if (existingPid !== null && existingPid !== process.pid) {
          let isAlive = false
          try {
            process.kill(existingPid, 0)
            isAlive = true
          } catch (killErr) {
            const killCode =
              killErr && typeof killErr === 'object' && 'code' in killErr ? String(killErr.code) : ''
            if (killCode === 'EPERM') isAlive = true
          }
          if (isAlive) {
            throw new DaemonError(
              'DAEMON_ALREADY_RUNNING',
              `Another Ghost Bot daemon (pid ${existingPid}) already owns ${dirname(lockPath)}`,
              { statusCode: 409 },
            )
          }
        }
        await unlink(lockPath).catch(() => undefined)
      }
    }
  }

  async start(): Promise<{ address: string }> {
    if (this.server) {
      throw new DaemonError('ALREADY_STARTED', 'Daemon server is already running')
    }

    const dbHandle = await openGhostBotDatabase(this.options.dataDir)
    try {
      await this.acquireDaemonLock(join(dirname(dbHandle.dbPath), 'daemon.lock'))
    } catch (err) {
      dbHandle.close()
      throw err
    }
    seedInitialBotsIfNeeded(dbHandle)
    this.dbHandle = dbHandle
    this.botRepo = new BotRepository(dbHandle)
    this.settingsRepo = new SettingsRepository(dbHandle)
    this.sessionRepo = new SessionRepository(dbHandle)
    this.sidebarRepo = new SidebarOrganizationRepository(dbHandle)
    this.memoryService = new MemoryService(dbHandle, this.settingsRepo)
    this.knowledgeService = new KnowledgeService(dbHandle, this.settingsRepo)
    const policyBroker = new RuntimePolicyBroker()
    this.mcpService = new McpService({
      db: dbHandle,
      settingsRepo: this.settingsRepo,
      policyBroker,
      secretResolver: this.options.mcpSecretResolver,
      gracefulShutdownMs: this.options.mcpGracefulShutdownMs,
    })
    this.runOrchestrator = new RunOrchestrator(dbHandle, {
      runtimeRegistry: this.runtimeRegistry,
      settingsRepo: this.settingsRepo,
      memoryService: this.memoryService,
      knowledgeService: this.knowledgeService,
      mcpService: this.mcpService,
      getProviderPolicyInput: (runtimeId, permission, canonicalWorkspace) =>
        this.buildProviderPolicyInput(runtimeId, permission, canonicalWorkspace),
    })
    this.runOrchestrator.reconcileOnStartup()
    const teamsBridge = new TeamsExecutionBridge({
      dbHandle,
      botRepo: this.botRepo,
      sessionRepo: this.sessionRepo,
      orchestrator: this.runOrchestrator,
      policyBroker,
      getRuntimeState: () => ({
        runtimeMode: this.runtimeMode,
        codexVersion: this.options.codexVersion ?? null,
        authMethod: 'none',
        accountId: null,
      }),
    })
    this.teamsService = new TeamsService(dbHandle, this.botRepo, teamsBridge)
    this.teamsService.reconcileOnStartup()

    this.schedulerService = new SchedulerService(dbHandle, this.botRepo, this.teamsService, {
      tickIntervalMs: 5_000,
    })
    const routineDispatcher = new DaemonRoutineDispatcher({
      dbHandle,
      botRepo: this.botRepo,
      sessionRepo: this.sessionRepo,
      orchestrator: this.runOrchestrator,
      policyBroker,
      teamsService: this.teamsService,
      approvalCoordinator: this.schedulerService.approvals,
      getRuntimeState: () => ({
        runtimeMode: this.runtimeMode,
        codexVersion: this.options.codexVersion ?? null,
        authMethod: 'none',
        accountId: null,
      }),
    })
    this.schedulerService.attachDispatcher(routineDispatcher)
    this.schedulerService.reconcileOnStartup()
    this.schedulerService.startTimer()

    this.computerUseService = new ComputerUseService(dbHandle, this.botRepo, policyBroker)
    this.computerUseService.reconcileOnStartup()
    this.terminalService = new ScopedTerminalService(dbHandle, this.botRepo)
    this.terminalService.reconcileOnStartup()
    this.skillsService = new LocalSkillsService(dbHandle)
    this.workspaceFilesService = new WorkspaceFilesService(dbHandle)
    this.workspaceDiscovery = new WorkspaceDiscoveryOperations(
      this.workspaceFilesService,
      (input) => this.requireDiscoveryGrant(input),
    )
    this.workspaceGitService = new WorkspaceGitService(
      this.workspaceFilesService,
      (input) => this.requireDiscoveryGrant(input),
    )
    this.workspaceOutputService = new WorkspaceOutputService(dbHandle)
    this.providerSecretStore = this.options.secretStore ?? createDefaultSecretStore()
    this.registerPersistentProviderAdapters()
    this.runOrchestrator.setOnRunTerminated((runId, reason) => {
      void this.computerUseService?.revokeByRunId(runId, reason).catch(() => {})
      void this.terminalService?.revokeByRunId(runId, reason).catch(() => {})
    })

    const server = createServer((req, res) => {
      void this.handleRequest(req, res)
    })
    this.server = server

    if (this.options.socketPath) {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(this.options.socketPath, () => {
          server.off('error', reject)
          resolve()
        })
      })
      await chmod(this.options.socketPath, 0o600)
      return { address: this.options.socketPath }
    }

    const port = this.options.port ?? 0
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const addr = server.address()
    const boundPort = typeof addr === 'object' && addr ? addr.port : port
    return { address: `http://127.0.0.1:${boundPort}` }
  }

  private registerPersistentProviderAdapters(): void {
    const overrides = this.options.testProviderAdapters ?? {}
    const resolveProviderKey = (providerId: string, readMeta: () => { accountRef: string }) => {
      const store = this.providerSecretStore
      if (!store) return null
      const meta = readMeta()
      return store.resolveProviderSecret({
        ownerId: LOCAL_USER_ID,
        providerId,
        accountRef: meta.accountRef,
      })
    }

    this.runtimeRegistry.registerPersistentAdapter(
      'openclaw',
      overrides.openclaw ?? new OpenClawGatewayAdapter({ timeoutMs: 2000 }),
    )
    this.runtimeRegistry.registerPersistentAdapter(
      'ollama',
      overrides.ollama ?? new OllamaLocalAdapter({ timeoutMs: 2000 }),
    )
    this.runtimeRegistry.registerPersistentAdapter(
      'claude-api',
      overrides['claude-api'] ??
        new AnthropicClaudeApiAdapter({
          resolveApiKey: () => resolveProviderKey('anthropic', () => this.readClaudeProviderMeta()),
          isExecutionAuthorized: () => this.readClaudeProviderMeta().executionAuthorized,
          getCredentialGeneration: () => this.readClaudeProviderMeta().credentialGeneration,
        }),
    )
    this.runtimeRegistry.registerPersistentAdapter(
      'gemini-api',
      overrides['gemini-api'] ??
        new GoogleGeminiApiAdapter({
          resolveApiKey: () => resolveProviderKey('gemini', () => this.readGeminiProviderMeta()),
          isExecutionAuthorized: () => this.readGeminiProviderMeta().executionAuthorized,
          getCredentialGeneration: () => this.readGeminiProviderMeta().credentialGeneration,
          getAccountRef: () => this.readGeminiProviderMeta().accountRef,
        }),
    )
    this.runtimeRegistry.registerPersistentAdapter(
      'kimi-acp',
      overrides['kimi-acp'] ?? new KimiAcpAdapter(),
    )
    this.runtimeRegistry.registerPersistentAdapter(
      'lmstudio',
      overrides.lmstudio ??
        new LmStudioLocalAdapter({
          baseUrl: this.readLocalCompatMeta('lmstudio', DEFAULT_LMSTUDIO_BASE_URL).baseUrl,
          isExecutionAuthorized: () =>
            this.readLocalCompatMeta('lmstudio', DEFAULT_LMSTUDIO_BASE_URL).executionAuthorized,
        }),
    )
    this.runtimeRegistry.registerPersistentAdapter(
      'llamacpp',
      overrides.llamacpp ??
        new LlamaCppLocalAdapter({
          baseUrl: this.readLocalCompatMeta('llamacpp', DEFAULT_LLAMACPP_BASE_URL).baseUrl,
          isExecutionAuthorized: () =>
            this.readLocalCompatMeta('llamacpp', DEFAULT_LLAMACPP_BASE_URL).executionAuthorized,
        }),
    )
    this.runtimeRegistry.registerPersistentAdapter(
      'openrouter',
      overrides.openrouter ??
        new OpenRouterApiAdapter({
          resolveApiKey: () =>
            resolveProviderKey('openrouter', () => this.readOpenRouterProviderMeta()),
          isExecutionAuthorized: () => this.readOpenRouterProviderMeta().executionAuthorized,
          getCredentialGeneration: () => this.readOpenRouterProviderMeta().credentialGeneration,
          getAccountRef: () => this.readOpenRouterProviderMeta().accountRef,
        }),
    )
  }

  private async buildProviderPolicyInput(
    runtimeId: string,
    permission: import('@ghost-bot/shared-types/runtime').PermissionMode,
    canonicalWorkspace: string,
  ): Promise<{
    policyInput: import('./runtime/policy-broker.ts').PolicyAuthorizationInput
    accountKey: string
  }> {
    const storeStatus = this.providerSecretStore?.getStatus() ?? {
      available: false,
      locked: false,
      backend: 'unavailable' as const,
      reason: 'Secret store unavailable',
    }
    if (runtimeId === 'claude-api') {
      const meta = this.readClaudeProviderMeta()
      const configured =
        storeStatus.available &&
        Boolean(
          this.providerSecretStore?.existsProviderSecret({
            ownerId: LOCAL_USER_ID,
            providerId: 'anthropic',
            accountRef: meta.accountRef,
          }),
        )
      return {
        accountKey: `claude:${meta.accountRef}:${meta.credentialGeneration}`,
        policyInput: {
          runtimeMode: 'claude-api',
          codexVersion: null,
          authMethod: 'apiKey',
          requestedPermission: permission,
          canonicalWorkspace,
          claudeExecutionAuthorized: meta.executionAuthorized,
          claudeCredentialConfigured: configured,
          claudeKeyringAvailable: storeStatus.available,
          claudeEndpointVerified: true,
        },
      }
    }
    if (runtimeId === 'gemini-api') {
      const meta = this.readGeminiProviderMeta()
      const configured =
        storeStatus.available &&
        Boolean(
          this.providerSecretStore?.existsProviderSecret({
            ownerId: LOCAL_USER_ID,
            providerId: 'gemini',
            accountRef: meta.accountRef,
          }),
        )
      return {
        accountKey: `gemini:${meta.accountRef}:${meta.credentialGeneration}`,
        policyInput: {
          runtimeMode: 'gemini-api',
          codexVersion: null,
          authMethod: 'apiKey',
          requestedPermission: permission,
          canonicalWorkspace,
          geminiExecutionAuthorized: meta.executionAuthorized,
          geminiCredentialConfigured: configured,
          geminiKeyringAvailable: storeStatus.available,
          geminiEndpointVerified: true,
        },
      }
    }
    if (runtimeId === 'openrouter') {
      const meta = this.readOpenRouterProviderMeta()
      const configured =
        storeStatus.available &&
        Boolean(
          this.providerSecretStore?.existsProviderSecret({
            ownerId: LOCAL_USER_ID,
            providerId: 'openrouter',
            accountRef: meta.accountRef,
          }),
        )
      return {
        accountKey: `openrouter:${meta.accountRef}:${meta.credentialGeneration}`,
        policyInput: {
          runtimeMode: 'openrouter',
          codexVersion: null,
          authMethod: 'apiKey',
          requestedPermission: permission,
          canonicalWorkspace,
          openRouterExecutionAuthorized: meta.executionAuthorized,
          openRouterCredentialConfigured: configured,
          openRouterKeyringAvailable: storeStatus.available,
          openRouterEndpointVerified: true,
        },
      }
    }
    if (runtimeId === 'lmstudio' || runtimeId === 'llamacpp') {
      const defaultUrl = runtimeId === 'lmstudio' ? DEFAULT_LMSTUDIO_BASE_URL : DEFAULT_LLAMACPP_BASE_URL
      const meta = this.readLocalCompatMeta(runtimeId, defaultUrl)
      const adapter = await this.runtimeRegistry.getUnifiedExecutionAdapter(runtimeId)
      const avail = await (adapter.adapter as LmStudioLocalAdapter | LlamaCppLocalAdapter)
        .checkAvailability()
        .catch(() => ({ available: false }))
      return {
        accountKey: `${runtimeId}:${meta.baseUrl}:${meta.configGeneration}`,
        policyInput: {
          runtimeMode: runtimeId,
          codexVersion: null,
          authMethod: 'none',
          requestedPermission: permission,
          canonicalWorkspace,
          localCompatAuthorized: meta.executionAuthorized,
          localCompatAvailable: avail.available,
          localCompatLoopbackVerified: true,
        },
      }
    }
    if (runtimeId === 'ollama') {
      const adapter = await this.runtimeRegistry.getUnifiedExecutionAdapter('ollama')
      const summary = await (adapter.adapter as OllamaLocalAdapter)
        .inspectLocalRuntime()
        .catch(() => ({ available: false, localOnlyVerified: false }))
      return {
        accountKey: 'ollama:local',
        policyInput: {
          runtimeMode: 'ollama',
          codexVersion: null,
          authMethod: 'none',
          requestedPermission: permission,
          canonicalWorkspace,
          ollamaExecutionAuthorized: false,
          ollamaAvailable: summary.available,
          ollamaLoopbackVerified: true,
          ollamaLocalOnlyVerified: summary.localOnlyVerified,
        },
      }
    }
    if (runtimeId === 'openclaw') {
      return {
        accountKey: 'openclaw:local',
        policyInput: {
          runtimeMode: 'openclaw',
          codexVersion: null,
          authMethod: 'none',
          requestedPermission: permission,
          canonicalWorkspace,
          openClawExecutionAuthorized: false,
          openClawLoopbackVerified: false,
          openClawSandboxVerified: false,
        },
      }
    }
    if (runtimeId === 'kimi-acp') {
      return {
        accountKey: 'kimi-acp:local',
        policyInput: {
          runtimeMode: 'kimi-acp',
          codexVersion: null,
          authMethod: 'none',
          requestedPermission: permission,
          canonicalWorkspace,
          kimiExecutionAuthorized: false,
          kimiCliAvailable: false,
          kimiAcpProtocolVerified: false,
          kimiAuthenticated: false,
          kimiContainmentVerified: false,
        },
      }
    }
    throw new DaemonError('LIVE_INFERENCE_DISABLED', `Unsupported runtime "${runtimeId}"`, {
      statusCode: 501,
    })
  }

  private readClaudeProviderMeta(): {
    accountRef: string
    maskedKeyHint: string | null
    credentialGeneration: number
    executionAuthorized: boolean
  } {
    const row = this.dbHandle?.sqlite
      .prepare(`SELECT value_json FROM settings WHERE key = 'provider.anthropic.v1'`)
      .get() as { value_json: string } | undefined
    if (!row) {
      return {
        accountRef: 'default',
        maskedKeyHint: null,
        credentialGeneration: 0,
        executionAuthorized: false,
      }
    }
    try {
      const parsed = JSON.parse(row.value_json) as Record<string, unknown>
      return {
        accountRef:
          typeof parsed.accountRef === 'string' && parsed.accountRef ? parsed.accountRef : 'default',
        maskedKeyHint: typeof parsed.maskedKeyHint === 'string' ? parsed.maskedKeyHint : null,
        credentialGeneration:
          typeof parsed.credentialGeneration === 'number' ? parsed.credentialGeneration : 0,
        executionAuthorized: parsed.executionAuthorized === true,
      }
    } catch {
      return {
        accountRef: 'default',
        maskedKeyHint: null,
        credentialGeneration: 0,
        executionAuthorized: false,
      }
    }
  }

  private writeClaudeProviderMeta(meta: {
    accountRef: string
    maskedKeyHint: string | null
    credentialGeneration: number
    executionAuthorized: boolean
  }): void {
    const nowIso = new Date().toISOString()
    this.dbHandle?.sqlite
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES ('provider.anthropic.v1', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(meta), nowIso)
  }

  private async getClaudeStatusDto(): Promise<import('@ghost-bot/shared-types/ipc').ClaudeStatusDto> {
    const meta = this.readClaudeProviderMeta()
    const store = this.providerSecretStore
    const status = store?.getStatus() ?? {
      available: false,
      locked: false,
      backend: 'unavailable' as const,
      reason: 'Secret store not initialized',
    }
    const credentialConfigured =
      status.available &&
      Boolean(
        store?.existsProviderSecret({
          ownerId: LOCAL_USER_ID,
          providerId: 'anthropic',
          accountRef: meta.accountRef,
        }),
      )
    return this.runtimeRegistry.getClaudeStatus({
      keyringAvailable: status.available,
      keyringLocked: status.locked,
      keyringReason: status.reason,
      credentialConfigured,
      accountRef: meta.accountRef,
      maskedKeyHint: credentialConfigured ? meta.maskedKeyHint : null,
      credentialGeneration: meta.credentialGeneration,
      executionAuthorized: credentialConfigured ? meta.executionAuthorized : false,
    })
  }

  private readGeminiProviderMeta(): {
    accountRef: string
    maskedKeyHint: string | null
    credentialGeneration: number
    executionAuthorized: boolean
  } {
    const row = this.dbHandle?.sqlite
      .prepare(`SELECT value_json FROM settings WHERE key = 'provider.gemini.v1'`)
      .get() as { value_json: string } | undefined
    if (!row) {
      return {
        accountRef: 'default',
        maskedKeyHint: null,
        credentialGeneration: 0,
        executionAuthorized: false,
      }
    }
    try {
      const parsed = JSON.parse(row.value_json) as Record<string, unknown>
      return {
        accountRef:
          typeof parsed.accountRef === 'string' && parsed.accountRef ? parsed.accountRef : 'default',
        maskedKeyHint: typeof parsed.maskedKeyHint === 'string' ? parsed.maskedKeyHint : null,
        credentialGeneration:
          typeof parsed.credentialGeneration === 'number' ? parsed.credentialGeneration : 0,
        executionAuthorized: parsed.executionAuthorized === true,
      }
    } catch {
      return {
        accountRef: 'default',
        maskedKeyHint: null,
        credentialGeneration: 0,
        executionAuthorized: false,
      }
    }
  }

  private writeGeminiProviderMeta(meta: {
    accountRef: string
    maskedKeyHint: string | null
    credentialGeneration: number
    executionAuthorized: boolean
  }): void {
    const nowIso = new Date().toISOString()
    this.dbHandle?.sqlite
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES ('provider.gemini.v1', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(meta), nowIso)
  }

  private async getGeminiStatusDto(): Promise<import('@ghost-bot/shared-types/ipc').GeminiStatusDto> {
    const meta = this.readGeminiProviderMeta()
    const store = this.providerSecretStore
    const status = store?.getStatus() ?? {
      available: false,
      locked: false,
      backend: 'unavailable' as const,
      reason: 'Secret store not initialized',
    }
    const credentialConfigured =
      status.available &&
      Boolean(
        store?.existsProviderSecret({
          ownerId: LOCAL_USER_ID,
          providerId: 'gemini',
          accountRef: meta.accountRef,
        }),
      )
    return this.runtimeRegistry.getGeminiStatus({
      keyringAvailable: status.available,
      keyringLocked: status.locked,
      keyringReason: status.reason,
      credentialConfigured,
      accountRef: meta.accountRef,
      maskedKeyHint: credentialConfigured ? meta.maskedKeyHint : null,
      credentialGeneration: meta.credentialGeneration,
      executionAuthorized: credentialConfigured ? meta.executionAuthorized : false,
    })
  }

  private readLocalCompatMeta(
    id: 'lmstudio' | 'llamacpp',
    defaultBaseUrl: string,
  ): { baseUrl: string; executionAuthorized: boolean; configGeneration: number } {
    const row = this.dbHandle?.sqlite
      .prepare(`SELECT value_json FROM settings WHERE key = ?`)
      .get(`provider.${id}.v1`) as { value_json: string } | undefined
    if (!row) return { baseUrl: defaultBaseUrl, executionAuthorized: false, configGeneration: 1 }
    try {
      const parsed = JSON.parse(row.value_json) as Record<string, unknown>
      const baseUrl =
        typeof parsed.baseUrl === 'string'
          ? assertLoopbackOpenAiCompatBaseUrl(parsed.baseUrl, '/v1')
          : defaultBaseUrl
      return {
        baseUrl,
        executionAuthorized: parsed.executionAuthorized === true,
        configGeneration:
          typeof parsed.configGeneration === 'number' && Number.isInteger(parsed.configGeneration)
            ? parsed.configGeneration
            : 1,
      }
    } catch {
      return { baseUrl: defaultBaseUrl, executionAuthorized: false, configGeneration: 1 }
    }
  }

  private writeLocalCompatMeta(
    id: 'lmstudio' | 'llamacpp',
    meta: { baseUrl: string; executionAuthorized: boolean; configGeneration: number },
  ): void {
    const nowIso = new Date().toISOString()
    this.dbHandle?.sqlite
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(`provider.${id}.v1`, JSON.stringify(meta), nowIso)
  }

  private readOpenRouterProviderMeta(): {
    accountRef: string
    maskedKeyHint: string | null
    credentialGeneration: number
    executionAuthorized: boolean
  } {
    const row = this.dbHandle?.sqlite
      .prepare(`SELECT value_json FROM settings WHERE key = 'provider.openrouter.v1'`)
      .get() as { value_json: string } | undefined
    if (!row) {
      return {
        accountRef: 'default',
        maskedKeyHint: null,
        credentialGeneration: 0,
        executionAuthorized: false,
      }
    }
    try {
      const parsed = JSON.parse(row.value_json) as Record<string, unknown>
      return {
        accountRef:
          typeof parsed.accountRef === 'string' && parsed.accountRef ? parsed.accountRef : 'default',
        maskedKeyHint: typeof parsed.maskedKeyHint === 'string' ? parsed.maskedKeyHint : null,
        credentialGeneration:
          typeof parsed.credentialGeneration === 'number' ? parsed.credentialGeneration : 0,
        executionAuthorized: parsed.executionAuthorized === true,
      }
    } catch {
      return {
        accountRef: 'default',
        maskedKeyHint: null,
        credentialGeneration: 0,
        executionAuthorized: false,
      }
    }
  }

  private writeOpenRouterProviderMeta(meta: {
    accountRef: string
    maskedKeyHint: string | null
    credentialGeneration: number
    executionAuthorized: boolean
  }): void {
    const nowIso = new Date().toISOString()
    this.dbHandle?.sqlite
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES ('provider.openrouter.v1', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(meta), nowIso)
  }

  private async getOpenRouterStatusDto(): Promise<import('@ghost-bot/shared-types/ipc').OpenRouterStatusDto> {
    const meta = this.readOpenRouterProviderMeta()
    const store = this.providerSecretStore
    const status = store?.getStatus() ?? {
      available: false,
      locked: false,
      backend: 'unavailable' as const,
      reason: 'Secret store not initialized',
    }
    const credentialConfigured =
      status.available &&
      Boolean(
        store?.existsProviderSecret({
          ownerId: LOCAL_USER_ID,
          providerId: 'openrouter',
          accountRef: meta.accountRef,
        }),
      )
    return this.runtimeRegistry.getOpenRouterStatus({
      keyringAvailable: status.available,
      keyringLocked: status.locked,
      keyringReason: status.reason,
      credentialConfigured,
      accountRef: meta.accountRef,
      maskedKeyHint: credentialConfigured ? meta.maskedKeyHint : null,
      credentialGeneration: meta.credentialGeneration,
      executionAuthorized: credentialConfigured ? meta.executionAuthorized : false,
    })
  }

  private async requireDiscoveryGrant(input: z.infer<typeof PersonalWorkspaceAccessSchema>): Promise<void> {
    const context = await this.workspaceFilesService?.resolveContext({ botId: input.botId })
    const grant = this.workspaceReadGrants.get(input.botId)
    if (!context?.authorized ||
        context.workspaceId !== input.workspaceId || context.authGeneration !== input.authGeneration ||
        grant?.workspaceId !== input.workspaceId || grant.authGeneration !== input.authGeneration) {
      throw new DaemonError('WORKSPACE_UNAUTHORIZED', 'Workspace authorization changed or read access has not been granted', {
        statusCode: 403,
      })
    }
  }

  async stop(): Promise<void> {
    this.workspaceDiscovery?.abortAll()
    this.workspaceDiscovery = null
    this.workspaceReadGrants.clear()
    this.workspaceGitService?.abortAll()
    this.workspaceGitService = null
    this.workspaceOutputService = null
    if (this.terminalService) {
      await this.terminalService.shutdownAll()
      this.terminalService = null
    }
    this.skillsService = null
    if (this.computerUseService) {
      await this.computerUseService.shutdownAll()
      this.computerUseService = null
    }
    if (this.schedulerService) {
      await this.schedulerService.stopTimer()
      this.schedulerService = null
    }
    if (this.runOrchestrator) {
      await this.runOrchestrator.stop()
      this.runOrchestrator = null
    }
    await this.runtimeRegistry.stop()
    if (this.server) {
      const srv = this.server
      this.server = null
      await new Promise<void>((resolve) => srv.close(() => resolve()))
    }
    this.botRepo = null
    this.settingsRepo = null
    this.sessionRepo = null
    this.workspaceFilesService = null
    if (this.memoryService) {
      this.memoryService.close()
      this.memoryService = null
    }
    if (this.knowledgeService) {
      this.knowledgeService.close()
      this.knowledgeService = null
    }
    if (this.mcpService) {
      await this.mcpService.close()
      this.mcpService = null
    }
    if (this.dbHandle) {
      this.dbHandle.close()
      this.dbHandle = null
    }
    if (this.lockFilePath) {
      const p = this.lockFilePath
      this.lockFilePath = null
      ACTIVE_DAEMON_LOCKS.delete(p)
      await unlink(p).catch(() => undefined)
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!constantTimeTokenMatch(req.headers.authorization, this.options.authToken)) {
        throw new DaemonError('UNAUTHORIZED', 'Missing or invalid daemon auth token', {
          statusCode: 401,
        })
      }

      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.method === 'GET' && url.pathname === '/health') {
        const body: DaemonHealthResponse = {
          ok: true,
          pid: process.pid,
          uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
          runtimeMode: this.runtimeMode,
        }
        sendJson(res, 200, body)
        return
      }

      if (req.method === 'GET' && url.pathname === '/providers') {
        const providers = await this.runtimeRegistry.listProviders()
        sendJson(res, 200, providers)
        return
      }

      if (req.method === 'GET' && url.pathname === '/openclaw/status') {
        sendJson(res, 200, await this.runtimeRegistry.getOpenClawStatus())
        return
      }

      if (req.method === 'GET' && url.pathname === '/ollama/status') {
        sendJson(res, 200, await this.runtimeRegistry.getOllamaStatus())
        return
      }

      if (req.method === 'GET' && url.pathname === '/kimi/status') {
        sendJson(res, 200, await this.runtimeRegistry.getKimiStatus())
        return
      }

      if (req.method === 'GET' && url.pathname === '/lmstudio/status') {
        const meta = this.readLocalCompatMeta('lmstudio', DEFAULT_LMSTUDIO_BASE_URL)
        sendJson(
          res,
          200,
          await this.runtimeRegistry.getLocalOpenAiCompatStatus({
            id: 'lmstudio',
            baseUrl: meta.baseUrl,
            executionAuthorized: meta.executionAuthorized,
          }),
        )
        return
      }

      if (req.method === 'PUT' && url.pathname === '/lmstudio/config') {
        const body = await readJsonBody(req)
        const parsed = SetLocalCompatConfigInputSchema.safeParse(body)
        if (!parsed.success) {
          throw new DaemonError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid LM Studio config', {
            statusCode: 400,
          })
        }
        let validatedUrl: string
        try {
          validatedUrl = assertLoopbackOpenAiCompatBaseUrl(parsed.data.baseUrl, '/v1')
        } catch (err) {
          throw new DaemonError('VALIDATION_ERROR', err instanceof Error ? err.message : 'Invalid loopback URL', {
            statusCode: 400,
          })
        }
        const prev = this.readLocalCompatMeta('lmstudio', DEFAULT_LMSTUDIO_BASE_URL)
        const nextAuth =
          validatedUrl !== prev.baseUrl ? false : (parsed.data.executionAuthorized ?? prev.executionAuthorized)
        const nextGen = validatedUrl !== prev.baseUrl ? prev.configGeneration + 1 : prev.configGeneration
        this.writeLocalCompatMeta('lmstudio', {
          baseUrl: validatedUrl,
          executionAuthorized: nextAuth,
          configGeneration: nextGen,
        })
        const lmPersistent = this.runtimeRegistry.getPersistentAdapter<LmStudioLocalAdapter>('lmstudio')
        lmPersistent?.updateBaseUrl(validatedUrl)
        if (validatedUrl !== prev.baseUrl || !nextAuth) {
          this.runtimeRegistry.abortProviderRuns('lmstudio')
        }
        sendJson(
          res,
          200,
          await this.runtimeRegistry.getLocalOpenAiCompatStatus({
            id: 'lmstudio',
            baseUrl: validatedUrl,
            executionAuthorized: nextAuth,
          }),
        )
        return
      }

      if (req.method === 'GET' && url.pathname === '/llamacpp/status') {
        const meta = this.readLocalCompatMeta('llamacpp', DEFAULT_LLAMACPP_BASE_URL)
        sendJson(
          res,
          200,
          await this.runtimeRegistry.getLocalOpenAiCompatStatus({
            id: 'llamacpp',
            baseUrl: meta.baseUrl,
            executionAuthorized: meta.executionAuthorized,
          }),
        )
        return
      }

      if (req.method === 'PUT' && url.pathname === '/llamacpp/config') {
        const body = await readJsonBody(req)
        const parsed = SetLocalCompatConfigInputSchema.safeParse(body)
        if (!parsed.success) {
          throw new DaemonError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid llama.cpp config', {
            statusCode: 400,
          })
        }
        let validatedUrl: string
        try {
          validatedUrl = assertLoopbackOpenAiCompatBaseUrl(parsed.data.baseUrl, '/v1')
        } catch (err) {
          throw new DaemonError('VALIDATION_ERROR', err instanceof Error ? err.message : 'Invalid loopback URL', {
            statusCode: 400,
          })
        }
        const prev = this.readLocalCompatMeta('llamacpp', DEFAULT_LLAMACPP_BASE_URL)
        const nextAuth =
          validatedUrl !== prev.baseUrl ? false : (parsed.data.executionAuthorized ?? prev.executionAuthorized)
        const nextGen = validatedUrl !== prev.baseUrl ? prev.configGeneration + 1 : prev.configGeneration
        this.writeLocalCompatMeta('llamacpp', {
          baseUrl: validatedUrl,
          executionAuthorized: nextAuth,
          configGeneration: nextGen,
        })
        const llamaPersistent =
          this.runtimeRegistry.getPersistentAdapter<LlamaCppLocalAdapter>('llamacpp')
        llamaPersistent?.updateBaseUrl(validatedUrl)
        if (validatedUrl !== prev.baseUrl || !nextAuth) {
          this.runtimeRegistry.abortProviderRuns('llamacpp')
        }
        sendJson(
          res,
          200,
          await this.runtimeRegistry.getLocalOpenAiCompatStatus({
            id: 'llamacpp',
            baseUrl: validatedUrl,
            executionAuthorized: nextAuth,
          }),
        )
        return
      }

      if (req.method === 'GET' && url.pathname === '/openrouter/status') {
        sendJson(res, 200, await this.getOpenRouterStatusDto())
        return
      }

      if (req.method === 'PUT' && url.pathname === '/openrouter/credential') {
        const body = await readJsonBody(req)
        const parsed = SetOpenRouterCredentialInputSchema.safeParse(body)
        if (!parsed.success) {
          throw new DaemonError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid OpenRouter key', {
            statusCode: 400,
          })
        }
        const apiKey = parsed.data.apiKey.trim()
        if (!apiKey || apiKey.includes('\0') || /\s/.test(apiKey)) {
          throw new DaemonError('VALIDATION_ERROR', 'OpenRouter API key format is invalid', { statusCode: 400 })
        }
        const store = this.providerSecretStore
        if (!store) {
          throw new DaemonError('SECRET_STORE_UNAVAILABLE', 'Secret store not initialized', { statusCode: 503 })
        }
        const status = store.getStatus()
        if (!status.available) {
          throw new DaemonError(
            status.locked ? 'KEYRING_LOCKED' : 'SECRET_STORE_UNAVAILABLE',
            status.reason ?? 'OS Secret Service is unavailable or locked',
            { statusCode: 503 },
          )
        }
        const prevMeta = this.readOpenRouterProviderMeta()
        const accountRef = parsed.data.accountRef
        if (prevMeta.accountRef !== accountRef) {
          store.deleteProviderSecret({
            ownerId: LOCAL_USER_ID,
            providerId: 'openrouter',
            accountRef: prevMeta.accountRef,
          })
        }
        store.storeProviderSecret(
          { ownerId: LOCAL_USER_ID, providerId: 'openrouter', accountRef },
          `Ghost Bot OpenRouter API (${accountRef})`,
          apiKey,
        )
        const maskedKeyHint =
          apiKey.length >= 10
            ? `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`
            : `...${apiKey.slice(-4)}`
        this.writeOpenRouterProviderMeta({
          accountRef,
          maskedKeyHint,
          credentialGeneration: prevMeta.credentialGeneration + 1,
          executionAuthorized: false,
        })
        this.runtimeRegistry.abortProviderRuns('openrouter')
        sendJson(res, 200, await this.getOpenRouterStatusDto())
        return
      }

      if (req.method === 'DELETE' && url.pathname === '/openrouter/credential') {
        const store = this.providerSecretStore
        if (!store) {
          throw new DaemonError('SECRET_STORE_UNAVAILABLE', 'Secret store not initialized', { statusCode: 503 })
        }
        const status = store.getStatus()
        if (!status.available) {
          throw new DaemonError(
            status.locked ? 'KEYRING_LOCKED' : 'SECRET_STORE_UNAVAILABLE',
            status.reason ?? 'OS Secret Service is unavailable or locked',
            { statusCode: 503 },
          )
        }
        const prevMeta = this.readOpenRouterProviderMeta()
        store.deleteProviderSecret({
          ownerId: LOCAL_USER_ID,
          providerId: 'openrouter',
          accountRef: prevMeta.accountRef,
        })
        this.writeOpenRouterProviderMeta({
          accountRef: prevMeta.accountRef,
          maskedKeyHint: null,
          credentialGeneration: prevMeta.credentialGeneration + 1,
          executionAuthorized: false,
        })
        this.runtimeRegistry.abortProviderRuns('openrouter')
        sendJson(res, 200, await this.getOpenRouterStatusDto())
        return
      }

      if (req.method === 'PUT' && url.pathname === '/openrouter/authorization') {
        const body = await readJsonBody(req)
        const parsed = SetOpenRouterAuthInputSchema.safeParse(body)
        if (!parsed.success) {
          throw new DaemonError('VALIDATION_ERROR', 'Invalid authorization payload', { statusCode: 400 })
        }
        const meta = this.readOpenRouterProviderMeta()
        const store = this.providerSecretStore
        const storeStatus = store?.getStatus() ?? {
          available: false,
          locked: false,
          backend: 'unavailable' as const,
          reason: 'Secret store not initialized',
        }
        if (parsed.data.authorized) {
          if (!storeStatus.available) {
            throw new DaemonError(
              storeStatus.locked ? 'KEYRING_LOCKED' : 'SECRET_STORE_UNAVAILABLE',
              storeStatus.reason ?? 'OS Secret Service is unavailable or locked',
              { statusCode: 503 },
            )
          }
          const exists = store!.existsProviderSecret({
            ownerId: LOCAL_USER_ID,
            providerId: 'openrouter',
            accountRef: meta.accountRef,
          })
          if (!exists) {
            throw new DaemonError(
              'OPENROUTER_CREDENTIAL_MISSING',
              'Configure an OpenRouter API key before authorizing execution',
              { statusCode: 400 },
            )
          }
        }
        this.writeOpenRouterProviderMeta({
          ...meta,
          executionAuthorized: parsed.data.authorized,
        })
        if (!parsed.data.authorized) {
          this.runtimeRegistry.abortProviderRuns('openrouter')
        }
        sendJson(res, 200, await this.getOpenRouterStatusDto())
        return
      }

      if (req.method === 'GET' && url.pathname === '/claude/status') {
        sendJson(res, 200, await this.getClaudeStatusDto())
        return
      }

      if (req.method === 'PUT' && url.pathname === '/claude/credential') {
        const body = await readJsonBody(req)
        const parsed = SetClaudeCredentialInputSchema.safeParse(body)
        if (!parsed.success) {
          throw new DaemonError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid credential payload', {
            statusCode: 400,
          })
        }
        const apiKey = parsed.data.apiKey.trim()
        if (!apiKey || apiKey.includes('\0') || /\s/.test(apiKey)) {
          throw new DaemonError('VALIDATION_ERROR', 'Anthropic API key format is invalid', {
            statusCode: 400,
          })
        }
        const store = this.providerSecretStore
        if (!store) {
          throw new DaemonError('SECRET_STORE_UNAVAILABLE', 'Secret store not initialized', { statusCode: 503 })
        }
        const status = store.getStatus()
        if (!status.available) {
          throw new DaemonError(
            status.locked ? 'KEYRING_LOCKED' : 'SECRET_STORE_UNAVAILABLE',
            status.reason ?? 'OS Secret Service is unavailable or locked',
            { statusCode: 503 },
          )
        }
        const prevMeta = this.readClaudeProviderMeta()
        const accountRef = parsed.data.accountRef
        if (prevMeta.accountRef !== accountRef) {
          store.deleteProviderSecret({
            ownerId: LOCAL_USER_ID,
            providerId: 'anthropic',
            accountRef: prevMeta.accountRef,
          })
        }
        store.storeProviderSecret(
          { ownerId: LOCAL_USER_ID, providerId: 'anthropic', accountRef },
          `Ghost Bot Anthropic API (${accountRef})`,
          apiKey,
        )
        const maskedKeyHint =
          apiKey.length >= 10
            ? `${apiKey.slice(0, 7)}...${apiKey.slice(-4)}`
            : `...${apiKey.slice(-4)}`
        this.writeClaudeProviderMeta({
          accountRef,
          maskedKeyHint,
          credentialGeneration: prevMeta.credentialGeneration + 1,
          executionAuthorized: false,
        })
        this.runtimeRegistry.abortProviderRuns('claude-api')
        sendJson(res, 200, await this.getClaudeStatusDto())
        return
      }

      if (req.method === 'DELETE' && url.pathname === '/claude/credential') {
        const store = this.providerSecretStore
        if (!store) {
          throw new DaemonError('SECRET_STORE_UNAVAILABLE', 'Secret store not initialized', { statusCode: 503 })
        }
        const status = store.getStatus()
        if (!status.available) {
          throw new DaemonError(
            status.locked ? 'KEYRING_LOCKED' : 'SECRET_STORE_UNAVAILABLE',
            status.reason ?? 'OS Secret Service is unavailable or locked',
            { statusCode: 503 },
          )
        }
        const prevMeta = this.readClaudeProviderMeta()
        store.deleteProviderSecret({
          ownerId: LOCAL_USER_ID,
          providerId: 'anthropic',
          accountRef: prevMeta.accountRef,
        })
        this.writeClaudeProviderMeta({
          accountRef: prevMeta.accountRef,
          maskedKeyHint: null,
          credentialGeneration: prevMeta.credentialGeneration + 1,
          executionAuthorized: false,
        })
        this.runtimeRegistry.abortProviderRuns('claude-api')
        sendJson(res, 200, await this.getClaudeStatusDto())
        return
      }

      if (req.method === 'PUT' && url.pathname === '/claude/authorization') {
        const body = await readJsonBody(req)
        const parsed = SetClaudeAuthInputSchema.safeParse(body)
        if (!parsed.success) {
          throw new DaemonError('VALIDATION_ERROR', 'Invalid authorization payload', { statusCode: 400 })
        }
        const meta = this.readClaudeProviderMeta()
        const store = this.providerSecretStore
        const storeStatus = store?.getStatus() ?? {
          available: false,
          locked: false,
          backend: 'unavailable' as const,
          reason: 'Secret store not initialized',
        }
        if (parsed.data.authorized) {
          if (!storeStatus.available) {
            throw new DaemonError(
              storeStatus.locked ? 'KEYRING_LOCKED' : 'SECRET_STORE_UNAVAILABLE',
              storeStatus.reason ?? 'OS Secret Service is unavailable or locked',
              { statusCode: 503 },
            )
          }
          const exists = store!.existsProviderSecret({
            ownerId: LOCAL_USER_ID,
            providerId: 'anthropic',
            accountRef: meta.accountRef,
          })
          if (!exists) {
            throw new DaemonError(
              'CLAUDE_CREDENTIAL_MISSING',
              'Configure an Anthropic API key before authorizing execution',
              { statusCode: 400 },
            )
          }
        }
        this.writeClaudeProviderMeta({
          ...meta,
          executionAuthorized: parsed.data.authorized,
        })
        if (!parsed.data.authorized) {
          this.runtimeRegistry.abortProviderRuns('claude-api')
        }
        sendJson(res, 200, await this.getClaudeStatusDto())
        return
      }

      if (req.method === 'GET' && url.pathname === '/gemini/status') {
        sendJson(res, 200, await this.getGeminiStatusDto())
        return
      }

      if (req.method === 'PUT' && url.pathname === '/gemini/credential') {
        const body = await readJsonBody(req)
        const parsed = SetGeminiCredentialInputSchema.safeParse(body)
        if (!parsed.success) {
          throw new DaemonError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid credential payload', {
            statusCode: 400,
          })
        }
        const apiKey = parsed.data.apiKey.trim()
        if (!apiKey || apiKey.includes('\0') || /\s/.test(apiKey)) {
          throw new DaemonError('VALIDATION_ERROR', 'Gemini API key format is invalid', {
            statusCode: 400,
          })
        }
        const store = this.providerSecretStore
        if (!store) {
          throw new DaemonError('SECRET_STORE_UNAVAILABLE', 'Secret store not initialized', { statusCode: 503 })
        }
        const status = store.getStatus()
        if (!status.available) {
          throw new DaemonError(
            status.locked ? 'KEYRING_LOCKED' : 'SECRET_STORE_UNAVAILABLE',
            status.reason ?? 'OS Secret Service is unavailable or locked',
            { statusCode: 503 },
          )
        }
        const prevMeta = this.readGeminiProviderMeta()
        const accountRef = parsed.data.accountRef
        if (prevMeta.accountRef !== accountRef) {
          store.deleteProviderSecret({
            ownerId: LOCAL_USER_ID,
            providerId: 'gemini',
            accountRef: prevMeta.accountRef,
          })
        }
        store.storeProviderSecret(
          { ownerId: LOCAL_USER_ID, providerId: 'gemini', accountRef },
          `Ghost Bot Gemini API (${accountRef})`,
          apiKey,
        )
        const maskedKeyHint =
          apiKey.length >= 10
            ? `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}`
            : `...${apiKey.slice(-4)}`
        this.writeGeminiProviderMeta({
          accountRef,
          maskedKeyHint,
          credentialGeneration: prevMeta.credentialGeneration + 1,
          executionAuthorized: false,
        })
        this.runtimeRegistry.abortProviderRuns('gemini-api')
        sendJson(res, 200, await this.getGeminiStatusDto())
        return
      }

      if (req.method === 'DELETE' && url.pathname === '/gemini/credential') {
        const store = this.providerSecretStore
        if (!store) {
          throw new DaemonError('SECRET_STORE_UNAVAILABLE', 'Secret store not initialized', { statusCode: 503 })
        }
        const status = store.getStatus()
        if (!status.available) {
          throw new DaemonError(
            status.locked ? 'KEYRING_LOCKED' : 'SECRET_STORE_UNAVAILABLE',
            status.reason ?? 'OS Secret Service is unavailable or locked',
            { statusCode: 503 },
          )
        }
        const prevMeta = this.readGeminiProviderMeta()
        store.deleteProviderSecret({
          ownerId: LOCAL_USER_ID,
          providerId: 'gemini',
          accountRef: prevMeta.accountRef,
        })
        this.writeGeminiProviderMeta({
          accountRef: prevMeta.accountRef,
          maskedKeyHint: null,
          credentialGeneration: prevMeta.credentialGeneration + 1,
          executionAuthorized: false,
        })
        this.runtimeRegistry.abortProviderRuns('gemini-api')
        sendJson(res, 200, await this.getGeminiStatusDto())
        return
      }

      if (req.method === 'PUT' && url.pathname === '/gemini/authorization') {
        const body = await readJsonBody(req)
        const parsed = SetGeminiAuthInputSchema.safeParse(body)
        if (!parsed.success) {
          throw new DaemonError('VALIDATION_ERROR', 'Invalid authorization payload', { statusCode: 400 })
        }
        const meta = this.readGeminiProviderMeta()
        const store = this.providerSecretStore
        const storeStatus = store?.getStatus() ?? {
          available: false,
          locked: false,
          backend: 'unavailable' as const,
          reason: 'Secret store not initialized',
        }
        if (parsed.data.authorized) {
          if (!storeStatus.available) {
            throw new DaemonError(
              storeStatus.locked ? 'KEYRING_LOCKED' : 'SECRET_STORE_UNAVAILABLE',
              storeStatus.reason ?? 'OS Secret Service is unavailable or locked',
              { statusCode: 503 },
            )
          }
          const exists = store!.existsProviderSecret({
            ownerId: LOCAL_USER_ID,
            providerId: 'gemini',
            accountRef: meta.accountRef,
          })
          if (!exists) {
            throw new DaemonError(
              'GEMINI_CREDENTIAL_MISSING',
              'Configure a Gemini API key before authorizing execution',
              { statusCode: 400 },
            )
          }
        }
        this.writeGeminiProviderMeta({
          ...meta,
          executionAuthorized: parsed.data.authorized,
        })
        if (!parsed.data.authorized) {
          this.runtimeRegistry.abortProviderRuns('gemini-api')
        }
        sendJson(res, 200, await this.getGeminiStatusDto())
        return
      }

      if (req.method === 'GET' && url.pathname === '/runtime/snapshot') {
        const refresh = url.searchParams.get('refresh') === '1'
        const snap = await this.runtimeRegistry.getSnapshot(refresh)
        sendJson(res, 200, snap)
        return
      }

      if (req.method === 'POST' && url.pathname === '/runtime/reconnect') {
        const snap = await this.runtimeRegistry.reconnect()
        if (this.runOrchestrator) {
          await this.runOrchestrator.reconnectRuntime()
        }
        sendJson(res, 200, snap)
        return
      }

      const settingsRepo = this.settingsRepo
      if (settingsRepo) {
        if (req.method === 'GET' && url.pathname === '/settings') {
          sendJson(res, 200, settingsRepo.getSettings())
          return
        }
        if (req.method === 'PATCH' && url.pathname === '/settings') {
          const body = await readJsonBody(req)
          const parsed = AppSettingsPatchSchema.safeParse(body)
          if (!parsed.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid settings patch', { statusCode: 400 })
          }
          sendJson(res, 200, settingsRepo.updateSettings(parsed.data))
          return
        }
        if (req.method === 'POST' && url.pathname === '/settings/reset') {
          sendJson(res, 200, settingsRepo.resetSettings())
          return
        }
        if (req.method === 'POST' && url.pathname === '/settings/migrate-local') {
          const body = await readJsonBody(req)
          const parsed = AppearanceSettingsSchema.partial().safeParse(body)
          if (!parsed.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid legacy settings payload', {
              statusCode: 400,
            })
          }
          sendJson(res, 200, settingsRepo.migrateLegacyAppearance(parsed.data))
          return
        }
      }

      const repo = this.botRepo
      if (!repo) {
        throw new DaemonError('DB_UNAVAILABLE', 'Database repository is not initialized', {
          statusCode: 503,
        })
      }

      if (req.method === 'GET' && url.pathname === '/bots') {
        sendJson(res, 200, repo.listBots())
        return
      }

      if (req.method === 'POST' && url.pathname === '/bots') {
        const body = await readJsonBody(req)
        const parsed = CreateBotInputSchema.safeParse(body)
        if (!parsed.success) {
          throw new DaemonError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid bot input', {
            statusCode: 400,
          })
        }
        sendJson(res, 201, await repo.createBot(parsed.data))
        return
      }

      const dupMatch = /^\/bots\/([^/]+)\/duplicate$/.exec(url.pathname)
      if (req.method === 'POST' && dupMatch) {
        const id = BotIdSchema.parse(decodeURIComponent(dupMatch[1]))
        sendJson(res, 201, await repo.duplicateBot(id))
        return
      }

      const botMatch = /^\/bots\/([^/]+)$/.exec(url.pathname)
      if (botMatch) {
        const idCheck = BotIdSchema.safeParse(decodeURIComponent(botMatch[1]))
        if (!idCheck.success) {
          throw new DaemonError('VALIDATION_ERROR', 'Invalid bot identifier', { statusCode: 400 })
        }
        if (req.method === 'PATCH') {
          const body = await readJsonBody(req)
          const parsed = UpdateBotInputSchema.safeParse({ id: idCheck.data, patch: body })
          if (!parsed.success) {
            throw new DaemonError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid bot patch', {
              statusCode: 400,
            })
          }
          const updatedBot = await repo.updateBot(parsed.data)
          this.workspaceDiscovery?.abortForBot(idCheck.data)
          if (parsed.data.patch.workspacePath !== undefined || parsed.data.patch.permission !== undefined) {
            this.workspaceReadGrants.delete(idCheck.data)
          }
          if (parsed.data.patch.permission === 'read-only' || parsed.data.patch.workspacePath) {
            await this.terminalService?.revokeByBotId(idCheck.data, 'bot_policy_updated').catch(() => {})
          }
          sendJson(res, 200, updatedBot)
          return
        }
        if (req.method === 'DELETE') {
          let archivedMcpIds: string[] = []
          const result = repo.deleteBot(idCheck.data, {
            onArchiveBot: (botId, now) => {
              this.memoryService?.archiveMemoriesForBotInTx(botId, now)
              this.knowledgeService?.archiveKnowledgeForBotInTx(botId, now)
              this.sidebarRepo?.pruneBotInTx(botId, now)
              this.sessionRepo?.pruneReadStateForBotInTx(botId, now)
              if (this.mcpService) {
                archivedMcpIds = this.mcpService.archiveMcpForBotInTx(botId)
              }
            },
          })
          this.workspaceReadGrants.delete(idCheck.data)
          this.workspaceDiscovery?.abortForBot(idCheck.data)
          await this.terminalService?.revokeByBotId(idCheck.data, 'bot_deleted').catch(() => {})
          if (this.mcpService && archivedMcpIds.length > 0) {
            await this.mcpService.invalidateBotConnections(archivedMcpIds)
          }
          sendJson(res, 200, result)
          return
        }
      }

      if (req.method === 'PUT' && url.pathname === '/settings/active-bot') {
        const body = await readJsonBody(req)
        const parsed = SetActiveBotParamsSchema.safeParse(body)
        if (!parsed.success) {
          throw new DaemonError('VALIDATION_ERROR', 'Invalid activeBotId payload', {
            statusCode: 400,
          })
        }
        sendJson(res, 200, repo.setActiveBot(parsed.data.id))
        return
      }

      if (this.sidebarRepo) {
        if (req.method === 'GET' && url.pathname === '/sidebar/organization') {
          sendJson(res, 200, this.sidebarRepo.getOrganization())
          return
        }
        if (req.method === 'PUT' && url.pathname === '/sidebar/organization') {
          const body = await readJsonBody(req)
          const parsed = UpdateSidebarOrganizationInputSchema.safeParse(body)
          if (!parsed.success) {
            throw new DaemonError(
              'VALIDATION_ERROR',
              parsed.error.issues[0]?.message ?? 'Invalid sidebar organization payload',
              { statusCode: 400 },
            )
          }
          sendJson(res, 200, this.sidebarRepo.updateOrganization(parsed.data))
          return
        }
      }

      if (req.method === 'POST' && url.pathname === '/avatars/import-svg') {
        const body = await readJsonBody(req)
        const parsed = ImportAvatarSvgInputSchema.safeParse(body)
        if (!parsed.success) {
          throw new DaemonError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid SVG payload', {
            statusCode: 400,
          })
        }
        const sanitized = sanitizeCustomSvg(parsed.data.rawSvg)
        if (!sanitized.ok) {
          throw new DaemonError('INVALID_AVATAR', sanitized.reason, { statusCode: 400 })
        }
        sendJson(res, 200, {
          svgDataUrl: sanitized.dataUrl,
          label: parsed.data.label,
        })
        return
      }

      const workspaceGit = this.workspaceGitService
      if (workspaceGit && req.method === 'POST') {
        if (url.pathname === '/workspace/git/inspect') {
          const input = await readWorkspaceRequest(req, WorkspaceGitInspectSchema)
          const cancellation = new AbortController()
          const onClose = () => cancellation.abort()
          res.once('close', onClose)
          try {
            sendJson(res, 200, await workspaceGit.inspect(input, cancellation.signal))
          } finally {
            res.off('close', onClose)
          }
          return
        }
        if (url.pathname === '/workspace/git/cancel') {
          const input = await readWorkspaceRequest(req, WorkspaceGitOperationSchema)
          sendJson(res, 200, await workspaceGit.cancel(input))
          return
        }
      }

      const workspaceOutput = this.workspaceOutputService
      if (workspaceOutput && req.method === 'POST') {
        if (url.pathname === '/workspace/output/list') {
          const body = await readJsonBody(req)
          sendJson(res, 200, workspaceOutput.listOutput(body))
          return
        }
        if (url.pathname === '/workspace/output/cancel') {
          const body = await readJsonBody(req)
          const result = await workspaceOutput.cancelExecution(body, {
            cancelRun: async (runId) => {
              if (!orchestrator) {
                throw new DaemonError('DAEMON_NOT_READY', 'Orchestrator unavailable', {
                  statusCode: 503,
                })
              }
              await orchestrator.cancelRun(runId)
            },
            cancelTerminalCommand: this.terminalService
              ? async (commandId) => {
                  await this.terminalService!.cancelCommand(commandId)
                }
              : undefined,
          })
          sendJson(res, 200, result)
          return
        }
      }

      if (this.workspaceFilesService) {
        // Only Electron main has the daemon credential and can submit the native dialog result.
        if (req.method === 'POST' && url.pathname === '/workspace/authorize-read') {
          const { botId, workspaceId, selectedRoot } = await readWorkspaceRequest(req, WorkspaceReadGrantSchema)
          const root = await realpath(selectedRoot).catch(() => null)
          const context = await this.workspaceFilesService.resolveContext({ botId })
          if (
            !context.authorized ||
            context.workspaceId !== workspaceId ||
            !context.authGeneration ||
            !root ||
            root !== context.canonicalRoot
          ) {
            throw new DaemonError('WORKSPACE_UNAUTHORIZED', 'Select the configured bot workspace directory', {
              statusCode: 403,
            })
          }
          this.workspaceReadGrants.set(botId, { workspaceId, authGeneration: context.authGeneration })
          sendJson(res, 200, true)
          return
        }

        if (req.method === 'POST' && url.pathname === '/workspace/context') {
          const selector = await readWorkspaceRequest(req, WorkspaceSelectorIpcSchema)
          if (selector.teamId) {
            throw new DaemonError('WORKSPACE_UNAUTHORIZED', 'Group workspace requires an authorized task scope', {
              statusCode: 403,
            })
          }
          const context = await this.workspaceFilesService.resolveContext(selector)
          const grant = this.workspaceReadGrants.get(context.ownerId)
          const authorized = context.authorized &&
            grant !== undefined &&
            grant.workspaceId === context.workspaceId &&
            grant.authGeneration === context.authGeneration
          sendJson(res, 200, {
            ...context,
            authorized,
            canWrite: false,
            authGeneration: authorized ? context.authGeneration : null,
            reason: authorized ? null : context.reason ?? 'Allow read access to this bot workspace',
          })
          return
        }
        if (req.method === 'POST' && url.pathname === '/workspace/list') {
          const input = await readWorkspaceRequest(req, WorkspaceListDirectoryIpcInputSchema)
          if (input.teamId) {
            throw new DaemonError('WORKSPACE_UNAUTHORIZED', 'Group workspace requires an authorized task scope', {
              statusCode: 403,
            })
          }
          const grant = input.botId ? this.workspaceReadGrants.get(input.botId) : undefined
          if (grant?.workspaceId !== input.workspaceId || grant.authGeneration !== input.authGeneration) {
            throw new DaemonError('WORKSPACE_UNAUTHORIZED', 'Workspace authorization changed or read access has not been granted', {
              statusCode: 403,
            })
          }
          const result = await this.workspaceFilesService.listDirectory(input)
          sendJson(res, 200, result)
          return
        }
        if (req.method === 'POST' && url.pathname === '/workspace/read') {
          const input = await readWorkspaceRequest(req, WorkspaceReadFileIpcInputSchema)
          if (input.teamId) {
            throw new DaemonError('WORKSPACE_UNAUTHORIZED', 'Group workspace requires an authorized task scope', {
              statusCode: 403,
            })
          }
          const grant = input.botId ? this.workspaceReadGrants.get(input.botId) : undefined
          if (grant?.workspaceId !== input.workspaceId || grant.authGeneration !== input.authGeneration) {
            throw new DaemonError('WORKSPACE_UNAUTHORIZED', 'Workspace authorization changed or read access has not been granted', {
              statusCode: 403,
            })
          }
          const result = await this.workspaceFilesService.readFile(input)
          sendJson(res, 200, { ...result, readOnly: true })
          return
        }
        const discovery = this.workspaceDiscovery
        if (req.method === 'POST' && discovery) {
          if (url.pathname === '/workspace/cancel-discovery') {
            const input = await readWorkspaceRequest(req, WorkspaceDiscoveryOperationSchema)
            sendJson(res, 200, await discovery.cancel(input))
            return
          }
          if (url.pathname === '/workspace/search' || url.pathname === '/workspace/preview') {
            const controller = new AbortController()
            const abort = () => controller.abort()
            res.once('close', abort)
            try {
              const result = url.pathname === '/workspace/search'
                ? await discovery.search(await readWorkspaceRequest(req, WorkspaceSearchInputSchema), controller.signal)
                : await discovery.preview(await readWorkspaceRequest(req, WorkspacePreviewInputSchema), controller.signal)
              if (!res.destroyed) sendJson(res, 200, result)
            } catch (error) {
              if (!res.destroyed) {
                if (error instanceof Error && error.name === 'AbortError') {
                  throw new DaemonError('DISCOVERY_CANCELLED', 'Workspace operation was cancelled', { statusCode: 409 })
                }
                throw error
              }
            } finally {
              res.off('close', abort)
            }
            return
          }
        }
        if (req.method === 'POST' && url.pathname === '/workspace/save') {
          throw new DaemonError('WORKSPACE_WRITES_DISABLED', 'Workspace file saving is disabled pending write-boundary verification', {
            statusCode: 403,
          })
        }
      }

      const sessionRepo = this.sessionRepo
      const orchestrator = this.runOrchestrator
      if (sessionRepo && orchestrator) {
        if (req.method === 'GET' && url.pathname === '/sessions') {
          const agentIdCheck = BotIdSchema.safeParse(url.searchParams.get('agentId') ?? '')
          if (!agentIdCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Valid agentId query parameter is required', {
              statusCode: 400,
            })
          }
          const limitRaw = url.searchParams.get('limit')
          const offsetRaw = url.searchParams.get('offset')
          const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined
          const offset = offsetRaw ? Number.parseInt(offsetRaw, 10) : undefined
          sendJson(res, 200, sessionRepo.listSessions(agentIdCheck.data, { limit, offset }))
          return
        }

        if (req.method === 'POST' && url.pathname === '/sessions') {
          const body = await readJsonBody(req)
          const parsed = CreateSessionInputSchema.safeParse(body)
          if (!parsed.success) {
            throw new DaemonError(
              'VALIDATION_ERROR',
              parsed.error.issues[0]?.message ?? 'Invalid session create payload',
              { statusCode: 400 },
            )
          }
          sendJson(res, 201, sessionRepo.createSession(parsed.data))
          return
        }

        if (req.method === 'PUT' && url.pathname === '/settings/active-session') {
          const body = await readJsonBody(req)
          const parsed = SetActiveSessionInputSchema.safeParse(body)
          if (!parsed.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid active session payload', {
              statusCode: 400,
            })
          }
          sendJson(
            res,
            200,
            sessionRepo.setActiveSessionId(parsed.data.agentId, parsed.data.sessionId),
          )
          return
        }

        const sessionMessagesMatch = /^\/sessions\/([^/]+)\/messages$/.exec(url.pathname)
        if (req.method === 'GET' && sessionMessagesMatch) {
          const idCheck = SessionIdSchema.safeParse(decodeURIComponent(sessionMessagesMatch[1]))
          if (!idCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid session identifier', {
              statusCode: 400,
            })
          }
          const limitRaw = url.searchParams.get('limit')
          const offsetRaw = url.searchParams.get('offset')
          const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined
          const offset = offsetRaw ? Number.parseInt(offsetRaw, 10) : undefined
          sendJson(res, 200, sessionRepo.getSessionMessages(idCheck.data, { limit, offset }))
          return
        }

        const sessionArchiveMatch = /^\/sessions\/([^/]+)\/archive$/.exec(url.pathname)
        if (req.method === 'POST' && sessionArchiveMatch) {
          const idCheck = SessionIdSchema.safeParse(decodeURIComponent(sessionArchiveMatch[1]))
          if (!idCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid session identifier', {
              statusCode: 400,
            })
          }
          sendJson(res, 200, sessionRepo.archiveSession(idCheck.data))
          return
        }

        const sessionReadMatch = /^\/sessions\/([^/]+)\/read$/.exec(url.pathname)
        if (req.method === 'POST' && sessionReadMatch) {
          const idCheck = SessionIdSchema.safeParse(decodeURIComponent(sessionReadMatch[1]))
          if (!idCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid session identifier', {
              statusCode: 400,
            })
          }
          sendJson(res, 200, sessionRepo.markSessionRead(idCheck.data))
          return
        }

        const sessionInspectMatch = /^\/sessions\/([^/]+)\/inspect$/.exec(url.pathname)
        if (req.method === 'GET' && sessionInspectMatch) {
          const idCheck = SessionIdSchema.safeParse(decodeURIComponent(sessionInspectMatch[1]))
          if (!idCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid session identifier', {
              statusCode: 400,
            })
          }
          sendJson(res, 200, await orchestrator.inspectSession(idCheck.data))
          return
        }

        const runRetryMatch = /^\/runs\/([^/]+)\/retry$/.exec(url.pathname)
        if (req.method === 'POST' && runRetryMatch) {
          const idCheck = RunIdSchema.safeParse(decodeURIComponent(runRetryMatch[1]))
          if (!idCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid run identifier', { statusCode: 400 })
          }
          const body = await readJsonBody(req)
          const parsed = RetryRunInputSchema.safeParse({
            runId: idCheck.data,
            ...(body && typeof body === 'object' ? body : {}),
          })
          if (!parsed.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid retry payload', { statusCode: 400 })
          }
          sendJson(res, 201, await orchestrator.retryRun(parsed.data))
          return
        }

        const sessionMatch = /^\/sessions\/([^/]+)$/.exec(url.pathname)
        if (req.method === 'PATCH' && sessionMatch) {
          const idCheck = SessionIdSchema.safeParse(decodeURIComponent(sessionMatch[1]))
          if (!idCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid session identifier', {
              statusCode: 400,
            })
          }
          const body = await readJsonBody(req)
          const parsed = RenameSessionInputSchema.safeParse({
            sessionId: idCheck.data,
            ...(body && typeof body === 'object' ? body : {}),
          })
          if (!parsed.success) {
            throw new DaemonError(
              'VALIDATION_ERROR',
              parsed.error.issues[0]?.message ?? 'Invalid session rename payload',
              { statusCode: 400 },
            )
          }
          sendJson(res, 200, sessionRepo.renameSession(parsed.data.sessionId, parsed.data.title))
          return
        }

        if (req.method === 'POST' && url.pathname === '/runs') {
          const body = await readJsonBody(req)
          const parsed = StartRunInputSchema.safeParse(body)
          if (!parsed.success) {
            throw new DaemonError(
              'VALIDATION_ERROR',
              parsed.error.issues[0]?.message ?? 'Invalid start run payload',
              { statusCode: 400 },
            )
          }
          sendJson(res, 201, await orchestrator.startRun(parsed.data))
          return
        }

        const runCancelMatch = /^\/runs\/([^/]+)\/cancel$/.exec(url.pathname)
        if (req.method === 'POST' && runCancelMatch) {
          const idCheck = RunIdSchema.safeParse(decodeURIComponent(runCancelMatch[1]))
          if (!idCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid run identifier', { statusCode: 400 })
          }
          sendJson(res, 200, orchestrator.cancelRun(idCheck.data))
          return
        }

        const runEventsMatch = /^\/runs\/([^/]+)\/events$/.exec(url.pathname)
        if (req.method === 'GET' && runEventsMatch) {
          const idCheck = RunIdSchema.safeParse(decodeURIComponent(runEventsMatch[1]))
          if (!idCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid run identifier', { statusCode: 400 })
          }
          const afterSeqRaw = url.searchParams.get('afterSeq')
          const limitRaw = url.searchParams.get('limit')
          const afterSeq = afterSeqRaw ? Number.parseInt(afterSeqRaw, 10) : 0
          const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 200
          sendJson(res, 200, orchestrator.getRunEvents(idCheck.data, afterSeq, limit))
          return
        }

        const runApprovalMatch = /^\/runs\/([^/]+)\/approval$/.exec(url.pathname)
        if (req.method === 'POST' && runApprovalMatch) {
          const idCheck = RunIdSchema.safeParse(decodeURIComponent(runApprovalMatch[1]))
          if (!idCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid run identifier', { statusCode: 400 })
          }
          const body = await readJsonBody(req)
          const parsed = ResolveApprovalInputSchema.safeParse({
            runId: idCheck.data,
            ...(body && typeof body === 'object' ? body : {}),
          })
          if (!parsed.success) {
            throw new DaemonError(
              'VALIDATION_ERROR',
              parsed.error.issues[0]?.message ?? 'Invalid approval resolution payload',
              { statusCode: 400 },
            )
          }
          const resolvedApproval = await orchestrator.resolveApproval(
            parsed.data.runId,
            parsed.data.approvalId,
            parsed.data.decision,
            parsed.data.argsHash,
          )
          if (this.schedulerService) {
            this.schedulerService.handleDaemonApprovalResolved(
              parsed.data.runId,
              parsed.data.approvalId,
              parsed.data.decision,
            )
          }
          sendJson(res, 200, resolvedApproval)
          return
        }

        const runMatch = /^\/runs\/([^/]+)$/.exec(url.pathname)
        if (req.method === 'GET' && runMatch) {
          const idCheck = RunIdSchema.safeParse(decodeURIComponent(runMatch[1]))
          if (!idCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid run identifier', { statusCode: 400 })
          }
          sendJson(res, 200, orchestrator.getRun(idCheck.data))
          return
        }
      }

      if (this.memoryService) {
        const memoryService = this.memoryService

        if (req.method === 'GET' && url.pathname === '/memories') {
          const botId = url.searchParams.get('botId') ?? undefined
          const scopeKind = url.searchParams.get('scopeKind') ?? undefined
          const includeUserWide = url.searchParams.get('includeUserWide') === 'true'
          const includeArchived = url.searchParams.get('includeArchived') === 'true'
          const category = url.searchParams.get('category') ?? undefined
          const limitRaw = url.searchParams.get('limit')
          const offsetRaw = url.searchParams.get('offset')
          const parsed = ListMemoriesIpcInputSchema.safeParse({
            ...(botId ? { botId } : {}),
            ...(scopeKind ? { scopeKind } : {}),
            includeUserWide,
            includeArchived,
            ...(category ? { category } : {}),
            ...(limitRaw ? { limit: Number.parseInt(limitRaw, 10) } : {}),
            ...(offsetRaw ? { offset: Number.parseInt(offsetRaw, 10) } : {}),
          })
          if (!parsed.success) {
            throw new DaemonError(
              'VALIDATION_ERROR',
              parsed.error.issues[0]?.message ?? 'Invalid memory list query',
              { statusCode: 400 },
            )
          }
          sendJson(res, 200, await memoryService.listMemories(parsed.data))
          return
        }

        if (req.method === 'POST' && url.pathname === '/memories/search') {
          const body = await readJsonBody(req)
          const parsed = SearchMemoriesIpcInputSchema.safeParse(body)
          if (!parsed.success) {
            throw new DaemonError(
              'VALIDATION_ERROR',
              parsed.error.issues[0]?.message ?? 'Invalid memory search payload',
              { statusCode: 400 },
            )
          }
          sendJson(res, 200, await memoryService.searchMemories(parsed.data))
          return
        }

        if (req.method === 'POST' && url.pathname === '/memories') {
          const body = await readJsonBody(req)
          const parsed = CreateMemoryIpcInputSchema.safeParse(body)
          if (!parsed.success) {
            throw new DaemonError(
              'VALIDATION_ERROR',
              parsed.error.issues[0]?.message ?? 'Invalid create memory payload',
              { statusCode: 400 },
            )
          }
          sendJson(res, 201, await memoryService.createMemory(parsed.data))
          return
        }

        const memoryArchiveMatch = /^\/memories\/([^/]+)\/archive$/.exec(url.pathname)
        if (req.method === 'POST' && memoryArchiveMatch) {
          const idCheck = MemoryIdParamSchema.safeParse({
            id: decodeURIComponent(memoryArchiveMatch[1]),
          })
          if (!idCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid memory identifier', { statusCode: 400 })
          }
          sendJson(res, 200, await memoryService.archiveMemory(idCheck.data.id))
          return
        }

        const memoryMatch = /^\/memories\/([^/]+)$/.exec(url.pathname)
        if (memoryMatch) {
          const idCheck = MemoryIdParamSchema.safeParse({
            id: decodeURIComponent(memoryMatch[1]),
          })
          if (!idCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid memory identifier', { statusCode: 400 })
          }
          if (req.method === 'PATCH') {
            const body = await readJsonBody(req)
            const parsed = UpdateMemoryIpcInputSchema.safeParse({
              id: idCheck.data.id,
              ...(body && typeof body === 'object' ? body : {}),
            })
            if (!parsed.success) {
              throw new DaemonError(
                'VALIDATION_ERROR',
                parsed.error.issues[0]?.message ?? 'Invalid update memory payload',
                { statusCode: 400 },
              )
            }
            sendJson(res, 200, await memoryService.updateMemory(parsed.data))
            return
          }
          if (req.method === 'DELETE') {
            sendJson(res, 200, await memoryService.deleteMemory(idCheck.data.id))
            return
          }
        }
      }

      if (this.knowledgeService) {
        const knowledgeService = this.knowledgeService

        if (req.method === 'GET' && url.pathname === '/knowledge/collections') {
          const botId = url.searchParams.get('botId') ?? undefined
          const scopeKind = url.searchParams.get('scopeKind') ?? undefined
          const includeUserWide = url.searchParams.get('includeUserWide') === 'true'
          const parsed = ListKnowledgeCollectionsInputSchema.safeParse({
            ...(botId ? { botId } : {}),
            ...(scopeKind ? { scopeKind } : {}),
            includeUserWide,
          })
          if (!parsed.success) {
            throw new DaemonError(
              'VALIDATION_ERROR',
              parsed.error.issues[0]?.message ?? 'Invalid collection list query',
              { statusCode: 400 },
            )
          }
          sendJson(res, 200, await knowledgeService.listCollections(parsed.data))
          return
        }

        if (req.method === 'POST' && url.pathname === '/knowledge/collections') {
          const body = await readJsonBody(req)
          const parsed = CreateKnowledgeCollectionInputSchema.safeParse(body)
          if (!parsed.success) {
            throw new DaemonError(
              'VALIDATION_ERROR',
              parsed.error.issues[0]?.message ?? 'Invalid create collection payload',
              { statusCode: 400 },
            )
          }
          sendJson(res, 201, await knowledgeService.createCollection(parsed.data))
          return
        }

        if (req.method === 'GET' && url.pathname === '/knowledge/documents') {
          const botId = url.searchParams.get('botId') ?? undefined
          const scopeKind = url.searchParams.get('scopeKind') ?? undefined
          const collectionId = url.searchParams.get('collectionId') ?? undefined
          const includeUserWide = url.searchParams.get('includeUserWide') === 'true'
          const includeArchived = url.searchParams.get('includeArchived') === 'true'
          const limitRaw = url.searchParams.get('limit')
          const offsetRaw = url.searchParams.get('offset')
          const parsed = ListKnowledgeDocsInputSchema.safeParse({
            ...(botId ? { botId } : {}),
            ...(scopeKind ? { scopeKind } : {}),
            ...(collectionId ? { collectionId } : {}),
            includeUserWide,
            includeArchived,
            ...(limitRaw ? { limit: Number.parseInt(limitRaw, 10) } : {}),
            ...(offsetRaw ? { offset: Number.parseInt(offsetRaw, 10) } : {}),
          })
          if (!parsed.success) {
            throw new DaemonError(
              'VALIDATION_ERROR',
              parsed.error.issues[0]?.message ?? 'Invalid document list query',
              { statusCode: 400 },
            )
          }
          sendJson(res, 200, await knowledgeService.listDocuments(parsed.data))
          return
        }

        if (req.method === 'POST' && url.pathname === '/knowledge/documents/search') {
          const body = await readJsonBody(req)
          const parsed = SearchKnowledgeDocsInputSchema.safeParse(body)
          if (!parsed.success) {
            throw new DaemonError(
              'VALIDATION_ERROR',
              parsed.error.issues[0]?.message ?? 'Invalid document search payload',
              { statusCode: 400 },
            )
          }
          sendJson(res, 200, await knowledgeService.searchDocuments(parsed.data))
          return
        }

        if (req.method === 'POST' && url.pathname === '/knowledge/documents/ingest-text') {
          const body = await readJsonBody(req, MAX_KNOWLEDGE_BODY_BYTES)
          const parsed = IngestKnowledgeTextInputSchema.safeParse(body)
          if (!parsed.success) {
            throw new DaemonError(
              'VALIDATION_ERROR',
              parsed.error.issues[0]?.message ?? 'Invalid document ingestion payload',
              { statusCode: 400 },
            )
          }
          sendJson(res, 201, await knowledgeService.ingestText(parsed.data))
          return
        }

        if (req.method === 'POST' && url.pathname === '/knowledge/documents/ingest-bytes') {
          const body = await readJsonBody(req, 3 * 1024 * 1024)
          const IngestAuthorizedBytesBodySchema = z
            .object({
              scope: z.discriminatedUnion('kind', [
                z.object({ kind: z.literal('user') }).strict(),
                z.object({ kind: z.literal('bot'), botId: BotIdSchema }).strict(),
                z.object({ kind: z.literal('workspace'), botId: BotIdSchema }).strict(),
              ]),
              collectionId: z.string().nullable().default(null),
              displayFilename: z.string().trim().min(1).max(255),
              bytesBase64: z.string().min(1).max(3 * 1024 * 1024),
              tags: z.array(z.string().trim().min(1).max(48)).max(16).default([]),
            })
            .strict()
          const parsed = IngestAuthorizedBytesBodySchema.safeParse(body)
          if (!parsed.success) {
            throw new DaemonError(
              'VALIDATION_ERROR',
              parsed.error.issues[0]?.message ?? 'Invalid document bytes payload',
              { statusCode: 400 },
            )
          }
          sendJson(res, 201, await knowledgeService.ingestAuthorizedBytes(parsed.data))
          return
        }

        if (req.method === 'POST' && url.pathname === '/knowledge/citations/resolve') {
          const body = await readJsonBody(req)
          const parsed = ResolveKnowledgeCitationInputSchema.safeParse(body)
          if (!parsed.success) {
            throw new DaemonError(
              'VALIDATION_ERROR',
              parsed.error.issues[0]?.message ?? 'Invalid citation resolution payload',
              { statusCode: 400 },
            )
          }
          sendJson(res, 200, await knowledgeService.resolveCitation(parsed.data))
          return
        }

        const docReplaceMatch = /^\/knowledge\/documents\/([^/]+)\/replace-text$/.exec(url.pathname)
        if (req.method === 'POST' && docReplaceMatch) {
          const idCheck = KnowledgeIdParamSchema.safeParse({
            id: decodeURIComponent(docReplaceMatch[1]),
          })
          if (!idCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid document identifier', {
              statusCode: 400,
            })
          }
          const body = await readJsonBody(req, MAX_KNOWLEDGE_BODY_BYTES)
          const parsed = ReplaceKnowledgeDocTextInputSchema.safeParse({
            id: idCheck.data.id,
            ...(body && typeof body === 'object' ? body : {}),
          })
          if (!parsed.success) {
            throw new DaemonError(
              'VALIDATION_ERROR',
              parsed.error.issues[0]?.message ?? 'Invalid document replacement payload',
              { statusCode: 400 },
            )
          }
          sendJson(res, 200, await knowledgeService.replaceDocumentText(parsed.data))
          return
        }

        const docArchiveMatch = /^\/knowledge\/documents\/([^/]+)\/archive$/.exec(url.pathname)
        if (req.method === 'POST' && docArchiveMatch) {
          const idCheck = KnowledgeIdParamSchema.safeParse({
            id: decodeURIComponent(docArchiveMatch[1]),
          })
          if (!idCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid document identifier', {
              statusCode: 400,
            })
          }
          sendJson(res, 200, await knowledgeService.archiveDocument(idCheck.data.id))
          return
        }

        const docMatch = /^\/knowledge\/documents\/([^/]+)$/.exec(url.pathname)
        if (docMatch) {
          const idCheck = KnowledgeIdParamSchema.safeParse({
            id: decodeURIComponent(docMatch[1]),
          })
          if (!idCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid document identifier', {
              statusCode: 400,
            })
          }
          if (req.method === 'PATCH') {
            const body = await readJsonBody(req)
            const parsed = UpdateKnowledgeDocInputSchema.safeParse({
              id: idCheck.data.id,
              ...(body && typeof body === 'object' ? body : {}),
            })
            if (!parsed.success) {
              throw new DaemonError(
                'VALIDATION_ERROR',
                parsed.error.issues[0]?.message ?? 'Invalid document update payload',
                { statusCode: 400 },
              )
            }
            sendJson(res, 200, await knowledgeService.updateDocument(parsed.data))
            return
          }
          if (req.method === 'DELETE') {
            sendJson(res, 200, await knowledgeService.deleteDocument(idCheck.data.id))
            return
          }
        }
      }

      if (this.mcpService) {
        const mcpService = this.mcpService

        if (req.method === 'GET' && url.pathname === '/mcp/servers') {
          const scopeKindsRaw = url.searchParams.get('scopeKinds')
          const parsed = ListMcpServersInputSchema.safeParse({
            ...(scopeKindsRaw ? { scopeKinds: scopeKindsRaw.split(',').filter(Boolean) } : {}),
            ...(url.searchParams.has('botId') ? { botId: url.searchParams.get('botId') ?? undefined } : {}),
            ...(url.searchParams.has('includeUserWide')
              ? { includeUserWide: url.searchParams.get('includeUserWide') === 'true' }
              : {}),
            ...(url.searchParams.has('enabledOnly')
              ? { enabledOnly: url.searchParams.get('enabledOnly') === 'true' }
              : {}),
            ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}),
            ...(url.searchParams.has('offset') ? { offset: Number(url.searchParams.get('offset')) } : {}),
          })
          if (!parsed.success) {
            throw new DaemonError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid MCP query', {
              statusCode: 400,
            })
          }
          sendJson(res, 200, mcpService.listServers(parsed.data))
          return
        }

        if (req.method === 'POST' && url.pathname === '/mcp/servers') {
          const body = await readJsonBody(req)
          const parsed = RegisterMcpServerIpcInputSchema.safeParse(body)
          if (!parsed.success) {
            throw new DaemonError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid MCP server payload', {
              statusCode: 400,
            })
          }
          sendJson(res, 201, mcpService.registerServer(parsed.data))
          return
        }

        if (req.method === 'POST' && url.pathname === '/mcp/resources/read') {
          const body = await readJsonBody(req)
          const parsed = ReadMcpResourceInputSchema.safeParse(body)
          if (!parsed.success) {
            throw new DaemonError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid MCP resource payload', {
              statusCode: 400,
            })
          }
          sendJson(res, 200, await mcpService.readResource(parsed.data))
          return
        }

        if (req.method === 'POST' && url.pathname === '/mcp/prompts/get') {
          const body = await readJsonBody(req)
          const parsed = GetMcpPromptInputSchema.safeParse(body)
          if (!parsed.success) {
            throw new DaemonError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid MCP prompt payload', {
              statusCode: 400,
            })
          }
          sendJson(res, 200, await mcpService.getPrompt(parsed.data))
          return
        }

        if (req.method === 'GET' && url.pathname === '/secrets/status') {
          sendJson(res, 200, mcpService.getSecretStoreStatus())
          return
        }

        const mcpServerSecretDeleteMatch = /^\/mcp\/servers\/([^/]+)\/secrets\/([^/]+)$/.exec(
          url.pathname,
        )
        if (mcpServerSecretDeleteMatch && req.method === 'DELETE') {
          const parsed = DeleteMcpServerSecretInputSchema.safeParse({
            serverId: decodeURIComponent(mcpServerSecretDeleteMatch[1]),
            refId: decodeURIComponent(mcpServerSecretDeleteMatch[2]),
          })
          if (!parsed.success) {
            throw new DaemonError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid secret reference delete params', {
              statusCode: 400,
            })
          }
          sendJson(res, 200, await mcpService.deleteServerSecretRef(parsed.data))
          return
        }

        const mcpServerSecretsMatch = /^\/mcp\/servers\/([^/]+)\/secrets$/.exec(url.pathname)
        if (mcpServerSecretsMatch) {
          const idCheck = McpServerIdParamSchema.safeParse({ id: decodeURIComponent(mcpServerSecretsMatch[1]) })
          if (!idCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid MCP server identifier', { statusCode: 400 })
          }
          if (req.method === 'GET') {
            sendJson(res, 200, mcpService.listServerSecretRefs(idCheck.data.id))
            return
          }
          if (req.method === 'PUT') {
            const body = await readJsonBody(req)
            const parsed = SetMcpServerSecretInputSchema.safeParse({
              ...(body && typeof body === 'object' ? body : {}),
              serverId: idCheck.data.id,
            })
            if (!parsed.success) {
              throw new DaemonError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid MCP secret payload', {
                statusCode: 400,
              })
            }
            sendJson(res, 200, mcpService.setServerSecretRef(parsed.data))
            return
          }
        }

        const mcpActionMatch = /^\/mcp\/servers\/([^/]+)\/(trust|revoke-trust|enabled|connect|disconnect|capabilities)$/.exec(
          url.pathname,
        )
        if (mcpActionMatch) {
          const idCheck = McpServerIdParamSchema.safeParse({ id: decodeURIComponent(mcpActionMatch[1]) })
          if (!idCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid MCP server identifier', { statusCode: 400 })
          }
          const action = mcpActionMatch[2]
          if (action === 'trust' && req.method === 'POST') {
            sendJson(res, 200, mcpService.approveTrust(idCheck.data.id))
            return
          }
          if (action === 'revoke-trust' && req.method === 'POST') {
            sendJson(res, 200, await mcpService.revokeTrust(idCheck.data.id))
            return
          }
          if (action === 'enabled' && req.method === 'POST') {
            const body = await readJsonBody(req)
            const parsed = SetMcpServerEnabledInputSchema.safeParse({
              id: idCheck.data.id,
              ...(body && typeof body === 'object' ? body : {}),
            })
            if (!parsed.success) {
              throw new DaemonError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid enabled payload', {
                statusCode: 400,
              })
            }
            sendJson(res, 200, await mcpService.setEnabled(parsed.data))
            return
          }
          if (action === 'connect' && req.method === 'POST') {
            sendJson(res, 200, await mcpService.connectServer(idCheck.data.id))
            return
          }
          if (action === 'disconnect' && req.method === 'POST') {
            sendJson(res, 200, await mcpService.disconnectServer(idCheck.data.id))
            return
          }
          if (action === 'capabilities' && req.method === 'GET') {
            sendJson(res, 200, mcpService.getCapabilities(idCheck.data.id))
            return
          }
        }

        const mcpServerMatch = /^\/mcp\/servers\/([^/]+)$/.exec(url.pathname)
        if (mcpServerMatch) {
          const idCheck = McpServerIdParamSchema.safeParse({ id: decodeURIComponent(mcpServerMatch[1]) })
          if (!idCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid MCP server identifier', { statusCode: 400 })
          }
          if (req.method === 'PATCH') {
            const body = await readJsonBody(req)
            const parsed = UpdateMcpServerIpcInputSchema.safeParse({
              id: idCheck.data.id,
              ...(body && typeof body === 'object' ? body : {}),
            })
            if (!parsed.success) {
              throw new DaemonError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid MCP update payload', {
                statusCode: 400,
              })
            }
            sendJson(res, 200, mcpService.updateServer(parsed.data))
            return
          }
          if (req.method === 'DELETE') {
            sendJson(res, 200, await mcpService.deleteServer(idCheck.data.id))
            return
          }
        }
      }

      if (this.teamsService) {
        const teamsService = this.teamsService

        if (req.method === 'GET' && url.pathname === '/teams') {
          const parsed = ListTeamsInputSchema.safeParse({
            ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}),
            ...(url.searchParams.has('offset') ? { offset: Number(url.searchParams.get('offset')) } : {}),
            ...(url.searchParams.has('includeArchived')
              ? { includeArchived: url.searchParams.get('includeArchived') === 'true' }
              : {}),
          })
          if (!parsed.success) {
            throw new DaemonError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid teams query', {
              statusCode: 400,
            })
          }
          sendJson(res, 200, teamsService.listTeams(parsed.data))
          return
        }

        if (req.method === 'POST' && url.pathname === '/teams') {
          const body = await readJsonBody(req)
          const parsed = CreateTeamIpcInputSchema.safeParse(body)
          if (!parsed.success) {
            throw new DaemonError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid team payload', {
              statusCode: 400,
            })
          }
          sendJson(res, 201, teamsService.createTeam(parsed.data))
          return
        }

        const teamSubMatch = /^\/teams\/([^/]+)\/(members|archive|preview|runs|messages)$/.exec(url.pathname)
        if (teamSubMatch && teamSubMatch[1] !== 'runs') {
          const idCheck = TeamIdParamSchema.safeParse({ teamId: decodeURIComponent(teamSubMatch[1]) })
          if (!idCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid team identifier', { statusCode: 400 })
          }
          const action = teamSubMatch[2]
          if (action === 'members' && req.method === 'PATCH') {
            const body = await readJsonBody(req)
            const parsed = UpdateTeamMembersIpcInputSchema.safeParse({
              teamId: idCheck.data.teamId,
              ...(body && typeof body === 'object' ? body : {}),
            })
            if (!parsed.success) {
              throw new DaemonError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid members payload', {
                statusCode: 400,
              })
            }
            sendJson(res, 200, teamsService.updateTeamMembers(parsed.data.teamId, parsed.data.memberBotIds))
            return
          }
          if (action === 'archive' && req.method === 'POST') {
            const archived = teamsService.archiveTeam(idCheck.data.teamId)
            this.sidebarRepo?.pruneTeam(idCheck.data.teamId)
            sendJson(res, 200, archived)
            return
          }
          if (action === 'preview' && req.method === 'POST') {
            const body = await readJsonBody(req)
            const parsed = PreviewTeamPlanIpcInputSchema.safeParse({
              teamId: idCheck.data.teamId,
              ...(body && typeof body === 'object' ? body : {}),
            })
            if (!parsed.success) {
              throw new DaemonError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid preview payload', {
                statusCode: 400,
              })
            }
            sendJson(res, 200, teamsService.previewPlan(parsed.data.teamId, parsed.data.plan))
            return
          }
          if (action === 'runs' && req.method === 'GET') {
            sendJson(res, 200, { runs: teamsService.listRunsForTeam(idCheck.data.teamId) })
            return
          }
          if (action === 'runs' && req.method === 'POST') {
            const body = await readJsonBody(req)
            const parsed = StartTeamRunIpcInputSchema.safeParse({
              teamId: idCheck.data.teamId,
              ...(body && typeof body === 'object' ? body : {}),
            })
            if (!parsed.success) {
              throw new DaemonError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid team run payload', {
                statusCode: 400,
              })
            }
            sendJson(res, 201, await teamsService.startTeamRun(parsed.data))
            return
          }
          if (action === 'messages' && req.method === 'GET') {
            const parsed = ListTeamMessagesIpcInputSchema.safeParse({
              teamId: idCheck.data.teamId,
              ...(url.searchParams.has('teamRunId') ? { teamRunId: url.searchParams.get('teamRunId') ?? undefined } : {}),
              ...(url.searchParams.has('viewerBotId') ? { viewerBotId: url.searchParams.get('viewerBotId') ?? undefined } : {}),
              ...(url.searchParams.has('afterSeq') ? { afterSeq: Number(url.searchParams.get('afterSeq')) } : {}),
              ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}),
            })
            if (!parsed.success) {
              throw new DaemonError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid team messages query', {
                statusCode: 400,
              })
            }
            sendJson(res, 200, { messages: teamsService.listMessages(parsed.data.teamId, parsed.data) })
            return
          }
        }

        const teamSingleMatch = /^\/teams\/([^/]+)$/.exec(url.pathname)
        if (teamSingleMatch && teamSingleMatch[1] !== 'runs' && req.method === 'PATCH') {
          const idCheck = TeamIdParamSchema.safeParse({ teamId: decodeURIComponent(teamSingleMatch[1]) })
          if (!idCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid team identifier', { statusCode: 400 })
          }
          const body = await readJsonBody(req)
          const parsed = UpdateTeamIpcInputSchema.safeParse({
            teamId: idCheck.data.teamId,
            ...(body && typeof body === 'object' ? body : {}),
          })
          if (!parsed.success) {
            throw new DaemonError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid team update payload', {
              statusCode: 400,
            })
          }
          sendJson(res, 200, teamsService.updateTeam(parsed.data))
          return
        }

        const teamRunSubMatch = /^\/teams\/runs\/([^/]+)\/(cancel|tasks|diagnostics|usage|approvals)$/.exec(url.pathname)
        if (teamRunSubMatch) {
          const idCheck = TeamRunIdParamSchema.safeParse({ teamRunId: decodeURIComponent(teamRunSubMatch[1]) })
          if (!idCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid teamRunId', { statusCode: 400 })
          }
          const action = teamRunSubMatch[2]
          if (action === 'cancel' && req.method === 'POST') {
            sendJson(res, 200, await teamsService.cancelTeamRun(idCheck.data.teamRunId))
            return
          }
          if (action === 'tasks' && req.method === 'GET') {
            sendJson(res, 200, { tasks: teamsService.listRunTasks(idCheck.data.teamRunId) })
            return
          }
          if (action === 'diagnostics' && req.method === 'GET') {
            sendJson(res, 200, teamsService.getDiagnostics(idCheck.data.teamRunId))
            return
          }
          if (action === 'usage' && req.method === 'GET') {
            sendJson(res, 200, teamsService.getAggregateUsage(idCheck.data.teamRunId))
            return
          }
          if (action === 'approvals' && req.method === 'GET') {
            sendJson(res, 200, { approvals: teamsService.listPendingApprovalsForRun(idCheck.data.teamRunId) })
            return
          }
        }

        const teamRunMatch = /^\/teams\/runs\/([^/]+)$/.exec(url.pathname)
        if (teamRunMatch && req.method === 'GET') {
          const idCheck = TeamRunIdParamSchema.safeParse({ teamRunId: decodeURIComponent(teamRunMatch[1]) })
          if (!idCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid teamRunId', { statusCode: 400 })
          }
          sendJson(res, 200, teamsService.getTeamRun(idCheck.data.teamRunId))
          return
        }
      }

      if (this.schedulerService) {
        const schedulerService = this.schedulerService

        if (req.method === 'GET' && url.pathname === '/routines') {
          const parsed = ListRoutinesIpcInputSchema.safeParse({
            botId: url.searchParams.get('botId') ?? undefined,
            includeArchived: url.searchParams.get('includeArchived') === 'true',
          })
          if (!parsed.success) {
            throw new DaemonError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid routines query', {
              statusCode: 400,
            })
          }
          sendJson(res, 200, { routines: schedulerService.listRoutines(parsed.data) })
          return
        }

        if (req.method === 'POST' && url.pathname === '/routines') {
          const body = await readJsonBody(req)
          const parsed = CreateRoutineIpcInputSchema.safeParse(body)
          if (!parsed.success) {
            throw new DaemonError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid routine input', {
              statusCode: 400,
            })
          }
          sendJson(
            res,
            201,
            schedulerService.createRoutine({
              ...parsed.data,
              timezone: parsed.data.timezone ?? 'UTC',
              task: {
                prompt: parsed.data.task.prompt,
                idempotent: parsed.data.task.idempotent ?? false,
              },
            }),
          )
          return
        }

        if (req.method === 'POST' && url.pathname === '/routines/import-preview') {
          const body = await readJsonBody(req)
          const parsed = ImportRoutineIpcInputSchema.safeParse(body)
          if (!parsed.success) {
            throw new DaemonError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid import preview payload', {
              statusCode: 400,
            })
          }
          sendJson(res, 200, schedulerService.previewImport(parsed.data.bundle, parsed.data.botId, parsed.data.conflictPolicy))
          return
        }

        if (req.method === 'POST' && url.pathname === '/routines/import-commit') {
          const body = await readJsonBody(req)
          const parsed = ImportRoutineIpcInputSchema.safeParse(body)
          if (!parsed.success) {
            throw new DaemonError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid import commit payload', {
              statusCode: 400,
            })
          }
          sendJson(res, 200, schedulerService.commitImport(parsed.data.bundle, parsed.data.botId, parsed.data.conflictPolicy))
          return
        }

        if (req.method === 'GET' && url.pathname === '/routines/export') {
          const botId = url.searchParams.get('botId')
          const botCheck = BotIdSchema.safeParse(botId)
          if (!botCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid botId', { statusCode: 400 })
          }
          sendJson(res, 200, schedulerService.exportRoutines(botCheck.data))
          return
        }

        const routineTaskActionMatch = /^\/routines\/tasks\/([^/]+)\/cancel$/.exec(url.pathname)
        if (routineTaskActionMatch && req.method === 'POST') {
          const body = await readJsonBody(req)
          const parsed = RoutineTaskParamSchema.safeParse({
            taskId: decodeURIComponent(routineTaskActionMatch[1]),
            botId: (body as Record<string, unknown>)?.botId,
          })
          if (!parsed.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid taskId or botId', { statusCode: 400 })
          }
          sendJson(res, 200, await schedulerService.cancelTask(parsed.data.taskId, parsed.data.botId))
          return
        }

        const routineTaskMatch = /^\/routines\/tasks\/([^/]+)$/.exec(url.pathname)
        if (routineTaskMatch && req.method === 'GET') {
          const parsed = RoutineTaskParamSchema.safeParse({
            taskId: decodeURIComponent(routineTaskMatch[1]),
            botId: url.searchParams.get('botId'),
          })
          if (!parsed.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid taskId or botId', { statusCode: 400 })
          }
          sendJson(res, 200, schedulerService.getTask(parsed.data.taskId, parsed.data.botId))
          return
        }

        const routineActionMatch = /^\/routines\/([^/]+)\/(enable|disable|archive|trigger|preview|diagnose|simulate|stats|history)$/.exec(
          url.pathname,
        )
        if (routineActionMatch) {
          const routineId = decodeURIComponent(routineActionMatch[1])
          const action = routineActionMatch[2]
          if (req.method === 'POST' && (action === 'enable' || action === 'disable' || action === 'archive')) {
            const body = await readJsonBody(req)
            const parsed = RoutineScopeParamSchema.safeParse({
              routineId,
              botId: (body as Record<string, unknown>)?.botId,
            })
            if (!parsed.success) {
              throw new DaemonError('VALIDATION_ERROR', 'Invalid routineId or botId', { statusCode: 400 })
            }
            const updated =
              action === 'enable'
                ? schedulerService.enableRoutine(parsed.data.routineId, parsed.data.botId)
                : action === 'disable'
                  ? schedulerService.disableRoutine(parsed.data.routineId, parsed.data.botId)
                  : schedulerService.archiveRoutine(parsed.data.routineId, parsed.data.botId)
            sendJson(res, 200, updated)
            return
          }
          if (req.method === 'POST' && action === 'trigger') {
            const body = await readJsonBody(req)
            const parsed = TriggerRoutineIpcInputSchema.safeParse({ ...(body as Record<string, unknown>), routineId })
            if (!parsed.success) {
              throw new DaemonError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid trigger payload', {
                statusCode: 400,
              })
            }
            sendJson(res, 201, schedulerService.triggerManual(parsed.data.routineId, parsed.data.botId, parsed.data.idempotencyKey))
            return
          }
          if (req.method === 'GET' && (action === 'preview' || action === 'simulate' || action === 'history')) {
            const countRaw = url.searchParams.get('count')
            const parsed = RoutineCountParamSchema.safeParse({
              routineId,
              botId: url.searchParams.get('botId'),
              count: countRaw ? Number(countRaw) : undefined,
            })
            if (!parsed.success) {
              throw new DaemonError('VALIDATION_ERROR', 'Invalid routineId, botId, or count', { statusCode: 400 })
            }
            if (action === 'preview') {
              sendJson(res, 200, schedulerService.previewRoutineSchedule(parsed.data.routineId, parsed.data.botId, parsed.data.count))
              return
            }
            if (action === 'simulate') {
              sendJson(res, 200, schedulerService.simulateRoutine(parsed.data.routineId, parsed.data.botId, parsed.data.count))
              return
            }
            sendJson(res, 200, { tasks: schedulerService.listTaskHistory(parsed.data.routineId, parsed.data.botId, parsed.data.count) })
            return
          }
          if (req.method === 'GET' && (action === 'diagnose' || action === 'stats')) {
            const parsed = RoutineScopeParamSchema.safeParse({
              routineId,
              botId: url.searchParams.get('botId'),
            })
            if (!parsed.success) {
              throw new DaemonError('VALIDATION_ERROR', 'Invalid routineId or botId', { statusCode: 400 })
            }
            sendJson(
              res,
              200,
              action === 'diagnose'
                ? schedulerService.diagnoseRoutine(parsed.data.routineId, parsed.data.botId)
                : schedulerService.getExecutionStatistics(parsed.data.routineId, parsed.data.botId),
            )
            return
          }
        }

        const routineMatch = /^\/routines\/([^/]+)$/.exec(url.pathname)
        if (routineMatch) {
          const routineId = decodeURIComponent(routineMatch[1])
          if (req.method === 'GET') {
            const parsed = RoutineScopeParamSchema.safeParse({
              routineId,
              botId: url.searchParams.get('botId'),
            })
            if (!parsed.success) {
              throw new DaemonError('VALIDATION_ERROR', 'Invalid routineId or botId', { statusCode: 400 })
            }
            sendJson(res, 200, schedulerService.getRoutine(parsed.data.routineId, parsed.data.botId))
            return
          }
          if (req.method === 'PATCH') {
            const body = await readJsonBody(req)
            const parsed = UpdateRoutineIpcInputSchema.safeParse({ ...(body as Record<string, unknown>), routineId })
            if (!parsed.success) {
              throw new DaemonError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid routine patch', {
                statusCode: 400,
              })
            }
            const { routineId: id, botId, task, ...restPatch } = parsed.data
            sendJson(
              res,
              200,
              schedulerService.updateRoutine(id, botId, {
                ...restPatch,
                ...(task ? { task: { prompt: task.prompt, idempotent: task.idempotent ?? false } } : {}),
              }),
            )
            return
          }
        }

        if (req.method === 'GET' && url.pathname === '/routine-notifications') {
          const limitRaw = url.searchParams.get('limit')
          const parsed = ListRoutineNotificationsIpcInputSchema.safeParse({
            botId: url.searchParams.get('botId'),
            unreadOnly: url.searchParams.get('unreadOnly') === 'true',
            limit: limitRaw ? Number(limitRaw) : undefined,
          })
          if (!parsed.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid notifications query', { statusCode: 400 })
          }
          sendJson(res, 200, { notifications: schedulerService.listNotifications(parsed.data.botId, parsed.data) })
          return
        }

        if (req.method === 'GET' && url.pathname === '/routine-notifications/unread-count') {
          const botCheck = BotIdSchema.safeParse(url.searchParams.get('botId'))
          if (!botCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid botId', { statusCode: 400 })
          }
          sendJson(res, 200, { unreadCount: schedulerService.getUnreadNotificationCount(botCheck.data) })
          return
        }

        const notifActionMatch = /^\/routine-notifications\/([^/]+)\/(mark-read|dismiss)$/.exec(url.pathname)
        if (notifActionMatch && req.method === 'POST') {
          const body = await readJsonBody(req)
          const parsed = RoutineNotificationParamSchema.safeParse({
            notificationId: decodeURIComponent(notifActionMatch[1]),
            botId: (body as Record<string, unknown>)?.botId,
          })
          if (!parsed.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid notificationId or botId', { statusCode: 400 })
          }
          sendJson(
            res,
            200,
            notifActionMatch[2] === 'mark-read'
              ? schedulerService.markNotificationRead(parsed.data.notificationId, parsed.data.botId)
              : schedulerService.dismissNotification(parsed.data.notificationId, parsed.data.botId),
          )
          return
        }
      }

      if (this.terminalService) {
        const termService = this.terminalService
        if (req.method === 'GET' && url.pathname === '/terminal/capabilities') {
          sendJson(res, 200, await termService.getCapabilities())
          return
        }
        if (req.method === 'GET' && url.pathname === '/terminal/commands') {
          const limitRaw = url.searchParams.get('limit')
          const parsed = ListTerminalCommandsInputSchema.safeParse({
            ...(url.searchParams.has('botId') ? { botId: url.searchParams.get('botId') ?? undefined } : {}),
            ...(limitRaw ? { limit: Number(limitRaw) } : {}),
          })
          if (!parsed.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid terminal commands query', { statusCode: 400 })
          }
          sendJson(res, 200, { commands: termService.listCommands(parsed.data.botId, parsed.data.limit) })
          return
        }
        if (req.method === 'POST' && url.pathname === '/terminal/commands/request') {
          const body = await readJsonBody(req)
          const parsed = RequestTerminalCommandInputSchema.safeParse(body)
          if (!parsed.success) {
            throw new DaemonError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid terminal command payload', {
              statusCode: 400,
            })
          }
          sendJson(res, 201, termService.requestCommandApproval(parsed.data))
          return
        }
        const termActionMatch = /^\/terminal\/commands\/([^/]+)\/(resolve|cancel)$/.exec(url.pathname)
        if (termActionMatch && req.method === 'POST') {
          const idCheck = TerminalCommandIdParamSchema.safeParse({
            commandId: decodeURIComponent(termActionMatch[1]),
          })
          if (!idCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid terminal command identifier', { statusCode: 400 })
          }
          if (termActionMatch[2] === 'resolve') {
            const body = await readJsonBody(req)
            const parsed = ResolveTerminalCommandInputSchema.safeParse({
              ...(body && typeof body === 'object' ? body : {}),
              commandId: idCheck.data.commandId,
            })
            if (!parsed.success) {
              throw new DaemonError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid resolve payload', {
                statusCode: 400,
              })
            }
            sendJson(res, 200, await termService.resolveCommandApproval(parsed.data))
            return
          }
          if (termActionMatch[2] === 'cancel') {
            sendJson(res, 200, await termService.cancelCommand(idCheck.data.commandId))
            return
          }
        }
      }

      if (this.skillsService) {
        const skillsService = this.skillsService
        if (req.method === 'GET' && url.pathname === '/skills') {
          sendJson(res, 200, { skills: skillsService.listSkills() })
          return
        }
        if (req.method === 'POST' && url.pathname === '/skills/discover') {
          const body = await readJsonBody(req)
          const parsed = DiscoverLocalSkillsInputSchema.safeParse(body)
          if (!parsed.success) {
            throw new DaemonError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid skill discovery payload', {
              statusCode: 400,
            })
          }
          sendJson(res, 200, { skills: skillsService.discoverSkills(parsed.data.roots) })
          return
        }
        const skillActionMatch = /^\/skills\/([^/]+)\/(trust|revoke-trust|enabled)$/.exec(url.pathname)
        if (skillActionMatch && req.method === 'POST') {
          const idCheck = SkillIdParamSchema.safeParse({
            skillId: decodeURIComponent(skillActionMatch[1]),
          })
          if (!idCheck.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid skill identifier', { statusCode: 400 })
          }
          const action = skillActionMatch[2]
          if (action === 'trust') {
            sendJson(res, 200, skillsService.approveTrust(idCheck.data.skillId))
            return
          }
          if (action === 'revoke-trust') {
            sendJson(res, 200, skillsService.revokeTrust(idCheck.data.skillId))
            return
          }
          if (action === 'enabled') {
            const body = await readJsonBody(req)
            const parsed = SetSkillEnabledInputSchema.safeParse({
              ...(body && typeof body === 'object' ? body : {}),
              skillId: idCheck.data.skillId,
            })
            if (!parsed.success) {
              throw new DaemonError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid enabled payload', {
                statusCode: 400,
              })
            }
            sendJson(res, 200, skillsService.setEnabled(parsed.data.skillId, parsed.data.enabled))
            return
          }
        }
      }

      if (this.computerUseService) {
        const cuService = this.computerUseService

        if (req.method === 'GET' && url.pathname === '/computer-use/capabilities') {
          sendJson(res, 200, await cuService.getCapabilities())
          return
        }

        if (req.method === 'GET' && url.pathname === '/computer-use/sessions') {
          const limitRaw = url.searchParams.get('limit')
          const parsed = ListComputerUseSessionsInputSchema.safeParse({
            botId: url.searchParams.get('botId') ?? undefined,
            limit: limitRaw ? Number(limitRaw) : undefined,
          })
          if (!parsed.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid computer-use sessions query', {
              statusCode: 400,
            })
          }
          sendJson(res, 200, { sessions: cuService.listSessions(parsed.data.botId, parsed.data.limit) })
          return
        }

        if (req.method === 'POST' && url.pathname === '/computer-use/sessions') {
          const body = await readJsonBody(req)
          const parsed = CreateComputerUseSessionInputSchema.safeParse(body)
          if (!parsed.success) {
            throw new DaemonError(
              'VALIDATION_ERROR',
              parsed.error.issues[0]?.message ?? 'Invalid computer-use session payload',
              { statusCode: 400 },
            )
          }
          sendJson(res, 201, await cuService.createSession(parsed.data))
          return
        }

        const cuApprovalResolveMatch =
          /^\/computer-use\/sessions\/([^/]+)\/approvals\/([^/]+)\/resolve$/.exec(url.pathname)
        if (cuApprovalResolveMatch && req.method === 'POST') {
          const body = await readJsonBody(req)
          const parsed = ResolveComputerUseApprovalInputSchema.safeParse({
            ...(typeof body === 'object' && body !== null ? body : {}),
            sessionId: decodeURIComponent(cuApprovalResolveMatch[1]!),
            approvalId: decodeURIComponent(cuApprovalResolveMatch[2]!),
          })
          if (!parsed.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid approval resolve payload', {
              statusCode: 400,
            })
          }
          sendJson(
            res,
            200,
            cuService.resolveActionApproval(
              parsed.data.sessionId,
              parsed.data.approvalId,
              parsed.data.decision,
            ),
          )
          return
        }

        const cuSubMatch =
          /^\/computer-use\/sessions\/([^/]+)\/(observe|approvals|actions|ledger|close|emergency-stop|test-fixture)$/.exec(
            url.pathname,
          )
        if (cuSubMatch) {
          const sessionId = decodeURIComponent(cuSubMatch[1]!)
          const sub = cuSubMatch[2]!

          if (sub === 'observe' && req.method === 'POST') {
            const body = await readJsonBody(req)
            const parsed = ComputerUseObserveInputSchema.safeParse({
              ...(typeof body === 'object' && body !== null ? body : {}),
              sessionId,
            })
            if (!parsed.success) {
              throw new DaemonError('VALIDATION_ERROR', 'Invalid observe payload', { statusCode: 400 })
            }
            sendJson(res, 200, await cuService.observeTab(parsed.data.sessionId, parsed.data.tabId))
            return
          }

          if (sub === 'approvals' && req.method === 'GET') {
            const limitRaw = url.searchParams.get('limit')
            const parsed = ComputerUseSessionListParamSchema.safeParse({
              sessionId,
              limit: limitRaw ? Number(limitRaw) : undefined,
            })
            if (!parsed.success) {
              throw new DaemonError('VALIDATION_ERROR', 'Invalid approvals query', { statusCode: 400 })
            }
            sendJson(res, 200, { approvals: cuService.listApprovals(parsed.data.sessionId, parsed.data.limit) })
            return
          }

          if (sub === 'approvals' && req.method === 'POST') {
            const body = await readJsonBody(req)
            const parsed = RequestComputerUseApprovalInputSchema.safeParse({
              ...(typeof body === 'object' && body !== null ? body : {}),
              sessionId,
            })
            if (!parsed.success) {
              throw new DaemonError(
                'VALIDATION_ERROR',
                parsed.error.issues[0]?.message ?? 'Invalid approval request payload',
                { statusCode: 400 },
              )
            }
            sendJson(res, 201, cuService.requestActionApproval(parsed.data))
            return
          }

          if (sub === 'actions' && req.method === 'POST') {
            const body = await readJsonBody(req)
            const parsed = ExecuteComputerUseActionInputSchema.safeParse({
              ...(typeof body === 'object' && body !== null ? body : {}),
              sessionId,
            })
            if (!parsed.success) {
              throw new DaemonError(
                'VALIDATION_ERROR',
                parsed.error.issues[0]?.message ?? 'Invalid action payload',
                { statusCode: 400 },
              )
            }
            sendJson(res, 200, await cuService.executeAction(parsed.data))
            return
          }

          if (sub === 'ledger' && req.method === 'GET') {
            const limitRaw = url.searchParams.get('limit')
            const parsed = ComputerUseSessionListParamSchema.safeParse({
              sessionId,
              limit: limitRaw ? Number(limitRaw) : undefined,
            })
            if (!parsed.success) {
              throw new DaemonError('VALIDATION_ERROR', 'Invalid ledger query', { statusCode: 400 })
            }
            sendJson(res, 200, { entries: cuService.listLedger(parsed.data.sessionId, parsed.data.limit) })
            return
          }

          if (sub === 'close' && req.method === 'POST') {
            const parsed = ComputerUseSessionIdParamSchema.safeParse({ sessionId })
            if (!parsed.success) {
              throw new DaemonError('VALIDATION_ERROR', 'Invalid sessionId', { statusCode: 400 })
            }
            sendJson(res, 200, await cuService.closeSession(parsed.data.sessionId))
            return
          }

          if (sub === 'emergency-stop' && req.method === 'POST') {
            const body = await readJsonBody(req)
            const parsed = ComputerUseEmergencyStopInputSchema.safeParse({
              ...(typeof body === 'object' && body !== null ? body : {}),
              sessionId,
            })
            if (!parsed.success) {
              throw new DaemonError('VALIDATION_ERROR', 'Invalid emergency-stop payload', {
                statusCode: 400,
              })
            }
            sendJson(res, 200, await cuService.emergencyStop(parsed.data.sessionId, parsed.data.reason))
            return
          }

          if (sub === 'test-fixture' && req.method === 'POST') {
            const body = await readJsonBody(req)
            const routes =
              typeof body === 'object' && body !== null && 'routes' in body
                ? (body as { routes: Record<string, string> }).routes
                : {}
            const port =
              typeof body === 'object' && body !== null && 'port' in body && typeof (body as { port?: unknown }).port === 'number'
                ? (body as { port: number }).port
                : 0
            sendJson(res, 200, await cuService.startTestFixture(sessionId, routes, port))
            return
          }
        }

        const cuSessionMatch = /^\/computer-use\/sessions\/([^/]+)$/.exec(url.pathname)
        if (cuSessionMatch && req.method === 'GET') {
          const parsed = ComputerUseSessionIdParamSchema.safeParse({
            sessionId: decodeURIComponent(cuSessionMatch[1]!),
          })
          if (!parsed.success) {
            throw new DaemonError('VALIDATION_ERROR', 'Invalid sessionId', { statusCode: 400 })
          }
          sendJson(res, 200, cuService.getSession(parsed.data.sessionId))
          return
        }
      }

      throw new DaemonError('NOT_FOUND', `Unknown daemon endpoint: ${req.method} ${url.pathname}`, {
        statusCode: 404,
      })
    } catch (err) {
      const normalized = normalizeDaemonError(
        err instanceof z.ZodError && req.url?.startsWith('/workspace/')
          ? new DaemonError('VALIDATION_ERROR', 'Invalid workspace request', { statusCode: 400 })
          : err,
      )
      sendJson(res, normalized.statusCode, normalized.body)
    }
  }
}
