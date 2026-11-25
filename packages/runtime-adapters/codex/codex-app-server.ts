import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { normalizeCodexModel } from '../../shared-types/discovery.ts'
import { canEnablePermission } from '../../shared-types/permissions.ts'
import type { RuntimePermissionEvidence } from '../../shared-types/permissions.ts'
import type {
  AgentEvent,
  AgentRequest,
  AgentRuntime,
  ApprovalDecision,
  AuthState,
  Capabilities,
  EventPayload,
  ModelInfo,
  PermissionMode,
  Session,
  SessionConfig,
  UsageSnapshot,
} from '../../shared-types/runtime.ts'
import {
  JsonRpcClientError,
  JsonRpcStdioClient,
} from '../json-rpc-client.ts'
import type { JsonRpcNotification, JsonRpcServerRequest } from '../json-rpc-client.ts'

export interface CodexAdapterOptions {
  /** Dedicated profile directory; defaults to ~/.config/ghost-bot/codex-profile. */
  profileDir?: string
  /** Override executable for testing (defaults to 'codex'). */
  command?: string
  /** Override args for testing (defaults to ['app-server', '--listen', 'stdio://']). */
  args?: readonly string[]
  /** Verified permission evidence; unverified modes fail closed. */
  permissionEvidence?: RuntimePermissionEvidence | null
  /** Explicit user opt-in for full-access mode. */
  fullAccessOptIn?: boolean
  /** Approval timeout in ms (defaults to 60_000). Fail-closed to deny on timeout. */
  approvalTimeoutMs?: number
  /** Callback invoked when browser ChatGPT login URL is issued. */
  onAuthUrl?: (info: { authUrl: string; loginId: string }) => void
}

export interface CodexAccountSummary {
  accountPresent: boolean
  accountType: 'chatgpt' | 'apiKey' | null
  email: string | null
  planType: string | null
  workspaceName: string | null
  requiresOpenaiAuth: boolean
}

interface ActiveRun {
  runId: string
  threadId: string
  turnId: string | null
  pendingNotifications: JsonRpcNotification[]
  seq: number
  queue: AgentEvent[]
  waiter: (() => void) | null
  done: boolean
  cancelled: boolean
}

interface PendingApproval {
  approvalId: string
  runId: string
  argsHash: string
  expiresAtMs: number
  timer: NodeJS.Timeout
  resolve: (decision: 'accept' | 'decline') => void
}

function defaultProfileDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && xdg.trim() ? xdg : join(homedir(), '.config')
  return join(base, 'ghost-bot', 'codex-profile')
}

function stableHash(value: unknown): string {
  const canonical = JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.keys(v as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = (v as Record<string, unknown>)[key]
          return acc
        }, {})
    }
    return v
  })
  return createHash('sha256').update(canonical ?? '').digest('hex')
}

function toIsoFromUnixSeconds(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return new Date(value * 1000).toISOString()
}

export function normalizeCodexRateLimits(
  payload: unknown,
  observedAt = new Date().toISOString(),
): UsageSnapshot | null {
  if (!payload || typeof payload !== 'object') return null
  const root = payload as Record<string, unknown>
  const snapshot = root.rateLimits
  if (!snapshot || typeof snapshot !== 'object') return null

  const rl = snapshot as Record<string, unknown>
  const windows: UsageSnapshot['windows'] = []

  const pushWindow = (label: string, raw: unknown) => {
    if (!raw || typeof raw !== 'object') {
      windows.push({ label, usedPercent: null, resetAt: null })
      return
    }
    const w = raw as Record<string, unknown>
    const usedPercent =
      typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent)
        ? w.usedPercent
        : null
    const duration =
      typeof w.windowDurationMins === 'number' && Number.isFinite(w.windowDurationMins)
        ? `${w.windowDurationMins}m`
        : label
    windows.push({
      label: duration,
      usedPercent,
      resetAt: toIsoFromUnixSeconds(w.resetsAt),
    })
  }

  pushWindow('primary', rl.primary)
  if (rl.secondary !== undefined) {
    pushWindow('secondary', rl.secondary)
  }

  return {
    source: 'provider',
    observedAt,
    windows,
  }
}

export function mapPermissionToCodex(mode: PermissionMode): {
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
  approvalPolicy: 'untrusted' | 'on-request' | 'never'
} {
  switch (mode) {
    case 'read-only':
      return { sandbox: 'read-only', approvalPolicy: 'on-request' }
    case 'ask-approval':
      return { sandbox: 'workspace-write', approvalPolicy: 'untrusted' }
    case 'workspace':
      return { sandbox: 'workspace-write', approvalPolicy: 'on-request' }
    case 'full-access':
      return { sandbox: 'danger-full-access', approvalPolicy: 'on-request' }
  }
}

export function buildCodexSandboxPolicy(
  mode: PermissionMode,
  workspace: string,
): Record<string, unknown> {
  switch (mode) {
    case 'read-only':
      return { type: 'readOnly', networkAccess: false }
    case 'ask-approval':
    case 'workspace':
      return {
        type: 'workspaceWrite',
        writableRoots: [resolve(workspace)],
        excludeSlashTmp: true,
        excludeTmpdirEnvVar: true,
        networkAccess: false,
      }
    case 'full-access':
      return { type: 'dangerFullAccess' }
  }
}

export class CodexAppServerAdapter implements AgentRuntime {
  readonly id = 'codex-app-server'

  private readonly options: CodexAdapterOptions
  private readonly profileDir: string
  private client: JsonRpcStdioClient | null = null
  private initialized = false
  private initPromise: Promise<void> | null = null
  private readonly sessionConfig = new Map<string, SessionConfig>()
  private readonly activeRunsByThread = new Map<string, ActiveRun>()
  private readonly activeRunsById = new Map<string, ActiveRun>()
  private readonly pendingApprovals = new Map<string, PendingApproval>()
  private loginWaiter: {
    loginId: string | null
    resolve: (state: AuthState) => void
  } | null = null

  constructor(options: CodexAdapterOptions = {}) {
    this.options = options
    this.profileDir = resolve(options.profileDir ?? defaultProfileDir())
  }

  private async ensureInitialized(): Promise<JsonRpcStdioClient> {
    if (this.client && this.initialized && this.client.isRunning) {
      return this.client
    }
    if (this.initPromise) {
      await this.initPromise
      if (!this.client) {
        throw new JsonRpcClientError('PROCESS_EXITED', 'Codex initialization failed')
      }
      return this.client
    }

    this.initPromise = (async () => {
      await mkdir(this.profileDir, { recursive: true, mode: 0o700 })
      const st = await lstat(this.profileDir)
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new JsonRpcClientError('TRANSPORT_ERROR', 'Codex profile path must be a real directory')
      }
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
        throw new JsonRpcClientError('TRANSPORT_ERROR', 'Codex profile directory must be owned by current user')
      }
      await chmod(this.profileDir, 0o700)
      // Build isolated environment: never inherit user ~/.codex or paid API keys.
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: this.profileDir,
        CODEX_HOME: this.profileDir,
        XDG_CONFIG_HOME: join(this.profileDir, '.config'),
        XDG_DATA_HOME: join(this.profileDir, '.local', 'share'),
        XDG_STATE_HOME: join(this.profileDir, '.local', 'state'),
        TERM: process.env.TERM ?? 'xterm-256color',
      }
      if (process.env.DISPLAY) env.DISPLAY = process.env.DISPLAY
      if (process.env.WAYLAND_DISPLAY) env.WAYLAND_DISPLAY = process.env.WAYLAND_DISPLAY
      if (process.env.DBUS_SESSION_BUS_ADDRESS) {
        env.DBUS_SESSION_BUS_ADDRESS = process.env.DBUS_SESSION_BUS_ADDRESS
      }

      const client = new JsonRpcStdioClient({
        command: this.options.command ?? 'codex',
        args: this.options.args ?? ['app-server', '--listen', 'stdio://'],
        cwd: this.profileDir,
        env,
        defaultTimeoutMs: 30_000,
        onNotification: (n) => this.handleNotification(n),
        onServerRequest: (req) => this.handleServerRequest(req),
        onExit: () => {
          this.initialized = false
          this.failAllActiveRuns('PROCESS_EXITED', 'Codex app-server exited unexpectedly')
        },
      })

      client.start()
      const initResult = await client.request<Record<string, unknown>>('initialize', {
        clientInfo: { name: 'ghost-bot', version: '0.1.0' },
      })
      if (!initResult || typeof initResult.userAgent !== 'string') {
        await client.close()
        throw new JsonRpcClientError('MALFORMED_PAYLOAD', 'Invalid Codex initialize response')
      }
      client.notify('initialized')
      this.client = client
      this.initialized = true
    })()

    try {
      await this.initPromise
    } finally {
      this.initPromise = null
    }
    return this.client!
  }

  async getAccountSummary(refreshToken = false): Promise<CodexAccountSummary> {
    const client = await this.ensureInitialized()
    const res = await client.request<Record<string, unknown>>('account/read', { refreshToken })
    if (!res || typeof res.requiresOpenaiAuth !== 'boolean') {
      throw new JsonRpcClientError('MALFORMED_PAYLOAD', 'Invalid account/read response')
    }
    const acct = res.account && typeof res.account === 'object'
      ? (res.account as Record<string, unknown>)
      : null
    const accountType = acct?.type === 'chatgpt' || acct?.type === 'apiKey' ? acct.type : null
    return {
      accountPresent: acct !== null,
      accountType,
      email: typeof acct?.email === 'string' ? acct.email : null,
      planType: typeof acct?.planType === 'string' ? acct.planType : null,
      workspaceName: typeof acct?.workspaceName === 'string' ? acct.workspaceName : null,
      requiresOpenaiAuth: res.requiresOpenaiAuth,
    }
  }

  private async requireVerifiedChatGptAccount(): Promise<CodexAccountSummary> {
    const summary = await this.getAccountSummary(false)
    if (!summary.accountPresent || summary.accountType !== 'chatgpt') {
      throw new JsonRpcClientError(
        'TRANSPORT_ERROR',
        summary.accountType === 'apiKey'
          ? 'API key account rejected; subscription-first policy requires verified ChatGPT account'
          : 'Verified ChatGPT account required before execution',
      )
    }
    return summary
  }

  private async canonicalizeWorkspace(workspace: string): Promise<string> {
    return realpath(resolve(workspace))
  }

  async getAuthStatus(): Promise<AuthState> {
    try {
      const summary = await this.getAccountSummary(false)
      if (!summary.accountPresent) {
        return { status: 'disconnected', detail: 'No account signed in' }
      }
      if (summary.accountType === 'apiKey') {
        return {
          status: 'error',
          detail: 'API key account present; subscription-first policy blocks silent API usage',
        }
      }
      return {
        status: 'connected',
        detail: [summary.planType, summary.workspaceName].filter(Boolean).join(' / ') || 'chatgpt',
      }
    } catch (err) {
      return {
        status: 'error',
        detail: err instanceof Error ? err.message : 'Failed to read Codex account status',
      }
    }
  }

  async authenticate(): Promise<AuthState> {
    const current = await this.getAuthStatus()
    if (current.status === 'connected') return current

    const client = await this.ensureInitialized()
    const loginPromise = new Promise<AuthState>((resolve) => {
      this.loginWaiter = { loginId: null, resolve }
    })

    const res = await client.request<Record<string, unknown>>(
      'account/login/start',
      { type: 'chatgpt' },
      { timeoutMs: 30_000 },
    )
    if (res?.type !== 'chatgpt' || typeof res.authUrl !== 'string' || typeof res.loginId !== 'string') {
      this.loginWaiter = null
      return { status: 'error', detail: 'Unexpected account/login/start response' }
    }
    if (this.loginWaiter) {
      this.loginWaiter.loginId = res.loginId
    }
    this.options.onAuthUrl?.({ authUrl: res.authUrl, loginId: res.loginId })

    return loginPromise
  }

  async cancelLogin(loginId: string): Promise<void> {
    const client = await this.ensureInitialized()
    await client.request('account/login/cancel', { loginId })
    if (this.loginWaiter) {
      const w = this.loginWaiter
      this.loginWaiter = null
      w.resolve({ status: 'disconnected', detail: 'Login cancelled' })
    }
  }

  async disconnect(): Promise<void> {
    this.revokeAllPendingApprovals()
    if (this.client && this.client.isRunning) {
      try {
        await this.client.request('account/logout')
      } finally {
        await this.close()
      }
    }
  }

  async close(): Promise<void> {
    this.revokeAllPendingApprovals()
    if (this.client) {
      await this.client.close()
      this.client = null
      this.initialized = false
    }
  }

  private revokePendingApprovalsForRun(runId: string): void {
    for (const [id, pending] of this.pendingApprovals.entries()) {
      if (pending.runId === runId) {
        clearTimeout(pending.timer)
        this.pendingApprovals.delete(id)
        pending.resolve('decline')
      }
    }
  }

  private revokeAllPendingApprovals(): void {
    for (const [id, pending] of this.pendingApprovals.entries()) {
      clearTimeout(pending.timer)
      this.pendingApprovals.delete(id)
      pending.resolve('decline')
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const client = await this.ensureInitialized()
    const res = await client.request<Record<string, unknown>>('model/list', {
      includeHidden: false,
      limit: 100,
    })
    if (!res || !Array.isArray(res.data)) {
      throw new JsonRpcClientError('MALFORMED_PAYLOAD', 'Invalid model/list response')
    }
    const evidence = this.options.permissionEvidence ?? null
    const fullOptIn = this.options.fullAccessOptIn ?? false
    const allModes: PermissionMode[] = ['read-only', 'ask-approval', 'workspace', 'full-access']
    const verifiedModes = allModes.filter((m) => canEnablePermission(m, evidence, fullOptIn))

    const models: ModelInfo[] = []
    for (const entry of res.data) {
      const norm = normalizeCodexModel(entry)
      if (!norm) continue
      models.push({
        id: norm.id,
        label: norm.label,
        efforts: norm.efforts,
        permissionModes: verifiedModes,
        supportsTools: true,
        supportsAttachments: false,
      })
    }
    return models
  }

  async capabilities(): Promise<Capabilities> {
    const models = await this.listModels()
    const evidence = this.options.permissionEvidence
    return {
      streaming: true,
      cancellation: true,
      resume: true,
      approvals: Boolean(evidence?.approvalEnforced),
      usage: true,
      sandbox: Boolean(evidence?.sandboxEnforced),
      models,
    }
  }

  async getUsage(): Promise<UsageSnapshot | null> {
    const client = await this.ensureInitialized()
    const res = await client.request<unknown>('account/rateLimits/read')
    return normalizeCodexRateLimits(res)
  }

  async createSession(config: SessionConfig): Promise<Session> {
    const evidence = this.options.permissionEvidence ?? null
    const fullOptIn = this.options.fullAccessOptIn ?? false
    if (!canEnablePermission(config.permission, evidence, fullOptIn)) {
      throw new JsonRpcClientError(
        'TRANSPORT_ERROR',
        `Permission mode '${config.permission}' is not verified/permitted for Codex runtime`,
      )
    }

    await this.requireVerifiedChatGptAccount()
    const canonicalWorkspace = await this.canonicalizeWorkspace(config.workspace)
    const client = await this.ensureInitialized()
    const { sandbox, approvalPolicy } = mapPermissionToCodex(config.permission)
    const res = await client.request<Record<string, unknown>>('thread/start', {
      cwd: canonicalWorkspace,
      model: config.modelId,
      sandbox,
      approvalPolicy,
      baseInstructions: config.instructions || undefined,
      ephemeral: false,
    })
    const thread = res?.thread as Record<string, unknown> | undefined
    if (!thread || typeof thread.id !== 'string') {
      throw new JsonRpcClientError('MALFORMED_PAYLOAD', 'Invalid thread/start response')
    }

    this.sessionConfig.set(thread.id, { ...config, workspace: canonicalWorkspace })
    return {
      id: thread.id,
      externalId: thread.id,
      runtimeId: this.id,
    }
  }

  async resumeSession(threadId: string, config: SessionConfig): Promise<Session> {
    const evidence = this.options.permissionEvidence ?? null
    const fullOptIn = this.options.fullAccessOptIn ?? false
    if (!canEnablePermission(config.permission, evidence, fullOptIn)) {
      throw new JsonRpcClientError(
        'TRANSPORT_ERROR',
        `Permission mode '${config.permission}' is not verified/permitted for Codex runtime`,
      )
    }

    await this.requireVerifiedChatGptAccount()
    const canonicalWorkspace = await this.canonicalizeWorkspace(config.workspace)
    const client = await this.ensureInitialized()
    const { sandbox, approvalPolicy } = mapPermissionToCodex(config.permission)
    const res = await client.request<Record<string, unknown>>('thread/resume', {
      threadId,
      cwd: canonicalWorkspace,
      model: config.modelId,
      sandbox,
      approvalPolicy,
    })
    const thread = res?.thread as Record<string, unknown> | undefined
    if (!thread || typeof thread.id !== 'string') {
      throw new JsonRpcClientError('MALFORMED_PAYLOAD', 'Invalid thread/resume response')
    }
    this.sessionConfig.set(thread.id, { ...config, workspace: canonicalWorkspace })
    return {
      id: thread.id,
      externalId: thread.id,
      runtimeId: this.id,
    }
  }

  async *run(request: AgentRequest): AsyncIterable<AgentEvent> {
    const config = this.sessionConfig.get(request.session.externalId)
    if (!config) {
      throw new JsonRpcClientError('TRANSPORT_ERROR', 'Session not found; call createSession first')
    }
    if (this.activeRunsByThread.has(request.session.externalId)) {
      throw new JsonRpcClientError(
        'TRANSPORT_ERROR',
        `Thread ${request.session.externalId} already has an active run`,
      )
    }

    await this.requireVerifiedChatGptAccount()
    const canonicalWorkspace = await this.canonicalizeWorkspace(config.workspace)
    const client = await this.ensureInitialized()

    const active: ActiveRun = {
      runId: request.runId,
      threadId: request.session.externalId,
      turnId: null,
      pendingNotifications: [],
      seq: 0,
      queue: [],
      waiter: null,
      done: false,
      cancelled: false,
    }
    this.activeRunsByThread.set(active.threadId, active)
    this.activeRunsById.set(active.runId, active)

    try {
      const { approvalPolicy } = mapPermissionToCodex(config.permission)
      const sandboxPolicy = buildCodexSandboxPolicy(config.permission, canonicalWorkspace)
      const turnRes = await client.request<Record<string, unknown>>('turn/start', {
        threadId: active.threadId,
        input: [{ type: 'text', text: request.text }],
        cwd: canonicalWorkspace,
        model: config.modelId,
        effort: config.effort,
        approvalPolicy,
        sandboxPolicy,
      })
      const turn = turnRes?.turn as Record<string, unknown> | undefined
      if (!turn || typeof turn.id !== 'string') {
        throw new JsonRpcClientError('MALFORMED_PAYLOAD', 'Invalid turn/start response')
      }
      active.turnId = turn.id
      if (active.pendingNotifications.length > 0) {
        const buffered = active.pendingNotifications.splice(0, active.pendingNotifications.length)
        for (const bufferedNotif of buffered) {
          this.handleNotification(bufferedNotif)
        }
      }

      if (active.cancelled && !active.done) {
        try {
          await client.request('turn/interrupt', {
            threadId: active.threadId,
            turnId: active.turnId,
          })
        } catch {
          this.pushEvent(active, { type: 'run.cancelled' })
          active.done = true
        }
      }

      while (!active.done || active.queue.length > 0) {
        if (active.queue.length > 0) {
          yield active.queue.shift()!
          continue
        }
        await new Promise<void>((resolveWait) => {
          active.waiter = resolveWait
        })
      }
    } finally {
      this.revokePendingApprovalsForRun(request.runId)
      this.activeRunsByThread.delete(active.threadId)
      this.activeRunsById.delete(active.runId)
    }
  }

  async cancel(runId: string): Promise<void> {
    const active = this.activeRunsById.get(runId)
    if (!active || active.done) return
    active.cancelled = true
    this.revokePendingApprovalsForRun(runId)
    if (!active.turnId) return
    const client = await this.ensureInitialized()
    await client.request('turn/interrupt', {
      threadId: active.threadId,
      turnId: active.turnId,
    })
  }

  async resolveApproval(decision: ApprovalDecision): Promise<void> {
    const pending = this.pendingApprovals.get(decision.approvalId)
    if (!pending) {
      throw new JsonRpcClientError('TRANSPORT_ERROR', 'Approval request not found or already expired')
    }
    if (pending.runId !== decision.runId || pending.argsHash !== decision.argsHash) {
      throw new JsonRpcClientError(
        'TRANSPORT_ERROR',
        'Approval decision mismatch on runId or argsHash',
      )
    }
    if (Date.now() > pending.expiresAtMs) {
      this.pendingApprovals.delete(decision.approvalId)
      clearTimeout(pending.timer)
      pending.resolve('decline')
      throw new JsonRpcClientError('TIMEOUT', 'Approval request expired')
    }

    this.pendingApprovals.delete(decision.approvalId)
    clearTimeout(pending.timer)
    pending.resolve(decision.decision === 'allow-once' ? 'accept' : 'decline')
  }

  private pushEvent(active: ActiveRun, payload: EventPayload): void {
    active.seq += 1
    active.queue.push({
      ...payload,
      runId: active.runId,
      seq: active.seq,
      timestamp: new Date().toISOString(),
    })
    if (active.waiter) {
      const w = active.waiter
      active.waiter = null
      w()
    }
  }

  private failAllActiveRuns(code: string, message: string): void {
    this.revokeAllPendingApprovals()
    for (const active of this.activeRunsById.values()) {
      if (!active.done) {
        this.pushEvent(active, { type: 'run.failed', code, message })
        active.done = true
        if (active.waiter) {
          const w = active.waiter
          active.waiter = null
          w()
        }
      }
    }
  }

  private handleNotification(n: JsonRpcNotification): void {
    const p = (n.params && typeof n.params === 'object' ? n.params : {}) as Record<string, unknown>

    if (n.method === 'account/login/completed') {
      if (this.loginWaiter) {
        const w = this.loginWaiter
        this.loginWaiter = null
        if (p.success === true) {
          w.resolve({ status: 'connected' })
        } else {
          w.resolve({
            status: 'error',
            detail: typeof p.error === 'string' ? p.error : 'Login failed',
          })
        }
      }
      return
    }

    const threadId = typeof p.threadId === 'string' ? p.threadId : null
    if (!threadId) return
    const active = this.activeRunsByThread.get(threadId)
    if (!active || active.done) return

    const turnObj = p.turn && typeof p.turn === 'object' ? (p.turn as Record<string, unknown>) : null
    const notifTurnId =
      typeof p.turnId === 'string'
        ? p.turnId
        : typeof turnObj?.id === 'string'
          ? turnObj.id
          : null
    if (notifTurnId !== null) {
      if (active.turnId === null) {
        // turn/start response and notifications can arrive in the same stdout read chunk before
        // the turn/start promise continuation assigns active.turnId; buffer until turnId is known.
        active.pendingNotifications.push(n)
        return
      }
      if (notifTurnId !== active.turnId) {
        return
      }
    }

    switch (n.method) {
      case 'item/agentMessage/delta': {
        if (typeof p.delta === 'string') {
          this.pushEvent(active, { type: 'message.delta', text: p.delta })
        }
        break
      }
      case 'item/started':
      case 'item/completed': {
        const item = p.item && typeof p.item === 'object' ? (p.item as Record<string, unknown>) : null
        if (!item || typeof item.type !== 'string' || item.type === 'agentMessage') break
        const callId = typeof item.id === 'string' ? item.id : randomUUID()
        this.pushEvent(active, {
          type: n.method === 'item/started' ? 'tool.started' : 'tool.completed',
          tool: item.type,
          callId,
          summary: typeof item.command === 'string' ? item.command : item.type,
        })
        break
      }
      case 'thread/tokenUsage/updated': {
        const tu = p.tokenUsage as Record<string, unknown> | undefined
        const last = tu?.last as Record<string, unknown> | undefined
        if (last) {
          this.pushEvent(active, {
            type: 'usage.updated',
            usage: {
              source: 'provider',
              observedAt: new Date().toISOString(),
              windows: [],
              inputTokens: typeof last.inputTokens === 'number' ? last.inputTokens : undefined,
              outputTokens: typeof last.outputTokens === 'number' ? last.outputTokens : undefined,
            },
          })
        }
        break
      }
      case 'turn/completed': {
        this.revokePendingApprovalsForRun(active.runId)
        const turn = p.turn as Record<string, unknown> | undefined
        const status = turn?.status
        if (status === 'interrupted' || active.cancelled) {
          this.pushEvent(active, { type: 'run.cancelled' })
        } else if (status === 'failed') {
          const errObj = turn?.error as Record<string, unknown> | undefined
          this.pushEvent(active, {
            type: 'run.failed',
            code: 'TURN_FAILED',
            message: typeof errObj?.message === 'string' ? errObj.message : 'Codex turn failed',
          })
        } else {
          this.pushEvent(active, { type: 'run.completed' })
        }
        active.done = true
        if (active.waiter) {
          const w = active.waiter
          active.waiter = null
          w()
        }
        break
      }
      case 'error': {
        this.revokePendingApprovalsForRun(active.runId)
        const msg = typeof p.message === 'string' ? p.message : 'Codex server error'
        this.pushEvent(active, { type: 'run.failed', code: 'SERVER_ERROR', message: msg })
        active.done = true
        if (active.waiter) {
          const w = active.waiter
          active.waiter = null
          w()
        }
        break
      }
    }
  }

  private async handleServerRequest(req: JsonRpcServerRequest): Promise<unknown> {
    const p = (req.params && typeof req.params === 'object' ? req.params : {}) as Record<
      string,
      unknown
    >
    const threadId = typeof p.threadId === 'string' ? p.threadId : null
    const active = threadId ? this.activeRunsByThread.get(threadId) : undefined

    if (
      req.method === 'item/commandExecution/requestApproval' ||
      req.method === 'item/fileChange/requestApproval' ||
      req.method === 'execCommandApproval' ||
      req.method === 'applyPatchApproval'
    ) {
      if (!active) {
        return { decision: 'decline' }
      }
      if (active.turnId !== null && typeof p.turnId === 'string' && p.turnId !== active.turnId) {
        return { decision: 'decline' }
      }
      const approvalId =
        typeof p.approvalId === 'string'
          ? p.approvalId
          : typeof p.itemId === 'string'
            ? p.itemId
            : randomUUID()
      const argsHash = stableHash({ method: req.method, params: p })
      const timeoutMs = this.options.approvalTimeoutMs ?? 60_000
      const expiresAtMs = Date.now() + timeoutMs
      const summary =
        typeof p.command === 'string'
          ? `Run command: ${p.command}`
          : typeof p.reason === 'string'
            ? p.reason
            : req.method

      return new Promise<{ decision: 'accept' | 'decline' }>((resolveDecision) => {
        const timer = setTimeout(() => {
          if (this.pendingApprovals.delete(approvalId)) {
            resolveDecision({ decision: 'decline' })
          }
        }, timeoutMs)

        this.pendingApprovals.set(approvalId, {
          approvalId,
          runId: active.runId,
          argsHash,
          expiresAtMs,
          timer,
          resolve: (decision) => resolveDecision({ decision }),
        })

        this.pushEvent(active, {
          type: 'approval.requested',
          approvalId,
          tool: req.method,
          argsHash,
          summary,
          expiresAt: new Date(expiresAtMs).toISOString(),
        })
      })
    }

    // Fail closed on unknown/unsupported server requests (e.g. dynamic tool calls or permissions).
    return { decision: 'decline' }
  }
}
