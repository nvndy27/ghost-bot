import { createHash, randomUUID } from 'node:crypto'
import type {
  BrowserAction,
  BrowserCapabilities,
  BrowserObservation,
} from '@ghost-bot/computer-use/browser-contracts'
import { BwrapIsolatedBrowserWorker } from '@ghost-bot/computer-use/isolated-browser'
import type {
  LiveViewerFrame,
  VirtualDesktopCapabilities,
} from '@ghost-bot/computer-use/virtual-desktop-contracts'
import { WestonHeadlessVirtualDesktop } from '@ghost-bot/computer-use/weston'
import type { BotRepository } from '../bots/repository.ts'
import type { DatabaseHandle } from '../db/client.ts'
import { DaemonError, redactSecrets } from '../errors.ts'
import { LOCAL_USER_ID } from '../memory/service.ts'
import type { RuntimePolicyBroker } from '../runtime/policy-broker.ts'

const MAX_OBSERVATION_BYTES = 2 * 1024 * 1024
const MAX_VIEWER_FPS = 2
const DEFAULT_APPROVAL_TTL_MS = 120_000

export interface ComputerUseCapabilitiesDto {
  browser: BrowserCapabilities
  virtualDesktop: VirtualDesktopCapabilities
  liveModelDrivenEnabled: false
  hostDesktopControlSupported: false
}

export interface ComputerUseSessionDto {
  id: string
  ownerId: string
  botId: string
  runId: string
  sessionKind: 'isolated-browser'
  state: 'created' | 'active' | 'stopped' | 'emergency_stopped' | 'failed' | 'interrupted'
  allowObservation: boolean
  allowNavigation: boolean
  allowInteraction: boolean
  allowedOrigins: string[]
  inheritedFromTeamOrRoutine: false
  workerPid: number | null
  emergencyStopReason: string | null
  activeTabId: string | null
  createdAt: string
  updatedAt: string
  closedAt: string | null
}

export interface ComputerUseApprovalDto {
  id: string
  cuSessionId: string
  ownerId: string
  botId: string
  runId: string
  tabId: string
  observationId: string
  navigationGeneration: number
  actionId: string
  actionKind: string
  actionHash: string
  status: 'pending' | 'approved' | 'denied' | 'consumed' | 'revoked' | 'expired'
  expiresAt: string
  createdAt: string
  resolvedAt: string | null
}

export interface ComputerUseLedgerEntryDto {
  id: string
  cuSessionId: string
  ownerId: string
  botId: string
  runId: string
  tabId: string | null
  observationId: string | null
  navigationGeneration: number | null
  actionId: string | null
  actionKind: string
  approvalId: string | null
  outcomeStatus: 'completed' | 'failed' | 'denied' | 'cancelled' | 'uncertain'
  sanitizedSummary: string
  errorCode: string | null
  replayAllowed: false
  createdAt: string
}

export interface ComputerUseObservationDto {
  observationId: string
  sessionId: string
  tabId: string
  url: string
  navigationGeneration: number
  viewport: { width: number; height: number }
  mimeType: 'image/png'
  byteLength: number
  sha256: string
  capturedAt: string
  sanitizedSummary: string
  isIsolatedBrowser: true
  imageBase64: string
  viewerFrame: LiveViewerFrame
}

interface ActiveWorkerEntry {
  worker: BwrapIsolatedBrowserWorker
  activeTabId: string
  tabGenerations: Map<string, number>
  latestObservations: Map<string, { observationId: string; navigationGeneration: number; capturedAt: string }>
  frameSeq: number
  lastFrameAtMs: number
  backpressureDropCount: number
  inFlightActionId: string | null
}

function hashActionPayload(action: BrowserAction): string {
  return createHash('sha256').update(JSON.stringify(action)).digest('hex')
}

function sanitizeActionSummary(action: BrowserAction): string {
  switch (action.kind) {
    case 'navigate':
      return `navigate:${action.url.slice(0, 120)}`
    case 'click_selector':
      return `click_selector:${action.selector.slice(0, 80)}`
    case 'click_point':
      return `click_point:(${action.x},${action.y})`
    case 'type_text':
      // Never persist typed text secrets
      return `type_text:${action.selector.slice(0, 60)}:[REDACTED len=${action.text.length}]`
    case 'scroll':
      return `scroll:(${action.deltaX},${action.deltaY})`
    case 'key_press':
      return `key_press:${action.key}`
    case 'wait':
      return `wait:${action.durationMs}ms`
  }
}

export class ComputerUseService {
  private readonly dbHandle: DatabaseHandle
  private readonly botRepo: BotRepository
  private readonly policyBroker: RuntimePolicyBroker
  private readonly workers = new Map<string, ActiveWorkerEntry>()
  private readonly weston = new WestonHeadlessVirtualDesktop()
  private readonly createWorker: () => BwrapIsolatedBrowserWorker

  constructor(
    dbHandle: DatabaseHandle,
    botRepo: BotRepository,
    policyBroker: RuntimePolicyBroker,
    options: { createWorker?: () => BwrapIsolatedBrowserWorker } = {},
  ) {
    this.dbHandle = dbHandle
    this.botRepo = botRepo
    this.policyBroker = policyBroker
    this.createWorker = options.createWorker ?? (() => new BwrapIsolatedBrowserWorker())
  }

  async getCapabilities(): Promise<ComputerUseCapabilitiesDto> {
    const worker = this.createWorker()
    let browser: BrowserCapabilities
    try {
      await worker.start()
      browser = await worker.probeCapabilities()
    } catch (err) {
      browser = {
        engine: 'chromium',
        executablePath: null,
        sandboxed: true,
        headless: true,
        contextIsolation: true,
        temporaryProfileSupported: true,
        networkPolicyMode: 'allowlist',
        notes: [redactSecrets(err instanceof Error ? err.message : 'Isolated browser probe unavailable')],
      }
    } finally {
      await worker.close().catch(() => {})
    }

    const vd = await this.weston.probeCapabilities()
    return {
      browser,
      virtualDesktop: {
        ...vd,
        frameCaptureSupported: false,
        inputInjectionSupported: false,
      },
      liveModelDrivenEnabled: false,
      hostDesktopControlSupported: false,
    }
  }

  async createSession(input: {
    botId: string
    runId: string
    explicitConsent: boolean
    inheritedFromTeamOrRoutine?: boolean
    allowObservation: boolean
    allowNavigation: boolean
    allowInteraction: boolean
    allowedOrigins: string[]
    viewport?: { width: number; height: number }
    liveModelDriven?: boolean
  }): Promise<ComputerUseSessionDto> {
    const bot = this.botRepo.getBot(input.botId)
    if (!bot) {
      throw new DaemonError('BOT_NOT_FOUND', `Bot "${input.botId}" not found or archived`, {
        statusCode: 404,
      })
    }

    const runRow = this.dbHandle.sqlite
      .prepare(`SELECT id, agent_id, status FROM runs WHERE id = ?`)
      .get(input.runId) as { id: string; agent_id: string; status: string } | undefined
    if (!runRow || runRow.agent_id !== input.botId) {
      throw new DaemonError(
        'CU_RUN_MISMATCH',
        `Authoritative daemon run "${input.runId}" not found for bot "${input.botId}"`,
        { statusCode: 403 },
      )
    }

    const decision = this.policyBroker.evaluateComputerUsePolicy({
      requestedPermission: bot.permission,
      explicitConsent: input.explicitConsent,
      inheritedFromTeamOrRoutine: input.inheritedFromTeamOrRoutine ?? false,
      allowObservation: input.allowObservation,
      allowNavigation: input.allowNavigation,
      allowInteraction: input.allowInteraction,
      liveModelDriven: input.liveModelDriven,
    })
    if (!decision.allowed) {
      throw new DaemonError(decision.reasonCode, decision.reason, { statusCode: 403 })
    }

    const sessionId = `cus_${randomUUID()}`
    const nowIso = new Date().toISOString()

    this.dbHandle.sqlite
      .prepare(
        `INSERT INTO cu_sessions (
          id, owner_id, bot_id, run_id, session_kind, state,
          allow_observation, allow_navigation, allow_interaction,
          allowed_origins_json, inherited_from_team_or_routine,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'isolated-browser', 'created', ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        sessionId,
        LOCAL_USER_ID,
        input.botId,
        input.runId,
        decision.allowObservation ? 1 : 0,
        decision.allowNavigation ? 1 : 0,
        decision.allowInteraction ? 1 : 0,
        JSON.stringify(input.allowedOrigins),
        nowIso,
        nowIso,
      )

    const worker = this.createWorker()
    try {
      await worker.start()
      const created = await worker.createSession({
        sessionId,
        scope: {
          ownerId: LOCAL_USER_ID,
          botId: input.botId,
          allowObservation: decision.allowObservation,
          allowNavigation: decision.allowNavigation,
          allowInteraction: decision.allowInteraction,
          allowedOrigins: input.allowedOrigins,
          maxTabs: 4,
          maxActionsPerBatch: 1,
        },
        viewport: input.viewport,
        headless: true,
      })
      if (created.hasNoSandboxFlag) {
        throw new DaemonError('CU_SANDBOX_VIOLATION', 'Chromium launched with --no-sandbox; aborted', {
          statusCode: 500,
        })
      }
      const tab = await worker.openTab(sessionId, LOCAL_USER_ID, input.botId)
      const tabGenerations = new Map<string, number>([[tab.tabId, tab.navigationGeneration]])

      this.workers.set(sessionId, {
        worker,
        activeTabId: tab.tabId,
        tabGenerations,
        latestObservations: new Map(),
        frameSeq: 0,
        lastFrameAtMs: 0,
        backpressureDropCount: 0,
        inFlightActionId: null,
      })

      const activeIso = new Date().toISOString()
      this.dbHandle.sqlite
        .prepare(
          `UPDATE cu_sessions SET state = 'active', worker_pid = ?, updated_at = ? WHERE id = ?`,
        )
        .run(worker.getPid(), activeIso, sessionId)

      this.appendLedger({
        cuSessionId: sessionId,
        botId: input.botId,
        runId: input.runId,
        tabId: tab.tabId,
        actionKind: 'session.created',
        outcomeStatus: 'completed',
        sanitizedSummary: `Created isolated browser session (${input.allowedOrigins.length} allowed origins)`,
      })

      return this.getSession(sessionId)
    } catch (err) {
      await worker.emergencyStop().catch(() => {})
      const failIso = new Date().toISOString()
      this.dbHandle.sqlite
        .prepare(`UPDATE cu_sessions SET state = 'failed', updated_at = ?, closed_at = ? WHERE id = ?`)
        .run(failIso, failIso, sessionId)
      this.appendLedger({
        cuSessionId: sessionId,
        botId: input.botId,
        runId: input.runId,
        actionKind: 'session.failed',
        outcomeStatus: 'failed',
        sanitizedSummary: redactSecrets(err instanceof Error ? err.message : 'Worker startup failed'),
        errorCode: 'CU_WORKER_START_FAILED',
      })
      if (err instanceof DaemonError) throw err
      throw new DaemonError(
        'CU_WORKER_START_FAILED',
        redactSecrets(err instanceof Error ? err.message : 'Failed to start isolated browser worker'),
        { statusCode: 500 },
      )
    }
  }

  listSessions(botId?: string, limit = 50): ComputerUseSessionDto[] {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)))
    const rows = botId
      ? (this.dbHandle.sqlite
          .prepare(
            `SELECT * FROM cu_sessions WHERE owner_id = ? AND bot_id = ? ORDER BY created_at DESC LIMIT ?`,
          )
          .all(LOCAL_USER_ID, botId, safeLimit) as Record<string, unknown>[])
      : (this.dbHandle.sqlite
          .prepare(`SELECT * FROM cu_sessions WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?`)
          .all(LOCAL_USER_ID, safeLimit) as Record<string, unknown>[])
    return rows.map((r) => this.rowToSession(r))
  }

  getSession(sessionId: string): ComputerUseSessionDto {
    const row = this.dbHandle.sqlite
      .prepare(`SELECT * FROM cu_sessions WHERE id = ? AND owner_id = ?`)
      .get(sessionId, LOCAL_USER_ID) as Record<string, unknown> | undefined
    if (!row) {
      throw new DaemonError('CU_SESSION_NOT_FOUND', `Computer Use session "${sessionId}" not found`, {
        statusCode: 404,
      })
    }
    return this.rowToSession(row)
  }

  async observeTab(sessionId: string, tabId?: string): Promise<ComputerUseObservationDto> {
    const session = this.getSession(sessionId)
    if (session.state !== 'active') {
      throw new DaemonError('CU_SESSION_NOT_ACTIVE', `Session "${sessionId}" is ${session.state}`, {
        statusCode: 409,
      })
    }
    if (!session.allowObservation) {
      throw new DaemonError('CU_OBSERVATION_FORBIDDEN', 'Observation permission not granted', {
        statusCode: 403,
      })
    }
    const entry = this.workers.get(sessionId)
    if (!entry) {
      throw new DaemonError('CU_WORKER_DISCONNECTED', 'Browser worker is not attached', {
        statusCode: 409,
      })
    }

    const targetTabId = tabId ?? entry.activeTabId
    let obs: BrowserObservation
    try {
      obs = await entry.worker.observeTab(sessionId, session.ownerId, session.botId, targetTabId)
    } catch (err) {
      await this.handleWorkerDisconnect(sessionId, err)
      throw new DaemonError(
        'CU_WORKER_DISCONNECTED',
        redactSecrets(err instanceof Error ? err.message : 'Browser worker disconnected during observation'),
        { statusCode: 502 },
      )
    }

    if (obs.byteLength > MAX_OBSERVATION_BYTES) {
      throw new DaemonError('CU_OBSERVATION_TOO_LARGE', 'Screenshot exceeds 2 MiB limit', {
        statusCode: 413,
      })
    }

    entry.tabGenerations.set(obs.tabId, obs.navigationGeneration)
    entry.latestObservations.set(obs.tabId, {
      observationId: obs.observationId,
      navigationGeneration: obs.navigationGeneration,
      capturedAt: obs.capturedAt,
    })

    const nowMs = Date.now()
    const minIntervalMs = Math.floor(1000 / MAX_VIEWER_FPS)
    if (nowMs - entry.lastFrameAtMs < minIntervalMs) {
      entry.backpressureDropCount += 1
    }
    entry.lastFrameAtMs = nowMs
    entry.frameSeq += 1

    this.appendLedger({
      cuSessionId: sessionId,
      botId: session.botId,
      runId: session.runId,
      tabId: obs.tabId,
      observationId: obs.observationId,
      navigationGeneration: obs.navigationGeneration,
      actionKind: 'observe_tab',
      outcomeStatus: 'completed',
      sanitizedSummary: `Observed tab ${obs.tabId} (gen ${obs.navigationGeneration}, ${obs.byteLength} bytes)`,
    })

    return {
      observationId: obs.observationId,
      sessionId: obs.sessionId,
      tabId: obs.tabId,
      url: obs.url,
      navigationGeneration: obs.navigationGeneration,
      viewport: obs.viewport,
      mimeType: obs.mimeType,
      byteLength: obs.byteLength,
      sha256: obs.sha256,
      capturedAt: obs.capturedAt,
      sanitizedSummary: obs.sanitizedSummary,
      isIsolatedBrowser: true,
      imageBase64: Buffer.from(obs.buffer).toString('base64'),
      viewerFrame: {
        sessionId: obs.sessionId,
        frameSeq: entry.frameSeq,
        timestamp: obs.capturedAt,
        width: obs.viewport.width,
        height: obs.viewport.height,
        mimeType: 'image/png',
        byteLength: obs.byteLength,
        captureStatus: 'streaming',
        backpressureDropCount: entry.backpressureDropCount,
        stale: false,
        executionStatus: 'idle',
        emergencyStopSignaled: false,
      },
    }
  }

  requestActionApproval(input: {
    sessionId: string
    tabId: string
    observationId: string
    navigationGeneration: number
    action: BrowserAction
    ttlMs?: number
  }): ComputerUseApprovalDto {
    const session = this.getSession(input.sessionId)
    if (session.state !== 'active') {
      throw new DaemonError('CU_SESSION_NOT_ACTIVE', `Session "${input.sessionId}" is ${session.state}`, {
        statusCode: 409,
      })
    }
    const entry = this.workers.get(input.sessionId)
    if (!entry) {
      throw new DaemonError('CU_WORKER_DISCONNECTED', 'Browser worker is not attached', {
        statusCode: 409,
      })
    }

    const latestObs = entry.latestObservations.get(input.tabId)
    if (
      !latestObs ||
      latestObs.observationId !== input.observationId ||
      latestObs.navigationGeneration !== input.navigationGeneration
    ) {
      throw new DaemonError(
        'CU_STALE_OBSERVATION',
        'Approval request must bind to the latest valid observation and navigation generation',
        { statusCode: 409 },
      )
    }

    const ttlMs = Math.max(5_000, Math.min(300_000, input.ttlMs ?? DEFAULT_APPROVAL_TTL_MS))
    const nowMs = Date.now()
    const nowIso = new Date(nowMs).toISOString()
    const expiresAt = new Date(nowMs + ttlMs).toISOString()
    const approvalId = `cuapp_${randomUUID()}`
    const actionHash = hashActionPayload(input.action)

    try {
      this.dbHandle.sqlite
        .prepare(
          `INSERT INTO cu_action_approvals (
            id, cu_session_id, owner_id, bot_id, run_id,
            tab_id, observation_id, navigation_generation,
            action_id, action_kind, action_hash, status,
            expires_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          approvalId,
          session.id,
          session.ownerId,
          session.botId,
          session.runId,
          input.tabId,
          input.observationId,
          input.navigationGeneration,
          input.action.actionId,
          input.action.kind,
          actionHash,
          expiresAt,
          nowIso,
        )
    } catch {
      throw new DaemonError(
        'CU_DUPLICATE_ACTION_ID',
        `Action identity "${input.action.actionId}" was already requested for session "${session.id}"`,
        { statusCode: 409 },
      )
    }

    return this.getApproval(session.id, approvalId)
  }

  resolveActionApproval(
    sessionId: string,
    approvalId: string,
    decision: 'approved' | 'denied',
  ): ComputerUseApprovalDto {
    const session = this.getSession(sessionId)
    if (session.state !== 'active') {
      throw new DaemonError('CU_SESSION_NOT_ACTIVE', `Session "${sessionId}" is ${session.state}`, {
        statusCode: 409,
      })
    }

    const row = this.getApproval(sessionId, approvalId)
    if (row.status !== 'pending') {
      throw new DaemonError('CU_APPROVAL_NOT_PENDING', `Approval "${approvalId}" is ${row.status}`, {
        statusCode: 409,
      })
    }

    const nowMs = Date.now()
    const nowIso = new Date(nowMs).toISOString()
    if (nowMs >= Date.parse(row.expiresAt)) {
      this.dbHandle.sqlite
        .prepare(`UPDATE cu_action_approvals SET status = 'expired', resolved_at = ? WHERE id = ?`)
        .run(nowIso, approvalId)
      throw new DaemonError('CU_APPROVAL_EXPIRED', 'Computer Use approval expired before resolution', {
        statusCode: 409,
      })
    }

    const nextStatus = decision === 'approved' ? 'approved' : 'denied'
    this.dbHandle.sqlite
      .prepare(`UPDATE cu_action_approvals SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'`)
      .run(nextStatus, nowIso, approvalId)

    if (decision === 'denied') {
      this.appendLedger({
        cuSessionId: sessionId,
        botId: session.botId,
        runId: session.runId,
        tabId: row.tabId,
        observationId: row.observationId,
        navigationGeneration: row.navigationGeneration,
        actionId: row.actionId,
        actionKind: row.actionKind,
        approvalId,
        outcomeStatus: 'denied',
        sanitizedSummary: `Action ${row.actionKind} (${row.actionId}) denied by user`,
        errorCode: 'CU_APPROVAL_DENIED',
      })
    }

    return this.getApproval(sessionId, approvalId)
  }

  listApprovals(sessionId: string, limit = 50): ComputerUseApprovalDto[] {
    this.getSession(sessionId)
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)))
    const rows = this.dbHandle.sqlite
      .prepare(
        `SELECT * FROM cu_action_approvals WHERE cu_session_id = ? AND owner_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(sessionId, LOCAL_USER_ID, safeLimit) as Record<string, unknown>[]
    return rows.map((r) => this.rowToApproval(r))
  }

  async executeAction(input: {
    sessionId: string
    approvalId: string
    observationId: string
    navigationGeneration: number
    action: BrowserAction
  }): Promise<{
    outcomeStatus: 'completed' | 'failed' | 'cancelled' | 'uncertain'
    navigationGeneration: number
    errorCode?: string
    sanitizedSummary: string
  }> {
    const session = this.getSession(input.sessionId)
    if (session.state !== 'active') {
      throw new DaemonError('CU_SESSION_NOT_ACTIVE', `Session "${input.sessionId}" is ${session.state}`, {
        statusCode: 409,
      })
    }
    const entry = this.workers.get(input.sessionId)
    if (!entry) {
      throw new DaemonError('CU_WORKER_DISCONNECTED', 'Browser worker is not attached', {
        statusCode: 409,
      })
    }

    if (input.action.kind === 'navigate' && !session.allowNavigation) {
      throw new DaemonError('CU_NAVIGATION_FORBIDDEN', 'Navigation permission not granted', {
        statusCode: 403,
      })
    }
    if (input.action.kind !== 'navigate' && !session.allowInteraction) {
      throw new DaemonError('CU_INTERACTION_FORBIDDEN', 'Interaction permission not granted', {
        statusCode: 403,
      })
    }

    const approval = this.getApproval(input.sessionId, input.approvalId)
    const actionHash = hashActionPayload(input.action)
    const nowMs = Date.now()
    const nowIso = new Date(nowMs).toISOString()

    if (approval.status !== 'approved') {
      throw new DaemonError(
        'CU_APPROVAL_INVALID',
        `Approval "${input.approvalId}" is ${approval.status} (must be single-use approved)`,
        { statusCode: 403 },
      )
    }
    if (nowMs >= Date.parse(approval.expiresAt)) {
      this.dbHandle.sqlite
        .prepare(`UPDATE cu_action_approvals SET status = 'expired' WHERE id = ?`)
        .run(approval.id)
      throw new DaemonError('CU_APPROVAL_EXPIRED', 'Computer Use approval expired', { statusCode: 403 })
    }
    const targetTabId = 'tabId' in input.action ? input.action.tabId : entry.activeTabId
    if (
      approval.ownerId !== session.ownerId ||
      approval.botId !== session.botId ||
      approval.runId !== session.runId ||
      approval.tabId !== targetTabId ||
      approval.observationId !== input.observationId ||
      approval.navigationGeneration !== input.navigationGeneration ||
      approval.actionId !== input.action.actionId ||
      approval.actionHash !== actionHash
    ) {
      throw new DaemonError(
        'CU_APPROVAL_BINDING_MISMATCH',
        'Action does not match bound approval identity, observation, tab, or navigation generation',
        { statusCode: 403 },
      )
    }

    // Revalidate latest observation & navigation generation immediately before execution
    const latestObs = entry.latestObservations.get(targetTabId)
    const currentGen = entry.tabGenerations.get(targetTabId)
    if (
      !latestObs ||
      latestObs.observationId !== input.observationId ||
      currentGen !== input.navigationGeneration
    ) {
      this.dbHandle.sqlite
        .prepare(`UPDATE cu_action_approvals SET status = 'revoked' WHERE id = ?`)
        .run(approval.id)
      throw new DaemonError(
        'CU_STALE_OBSERVATION_OR_NAV',
        'Tab navigated or observation became stale before execution; approval revoked',
        { statusCode: 409 },
      )
    }

    // Atomically consume single-use approval BEFORE dispatching to worker
    const consumed = this.dbHandle.sqlite
      .prepare(
        `UPDATE cu_action_approvals
         SET status = 'consumed', resolved_at = ?
         WHERE id = ? AND status = 'approved'`,
      )
      .run(nowIso, approval.id)
    if (Number(consumed.changes) !== 1) {
      throw new DaemonError('CU_APPROVAL_ALREADY_CONSUMED', 'Approval was already consumed', {
        statusCode: 409,
      })
    }

    const sanitizedSummary = sanitizeActionSummary(input.action)
    entry.inFlightActionId = input.action.actionId

    try {
      const batchRes = await entry.worker.executeBatch({
        batchId: `batch_${randomUUID()}`,
        sessionId: session.id,
        ownerId: session.ownerId,
        botId: session.botId,
        actions: [input.action],
      })
      const step = batchRes.entries[0]
      if (!step) {
        throw new Error('Empty batch result from browser worker')
      }
      if (step.status === 'completed') {
        const nextGen =
          step.navigationGeneration ??
          (input.action.kind === 'navigate'
            ? (entry.tabGenerations.get(targetTabId) ?? 0) + 1
            : (entry.tabGenerations.get(targetTabId) ?? input.navigationGeneration))
        entry.tabGenerations.set(targetTabId, nextGen)
        this.appendLedger({
          cuSessionId: session.id,
          botId: session.botId,
          runId: session.runId,
          tabId: targetTabId,
          observationId: input.observationId,
          navigationGeneration: input.navigationGeneration,
          actionId: input.action.actionId,
          actionKind: input.action.kind,
          approvalId: approval.id,
          outcomeStatus: 'completed',
          sanitizedSummary,
        })
        return {
          outcomeStatus: 'completed',
          navigationGeneration: nextGen,
          sanitizedSummary,
        }
      }

      const outcomeStatus =
        step.status === 'cancelled' ? 'cancelled' : step.status === 'uncertain' ? 'uncertain' : 'failed'
      this.appendLedger({
        cuSessionId: session.id,
        botId: session.botId,
        runId: session.runId,
        tabId: targetTabId,
        observationId: input.observationId,
        navigationGeneration: input.navigationGeneration,
        actionId: input.action.actionId,
        actionKind: input.action.kind,
        approvalId: approval.id,
        outcomeStatus,
        sanitizedSummary,
        errorCode: step.errorCode ?? 'CU_ACTION_FAILED',
      })
      return {
        outcomeStatus,
        navigationGeneration: entry.tabGenerations.get(targetTabId) ?? input.navigationGeneration,
        errorCode: step.errorCode ?? undefined,
        sanitizedSummary,
      }
    } catch (err) {
      await this.handleWorkerDisconnect(session.id, err, {
        tabId: targetTabId,
        observationId: input.observationId,
        navigationGeneration: input.navigationGeneration,
        actionId: input.action.actionId,
        actionKind: input.action.kind,
        approvalId: approval.id,
        sanitizedSummary,
      })
      return {
        outcomeStatus: 'uncertain',
        navigationGeneration: input.navigationGeneration,
        errorCode: 'CU_EXECUTION_UNCERTAIN',
        sanitizedSummary,
      }
    } finally {
      entry.inFlightActionId = null
    }
  }

  listLedger(sessionId: string, limit = 50): ComputerUseLedgerEntryDto[] {
    this.getSession(sessionId)
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)))
    const rows = this.dbHandle.sqlite
      .prepare(
        `SELECT * FROM cu_action_ledger WHERE cu_session_id = ? AND owner_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(sessionId, LOCAL_USER_ID, safeLimit) as Record<string, unknown>[]
    return rows.map((r) => this.rowToLedger(r))
  }

  async closeSession(sessionId: string): Promise<ComputerUseSessionDto> {
    const session = this.getSession(sessionId)
    const entry = this.workers.get(sessionId)
    if (entry) {
      await entry.worker.close().catch(() => {})
      this.workers.delete(sessionId)
    }
    const nowIso = new Date().toISOString()
    if (session.state === 'created' || session.state === 'active') {
      this.dbHandle.sqlite
        .prepare(
          `UPDATE cu_sessions SET state = 'stopped', updated_at = ?, closed_at = ? WHERE id = ?`,
        )
        .run(nowIso, nowIso, sessionId)
      this.dbHandle.sqlite
        .prepare(
          `UPDATE cu_action_approvals SET status = 'revoked' WHERE cu_session_id = ? AND status IN ('pending', 'approved')`,
        )
        .run(sessionId)
      this.appendLedger({
        cuSessionId: sessionId,
        botId: session.botId,
        runId: session.runId,
        actionKind: 'session.closed',
        outcomeStatus: 'completed',
        sanitizedSummary: 'Closed isolated browser session',
      })
    }
    return this.getSession(sessionId)
  }

  async emergencyStop(sessionId: string, reason = 'User emergency stop'): Promise<{
    session: ComputerUseSessionDto
    confirmed: boolean
  }> {
    const session = this.getSession(sessionId)
    const nowIso = new Date().toISOString()
    this.dbHandle.sqlite
      .prepare(
        `UPDATE cu_action_approvals SET status = 'revoked' WHERE cu_session_id = ? AND status IN ('pending', 'approved')`,
      )
      .run(sessionId)

    let confirmed = true
    const entry = this.workers.get(sessionId)
    if (entry) {
      const stopRes = await entry.worker.emergencyStop()
      confirmed = stopRes.confirmed
      if (entry.inFlightActionId) {
        this.appendLedger({
          cuSessionId: sessionId,
          botId: session.botId,
          runId: session.runId,
          actionId: entry.inFlightActionId,
          actionKind: 'action.emergency_interrupted',
          outcomeStatus: 'uncertain',
          sanitizedSummary: 'In-flight action interrupted by emergency stop; replay forbidden',
          errorCode: 'CU_EMERGENCY_STOPPED',
        })
      }
      this.workers.delete(sessionId)
    }

    const nextState = confirmed ? 'emergency_stopped' : 'interrupted'
    this.dbHandle.sqlite
      .prepare(
        `UPDATE cu_sessions
         SET state = ?, emergency_stop_reason = ?, updated_at = ?, closed_at = ?
         WHERE id = ?`,
      )
      .run(nextState, redactSecrets(reason).slice(0, 240), nowIso, nowIso, sessionId)

    this.appendLedger({
      cuSessionId: sessionId,
      botId: session.botId,
      runId: session.runId,
      actionKind: 'session.emergency_stop',
      outcomeStatus: confirmed ? 'cancelled' : 'uncertain',
      sanitizedSummary: confirmed
        ? `Emergency stop confirmed: ${redactSecrets(reason).slice(0, 120)}`
        : 'Emergency stop requested; worker process termination unconfirmed',
      errorCode: confirmed ? 'CU_EMERGENCY_STOPPED' : 'CU_TERMINATION_UNCONFIRMED',
    })

    return { session: this.getSession(sessionId), confirmed }
  }

  reconcileOnStartup(): { interruptedSessions: number; revokedApprovals: number } {
    const nowIso = new Date().toISOString()
    return this.dbHandle.transaction(() => {
      const active = this.dbHandle.sqlite
        .prepare(`SELECT id, bot_id, run_id FROM cu_sessions WHERE state IN ('created', 'active')`)
        .all() as Array<{ id: string; bot_id: string; run_id: string }>

      const sessRes = this.dbHandle.sqlite
        .prepare(
          `UPDATE cu_sessions
           SET state = 'interrupted', updated_at = ?, closed_at = COALESCE(closed_at, ?)
           WHERE state IN ('created', 'active')`,
        )
        .run(nowIso, nowIso)

      const appRes = this.dbHandle.sqlite
        .prepare(
          `UPDATE cu_action_approvals
           SET status = 'revoked'
           WHERE status IN ('pending', 'approved')`,
        )
        .run()

      for (const s of active) {
        this.appendLedger({
          cuSessionId: s.id,
          botId: s.bot_id,
          runId: s.run_id,
          actionKind: 'session.reconciled_on_startup',
          outcomeStatus: 'uncertain',
          sanitizedSummary: 'Previous daemon exited while Computer Use session was active; replay forbidden',
          errorCode: 'CU_DAEMON_RESTARTED',
        })
      }

      return {
        interruptedSessions: Number(sessRes.changes),
        revokedApprovals: Number(appRes.changes),
      }
    })
  }

  pruneAuditRetention(olderThanIso: string): number {
    return this.dbHandle.transaction(() => {
      const res = this.dbHandle.sqlite
        .prepare(
          `DELETE FROM cu_action_ledger
           WHERE outcome_status IN ('completed', 'failed', 'denied', 'cancelled')
             AND created_at <= ?
             AND cu_session_id NOT IN (
               SELECT id FROM cu_sessions WHERE state IN ('created', 'active')
             )`,
        )
        .run(olderThanIso)
      return Number(res.changes)
    })
  }

  async shutdownAll(): Promise<void> {
    for (const sessionId of Array.from(this.workers.keys())) {
      await this.emergencyStop(sessionId, 'Daemon shutdown').catch(() => {})
    }
  }

  private async handleWorkerDisconnect(
    sessionId: string,
    err: unknown,
    inFlight?: {
      tabId: string
      observationId: string
      navigationGeneration: number
      actionId: string
      actionKind: string
      approvalId: string
      sanitizedSummary: string
    },
  ): Promise<void> {
    const session = this.getSession(sessionId)
    const entry = this.workers.get(sessionId)
    if (entry) {
      await entry.worker.emergencyStop().catch(() => {})
      this.workers.delete(sessionId)
    }
    const nowIso = new Date().toISOString()
    this.dbHandle.sqlite
      .prepare(`UPDATE cu_sessions SET state = 'interrupted', updated_at = ?, closed_at = ? WHERE id = ?`)
      .run(nowIso, nowIso, sessionId)
    this.dbHandle.sqlite
      .prepare(
        `UPDATE cu_action_approvals SET status = 'revoked' WHERE cu_session_id = ? AND status IN ('pending', 'approved')`,
      )
      .run(sessionId)

    if (inFlight) {
      this.appendLedger({
        cuSessionId: sessionId,
        botId: session.botId,
        runId: session.runId,
        tabId: inFlight.tabId,
        observationId: inFlight.observationId,
        navigationGeneration: inFlight.navigationGeneration,
        actionId: inFlight.actionId,
        actionKind: inFlight.actionKind,
        approvalId: inFlight.approvalId,
        outcomeStatus: 'uncertain',
        sanitizedSummary: `${inFlight.sanitizedSummary} (${redactSecrets(err instanceof Error ? err.message : 'worker disconnected').slice(0, 80)})`,
        errorCode: 'CU_EXECUTION_UNCERTAIN',
      })
    }
  }

  private getApproval(sessionId: string, approvalId: string): ComputerUseApprovalDto {
    const row = this.dbHandle.sqlite
      .prepare(
        `SELECT * FROM cu_action_approvals WHERE id = ? AND cu_session_id = ? AND owner_id = ?`,
      )
      .get(approvalId, sessionId, LOCAL_USER_ID) as Record<string, unknown> | undefined
    if (!row) {
      throw new DaemonError('CU_APPROVAL_NOT_FOUND', `Approval "${approvalId}" not found`, {
        statusCode: 404,
      })
    }
    return this.rowToApproval(row)
  }

  private appendLedger(input: {
    cuSessionId: string
    botId: string
    runId: string
    tabId?: string
    observationId?: string
    navigationGeneration?: number
    actionId?: string
    actionKind: string
    approvalId?: string
    outcomeStatus: 'completed' | 'failed' | 'denied' | 'cancelled' | 'uncertain'
    sanitizedSummary: string
    errorCode?: string
  }): void {
    this.dbHandle.sqlite
      .prepare(
        `INSERT INTO cu_action_ledger (
          id, cu_session_id, owner_id, bot_id, run_id,
          tab_id, observation_id, navigation_generation,
          action_id, action_kind, approval_id, outcome_status,
          sanitized_summary, error_code, replay_allowed, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        `cul_${randomUUID()}`,
        input.cuSessionId,
        LOCAL_USER_ID,
        input.botId,
        input.runId,
        input.tabId ?? null,
        input.observationId ?? null,
        input.navigationGeneration ?? null,
        input.actionId ?? null,
        input.actionKind,
        input.approvalId ?? null,
        input.outcomeStatus,
        redactSecrets(input.sanitizedSummary).slice(0, 500),
        input.errorCode ?? null,
        new Date().toISOString(),
      )
  }

  private rowToSession(r: Record<string, unknown>): ComputerUseSessionDto {
    const id = String(r.id)
    const entry = this.workers.get(id)
    return {
      id,
      ownerId: String(r.owner_id),
      botId: String(r.bot_id),
      runId: String(r.run_id),
      sessionKind: 'isolated-browser',
      state: r.state as ComputerUseSessionDto['state'],
      allowObservation: Number(r.allow_observation) === 1,
      allowNavigation: Number(r.allow_navigation) === 1,
      allowInteraction: Number(r.allow_interaction) === 1,
      allowedOrigins: JSON.parse(String(r.allowed_origins_json)) as string[],
      inheritedFromTeamOrRoutine: false,
      workerPid: r.worker_pid === null || r.worker_pid === undefined ? null : Number(r.worker_pid),
      emergencyStopReason:
        r.emergency_stop_reason === null || r.emergency_stop_reason === undefined
          ? null
          : String(r.emergency_stop_reason),
      activeTabId: entry?.activeTabId ?? null,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      closedAt: r.closed_at === null || r.closed_at === undefined ? null : String(r.closed_at),
    }
  }

  private rowToApproval(r: Record<string, unknown>): ComputerUseApprovalDto {
    return {
      id: String(r.id),
      cuSessionId: String(r.cu_session_id),
      ownerId: String(r.owner_id),
      botId: String(r.bot_id),
      runId: String(r.run_id),
      tabId: String(r.tab_id),
      observationId: String(r.observation_id),
      navigationGeneration: Number(r.navigation_generation),
      actionId: String(r.action_id),
      actionKind: String(r.action_kind),
      actionHash: String(r.action_hash),
      status: r.status as ComputerUseApprovalDto['status'],
      expiresAt: String(r.expires_at),
      createdAt: String(r.created_at),
      resolvedAt:
        r.resolved_at === null || r.resolved_at === undefined ? null : String(r.resolved_at),
    }
  }

  private rowToLedger(r: Record<string, unknown>): ComputerUseLedgerEntryDto {
    return {
      id: String(r.id),
      cuSessionId: String(r.cu_session_id),
      ownerId: String(r.owner_id),
      botId: String(r.bot_id),
      runId: String(r.run_id),
      tabId: r.tab_id === null || r.tab_id === undefined ? null : String(r.tab_id),
      observationId:
        r.observation_id === null || r.observation_id === undefined ? null : String(r.observation_id),
      navigationGeneration:
        r.navigation_generation === null || r.navigation_generation === undefined
          ? null
          : Number(r.navigation_generation),
      actionId: r.action_id === null || r.action_id === undefined ? null : String(r.action_id),
      actionKind: String(r.action_kind),
      approvalId: r.approval_id === null || r.approval_id === undefined ? null : String(r.approval_id),
      outcomeStatus: r.outcome_status as ComputerUseLedgerEntryDto['outcomeStatus'],
      sanitizedSummary: String(r.sanitized_summary),
      errorCode: r.error_code === null || r.error_code === undefined ? null : String(r.error_code),
      replayAllowed: false,
      createdAt: String(r.created_at),
    }
  }
}
