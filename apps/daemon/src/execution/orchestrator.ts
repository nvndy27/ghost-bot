import { randomUUID } from 'node:crypto'
import type { DatabaseHandle } from '../db/client.ts'
import { DaemonError, redactSecrets } from '../errors.ts'
import { serializeMessageContent } from '../sessions/repository.ts'
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

export class RunOrchestrator {
  readonly eventStore: RunEventStore
  private readonly dbHandle: DatabaseHandle
  private readonly activeControls = new Map<string, ActiveRunControl>()
  private stopping = false

  constructor(dbHandle: DatabaseHandle) {
    this.dbHandle = dbHandle
    this.eventStore = new RunEventStore(dbHandle)
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
        .prepare(`SELECT id, status FROM runs WHERE status IN (${activePlaceholders})`)
        .all(...ACTIVE_RUN_STATUSES) as unknown as Array<{ id: string; status: string }>

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
      }

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

  startRun(input: StartRunInput): StartRunResult {
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
      if (!isMockRuntime) {
        throw new DaemonError(
          'LIVE_INFERENCE_DISABLED',
          `Live AI inference for runtime "${bot.runtime_id}" is disabled in Phase 2A. Switch the bot runtime to "mock" for persisted local simulation.`,
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
        workspacePath: bot.workspace_path,
        isMock: true,
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
          serializeMessageContent('', { isMock: true, runtimeId: 'mock' }),
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
          isMock: true,
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
        workspacePath: bot.workspace_path,
      }
    })

    if (!txResult.deduplicated) {
      const abortController = new AbortController()
      const control: ActiveRunControl = {
        abortController,
        pendingApproval: null,
        donePromise: Promise.resolve(),
      }
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
      this.activeControls.set(txResult.run.id, control)
    }

    return {
      run: txResult.run,
      deduplicated: txResult.deduplicated,
      userMessageId: txResult.userMessageId,
      assistantMessageId: txResult.assistantMessageId,
    }
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
    }

    return result
  }

  resolveApproval(
    runId: string,
    approvalId: string,
    decision: 'approved' | 'denied',
  ): { run: RunRecord } {
    const control = this.activeControls.get(runId)
    if (!control?.pendingApproval || control.pendingApproval.spec.approvalId !== approvalId) {
      throw new DaemonError(
        'APPROVAL_NOT_FOUND',
        `No pending approval "${approvalId}" for run "${runId}"`,
        { statusCode: 404 },
      )
    }

    this.dbHandle.transaction(() => {
      const row = this.dbHandle.sqlite
        .prepare('SELECT status FROM runs WHERE id = ?')
        .get(runId) as { status: string } | undefined

      if (!row || row.status !== 'awaiting_approval') {
        throw new DaemonError(
          'INVALID_RUN_TRANSITION',
          `Run "${runId}" is not awaiting approval`,
          { statusCode: 409 },
        )
      }

      assertLegalTransition('awaiting_approval', 'running')
      const now = new Date().toISOString()
      this.dbHandle.sqlite
        .prepare(`UPDATE runs SET status = 'running' WHERE id = ?`)
        .run(runId)
      this.eventStore.appendEvent(runId, {
        eventKey: `approval.resolved:${approvalId}`,
        type: 'approval.resolved',
        payload: { approvalId, decision },
        timestamp: now,
      })
    })

    const pending = control.pendingApproval
    control.pendingApproval = null
    pending.resolve(decision)

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
        .prepare('SELECT status FROM runs WHERE id = ?')
        .get(params.runId) as { status: string } | undefined
      if (!row || !isRunStatus(row.status)) return

      const race = resolveTerminalRace(row.status, params.terminalStatus)
      if (race !== 'proceed') return

      assertLegalTransition(row.status, params.terminalStatus)

      const errorJson = params.error ? JSON.stringify(params.error) : null
      this.dbHandle.sqlite
        .prepare('UPDATE runs SET status = ?, ended_at = ?, error_json = ? WHERE id = ?')
        .run(params.terminalStatus, now, errorJson, params.runId)

      this.dbHandle.sqlite
        .prepare(
          `UPDATE messages
           SET content_json = ?, status = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          serializeMessageContent(params.accumulatedText, { isMock: true, runtimeId: 'mock' }),
          params.messageStatus,
          now,
          params.assistantMessageId,
        )

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

      this.transitionRun(runId, 'running', {
        eventKey: 'run.started',
        type: 'run.started',
        payload: { runtimeId: 'mock', isMock: true, scenario: plan.kind },
      })

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

      if (plan.approval) {
        maybeFlush(true)
        const approvalSpec = plan.approval
        const decisionPromise = new Promise<'approved' | 'denied' | 'cancelled'>((resolve) => {
          control.pendingApproval = { spec: approvalSpec, resolve }
        })

        this.transitionRun(runId, 'awaiting_approval', {
          eventKey: `approval.requested:${approvalSpec.approvalId}`,
          type: 'approval.requested',
          payload: {
            approvalId: approvalSpec.approvalId,
            title: approvalSpec.title,
            command: approvalSpec.command,
            risk: approvalSpec.risk,
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

  async stop(): Promise<void> {
    this.stopping = true
    const controls = Array.from(this.activeControls.values())
    for (const control of controls) {
      if (control.pendingApproval) {
        const pending = control.pendingApproval
        control.pendingApproval = null
        pending.resolve('cancelled')
      }
      control.abortController.abort()
    }

    if (controls.length > 0) {
      await Promise.race([
        Promise.allSettled(controls.map((c) => c.donePromise)),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ])
    }
  }
}
