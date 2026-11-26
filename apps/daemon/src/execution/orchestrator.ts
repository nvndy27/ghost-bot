import { createHash, randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { PermissionMode, SessionConfig } from '@ghost-bot/shared-types/runtime'
import type { DatabaseHandle } from '../db/client.ts'
import { DaemonError, redactSecrets } from '../errors.ts'
import type { KnowledgeService, PreparedExecutionKnowledgeContext } from '../knowledge/service.ts'
import type { McpService } from '../mcp/service.ts'
import type { MemoryService, PreparedExecutionMemoryContext } from '../memory/service.ts'
import { RuntimePolicyBroker } from '../runtime/policy-broker.ts'
import type { CodexExecutionClient, RuntimeRegistry } from '../runtime/registry.ts'
import { serializeMessageContent } from '../sessions/repository.ts'
import type { SettingsRepository } from '../settings/repository.ts'
import {
  assembleCombinedExecutionContext,
  COMBINED_EXECUTION_CONTEXT_LIMITS,
  type CombinedExecutionContext,
} from './context-assembler.ts'
import { RunEventStore } from './event-store.ts'
import { buildMockScenarioPlan } from './mock-scenarios.ts'
import {
  ACTIVE_RUN_STATUSES,
  assertLegalTransition,
  isRunStatus,
  isTerminalStatus,
  resolveTerminalRace,
} from './state-machine.ts'
import type { RunStatus } from './state-machine.ts'

export interface RunErrorRecord {
  code: string
  message: string
  retryable: boolean
}

export interface PendingApprovalRecord {
  approvalId: string
  title: string
  command: string
  risk: 'low' | 'medium' | 'high'
  actionType?: string
  argsHash?: string
  permissionMode?: string
  expiresAt?: string
  isMock?: boolean
  status?: 'pending' | 'resolving' | 'approved' | 'denied' | 'expired' | 'revoked' | 'resolution_failed'
}

export interface RunRecord {
  id: string
  sessionId: string
  agentId: string
  idempotencyKey: string
  runtimeId: string
  modelId: string
  effort: string
  permissionMode: string
  configSnapshot: Record<string, unknown>
  status: RunStatus
  error: RunErrorRecord | null
  startedAt: string
  endedAt: string | null
  createdAt: string
  pendingApproval: PendingApprovalRecord | null
}

export interface StartRunInput {
  sessionId: string
  idempotencyKey: string
  text: string
}

export interface StartRunResult {
  run: RunRecord
  deduplicated: boolean
  userMessageId: string
  assistantMessageId: string
}

interface RawRunRow {
  id: string
  session_id: string
  agent_id: string
  idempotency_key: string
  runtime_id: string
  model_id: string
  effort: string
  permission_mode: string
  config_snapshot_json: string
  status: string
  error_json: string | null
  started_at: string
  ended_at: string | null
  created_at: string
}

interface ActiveRunControl {
  abortController: AbortController
  pendingApproval: {
    spec: PendingApprovalRecord
    resolve: (decision: 'approved' | 'denied' | 'cancelled') => void
  } | null
  liveCancel?: (runId: string) => Promise<void>
  liveResolveApproval?: (decision: {
    approvalId: string
    runId: string
    argsHash: string
    decision: 'allow-once' | 'deny'
  }) => Promise<void>
  cancelTimeout?: ReturnType<typeof setTimeout>
  donePromise: Promise<void>
}

const FLUSH_INTERVAL_MS = 140
const FLUSH_CHUNK_THRESHOLD = 16

function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // ignore malformed json
  }
  return {}
}

function parseRunError(raw: string | null): RunErrorRecord | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>
      if (typeof obj.code === 'string' && typeof obj.message === 'string') {
        return {
          code: obj.code,
          message: obj.message,
          retryable: Boolean(obj.retryable),
        }
      }
    }
  } catch {
    // ignore malformed error json
  }
  return null
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export interface RunOrchestratorOptions {
  runtimeRegistry?: RuntimeRegistry
  settingsRepo?: SettingsRepository
  policyBroker?: RuntimePolicyBroker
  memoryService?: MemoryService
  knowledgeService?: KnowledgeService
  mcpService?: McpService
}

const QUARANTINE_SETTINGS_KEY = 'execution.quarantinedSessions.v1'

export class RunOrchestrator {
  readonly eventStore: RunEventStore
  private readonly dbHandle: DatabaseHandle
  private readonly runtimeRegistry?: RuntimeRegistry
  private readonly settingsRepo?: SettingsRepository
  private readonly policyBroker: RuntimePolicyBroker
  private readonly memoryService?: MemoryService
  private readonly knowledgeService?: KnowledgeService
  private readonly mcpService?: McpService
  private readonly activeControls = new Map<string, ActiveRunControl>()
  private readonly sessionsWithUnconfirmedStop = new Map<string, number>()
  private stopping = false

  constructor(dbHandle: DatabaseHandle, options?: RunOrchestratorOptions) {
    this.dbHandle = dbHandle
    this.runtimeRegistry = options?.runtimeRegistry
    this.settingsRepo = options?.settingsRepo
    this.policyBroker = options?.policyBroker ?? new RuntimePolicyBroker()
    this.memoryService = options?.memoryService
    this.knowledgeService = options?.knowledgeService
    this.mcpService = options?.mcpService
    this.eventStore = new RunEventStore(dbHandle)
    this.loadDurableQuarantine()
  }

  private async prepareExecutionKnowledgeSafely(params: {
    sessionId: string
    agentId: string
    runtimeId: string
    queryText: string
    isMock: boolean
    maxBytesBudget: number
  }): Promise<PreparedExecutionKnowledgeContext> {
    if (!this.knowledgeService) {
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
    try {
      return await this.knowledgeService.prepareExecutionContext(params)
    } catch (err) {
      if (err instanceof DaemonError && err.code === 'KNOWLEDGE_AUTHORIZATION_FAILED') {
        throw err
      }
      return {
        status: 'error_omitted',
        mechanism: 'none',
        envelopeJson: null,
        selectedDocuments: 0,
        selectedChunks: 0,
        totalBytes: 0,
        truncated: false,
        citations: [],
      }
    }
  }

  private async prepareCombinedContextSafely(params: {
    sessionId: string
    agentId: string
    runtimeId: string
    queryText: string
    isMock: boolean
  }): Promise<CombinedExecutionContext> {
    const memory = await this.prepareExecutionMemorySafely(params)
    const remainingForKnowledge = Math.max(
      512,
      Math.min(
        COMBINED_EXECUTION_CONTEXT_LIMITS.maxKnowledgeBytes,
        COMBINED_EXECUTION_CONTEXT_LIMITS.maxCombinedBytes -
          memory.totalBytes -
          COMBINED_EXECUTION_CONTEXT_LIMITS.envelopeOverheadBytes,
      ),
    )
    const knowledge = await this.prepareExecutionKnowledgeSafely({
      ...params,
      maxBytesBudget: remainingForKnowledge,
    })
    return assembleCombinedExecutionContext(memory, knowledge)
  }

  private async prepareExecutionMemorySafely(params: {
    sessionId: string
    agentId: string
    runtimeId: string
    queryText: string
    isMock: boolean
  }): Promise<PreparedExecutionMemoryContext> {
    if (!this.memoryService) {
      return {
        status: 'disabled',
        mechanism: 'none',
        envelopeJson: null,
        selectedCount: 0,
        totalBytes: 0,
        truncated: false,
      }
    }
    try {
      return await this.memoryService.prepareExecutionContext(params)
    } catch (err) {
      if (err instanceof DaemonError && err.code === 'MEMORY_AUTHORIZATION_FAILED') {
        throw err
      }
      return {
        status: 'error_omitted',
        mechanism: 'none',
        envelopeJson: null,
        selectedCount: 0,
        totalBytes: 0,
        truncated: false,
      }
    }
  }

  private loadDurableQuarantine(): void {
    try {
      const row = this.dbHandle.sqlite
        .prepare('SELECT value_json FROM settings WHERE key = ?')
        .get(QUARANTINE_SETTINGS_KEY) as { value_json: string } | undefined
      if (!row) return
      const parsed = JSON.parse(row.value_json) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [sid, val] of Object.entries(parsed)) {
          if (typeof val === 'number' && Number.isFinite(val)) {
            this.sessionsWithUnconfirmedStop.set(sid, val)
          }
        }
      }
    } catch {
      // ignore malformed quarantine map
    }
  }

  private persistDurableQuarantine(): void {
    const obj: Record<string, number> = {}
    for (const [sid, gen] of this.sessionsWithUnconfirmedStop.entries()) {
      obj[sid] = gen
    }
    this.dbHandle.sqlite
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(QUARANTINE_SETTINGS_KEY, JSON.stringify(obj), new Date().toISOString())
  }

  private addQuarantine(sessionId: string): void {
    this.sessionsWithUnconfirmedStop.set(sessionId, this.runtimeRegistry?.getGeneration() ?? 0)
    this.persistDurableQuarantine()
  }

  private clearQuarantineForSession(sessionId: string): void {
    if (this.sessionsWithUnconfirmedStop.delete(sessionId)) {
      this.persistDurableQuarantine()
    }
  }

  private clearAllQuarantine(): void {
    if (this.sessionsWithUnconfirmedStop.size > 0) {
      this.sessionsWithUnconfirmedStop.clear()
      this.persistDurableQuarantine()
    }
  }

  private rowToRun(row: RawRunRow): RunRecord {
    const status: RunStatus = isRunStatus(row.status) ? row.status : 'failed'
    const control = this.activeControls.get(row.id)
    return {
      id: row.id,
      sessionId: row.session_id,
      agentId: row.agent_id,
      idempotencyKey: row.idempotency_key,
      runtimeId: row.runtime_id,
      modelId: row.model_id,
      effort: row.effort,
      permissionMode: row.permission_mode,
      configSnapshot: parseJsonObject(row.config_snapshot_json),
      status,
      error: parseRunError(row.error_json),
      startedAt: row.started_at,
      endedAt: row.ended_at,
      createdAt: row.created_at,
      pendingApproval: control?.pendingApproval?.spec ?? null,
    }
  }

  reconcileOnStartup(): number {
    const activePlaceholders = ACTIVE_RUN_STATUSES.map(() => '?').join(', ')
    const now = new Date().toISOString()

    return this.dbHandle.transaction(() => {
      const staleRuns = this.dbHandle.sqlite
        .prepare(
          `SELECT id, session_id, runtime_id, status FROM runs WHERE status IN (${activePlaceholders})`,
        )
        .all(...ACTIVE_RUN_STATUSES) as unknown as Array<{
        id: string
        session_id: string
        runtime_id: string
        status: string
      }>

      if (staleRuns.length === 0) {
        return 0
      }

      const errorJson = JSON.stringify({
        code: 'DAEMON_RESTARTED',
        message: 'Run was interrupted because the daemon stopped before completion.',
        retryable: true,
      })

      for (const stale of staleRuns) {
        this.dbHandle.sqlite
          .prepare(
            `UPDATE runs
             SET status = 'interrupted', ended_at = ?, error_json = ?
             WHERE id = ?`,
          )
          .run(now, errorJson, stale.id)

        // Reconstruct any committed message.delta events that were not yet flushed to messages.content_json
        const deltaRows = this.dbHandle.sqlite
          .prepare(
            `SELECT payload_json FROM run_events
             WHERE run_id = ? AND type = 'message.delta'
             ORDER BY seq ASC`,
          )
          .all(stale.id) as unknown as Array<{ payload_json: string }>

        if (deltaRows.length > 0) {
          let reconstructed = ''
          for (const d of deltaRows) {
            try {
              const p = JSON.parse(d.payload_json) as { delta?: unknown; text?: unknown }
              if (typeof p.delta === 'string') reconstructed += p.delta
              else if (typeof p.text === 'string') reconstructed += p.text
            } catch {
              // ignore malformed payload
            }
          }
          if (reconstructed.length > 0) {
            const msgRow = this.dbHandle.sqlite
              .prepare(`SELECT id, content_json FROM messages WHERE run_id = ? AND status = 'streaming' LIMIT 1`)
              .get(stale.id) as { id: string; content_json: string } | undefined
            if (msgRow) {
              const existingMeta = parseJsonObject(msgRow.content_json).meta as
                | Record<string, unknown>
                | undefined
              this.dbHandle.sqlite
                .prepare(`UPDATE messages SET content_json = ?, status = 'interrupted', updated_at = ? WHERE id = ?`)
                .run(serializeMessageContent(reconstructed, existingMeta), now, msgRow.id)
            }
          }
        }

        this.dbHandle.sqlite
          .prepare(
            `UPDATE messages
             SET status = 'interrupted', updated_at = ?
             WHERE run_id = ? AND status = 'streaming'`,
          )
          .run(now, stale.id)

        this.eventStore.appendEvent(stale.id, {
          eventKey: `run.interrupted:startup:${stale.id}`,
          type: 'run.interrupted',
          payload: {
            previousStatus: stale.status,
            reason: 'daemon_restarted',
          },
          timestamp: now,
        })

        // Reconstruct durable quarantine for any live provider run that may still have active
        // or uncertain execution/tool subprocesses (starting, running, awaiting_approval, cancelling).
        // Runs still in 'queued' never dispatched to the provider, and 'mock' has no external state.
        if (stale.runtime_id !== 'mock' && stale.status !== 'queued') {
          this.sessionsWithUnconfirmedStop.set(
            stale.session_id,
            this.runtimeRegistry?.getGeneration() ?? 0,
          )
          this.persistDurableQuarantine()
        }
      }

      // Startup reconciliation must never leave pending/resolving approvals actionable.
      this.dbHandle.sqlite
        .prepare(
          `UPDATE approvals
           SET status = 'revoked', resolved_at = ?, decision_meta_json = ?
           WHERE status IN ('pending', 'resolving')`,
        )
        .run(now, JSON.stringify({ reason: 'daemon_restarted' }))

      this.dbHandle.sqlite
        .prepare(
          `UPDATE mcp_approval_bindings
           SET dispatch_state = 'uncertain', updated_at = ?
           WHERE dispatch_state = 'dispatched'`,
        )
        .run(now)

      this.dbHandle.sqlite
        .prepare(
          `UPDATE mcp_approval_bindings
           SET dispatch_state = 'cancelled', updated_at = ?
           WHERE dispatch_state = 'pending'`,
        )
        .run(now)

      return staleRuns.length
    })
  }

  getRun(runId: string): RunRecord {
    const row = this.dbHandle.sqlite
      .prepare(
        `SELECT id, session_id, agent_id, idempotency_key, runtime_id, model_id, effort, permission_mode, config_snapshot_json, status, error_json, started_at, ended_at, created_at
         FROM runs
         WHERE id = ?`,
      )
      .get(runId) as RawRunRow | undefined

    if (!row) {
      throw new DaemonError('RUN_NOT_FOUND', `Run "${runId}" was not found`, {
        statusCode: 404,
      })
    }
    return this.rowToRun(row)
  }

  getRunEvents(runId: string, afterSeq = 0, limit = 200) {
    this.getRun(runId)
    return this.eventStore.listEventsAfter(runId, afterSeq, limit)
  }

  async startRun(input: StartRunInput): Promise<StartRunResult> {
    if (this.stopping) {
      throw new DaemonError('DAEMON_STOPPING', 'Daemon is shutting down', {
        statusCode: 503,
        retryable: true,
      })
    }

    const trimmedText = input.text.trim()
    if (!trimmedText) {
      throw new DaemonError('INVALID_INPUT', 'Message text cannot be empty', {
        statusCode: 400,
      })
    }

    const idempotencyKey = input.idempotencyKey.trim()
    if (!idempotencyKey || idempotencyKey.length > 128) {
      throw new DaemonError('INVALID_IDEMPOTENCY_KEY', 'A valid idempotencyKey is required', {
        statusCode: 400,
      })
    }

    // Generation changes alone do NOT clear quarantine; only confirmed provider termination
    // or explicit owned-runtime termination via reconnectRuntime() clears sessionsWithUnconfirmedStop.
    if (this.sessionsWithUnconfirmedStop.has(input.sessionId)) {
      throw new DaemonError(
        'RUN_STOP_UNCONFIRMED',
        `Previous run cancellation in session "${input.sessionId}" has not been confirmed stopped by the runtime.`,
        { statusCode: 409, retryable: true },
      )
    }

    // Preflight read of session & bot to prepare async Codex verification before atomic transaction.
    const preSession = this.dbHandle.sqlite
      .prepare('SELECT id, agent_id, runtime_id, account_id, external_session_id, archived_at FROM sessions WHERE id = ?')
      .get(input.sessionId) as
      | {
          id: string
          agent_id: string
          runtime_id: string
          account_id: string
          external_session_id: string | null
          archived_at: string | null
        }
      | undefined

    if (!preSession) {
      throw new DaemonError('SESSION_NOT_FOUND', `Session "${input.sessionId}" was not found`, {
        statusCode: 404,
      })
    }
    if (preSession.archived_at !== null) {
      throw new DaemonError('SESSION_ARCHIVED', 'Cannot start a run in an archived session', {
        statusCode: 409,
      })
    }

    const preBot = this.dbHandle.sqlite
      .prepare(
        `SELECT id, name, instructions, runtime_id, model_id, effort, workspace_path, permission_mode, archived_at
         FROM agents
         WHERE id = ?`,
      )
      .get(preSession.agent_id) as
      | {
          id: string
          name: string
          instructions: string
          runtime_id: string
          model_id: string
          effort: string
          workspace_path: string
          permission_mode: string
          archived_at: string | null
        }
      | undefined

    if (!preBot || preBot.archived_at !== null) {
      throw new DaemonError('BOT_NOT_FOUND', `Bot "${preSession.agent_id}" was not found or is archived`, {
        statusCode: 404,
      })
    }

    if (preBot.permission_mode === 'full-access') {
      throw new DaemonError(
        'PERMISSION_MODE_DISABLED',
        'Full Access permission mode is disabled in this release.',
        { statusCode: 403 },
      )
    }

    const isMockRuntime = preBot.runtime_id === 'mock' || preBot.runtime_id === 'mock-offline'
    const isCodexRuntime = preBot.runtime_id === 'codex'

    let codexPreflight: {
      adapter: CodexExecutionClient
      generation: number
      codexVersion: string | null
      accountKey: string
      canonicalWorkspace: string
      effectiveInstructions: string
      externalSessionId: string | null
    } | null = null

    if (isCodexRuntime) {
      if (!this.runtimeRegistry || this.runtimeRegistry.getRuntimeMode() !== 'codex') {
        throw new DaemonError(
          'LIVE_INFERENCE_DISABLED',
          'Live AI inference for Codex is disabled when the daemon is running in mock mode.',
          { statusCode: 501 },
        )
      }
      if (preSession.runtime_id !== 'codex') {
        throw new DaemonError(
          'SESSION_RUNTIME_MISMATCH',
          'Cannot run live Codex inference in a historical mock session; start a New conversation.',
          { statusCode: 409 },
        )
      }

      let canonicalWorkspace = ''
      try {
        canonicalWorkspace = await realpath(resolve(preBot.workspace_path))
        const st = await stat(canonicalWorkspace)
        if (!st.isDirectory()) {
          throw new Error('Not a directory')
        }
      } catch {
        throw new DaemonError(
          'INVALID_WORKSPACE',
          `Bot workspace path "${preBot.workspace_path}" is missing or not a directory`,
          { statusCode: 400 },
        )
      }

      const execInfo = await this.runtimeRegistry.getExecutionAdapter()
      const { adapter, generation, codexVersion, snapshot } = execInfo

      const modelMeta = snapshot.models.find((m) => m.id === preBot.model_id)
      if (!modelMeta) {
        throw new DaemonError(
          'MODEL_UNAVAILABLE',
          `Model "${preBot.model_id}" is not available in the discovered Codex catalog. Select an available model.`,
          { statusCode: 400 },
        )
      }
      if (modelMeta.efforts.length > 0 && !modelMeta.efforts.includes(preBot.effort)) {
        throw new DaemonError(
          'EFFORT_UNSUPPORTED',
          `Reasoning effort "${preBot.effort}" is not supported by model "${preBot.model_id}".`,
          { statusCode: 400 },
        )
      }

      const policyDecision = this.policyBroker.authorizeLiveExecution({
        runtimeMode: 'codex',
        codexVersion,
        authMethod: snapshot.authMethod,
        requestedPermission: preBot.permission_mode as PermissionMode,
        canonicalWorkspace,
      })
      if (!policyDecision.allowed) {
        throw new DaemonError('PERMISSION_DENIED', policyDecision.reason, { statusCode: 403 })
      }

      const accountKey = `${snapshot.authMethod}:${snapshot.planType ?? ''}:${snapshot.workspaceName ?? ''}`
      if (preSession.external_session_id && preSession.account_id !== accountKey) {
        throw new DaemonError(
          'ACCOUNT_MISMATCH',
          'This conversation belongs to a different account; start a New conversation.',
          { statusCode: 409 },
        )
      }

      const instructionParts: string[] = []
      if (preBot.instructions.trim()) instructionParts.push(preBot.instructions.trim())
      const personalization = this.settingsRepo?.getSettings().personalization
      if (personalization) {
        if (personalization.defaultInstructions.trim()) {
          instructionParts.push(personalization.defaultInstructions.trim())
        }
        if (personalization.responseStyle && personalization.responseStyle !== 'balanced') {
          instructionParts.push(`Response style: ${personalization.responseStyle}`)
        }
      }

      codexPreflight = {
        adapter,
        generation,
        codexVersion,
        accountKey,
        canonicalWorkspace,
        effectiveInstructions: instructionParts.join('\n\n'),
        externalSessionId: preSession.external_session_id,
      }
    } else if (isMockRuntime) {
      if (preSession.runtime_id === 'codex') {
        throw new DaemonError(
          'SESSION_RUNTIME_MISMATCH',
          'Cannot run mock simulation in a live Codex conversation; start a New conversation.',
          { statusCode: 409 },
        )
      }
    } else {
      throw new DaemonError(
        'LIVE_INFERENCE_DISABLED',
        `Runtime "${preBot.runtime_id}" is not supported for execution in Phase 2B.`,
        { statusCode: 501 },
      )
    }

    const activePlaceholders = ACTIVE_RUN_STATUSES.map(() => '?').join(', ')
    const now = new Date().toISOString()

    const txResult = this.dbHandle.transaction(() => {
      const session = this.dbHandle.sqlite
        .prepare('SELECT id, agent_id, archived_at FROM sessions WHERE id = ?')
        .get(input.sessionId) as { id: string; agent_id: string; archived_at: string | null } | undefined

      if (!session) {
        throw new DaemonError('SESSION_NOT_FOUND', `Session "${input.sessionId}" was not found`, {
          statusCode: 404,
        })
      }
      if (session.archived_at !== null) {
        throw new DaemonError('SESSION_ARCHIVED', 'Cannot start a run in an archived session', {
          statusCode: 409,
        })
      }

      const existingRun = this.dbHandle.sqlite
        .prepare(
          `SELECT id, session_id, agent_id, idempotency_key, runtime_id, model_id, effort, permission_mode, config_snapshot_json, status, error_json, started_at, ended_at, created_at
           FROM runs
           WHERE session_id = ? AND idempotency_key = ?`,
        )
        .get(input.sessionId, idempotencyKey) as RawRunRow | undefined

      if (existingRun) {
        const botRow = this.dbHandle.sqlite
          .prepare(
            `SELECT runtime_id, model_id, effort, permission_mode FROM agents WHERE id = ?`,
          )
          .get(session.agent_id) as
          | { runtime_id: string; model_id: string; effort: string; permission_mode: string }
          | undefined

        if (
          botRow &&
          (existingRun.runtime_id !== botRow.runtime_id ||
            existingRun.model_id !== botRow.model_id ||
            existingRun.effort !== botRow.effort ||
            existingRun.permission_mode !== botRow.permission_mode)
        ) {
          throw new DaemonError(
            'IDEMPOTENCY_CONFLICT',
            'Idempotency key was already used with a different execution configuration',
            { statusCode: 409 },
          )
        }

        const userMsg = this.dbHandle.sqlite
          .prepare(`SELECT id, content_json FROM messages WHERE run_id = ? AND role = 'user' LIMIT 1`)
          .get(existingRun.id) as { id: string; content_json: string } | undefined
        if (userMsg) {
          let existingText = ''
          try {
            const parsed = JSON.parse(userMsg.content_json) as { text?: unknown }
            if (typeof parsed.text === 'string') existingText = parsed.text
          } catch {
            // ignore
          }
          if (existingText !== trimmedText) {
            throw new DaemonError(
              'IDEMPOTENCY_CONFLICT',
              'Idempotency key was already used with a different prompt payload',
              { statusCode: 409 },
            )
          }
        }
        const assistantMsg = this.dbHandle.sqlite
          .prepare(`SELECT id FROM messages WHERE run_id = ? AND role = 'assistant' LIMIT 1`)
          .get(existingRun.id) as { id: string } | undefined

        return {
          deduplicated: true as const,
          run: this.rowToRun(existingRun),
          userMessageId: userMsg?.id ?? '',
          assistantMessageId: assistantMsg?.id ?? '',
          botName: '',
          workspacePath: '',
        }
      }

      const activeRun = this.dbHandle.sqlite
        .prepare(
          `SELECT id, status FROM runs WHERE session_id = ? AND status IN (${activePlaceholders}) LIMIT 1`,
        )
        .get(input.sessionId, ...ACTIVE_RUN_STATUSES) as { id: string; status: string } | undefined

      if (activeRun) {
        throw new DaemonError(
          'RUN_ALREADY_ACTIVE',
          `Session "${input.sessionId}" already has active run "${activeRun.id}" (${activeRun.status})`,
          { statusCode: 409 },
        )
      }

      const bot = this.dbHandle.sqlite
        .prepare(
          `SELECT id, name, runtime_id, model_id, effort, workspace_path, permission_mode, archived_at
           FROM agents
           WHERE id = ?`,
        )
        .get(session.agent_id) as
        | {
            id: string
            name: string
            runtime_id: string
            model_id: string
            effort: string
            workspace_path: string
            permission_mode: string
            archived_at: string | null
          }
        | undefined

      if (!bot || bot.archived_at !== null) {
        throw new DaemonError('BOT_NOT_FOUND', `Bot "${session.agent_id}" was not found or is archived`, {
          statusCode: 404,
        })
      }

      if (bot.permission_mode === 'full-access') {
        throw new DaemonError(
          'PERMISSION_MODE_DISABLED',
          'Full Access permission mode is disabled in this release.',
          { statusCode: 403 },
        )
      }

      const isMockRuntime = bot.runtime_id === 'mock' || bot.runtime_id === 'mock-offline'
      if (!isMockRuntime && bot.runtime_id !== 'codex') {
        throw new DaemonError(
          'LIVE_INFERENCE_DISABLED',
          `Live AI inference for runtime "${bot.runtime_id}" is disabled in Phase 2B.`,
          { statusCode: 501 },
        )
      }

      const runId = `run_${randomUUID()}`
      const userMessageId = `msg_${randomUUID()}`
      const assistantMessageId = `msg_${randomUUID()}`

      const maxOrderRow = this.dbHandle.sqlite
        .prepare('SELECT COALESCE(MAX(seq_order), 0) AS max_order FROM messages WHERE session_id = ?')
        .get(input.sessionId) as { max_order: number } | undefined
      const baseOrder = Number(maxOrderRow?.max_order ?? 0)

      const configSnapshot = {
        botId: bot.id,
        botName: bot.name,
        runtimeId: bot.runtime_id,
        modelId: bot.model_id,
        effort: bot.effort,
        permissionMode: bot.permission_mode,
        workspacePath: codexPreflight?.canonicalWorkspace ?? bot.workspace_path,
        codexVersion: codexPreflight?.codexVersion ?? null,
        isMock: isMockRuntime,
      }
      const configSnapshotJson = JSON.stringify(configSnapshot)

      this.dbHandle.sqlite
        .prepare(
          `INSERT INTO runs (id, session_id, agent_id, idempotency_key, runtime_id, model_id, effort, permission_mode, config_snapshot_json, status, error_json, started_at, ended_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, ?, NULL, ?)`,
        )
        .run(
          runId,
          input.sessionId,
          bot.id,
          idempotencyKey,
          bot.runtime_id,
          bot.model_id,
          bot.effort,
          bot.permission_mode,
          configSnapshotJson,
          now,
          now,
        )

      this.dbHandle.sqlite
        .prepare(
          `INSERT INTO messages (id, session_id, role, content_json, seq_order, status, created_at, updated_at, run_id)
           VALUES (?, ?, 'user', ?, ?, 'complete', ?, ?, ?)`,
        )
        .run(
          userMessageId,
          input.sessionId,
          serializeMessageContent(trimmedText),
          baseOrder + 1,
          now,
          now,
          runId,
        )

      this.dbHandle.sqlite
        .prepare(
          `INSERT INTO messages (id, session_id, role, content_json, seq_order, status, created_at, updated_at, run_id)
           VALUES (?, ?, 'assistant', ?, ?, 'streaming', ?, ?, ?)`,
        )
        .run(
          assistantMessageId,
          input.sessionId,
          serializeMessageContent('', { isMock: isMockRuntime, runtimeId: bot.runtime_id }),
          baseOrder + 2,
          now,
          now,
          runId,
        )

      this.dbHandle.sqlite
        .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
        .run(now, input.sessionId)

      this.eventStore.appendEvent(runId, {
        eventKey: 'run.queued',
        type: 'run.queued',
        payload: {
          sessionId: input.sessionId,
          agentId: bot.id,
          runtimeId: bot.runtime_id,
          isMock: isMockRuntime,
        },
        timestamp: now,
      })

      const insertedRow = this.dbHandle.sqlite
        .prepare(
          `SELECT id, session_id, agent_id, idempotency_key, runtime_id, model_id, effort, permission_mode, config_snapshot_json, status, error_json, started_at, ended_at, created_at
           FROM runs
           WHERE id = ?`,
        )
        .get(runId) as unknown as RawRunRow

      return {
        deduplicated: false as const,
        run: this.rowToRun(insertedRow),
        userMessageId,
        assistantMessageId,
        botName: bot.name,
        workspacePath: codexPreflight?.canonicalWorkspace ?? bot.workspace_path,
        modelId: bot.model_id,
        effort: bot.effort,
        permissionMode: bot.permission_mode as PermissionMode,
        isMock: isMockRuntime,
      }
    })

    if (!txResult.deduplicated) {
      const abortController = new AbortController()
      const control: ActiveRunControl = {
        abortController,
        pendingApproval: null,
        donePromise: Promise.resolve(),
      }
      if (!txResult.isMock && codexPreflight) {
        const preflight = codexPreflight
        control.liveCancel = (rId) => preflight.adapter.cancel(rId)
        control.donePromise = this.executeCodexRun({
          runId: txResult.run.id,
          sessionId: input.sessionId,
          agentId: txResult.run.agentId,
          assistantMessageId: txResult.assistantMessageId,
          prompt: trimmedText,
          modelId: txResult.modelId,
          effort: txResult.effort,
          permission: txResult.permissionMode,
          preflight,
          control,
        }).finally(() => {
          if (control.cancelTimeout) clearTimeout(control.cancelTimeout)
          this.activeControls.delete(txResult.run.id)
        })
      } else {
        control.donePromise = this.executeMockRun({
          runId: txResult.run.id,
          sessionId: input.sessionId,
          assistantMessageId: txResult.assistantMessageId,
          prompt: trimmedText,
          botName: txResult.botName,
          workspacePath: txResult.workspacePath,
          control,
        }).finally(() => {
          this.activeControls.delete(txResult.run.id)
        })
      }
      this.activeControls.set(txResult.run.id, control)
    }

    return {
      run: txResult.run,
      deduplicated: txResult.deduplicated,
      userMessageId: txResult.userMessageId,
      assistantMessageId: txResult.assistantMessageId,
    }
  }

  async reconnectRuntime(): Promise<void> {
    if (this.runtimeRegistry) {
      await this.runtimeRegistry.reconnect()
    }
    this.clearAllQuarantine()
  }

  async inspectSession(sessionId: string): Promise<{
    sessionId: string
    agentId: string
    runtimeId: string
    externalSessionId: string | null
    providerThreadStatus: 'not_applicable' | 'accessible' | 'unavailable' | 'unknown'
    hasToolActivity: boolean
    resumable: boolean
    reason: string
    quarantined: boolean
    lastRun: RunRecord | null
    approvalsCount: number
  }> {
    const sess = this.dbHandle.sqlite
      .prepare(
        `SELECT id, agent_id, account_id, runtime_id, external_session_id, archived_at FROM sessions WHERE id = ?`,
      )
      .get(sessionId) as
      | {
          id: string
          agent_id: string
          account_id: string
          runtime_id: string
          external_session_id: string | null
          archived_at: string | null
        }
      | undefined

    if (!sess) {
      throw new DaemonError('SESSION_NOT_FOUND', `Session "${sessionId}" was not found`, {
        statusCode: 404,
      })
    }

    const bot = this.dbHandle.sqlite
      .prepare(`SELECT id, runtime_id, archived_at FROM agents WHERE id = ?`)
      .get(sess.agent_id) as
      | { id: string; runtime_id: string; archived_at: string | null }
      | undefined

    const lastRunRow = this.dbHandle.sqlite
      .prepare(
        `SELECT id, session_id, agent_id, idempotency_key, runtime_id, model_id, effort, permission_mode, config_snapshot_json, status, error_json, started_at, ended_at, created_at
         FROM runs
         WHERE session_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(sessionId) as RawRunRow | undefined

    const appCountRow = this.dbHandle.sqlite
      .prepare(`SELECT COUNT(*) AS cnt FROM approvals WHERE session_id = ?`)
      .get(sessionId) as { cnt: number } | undefined

    const quarantined = this.sessionsWithUnconfirmedStop.has(sessionId)
    let resumable = true
    let reason = 'Session is ready.'
    if (sess.archived_at !== null) {
      resumable = false
      reason = 'Session is archived.'
    } else if (!bot || bot.archived_at !== null) {
      resumable = false
      reason = 'Associated bot is missing or archived.'
    } else if (quarantined) {
      resumable = false
      reason = 'Previous cancellation stop is unconfirmed; reconnect runtime or start a New chat.'
    } else if (sess.runtime_id !== bot.runtime_id) {
      resumable = false
      reason = `Session runtime "${sess.runtime_id}" differs from bot runtime "${bot.runtime_id}"; start a New chat.`
    }

    const hasToolActivity = lastRunRow ? this.hasToolActivityForRun(lastRunRow.id) : false

    let providerThreadStatus: 'not_applicable' | 'accessible' | 'unavailable' | 'unknown' =
      'not_applicable'
    if (sess.runtime_id === 'codex') {
      if (!sess.external_session_id) {
        providerThreadStatus = 'unavailable'
      } else {
        let accountMismatch = false
        if (this.runtimeRegistry) {
          const snap = await this.runtimeRegistry.getSnapshot(false).catch(() => null)
          if (snap?.status === 'available' && snap.lifecycleState === 'connected') {
            try {
              const exec = await this.runtimeRegistry.getExecutionAdapter()
              const currentAccountKey = `${snap.authMethod}:${snap.planType ?? ''}:${snap.workspaceName ?? ''}`
              if (
                sess.account_id &&
                sess.account_id !== 'local' &&
                sess.account_id !== 'local-default' &&
                sess.account_id !== currentAccountKey
              ) {
                accountMismatch = true
                providerThreadStatus = 'unavailable'
                resumable = false
                reason = 'Session belongs to a different account; start a New chat.'
              } else if (typeof exec.adapter.readThread === 'function') {
                const threadRead = await exec.adapter.readThread(sess.external_session_id)
                providerThreadStatus = threadRead.accessible ? 'accessible' : 'unavailable'
                if (!threadRead.accessible) {
                  resumable = false
                  reason =
                    threadRead.reason ?? 'Provider thread is no longer accessible; start a New chat.'
                }
              } else {
                providerThreadStatus = 'unknown'
              }
            } catch {
              providerThreadStatus = 'unknown'
            }
          } else {
            providerThreadStatus = 'unknown'
          }
        } else {
          providerThreadStatus = 'unknown'
        }
        if (accountMismatch) {
          providerThreadStatus = 'unavailable'
        }
      }
    }

    return {
      sessionId: sess.id,
      agentId: sess.agent_id,
      runtimeId: sess.runtime_id,
      externalSessionId: sess.external_session_id,
      providerThreadStatus,
      hasToolActivity,
      resumable,
      reason,
      quarantined,
      lastRun: lastRunRow ? this.rowToRun(lastRunRow) : null,
      approvalsCount: Number(appCountRow?.cnt ?? 0),
    }
  }

  private hasToolActivityForRun(runId: string): boolean {
    const toolCountRow = this.dbHandle.sqlite
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM run_events
         WHERE run_id = ? AND type IN ('tool.started', 'tool.requested', 'tool.completed', 'approval.requested')`,
      )
      .get(runId) as { cnt: number } | undefined
    if (Number(toolCountRow?.cnt ?? 0) > 0) return true
    const appRow = this.dbHandle.sqlite
      .prepare(`SELECT COUNT(*) AS cnt FROM approvals WHERE run_id = ?`)
      .get(runId) as { cnt: number } | undefined
    return Number(appRow?.cnt ?? 0) > 0
  }

  async retryRun(input: {
    runId: string
    idempotencyKey: string
    confirmSideEffects?: boolean
  }): Promise<StartRunResult> {
    const orig = this.getRun(input.runId)
    if (orig.status !== 'failed' && orig.status !== 'interrupted' && orig.status !== 'cancelled') {
      throw new DaemonError(
        'RETRY_NOT_ALLOWED',
        `Cannot retry run "${orig.id}" in status "${orig.status}"`,
        { statusCode: 409 },
      )
    }
    if (this.sessionsWithUnconfirmedStop.has(orig.sessionId)) {
      throw new DaemonError(
        'RUN_STOP_UNCONFIRMED',
        `Cannot retry while previous cancellation in session "${orig.sessionId}" is unconfirmed.`,
        { statusCode: 409, retryable: true },
      )
    }
    if (this.hasToolActivityForRun(orig.id) && input.confirmSideEffects !== true) {
      throw new DaemonError(
        'RETRY_CONFIRMATION_REQUIRED',
        'Previous run had tool or approval activity that may have already applied side effects. Explicit confirmation is required before retrying.',
        { statusCode: 409 },
      )
    }

    const userMsg = this.dbHandle.sqlite
      .prepare(`SELECT content_json FROM messages WHERE run_id = ? AND role = 'user' LIMIT 1`)
      .get(orig.id) as { content_json: string } | undefined

    let promptText = ''
    if (userMsg) {
      try {
        const parsed = JSON.parse(userMsg.content_json) as { text?: unknown }
        if (typeof parsed.text === 'string') promptText = parsed.text
      } catch {
        // ignore
      }
    }
    if (!promptText.trim()) {
      throw new DaemonError('ORIGINAL_PROMPT_MISSING', 'Cannot locate original user prompt to retry', {
        statusCode: 404,
      })
    }

    return this.startRun({
      sessionId: orig.sessionId,
      idempotencyKey: input.idempotencyKey,
      text: promptText,
    })
  }

  cancelRun(runId: string): { run: RunRecord; alreadyTerminal: boolean } {
    const control = this.activeControls.get(runId)

    const result = this.dbHandle.transaction(() => {
      const row = this.dbHandle.sqlite
        .prepare(
          `SELECT id, session_id, agent_id, idempotency_key, runtime_id, model_id, effort, permission_mode, config_snapshot_json, status, error_json, started_at, ended_at, created_at
           FROM runs
           WHERE id = ?`,
        )
        .get(runId) as RawRunRow | undefined

      if (!row) {
        throw new DaemonError('RUN_NOT_FOUND', `Run "${runId}" was not found`, {
          statusCode: 404,
        })
      }

      const currentStatus = isRunStatus(row.status) ? row.status : 'failed'
      if (isTerminalStatus(currentStatus)) {
        return { run: this.rowToRun(row), alreadyTerminal: true }
      }

      if (currentStatus !== 'cancelling') {
        assertLegalTransition(currentStatus, 'cancelling')
        const now = new Date().toISOString()
        this.dbHandle.sqlite
          .prepare(`UPDATE runs SET status = 'cancelling' WHERE id = ?`)
          .run(runId)
        this.revokeApprovalsInTx(runId, 'run_cancelled', now)
        this.eventStore.appendEvent(runId, {
          eventKey: 'run.cancelling',
          type: 'run.cancelling',
          payload: { previousStatus: currentStatus },
          timestamp: now,
        })
      }

      const updated = this.dbHandle.sqlite
        .prepare(
          `SELECT id, session_id, agent_id, idempotency_key, runtime_id, model_id, effort, permission_mode, config_snapshot_json, status, error_json, started_at, ended_at, created_at
           FROM runs
           WHERE id = ?`,
        )
        .get(runId) as unknown as RawRunRow

      return { run: this.rowToRun(updated), alreadyTerminal: false }
    })

    if (!result.alreadyTerminal && control) {
      if (control.pendingApproval) {
        const pending = control.pendingApproval
        control.pendingApproval = null
        pending.resolve('cancelled')
      }
      control.abortController.abort()
      if (control.liveCancel) {
        void control.liveCancel(runId).catch(() => undefined)
        if (!control.cancelTimeout) {
          control.cancelTimeout = setTimeout(() => {
            try {
              const cur = this.getRun(runId)
              if (!isTerminalStatus(cur.status)) {
                this.addQuarantine(cur.sessionId)
                this.finalizeRun({
                  runId,
                  sessionId: cur.sessionId,
                  assistantMessageId: '',
                  terminalStatus: 'interrupted',
                  messageStatus: 'interrupted',
                  accumulatedText: '[Cancellation acknowledgement timed out]',
                  error: {
                    code: 'CANCEL_ACK_TIMEOUT',
                    message: 'Runtime did not acknowledge cancellation within timeout.',
                    retryable: true,
                  },
                  eventKey: 'run.interrupted:cancel_timeout',
                  eventType: 'run.interrupted',
                  eventPayload: { reason: 'cancel_ack_timeout' },
                })
              }
            } catch {
              // ignore if already cleaned up
            }
          }, 8_000)
        }
      }
    }

    return result
  }

  private revokeApprovalsInTx(runId: string, reason: string, now: string): void {
    const pendingRows = this.dbHandle.sqlite
      .prepare(`SELECT id FROM approvals WHERE run_id = ? AND status IN ('pending', 'resolving')`)
      .all(runId) as unknown as Array<{ id: string }>

    if (pendingRows.length === 0) return

    this.dbHandle.sqlite
      .prepare(
        `UPDATE approvals
         SET status = 'revoked', resolved_at = ?, decision_meta_json = ?
         WHERE run_id = ? AND status IN ('pending', 'resolving')`,
      )
      .run(now, JSON.stringify({ reason }), runId)

    this.dbHandle.sqlite
      .prepare(
        `UPDATE mcp_approval_bindings
         SET dispatch_state = 'cancelled', updated_at = ?
         WHERE approval_id IN (SELECT id FROM approvals WHERE run_id = ?) AND dispatch_state = 'pending'`,
      )
      .run(now, runId)

    for (const row of pendingRows) {
      this.eventStore.appendEvent(runId, {
        eventKey: `approval.revoked:${row.id}`,
        type: 'approval.revoked',
        payload: { approvalId: row.id, reason },
        timestamp: now,
      })
    }
  }

  async resolveApproval(
    runId: string,
    approvalId: string,
    decision: 'approved' | 'denied',
    expectedArgsHash?: string,
  ): Promise<{ run: RunRecord }> {
    const control = this.activeControls.get(runId)

    const prep = this.dbHandle.transaction(() => {
      const appRow = this.dbHandle.sqlite
        .prepare(
          `SELECT id, run_id, runtime_generation, args_hash, permission_mode, status, expires_at
           FROM approvals
           WHERE id = ? AND run_id = ?`,
        )
        .get(approvalId, runId) as
        | {
            id: string
            run_id: string
            runtime_generation: number
            args_hash: string
            permission_mode: string
            status: string
            expires_at: string
          }
        | undefined

      const runRow = this.dbHandle.sqlite
        .prepare('SELECT status, runtime_id FROM runs WHERE id = ?')
        .get(runId) as { status: string; runtime_id: string } | undefined

      if (!runRow) {
        throw new DaemonError('RUN_NOT_FOUND', `Run "${runId}" was not found`, { statusCode: 404 })
      }

      if (!appRow) {
        if (!control?.pendingApproval || control.pendingApproval.spec.approvalId !== approvalId) {
          throw new DaemonError(
            'APPROVAL_NOT_FOUND',
            `No pending approval "${approvalId}" for run "${runId}"`,
            { statusCode: 404 },
          )
        }
      }

      if (appRow) {
        if (appRow.status !== 'pending') {
          throw new DaemonError(
            'APPROVAL_ALREADY_RESOLVED',
            `Approval "${approvalId}" is already in state "${appRow.status}"`,
            { statusCode: 409 },
          )
        }
        const now = new Date().toISOString()
        const expiresMs = Date.parse(appRow.expires_at)
        if (Number.isFinite(expiresMs) && Date.now() > expiresMs) {
          this.dbHandle.sqlite
            .prepare(`UPDATE approvals SET status = 'expired', resolved_at = ? WHERE id = ?`)
            .run(now, approvalId)
          this.eventStore.appendEvent(runId, {
            eventKey: `approval.expired:${approvalId}`,
            type: 'approval.expired',
            payload: { approvalId },
            timestamp: now,
          })
          return { outcome: 'expired' as const, isCodex: false, argsHash: '' }
        }
        if (expectedArgsHash && expectedArgsHash !== appRow.args_hash) {
          throw new DaemonError(
            'APPROVAL_ARGS_MISMATCH',
            'Approval action arguments hash mismatch',
            { statusCode: 409 },
          )
        }
        const mcpBinding = this.dbHandle.sqlite
          .prepare(
            `SELECT dispatch_state, args_hash
             FROM mcp_approval_bindings
             WHERE approval_id = ?`,
          )
          .get(approvalId) as { dispatch_state: string; args_hash: string } | undefined
        if (mcpBinding) {
          if (mcpBinding.dispatch_state !== 'pending') {
            throw new DaemonError(
              'APPROVAL_ALREADY_RESOLVED',
              `MCP approval "${approvalId}" is already in dispatch state "${mcpBinding.dispatch_state}"`,
              { statusCode: 409 },
            )
          }
          if (mcpBinding.args_hash !== appRow.args_hash) {
            throw new DaemonError(
              'APPROVAL_ARGS_MISMATCH',
              'MCP approval binding arguments hash mismatch',
              { statusCode: 409 },
            )
          }
        }
        if (
          runRow.runtime_id === 'codex' &&
          this.runtimeRegistry &&
          this.runtimeRegistry.getGeneration() !== appRow.runtime_generation
        ) {
          this.dbHandle.sqlite
            .prepare(
              `UPDATE approvals SET status = 'revoked', resolved_at = ?, decision_meta_json = ? WHERE id = ?`,
            )
            .run(now, JSON.stringify({ reason: 'runtime_generation_changed' }), approvalId)
          this.eventStore.appendEvent(runId, {
            eventKey: `approval.revoked:${approvalId}`,
            type: 'approval.revoked',
            payload: { approvalId, reason: 'runtime_generation_changed' },
            timestamp: now,
          })
          return { outcome: 'revoked_generation' as const, isCodex: false, argsHash: '' }
        }

        if (runRow.status !== 'awaiting_approval') {
          throw new DaemonError(
            'INVALID_RUN_TRANSITION',
            `Run "${runId}" is not awaiting approval`,
            { statusCode: 409 },
          )
        }

        this.dbHandle.sqlite
          .prepare(`UPDATE approvals SET status = 'resolving' WHERE id = ? AND status = 'pending'`)
          .run(approvalId)
      } else if (runRow.status !== 'awaiting_approval') {
        throw new DaemonError(
          'INVALID_RUN_TRANSITION',
          `Run "${runId}" is not awaiting approval`,
          { statusCode: 409 },
        )
      }

      return {
        outcome: 'proceed' as const,
        isCodex: runRow.runtime_id === 'codex',
        argsHash: appRow?.args_hash ?? 'mock',
      }
    })

    if (prep.outcome === 'expired') {
      throw new DaemonError('APPROVAL_EXPIRED', `Approval "${approvalId}" has expired`, {
        statusCode: 410,
      })
    }
    if (prep.outcome === 'revoked_generation') {
      throw new DaemonError(
        'RUNTIME_GENERATION_CHANGED',
        'Runtime generation changed; approval was revoked.',
        { statusCode: 409 },
      )
    }

    if (prep.isCodex) {
      if (!control?.liveResolveApproval) {
        const now = new Date().toISOString()
        this.dbHandle.sqlite
          .prepare(
            `UPDATE approvals SET status = 'resolution_failed', resolved_at = ?, decision_meta_json = ? WHERE id = ?`,
          )
          .run(now, JSON.stringify({ reason: 'adapter_unavailable' }), approvalId)
        this.eventStore.appendEvent(runId, {
          eventKey: `approval.resolution_failed:${approvalId}`,
          type: 'approval.resolution_failed',
          payload: { approvalId, reason: 'adapter_unavailable' },
          timestamp: now,
        })
        throw new DaemonError(
          'APPROVAL_DELIVERY_FAILED',
          'Live Codex adapter is unavailable to receive approval decision',
          { statusCode: 503 },
        )
      }

      try {
        await control.liveResolveApproval({
          approvalId,
          runId,
          argsHash: prep.argsHash,
          decision: decision === 'approved' ? 'allow-once' : 'deny',
        })
      } catch (err) {
        const now = new Date().toISOString()
        const safeErr = redactSecrets(err instanceof Error ? err.message : String(err))
        this.dbHandle.sqlite
          .prepare(
            `UPDATE approvals SET status = 'resolution_failed', resolved_at = ?, decision_meta_json = ? WHERE id = ?`,
          )
          .run(now, JSON.stringify({ reason: safeErr }), approvalId)
        this.eventStore.appendEvent(runId, {
          eventKey: `approval.resolution_failed:${approvalId}`,
          type: 'approval.resolution_failed',
          payload: { approvalId, reason: safeErr },
          timestamp: now,
        })
        throw new DaemonError('APPROVAL_DELIVERY_FAILED', safeErr, { statusCode: 502 })
      }
    }

    this.dbHandle.transaction(() => {
      const row = this.dbHandle.sqlite
        .prepare('SELECT status FROM runs WHERE id = ?')
        .get(runId) as { status: string } | undefined
      if (!row || row.status !== 'awaiting_approval') {
        return
      }
      assertLegalTransition('awaiting_approval', 'running')
      const now = new Date().toISOString()
      this.dbHandle.sqlite
        .prepare(`UPDATE runs SET status = 'running' WHERE id = ?`)
        .run(runId)
      this.dbHandle.sqlite
        .prepare(
          `UPDATE approvals SET status = ?, resolved_at = ?, decision_meta_json = ? WHERE id = ?`,
        )
        .run(decision, now, JSON.stringify({ decision }), approvalId)
      if (decision === 'denied') {
        this.dbHandle.sqlite
          .prepare(
            `UPDATE mcp_approval_bindings
             SET dispatch_state = 'cancelled', updated_at = ?
             WHERE approval_id = ? AND dispatch_state = 'pending'`,
          )
          .run(now, approvalId)
      }
      this.eventStore.appendEvent(runId, {
        eventKey: `approval.resolved:${approvalId}`,
        type: 'approval.resolved',
        payload: { approvalId, decision, isMock: !prep.isCodex },
        timestamp: now,
      })
    })

    if (control?.pendingApproval?.spec.approvalId === approvalId) {
      const pending = control.pendingApproval
      control.pendingApproval = null
      pending.resolve(decision)
    }

    return { run: this.getRun(runId) }
  }

  private transitionRun(
    runId: string,
    to: RunStatus,
    event?: { eventKey: string; type: string; payload: Record<string, unknown> },
  ): boolean {
    return this.dbHandle.transaction(() => {
      const row = this.dbHandle.sqlite
        .prepare('SELECT status FROM runs WHERE id = ?')
        .get(runId) as { status: string } | undefined
      if (!row || !isRunStatus(row.status)) return false

      const race = resolveTerminalRace(row.status, to)
      if (race === 'ignore_duplicate') return false
      if (race === 'reject_conflict') return false

      if (row.status === to) return true
      assertLegalTransition(row.status, to)

      this.dbHandle.sqlite.prepare('UPDATE runs SET status = ? WHERE id = ?').run(to, runId)
      if (event) {
        this.eventStore.appendEvent(runId, event)
      }
      return true
    })
  }

  private finalizeRun(params: {
    runId: string
    sessionId: string
    assistantMessageId: string
    terminalStatus: 'completed' | 'cancelled' | 'failed' | 'interrupted'
    messageStatus: 'complete' | 'cancelled' | 'failed' | 'interrupted'
    accumulatedText: string
    error?: RunErrorRecord
    eventKey: string
    eventType: string
    eventPayload: Record<string, unknown>
  }): void {
    const now = new Date().toISOString()
    this.dbHandle.transaction(() => {
      const row = this.dbHandle.sqlite
        .prepare('SELECT status, runtime_id FROM runs WHERE id = ?')
        .get(params.runId) as { status: string; runtime_id: string } | undefined
      if (!row || !isRunStatus(row.status)) return

      const race = resolveTerminalRace(row.status, params.terminalStatus)
      if (race !== 'proceed') return

      assertLegalTransition(row.status, params.terminalStatus)

      const errorJson = params.error ? JSON.stringify(params.error) : null
      this.dbHandle.sqlite
        .prepare('UPDATE runs SET status = ?, ended_at = ?, error_json = ? WHERE id = ?')
        .run(params.terminalStatus, now, errorJson, params.runId)

      this.revokeApprovalsInTx(params.runId, `run_${params.terminalStatus}`, now)

      const isMockMeta = row.runtime_id !== 'codex'
      const contentJson = serializeMessageContent(params.accumulatedText, {
        isMock: isMockMeta,
        runtimeId: row.runtime_id,
      })
      if (params.assistantMessageId) {
        this.dbHandle.sqlite
          .prepare(
            `UPDATE messages
             SET content_json = ?, status = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(contentJson, params.messageStatus, now, params.assistantMessageId)
      } else {
        this.dbHandle.sqlite
          .prepare(
            `UPDATE messages
             SET content_json = ?, status = ?, updated_at = ?
             WHERE run_id = ? AND role = 'assistant'`,
          )
          .run(contentJson, params.messageStatus, now, params.runId)
      }

      this.dbHandle.sqlite
        .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
        .run(now, params.sessionId)

      this.eventStore.appendEvent(params.runId, {
        eventKey: params.eventKey,
        type: params.eventType,
        payload: params.eventPayload,
        timestamp: now,
      })
    })
  }

  private flushAssistantBuffer(assistantMessageId: string, text: string): void {
    const now = new Date().toISOString()
    this.dbHandle.sqlite
      .prepare(
        `UPDATE messages
         SET content_json = ?, updated_at = ?
         WHERE id = ? AND status = 'streaming'`,
      )
      .run(serializeMessageContent(text, { isMock: true, runtimeId: 'mock' }), now, assistantMessageId)
  }

  private async executeMockRun(params: {
    runId: string
    sessionId: string
    assistantMessageId: string
    prompt: string
    botName: string
    workspacePath: string
    control: ActiveRunControl
  }): Promise<void> {
    const { runId, sessionId, assistantMessageId, prompt, botName, workspacePath, control } = params
    const signal = control.abortController.signal
    const plan = buildMockScenarioPlan(prompt, botName, workspacePath)

    let accumulatedText = ''
    let pendingChunks = 0
    let lastFlushAt = Date.now()
    let chunkIndex = 0

    const maybeFlush = (force = false) => {
      const nowMs = Date.now()
      if (force || pendingChunks >= FLUSH_CHUNK_THRESHOLD || nowMs - lastFlushAt >= FLUSH_INTERVAL_MS) {
        if (pendingChunks > 0) {
          this.flushAssistantBuffer(assistantMessageId, accumulatedText)
          pendingChunks = 0
          lastFlushAt = nowMs
        }
      }
    }

    const finalizeIfCancelled = (): boolean => {
      if (!signal.aborted && !this.stopping) return false
      maybeFlush(true)
      const cancelledText =
        accumulatedText.trim().length > 0
          ? `${accumulatedText}\n\n[Cancelled]`
          : '[Run cancelled]'
      this.finalizeRun({
        runId,
        sessionId,
        assistantMessageId,
        terminalStatus: this.stopping ? 'interrupted' : 'cancelled',
        messageStatus: this.stopping ? 'interrupted' : 'cancelled',
        accumulatedText: cancelledText,
        eventKey: this.stopping ? 'run.interrupted:shutdown' : 'run.cancelled',
        eventType: this.stopping ? 'run.interrupted' : 'run.cancelled',
        eventPayload: { reason: this.stopping ? 'daemon_stopping' : 'user_cancelled' },
      })
      return true
    }

    try {
      this.transitionRun(runId, 'starting', {
        eventKey: 'run.starting',
        type: 'run.starting',
        payload: { runtimeId: 'mock', isMock: true },
      })

      await sleepAbortable(plan.initialPauseMs, signal)
      if (finalizeIfCancelled()) return

    const sessionOwner = this.dbHandle.sqlite
        .prepare('SELECT agent_id FROM sessions WHERE id = ?')
        .get(sessionId) as { agent_id: string } | undefined
      const combinedContext = sessionOwner
        ? await this.prepareCombinedContextSafely({
            sessionId,
            agentId: sessionOwner.agent_id,
            runtimeId: 'mock',
            queryText: prompt,
            isMock: true,
          })
        : null

      if (finalizeIfCancelled()) return

      const preparedMemory = combinedContext?.memory ?? {
        status: 'disabled' as const,
        mechanism: 'none' as const,
        envelopeJson: null,
        selectedCount: 0,
        totalBytes: 0,
        truncated: false,
      }
      const preparedKnowledge = combinedContext?.knowledge ?? {
        status: 'disabled' as const,
        mechanism: 'none' as const,
        envelopeJson: null,
        selectedDocuments: 0,
        selectedChunks: 0,
        totalBytes: 0,
        truncated: false,
        citations: [],
      }

      this.transitionRun(runId, 'running', {
        eventKey: 'run.started',
        type: 'run.started',
        payload: {
          runtimeId: 'mock',
          isMock: true,
          scenario: plan.kind,
          memoryContext: {
            status: preparedMemory.status,
            mechanism: preparedMemory.mechanism,
            count: preparedMemory.selectedCount,
            totalBytes: preparedMemory.totalBytes,
            truncated: preparedMemory.truncated,
          },
          knowledgeContext: {
            status: preparedKnowledge.status,
            mechanism: preparedKnowledge.mechanism,
            documents: preparedKnowledge.selectedDocuments,
            chunks: preparedKnowledge.selectedChunks,
            totalBytes: preparedKnowledge.totalBytes,
            truncated: preparedKnowledge.truncated,
            attachedSources: combinedContext?.attachedSources ?? [],
          },
          combinedContextBytes: combinedContext?.totalBytes ?? 0,
        },
      })

      if (preparedMemory.status === 'attached' && preparedMemory.envelopeJson) {
        plan.chunks.push(
          `\n\n[Memory Context Attached: ${preparedMemory.selectedCount} item(s), ${preparedMemory.totalBytes} bytes]`,
        )
      }
      if (preparedKnowledge.status === 'attached' && preparedKnowledge.envelopeJson) {
        plan.chunks.push(
          `\n\n[Knowledge Context Attached: ${preparedKnowledge.selectedDocuments} doc(s), ${preparedKnowledge.selectedChunks} chunk(s), ${preparedKnowledge.totalBytes} bytes]`,
        )
      }

      if (plan.emitTool) {
        this.eventStore.appendEvent(runId, {
          eventKey: `tool.started:${plan.emitTool.toolCallId}`,
          type: 'tool.started',
          payload: {
            toolCallId: plan.emitTool.toolCallId,
            toolName: plan.emitTool.toolName,
          },
        })
      }

      for (const chunk of plan.chunks) {
        if (finalizeIfCancelled()) return
        accumulatedText += chunk
        pendingChunks += 1
        chunkIndex += 1
        this.eventStore.appendEvent(runId, {
          eventKey: `message.delta:${chunkIndex}`,
          type: 'message.delta',
          payload: { delta: chunk },
        })
        if (plan.duplicateEventTest && chunkIndex === 1) {
          // Deliberately emit a duplicate eventKey to exercise idempotent deduplication
          this.eventStore.appendEvent(runId, {
            eventKey: 'message.delta:1',
            type: 'message.delta',
            payload: { delta: chunk },
          })
        }
        maybeFlush(false)
        await sleepAbortable(plan.chunkDelayMs, signal)
      }

      if (finalizeIfCancelled()) return

      if (plan.hangIndefinitely) {
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve()
            return
          }
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
        finalizeIfCancelled()
        return
      }

      if (plan.failAfterChunks) {
        maybeFlush(true)
        this.finalizeRun({
          runId,
          sessionId,
          assistantMessageId,
          terminalStatus: 'failed',
          messageStatus: 'failed',
          accumulatedText,
          error: {
            code: plan.failAfterChunks.code,
            message: plan.failAfterChunks.message,
            retryable: true,
          },
          eventKey: 'run.failed',
          eventType: 'run.failed',
          eventPayload: {
            code: plan.failAfterChunks.code,
            message: plan.failAfterChunks.message,
          },
        })
        return
      }

      if (plan.mcpTool) {
        maybeFlush(true)
        if (!this.mcpService) {
          throw new DaemonError('MCP_UNAVAILABLE', 'MCP service is not configured in daemon', { statusCode: 503 })
        }
        const runMeta = this.dbHandle.sqlite
          .prepare('SELECT agent_id, permission_mode FROM runs WHERE id = ?')
          .get(runId) as { agent_id: string; permission_mode: string } | undefined
        const agentId = runMeta?.agent_id ?? 'chief'
        const permissionMode = (runMeta?.permission_mode ?? 'ask-approval') as PermissionMode

        const prepared = await this.mcpService.prepareToolCallForRun({
          serverId: plan.mcpTool.serverId,
          toolName: plan.mcpTool.toolName,
          botId: agentId,
          workspacePath,
          permissionMode,
          signal,
        })

        const argsJson = JSON.stringify(plan.mcpTool.args)
        const argsHash = createHash('sha256').update(argsJson).digest('hex')
        const mcpApprovalId = `mcp_app_${randomUUID()}`
        const nowApp = new Date().toISOString()
        const expiresAt = new Date(Date.now() + 120_000).toISOString()
        const approvalSpec: PendingApprovalRecord = {
          approvalId: mcpApprovalId,
          title: `Approve MCP tool ${plan.mcpTool.serverId}/${plan.mcpTool.toolName}`,
          command: `${plan.mcpTool.serverId}/${plan.mcpTool.toolName} ${argsJson}`,
          risk: 'high',
          actionType: 'mcp.toolCall',
          argsHash,
          permissionMode,
          expiresAt,
          isMock: false,
          status: 'pending',
        }
        const decisionPromise = new Promise<'approved' | 'denied' | 'cancelled'>((resolve) => {
          control.pendingApproval = { spec: approvalSpec, resolve }
        })

        this.dbHandle.transaction(() => {
          this.dbHandle.sqlite
            .prepare(
              `INSERT INTO approvals (
                 id, run_id, session_id, agent_id, runtime_generation, account_id,
                 thread_id, turn_id, provider_request_id, action_type, action_summary,
                 args_json, args_hash, permission_mode, status, decision_meta_json,
                 created_at, expires_at, resolved_at
               ) VALUES (?, ?, ?, ?, ?, 'local', NULL, NULL, ?, 'mcp.toolCall', ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL)`,
            )
            .run(
              mcpApprovalId,
              runId,
              sessionId,
              agentId,
              prepared.connectionGeneration,
              mcpApprovalId,
              approvalSpec.command,
              argsJson,
              argsHash,
              permissionMode,
              nowApp,
              expiresAt,
            )

          this.dbHandle.sqlite
            .prepare(
              `INSERT INTO mcp_approval_bindings (
                 approval_id, server_id, config_fingerprint, trusted_binary_digest,
                 connection_generation, capability_key, definition_hash, tool_name,
                 args_hash, dispatch_state, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
            )
            .run(
              mcpApprovalId,
              plan.mcpTool!.serverId,
              prepared.configFingerprint,
              prepared.server.trustedBinaryDigest,
              prepared.connectionGeneration,
              `${plan.mcpTool!.serverId}::${plan.mcpTool!.toolName}`,
              prepared.definitionHash,
              plan.mcpTool!.toolName,
              argsHash,
              nowApp,
              nowApp,
            )
        })

        this.transitionRun(runId, 'awaiting_approval', {
          eventKey: `approval.requested:${mcpApprovalId}`,
          type: 'approval.requested',
          payload: {
            approvalId: mcpApprovalId,
            title: approvalSpec.title,
            command: approvalSpec.command,
            risk: approvalSpec.risk,
            actionType: 'mcp.toolCall',
            argsHash,
            permissionMode,
            expiresAt,
            serverId: plan.mcpTool.serverId,
            toolName: plan.mcpTool.toolName,
            definitionHash: prepared.definitionHash,
          },
        })

        const decision = await decisionPromise
        if (decision === 'cancelled' || finalizeIfCancelled()) {
          return
        }

        if (decision === 'denied') {
          this.transitionRun(runId, 'cancelling', {
            eventKey: `run.cancelling:mcp_approval_denied:${mcpApprovalId}`,
            type: 'run.cancelling',
            payload: { reason: 'approval_denied', approvalId: mcpApprovalId },
          })
          accumulatedText += `\n\n[MCP tool ${plan.mcpTool.serverId}/${plan.mcpTool.toolName} denied by user]`
          this.finalizeRun({
            runId,
            sessionId,
            assistantMessageId,
            terminalStatus: 'cancelled',
            messageStatus: 'cancelled',
            accumulatedText,
            eventKey: 'run.cancelled:mcp_approval_denied',
            eventType: 'run.cancelled',
            eventPayload: { reason: 'approval_denied', approvalId: mcpApprovalId },
          })
          return
        }

        const claimTime = new Date().toISOString()
        const claimed = this.dbHandle.transaction(() => {
          const appCheck = this.dbHandle.sqlite
            .prepare(`SELECT status, args_hash FROM approvals WHERE id = ?`)
            .get(mcpApprovalId) as { status: string; args_hash: string } | undefined
          if (!appCheck || appCheck.status !== 'approved' || appCheck.args_hash !== argsHash) {
            return false
          }
          const res = this.dbHandle.sqlite
            .prepare(
              `UPDATE mcp_approval_bindings
               SET dispatch_state = 'dispatched', updated_at = ?
               WHERE approval_id = ? AND dispatch_state = 'pending' AND args_hash = ?`,
            )
            .run(claimTime, mcpApprovalId, argsHash)
          return Number(res.changes) === 1
        })

        if (!claimed) {
          throw new DaemonError(
            'APPROVAL_ALREADY_CONSUMED',
            'MCP approval was already consumed or invalidated before dispatch',
            { statusCode: 409 },
          )
        }

        this.eventStore.appendEvent(runId, {
          eventKey: `tool.started:${mcpApprovalId}`,
          type: 'tool.started',
          payload: {
            toolCallId: mcpApprovalId,
            toolName: `${plan.mcpTool.serverId}/${plan.mcpTool.toolName}`,
            summary: `Executing MCP tool ${plan.mcpTool.serverId}/${plan.mcpTool.toolName}`,
          },
        })

        try {
          const toolResult = await this.mcpService.invokeApprovedTool({
            serverId: plan.mcpTool.serverId,
            toolName: plan.mcpTool.toolName,
            args: plan.mcpTool.args,
            botId: agentId,
            workspacePath,
            permissionMode,
            expectedConfigFingerprint: prepared.configFingerprint,
            expectedDefinitionHash: prepared.definitionHash,
            expectedConnectionGeneration: prepared.connectionGeneration,
            signal,
          })

          const completedAt = new Date().toISOString()
          const resultText = toolResult.content
            .map((part) => (part.type === 'text' ? part.text ?? '' : `[${part.type}]`))
            .filter((v) => v.length > 0)
            .join('\n')
          const summary = redactSecrets(resultText || (toolResult.isToolError ? 'Tool returned error' : 'Tool completed')).slice(0, 1000)

          this.dbHandle.sqlite
            .prepare(
              `UPDATE mcp_approval_bindings
               SET dispatch_state = ?, updated_at = ?
               WHERE approval_id = ? AND dispatch_state = 'dispatched'`,
            )
            .run(toolResult.isToolError ? 'failed' : 'completed', completedAt, mcpApprovalId)

          const delta = `MCP tool \`${plan.mcpTool.serverId}/${plan.mcpTool.toolName}\` ${toolResult.isToolError ? 'returned error' : 'result'}:\n${summary}`
          accumulatedText += delta
          pendingChunks += 1
          chunkIndex += 1
          this.eventStore.appendEvent(runId, {
            eventKey: `message.delta:${chunkIndex}`,
            type: 'message.delta',
            payload: { delta },
          })
          this.eventStore.appendEvent(runId, {
            eventKey: `tool.completed:${mcpApprovalId}`,
            type: 'tool.completed',
            payload: {
              toolCallId: mcpApprovalId,
              toolName: `${plan.mcpTool.serverId}/${plan.mcpTool.toolName}`,
              summary,
              isError: toolResult.isToolError,
            },
          })
        } catch (invokeErr) {
          const completedAt = new Date().toISOString()
          const errCode = invokeErr instanceof DaemonError ? invokeErr.code : 'MCP_DISPATCH_UNCERTAIN'
          const isPreDispatch = errCode === 'MCP_STALE_APPROVAL' || errCode === 'MCP_UNTRUSTED' || errCode === 'MCP_FORBIDDEN' || errCode === 'MCP_DISABLED'
          const nextState = isPreDispatch ? 'failed' : 'uncertain'
          const safeMsg = redactSecrets(invokeErr instanceof Error ? invokeErr.message : String(invokeErr))
          this.dbHandle.sqlite
            .prepare(
              `UPDATE mcp_approval_bindings
               SET dispatch_state = ?, updated_at = ?
               WHERE approval_id = ? AND dispatch_state = 'dispatched'`,
            )
            .run(nextState, completedAt, mcpApprovalId)
          throw invokeErr
        }
      }

      if (plan.approval) {
        maybeFlush(true)
        const mockApprovalId = `${plan.approval.approvalId}_${runId}`
        const approvalSpec: PendingApprovalRecord = {
          ...plan.approval,
          approvalId: mockApprovalId,
          actionType: 'mock.workspaceWrite',
          argsHash: 'mock',
          permissionMode: 'ask-approval',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          isMock: true,
          status: 'pending',
        }
        const decisionPromise = new Promise<'approved' | 'denied' | 'cancelled'>((resolve) => {
          control.pendingApproval = { spec: approvalSpec, resolve }
        })

        const nowApp = new Date().toISOString()
        const runMeta = this.dbHandle.sqlite
          .prepare('SELECT agent_id FROM runs WHERE id = ?')
          .get(runId) as { agent_id: string } | undefined
        this.dbHandle.sqlite
          .prepare(
            `INSERT OR IGNORE INTO approvals (
               id, run_id, session_id, agent_id, runtime_generation, account_id,
               thread_id, turn_id, provider_request_id, action_type, action_summary,
               args_json, args_hash, permission_mode, status, decision_meta_json,
               created_at, expires_at, resolved_at
             ) VALUES (?, ?, ?, ?, 0, 'local', NULL, NULL, ?, 'mock.workspaceWrite', ?, ?, 'mock', 'ask-approval', 'pending', NULL, ?, ?, NULL)`,
          )
          .run(
            mockApprovalId,
            runId,
            sessionId,
            runMeta?.agent_id ?? 'chief',
            mockApprovalId,
            approvalSpec.command,
            JSON.stringify({ command: approvalSpec.command }),
            nowApp,
            approvalSpec.expiresAt!,
          )

        this.transitionRun(runId, 'awaiting_approval', {
          eventKey: `approval.requested:${approvalSpec.approvalId}`,
          type: 'approval.requested',
          payload: {
            approvalId: approvalSpec.approvalId,
            title: approvalSpec.title,
            command: approvalSpec.command,
            risk: approvalSpec.risk,
            actionType: approvalSpec.actionType,
            argsHash: approvalSpec.argsHash,
            permissionMode: approvalSpec.permissionMode,
            expiresAt: approvalSpec.expiresAt,
            isMock: true,
          },
        })

        const decision = await decisionPromise
        if (decision === 'cancelled' || finalizeIfCancelled()) {
          return
        }

        if (decision === 'denied') {
          accumulatedText += '\n\n[Simulated action denied by user]'
          this.finalizeRun({
            runId,
            sessionId,
            assistantMessageId,
            terminalStatus: 'cancelled',
            messageStatus: 'cancelled',
            accumulatedText,
            eventKey: 'run.cancelled:approval_denied',
            eventType: 'run.cancelled',
            eventPayload: { reason: 'approval_denied' },
          })
          return
        }

        for (const chunk of plan.postApprovalChunks ?? []) {
          if (finalizeIfCancelled()) return
          accumulatedText += chunk
          pendingChunks += 1
          chunkIndex += 1
          this.eventStore.appendEvent(runId, {
            eventKey: `message.delta:${chunkIndex}`,
            type: 'message.delta',
            payload: { delta: chunk },
          })
          maybeFlush(false)
          await sleepAbortable(plan.chunkDelayMs, signal)
        }
      }

      if (finalizeIfCancelled()) return

      if (plan.emitTool) {
        this.eventStore.appendEvent(runId, {
          eventKey: `tool.completed:${plan.emitTool.toolCallId}`,
          type: 'tool.completed',
          payload: {
            toolCallId: plan.emitTool.toolCallId,
            toolName: plan.emitTool.toolName,
            summary: plan.emitTool.summary,
          },
        })
      }

      this.eventStore.appendEvent(runId, {
        eventKey: 'usage.updated:final',
        type: 'usage.updated',
        payload: {
          inputTokens: Math.max(12, Math.ceil(prompt.length / 4)),
          outputTokens: Math.max(24, Math.ceil(accumulatedText.length / 4)),
          isMock: true,
        },
      })

      maybeFlush(true)
      this.finalizeRun({
        runId,
        sessionId,
        assistantMessageId,
        terminalStatus: 'completed',
        messageStatus: 'complete',
        accumulatedText,
        eventKey: 'run.completed',
        eventType: 'run.completed',
        eventPayload: {
          assistantMessageId,
          isMock: true,
        },
      })
    } catch (err) {
      maybeFlush(true)
      const message = redactSecrets(err instanceof Error ? err.message : String(err))
      this.finalizeRun({
        runId,
        sessionId,
        assistantMessageId,
        terminalStatus: 'failed',
        messageStatus: 'failed',
        accumulatedText,
        error: {
          code: 'MOCK_ORCHESTRATOR_ERROR',
          message,
          retryable: false,
        },
        eventKey: 'run.failed:unexpected',
        eventType: 'run.failed',
        eventPayload: {
          code: 'MOCK_ORCHESTRATOR_ERROR',
          message,
        },
      })
    }
  }

  private async executeCodexRun(params: {
    runId: string
    sessionId: string
    agentId: string
    assistantMessageId: string
    prompt: string
    modelId: string
    effort: string
    permission: PermissionMode
    preflight: {
      adapter: CodexExecutionClient
      generation: number
      codexVersion: string | null
      accountKey: string
      canonicalWorkspace: string
      effectiveInstructions: string
      externalSessionId: string | null
    }
    control: ActiveRunControl
  }): Promise<void> {
    const {
      runId,
      sessionId,
      agentId,
      assistantMessageId,
      prompt,
      modelId,
      effort,
      permission,
      preflight,
      control,
    } = params
    const signal = control.abortController.signal
    const { adapter, generation, accountKey, canonicalWorkspace, effectiveInstructions } = preflight

    let accumulatedText = ''
    let pendingChunks = 0
    let lastFlushAt = Date.now()
    let sawTerminal = false

    const flushCodexBuffer = (force = false) => {
      const nowMs = Date.now()
      if (force || pendingChunks >= FLUSH_CHUNK_THRESHOLD || nowMs - lastFlushAt >= FLUSH_INTERVAL_MS) {
        if (pendingChunks > 0) {
          const now = new Date().toISOString()
          this.dbHandle.sqlite
            .prepare(
              `UPDATE messages SET content_json = ?, updated_at = ? WHERE id = ? AND status = 'streaming'`,
            )
            .run(
              serializeMessageContent(accumulatedText, { isMock: false, runtimeId: 'codex' }),
              now,
              assistantMessageId,
            )
          pendingChunks = 0
          lastFlushAt = nowMs
        }
      }
    }

    try {
      this.transitionRun(runId, 'starting', {
        eventKey: 'run.starting',
        type: 'run.starting',
        payload: {
          runtimeId: 'codex',
          codexVersion: preflight.codexVersion,
          isMock: false,
        },
      })

      if (signal.aborted || this.stopping) {
        this.finalizeRun({
          runId,
          sessionId,
          assistantMessageId,
          terminalStatus: this.stopping ? 'interrupted' : 'cancelled',
          messageStatus: this.stopping ? 'interrupted' : 'cancelled',
          accumulatedText: '[Run cancelled before turn start]',
          eventKey: this.stopping ? 'run.interrupted:shutdown' : 'run.cancelled:pre_turn',
          eventType: this.stopping ? 'run.interrupted' : 'run.cancelled',
          eventPayload: { reason: this.stopping ? 'daemon_stopping' : 'cancelled_before_turn' },
        })
        return
      }

      if (this.runtimeRegistry && this.runtimeRegistry.getGeneration() !== generation) {
        throw new DaemonError(
          'RUNTIME_GENERATION_CHANGED',
          'Codex runtime generation changed before thread setup; please retry.',
          { statusCode: 409, retryable: true },
        )
      }

      const sessionConfig: SessionConfig = {
        agentId,
        accountId: accountKey,
        modelId,
        effort,
        permission,
        workspace: canonicalWorkspace,
        instructions: effectiveInstructions,
      }

      let providerSession
      if (preflight.externalSessionId) {
        providerSession = await adapter.resumeSession(preflight.externalSessionId, sessionConfig)
      } else {
        providerSession = await adapter.createSession(sessionConfig)
        try {
          const now = new Date().toISOString()
          this.dbHandle.sqlite
            .prepare(
              `UPDATE sessions SET external_session_id = ?, account_id = ?, updated_at = ? WHERE id = ?`,
            )
            .run(providerSession.externalId, accountKey, now, sessionId)
        } catch (persistErr) {
          const msg = redactSecrets(
            persistErr instanceof Error ? persistErr.message : String(persistErr),
          )
          this.finalizeRun({
            runId,
            sessionId,
            assistantMessageId,
            terminalStatus: 'failed',
            messageStatus: 'failed',
            accumulatedText: '',
            error: {
              code: 'THREAD_PERSIST_FAILED',
              message: `Failed to persist provider thread identity: ${msg}`,
              retryable: false,
            },
            eventKey: 'run.failed:thread_persist',
            eventType: 'run.failed',
            eventPayload: {
              code: 'THREAD_PERSIST_FAILED',
              orphanThreadId: providerSession.externalId,
            },
          })
          return
        }
      }

      if (signal.aborted || this.stopping) {
        this.finalizeRun({
          runId,
          sessionId,
          assistantMessageId,
          terminalStatus: this.stopping ? 'interrupted' : 'cancelled',
          messageStatus: this.stopping ? 'interrupted' : 'cancelled',
          accumulatedText: '[Run cancelled before turn start]',
          eventKey: this.stopping ? 'run.interrupted:shutdown' : 'run.cancelled:pre_turn',
          eventType: this.stopping ? 'run.interrupted' : 'run.cancelled',
          eventPayload: { reason: this.stopping ? 'daemon_stopping' : 'cancelled_before_turn' },
        })
        return
      }

      this.transitionRun(runId, 'running', {
        eventKey: 'run.started',
        type: 'run.started',
        payload: {
          runtimeId: 'codex',
          threadId: providerSession.externalId,
          resumed: Boolean(preflight.externalSessionId),
          isMock: false,
          contextTiming: 'deferred_to_dispatch',
        },
      })

      for await (const ev of adapter.run({
        runId,
        session: providerSession,
        text: prompt,
        prepareReferenceContext: async () => {
          if (signal.aborted || this.stopping) {
            throw new DaemonError('RUN_CANCELLED', 'Run cancelled before turn dispatch', {
              statusCode: 409,
            })
          }
          const latestCombined = await this.prepareCombinedContextSafely({
            sessionId,
            agentId,
            runtimeId: 'codex',
            queryText: prompt,
            isMock: false,
          })
          if (signal.aborted || this.stopping) {
            throw new DaemonError('RUN_CANCELLED', 'Run cancelled during context preparation', {
              statusCode: 409,
            })
          }
          this.eventStore.appendEvent(runId, {
            eventKey: 'run.context_prepared',
            type: 'run.context_prepared',
            payload: {
              memoryContext: {
                status: latestCombined.memory.status,
                mechanism: latestCombined.memory.mechanism,
                count: latestCombined.memory.selectedCount,
                totalBytes: latestCombined.memory.totalBytes,
                truncated: latestCombined.memory.truncated,
              },
              knowledgeContext: {
                status: latestCombined.knowledge.status,
                mechanism: latestCombined.knowledge.mechanism,
                documents: latestCombined.knowledge.selectedDocuments,
                chunks: latestCombined.knowledge.selectedChunks,
                totalBytes: latestCombined.knowledge.totalBytes,
                truncated: latestCombined.knowledge.truncated,
                attachedSources: latestCombined.attachedSources,
              },
              combinedContextBytes: latestCombined.totalBytes,
            },
          })
          return latestCombined.envelopeJson ?? undefined
        },
      })) {
        if (this.runtimeRegistry && this.runtimeRegistry.getGeneration() !== generation) {
          throw new DaemonError(
            'RUNTIME_GENERATION_CHANGED',
            'Codex runtime generation changed during execution',
            { statusCode: 409, retryable: true },
          )
        }

        if (ev.type === 'message.delta') {
          accumulatedText += ev.text
          pendingChunks += 1
          this.eventStore.appendEvent(runId, {
            eventKey: `codex.evt:${ev.seq}`,
            type: 'message.delta',
            payload: { delta: ev.text },
            timestamp: ev.timestamp,
          })
          flushCodexBuffer(false)
        } else if (ev.type === 'tool.started') {
          this.eventStore.appendEvent(runId, {
            eventKey: `codex.evt:${ev.seq}`,
            type: 'tool.started',
            payload: {
              toolCallId: ev.callId,
              toolName: ev.tool,
            },
            timestamp: ev.timestamp,
          })
        } else if (ev.type === 'tool.completed') {
          this.eventStore.appendEvent(runId, {
            eventKey: `codex.evt:${ev.seq}`,
            type: 'tool.completed',
            payload: {
              toolCallId: ev.callId,
              toolName: ev.tool,
              summary: ev.summary,
            },
            timestamp: ev.timestamp,
          })
        } else if (ev.type === 'usage.updated') {
          this.eventStore.appendEvent(runId, {
            eventKey: `codex.evt:${ev.seq}`,
            type: 'usage.updated',
            payload: {
              inputTokens: ev.usage.inputTokens ?? null,
              outputTokens: ev.usage.outputTokens ?? null,
              isMock: false,
            },
            timestamp: ev.timestamp,
          })
        } else if (ev.type === 'approval.requested') {
          const now = new Date().toISOString()
          const blockedReadOnly = permission === 'read-only'
          this.dbHandle.sqlite
            .prepare(
              `INSERT OR IGNORE INTO approvals (
                 id, run_id, session_id, agent_id, runtime_generation, account_id,
                 thread_id, turn_id, provider_request_id, action_type, action_summary,
                 args_json, args_hash, permission_mode, status, decision_meta_json,
                 created_at, expires_at, resolved_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
            )
            .run(
              ev.approvalId,
              runId,
              sessionId,
              agentId,
              generation,
              accountKey,
              providerSession.externalId,
              ev.turnId ?? null,
              ev.approvalId,
              ev.tool,
              redactSecrets(ev.summary),
              JSON.stringify({ summary: redactSecrets(ev.summary) }),
              ev.argsHash,
              permission,
              blockedReadOnly ? 'denied' : 'pending',
              now,
              ev.expiresAt,
            )

          if (blockedReadOnly) {
            this.eventStore.appendEvent(runId, {
              eventKey: `codex.evt:${ev.seq}`,
              type: 'approval.requested',
              payload: {
                approvalId: ev.approvalId,
                title: ev.summary,
                tool: ev.tool,
                argsHash: ev.argsHash,
                blockedInReadOnly: true,
              },
              timestamp: ev.timestamp,
            })
            if (typeof adapter.resolveApproval === 'function') {
              await adapter
                .resolveApproval({
                  approvalId: ev.approvalId,
                  runId,
                  argsHash: ev.argsHash,
                  decision: 'deny',
                })
                .catch(() => undefined)
            }
            this.dbHandle.sqlite
              .prepare(`UPDATE approvals SET resolved_at = ?, decision_meta_json = ? WHERE id = ?`)
              .run(new Date().toISOString(), JSON.stringify({ reason: 'read_only_mode' }), ev.approvalId)
            this.eventStore.appendEvent(runId, {
              eventKey: `approval.denied:${ev.approvalId}`,
              type: 'approval.denied',
              payload: {
                approvalId: ev.approvalId,
                reason: 'Read-only mode denies privileged approval requests by policy.',
              },
            })
          } else {
            if (typeof adapter.resolveApproval === 'function') {
              control.liveResolveApproval = (dec) => adapter.resolveApproval!(dec)
            }
            control.pendingApproval = {
              spec: {
                approvalId: ev.approvalId,
                title: ev.summary,
                command: ev.summary,
                risk: 'medium',
                actionType: ev.tool,
                argsHash: ev.argsHash,
                permissionMode: permission,
                expiresAt: ev.expiresAt,
                isMock: false,
                status: 'pending',
              },
              resolve: () => undefined,
            }
            this.transitionRun(runId, 'awaiting_approval', {
              eventKey: `codex.evt:${ev.seq}`,
              type: 'approval.requested',
              payload: {
                approvalId: ev.approvalId,
                title: ev.summary,
                command: ev.summary,
                tool: ev.tool,
                argsHash: ev.argsHash,
                permissionMode: permission,
                expiresAt: ev.expiresAt,
                isMock: false,
              },
            })
          }
        } else if (ev.type === 'run.completed') {
          sawTerminal = true
          this.clearQuarantineForSession(sessionId)
          flushCodexBuffer(true)
          this.finalizeRun({
            runId,
            sessionId,
            assistantMessageId,
            terminalStatus: 'completed',
            messageStatus: 'complete',
            accumulatedText,
            eventKey: 'run.completed',
            eventType: 'run.completed',
            eventPayload: { assistantMessageId, isMock: false },
          })
          break
        } else if (ev.type === 'run.cancelled') {
          sawTerminal = true
          this.clearQuarantineForSession(sessionId)
          flushCodexBuffer(true)
          const cancelledText =
            accumulatedText.trim().length > 0
              ? `${accumulatedText}\n\n[Cancelled]`
              : '[Run cancelled]'
          this.finalizeRun({
            runId,
            sessionId,
            assistantMessageId,
            terminalStatus: 'cancelled',
            messageStatus: 'cancelled',
            accumulatedText: cancelledText,
            eventKey: 'run.cancelled',
            eventType: 'run.cancelled',
            eventPayload: { reason: 'user_cancelled' },
          })
          break
        } else if (ev.type === 'run.failed') {
          sawTerminal = true
          flushCodexBuffer(true)
          const safeMsg = redactSecrets(ev.message)
          this.finalizeRun({
            runId,
            sessionId,
            assistantMessageId,
            terminalStatus: 'failed',
            messageStatus: 'failed',
            accumulatedText,
            error: {
              code: ev.code,
              message: safeMsg,
              retryable: true,
            },
            eventKey: 'run.failed',
            eventType: 'run.failed',
            eventPayload: { code: ev.code, message: safeMsg },
          })
          break
        }
      }

      if (!sawTerminal) {
        flushCodexBuffer(true)
        this.finalizeRun({
          runId,
          sessionId,
          assistantMessageId,
          terminalStatus: this.stopping ? 'interrupted' : 'failed',
          messageStatus: this.stopping ? 'interrupted' : 'failed',
          accumulatedText,
          error: {
            code: 'RUNTIME_DISCONNECTED',
            message: 'Codex runtime stream ended before reporting a terminal event.',
            retryable: true,
          },
          eventKey: 'run.failed:stream_eof',
          eventType: this.stopping ? 'run.interrupted' : 'run.failed',
          eventPayload: { reason: 'stream_ended_without_terminal_event' },
        })
      }
    } catch (err) {
      flushCodexBuffer(true)
      const safeMsg = redactSecrets(err instanceof Error ? err.message : String(err))
      const errCode = err instanceof DaemonError ? err.code : 'CODEX_EXECUTION_ERROR'
      this.finalizeRun({
        runId,
        sessionId,
        assistantMessageId,
        terminalStatus: this.stopping ? 'interrupted' : 'failed',
        messageStatus: this.stopping ? 'interrupted' : 'failed',
        accumulatedText,
        error: {
          code: errCode,
          message: safeMsg,
          retryable: true,
        },
        eventKey: 'run.failed:codex_error',
        eventType: this.stopping ? 'run.interrupted' : 'run.failed',
        eventPayload: { code: errCode, message: safeMsg },
      })
    } finally {
      if (this.runtimeRegistry && !this.stopping) {
        void this.runtimeRegistry.getSnapshot(true).catch(() => undefined)
      }
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    const entries = Array.from(this.activeControls.entries())
    for (const [runId, control] of entries) {
      if (control.cancelTimeout) {
        clearTimeout(control.cancelTimeout)
      }
      if (control.pendingApproval) {
        const pending = control.pendingApproval
        control.pendingApproval = null
        pending.resolve('cancelled')
      }
      control.abortController.abort()
      if (control.liveCancel) {
        void control.liveCancel(runId).catch(() => undefined)
      }
    }

    if (entries.length > 0) {
      await Promise.race([
        Promise.allSettled(entries.map(([, c]) => c.donePromise)),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ])
    }
  }
}
