import { createHash, randomUUID } from 'node:crypto'
import type {
  RoutineRecord,
  RoutineScope,
  ScheduledTaskRecord,
  TaskStatus,
  TaskTriggerSource,
} from '../contracts/types.ts'
import { rowToTask, type RawTaskRow } from '../repository/routine-repository.ts'
import type { SchedulerDatabaseHandle } from '../repository/sqlite-store.ts'
import {
  assertScopeAccess,
  DEFAULT_QUEUE_CAPACITY,
  SchedulerError,
} from '../security/validation.ts'

const TERMINAL_STATUSES = new Set<TaskStatus>(['completed', 'failed', 'cancelled', 'expired'])

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

export interface ExecutionQueueOptions {
  maxQueueCapacity?: number
}

export interface EnqueueOptions {
  triggerSource?: TaskTriggerSource
  occurrenceKeyOverride?: string
  payloadHash?: string
  dedupExpiresAt?: string | null
}

export function computeTaskPayloadHash(routine: RoutineRecord): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        routineRevision: routine.revision,
        trigger: routine.trigger,
        timezone: routine.timezone,
        task: routine.task,
      }),
    )
    .digest('hex')
}

export class ExecutionQueue {
  private readonly db: SchedulerDatabaseHandle
  private readonly maxQueueCapacity: number

  constructor(db: SchedulerDatabaseHandle, options: ExecutionQueueOptions = {}) {
    this.db = db
    this.maxQueueCapacity = options.maxQueueCapacity ?? DEFAULT_QUEUE_CAPACITY
  }

  enqueueOccurrence(
    routine: RoutineRecord,
    scheduledFor: string,
    nowMs = Date.now(),
    options: EnqueueOptions = {},
  ): { task: ScheduledTaskRecord; created: boolean } {
    if (routine.ownership !== 'ghost-bot') {
      throw new SchedulerError(
        'EXTERNAL_ROUTINE_OWNERSHIP',
        `Cannot enqueue externally owned routine (${routine.ownership})`,
      )
    }
    const triggerSource: TaskTriggerSource = options.triggerSource ?? 'schedule'
    const occurrenceKey = options.occurrenceKeyOverride ?? `${routine.id}:${scheduledFor}`
    const payloadHash = options.payloadHash ?? computeTaskPayloadHash(routine)
    const nowIso = new Date(nowMs).toISOString()

    return this.db.transaction(() => {
      if (triggerSource === 'schedule') {
        const wmRow = this.db.sqlite
          .prepare(`SELECT dedup_watermark_at FROM scheduler_routines WHERE id = ?`)
          .get(routine.id) as { dedup_watermark_at: string | null } | undefined
        if (wmRow?.dedup_watermark_at && scheduledFor <= wmRow.dedup_watermark_at) {
          throw new SchedulerError(
            'STALE_OCCURRENCE_BEFORE_WATERMARK',
            `Occurrence "${scheduledFor}" is at or before durable deduplication watermark "${wmRow.dedup_watermark_at}"`,
          )
        }
      }

      const dedupRow = this.db.sqlite
        .prepare(
          `SELECT occurrence_key, payload_hash FROM scheduler_occurrence_dedup WHERE occurrence_key = ?`,
        )
        .get(occurrenceKey) as { occurrence_key: string; payload_hash: string | null } | undefined

      const existing = this.db.sqlite
        .prepare(`SELECT * FROM scheduler_tasks WHERE occurrence_key = ?`)
        .get(occurrenceKey) as RawTaskRow | undefined

      if (dedupRow || existing) {
        if (
          triggerSource === 'manual' &&
          dedupRow?.payload_hash &&
          dedupRow.payload_hash !== payloadHash
        ) {
          throw new SchedulerError(
            'IDEMPOTENCY_CONFLICT',
            `Manual idempotency key "${occurrenceKey}" reused with different routine revision or task`,
          )
        }
        if (existing) {
          return { task: rowToTask(existing), created: false }
        }
        throw new SchedulerError(
          'DUPLICATE_OCCURRENCE',
          `Occurrence "${occurrenceKey}" was already recorded in durable deduplication ledger`,
        )
      }

      const activeCountRow = this.db.sqlite
        .prepare(
          `SELECT COUNT(*) AS cnt FROM scheduler_tasks
           WHERE status IN ('scheduled', 'queued', 'claimed', 'running', 'awaiting_approval', 'interrupted')`,
        )
        .get() as { cnt: number }
      if (Number(activeCountRow?.cnt ?? 0) >= this.maxQueueCapacity) {
        throw new SchedulerError(
          'QUEUE_CAPACITY_EXCEEDED',
          `Execution queue reached capacity limit (${this.maxQueueCapacity})`,
        )
      }

      const id = `tsk_${randomUUID()}`
      const hasScheduledForCol = (
        this.db.sqlite.prepare(`PRAGMA table_info(scheduler_occurrence_dedup)`).all() as Array<{
          name: string
        }>
      ).some((c) => c.name === 'scheduled_for')
      if (hasScheduledForCol) {
        this.db.sqlite
          .prepare(
            `INSERT INTO scheduler_occurrence_dedup (
              occurrence_key, routine_id, trigger_source, scheduled_for, payload_hash, created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            occurrenceKey,
            routine.id,
            triggerSource,
            scheduledFor,
            payloadHash,
            nowIso,
            options.dedupExpiresAt ?? null,
          )
      } else {
        this.db.sqlite
          .prepare(
            `INSERT INTO scheduler_occurrence_dedup (
              occurrence_key, routine_id, trigger_source, payload_hash, created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            occurrenceKey,
            routine.id,
            triggerSource,
            payloadHash,
            nowIso,
            options.dedupExpiresAt ?? null,
          )
      }

      this.db.sqlite
        .prepare(
          `INSERT INTO scheduler_tasks (
            id, routine_id, routine_revision, trigger_source, owner_id, bot_id, occurrence_key, scheduled_for,
            status, attempt, max_attempts, claim_owner, claim_lease_expires_at,
            uncertain_execution, approval_required, task_snapshot_json, payload_hash,
            error_code, error_message, started_at, ended_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, NULL, NULL, 0, 0, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          id,
          routine.id,
          routine.revision,
          triggerSource,
          routine.ownerId,
          routine.botId,
          occurrenceKey,
          scheduledFor,
          routine.retryPolicy.maxAttempts,
          JSON.stringify(routine.task),
          payloadHash,
          nowIso,
          nowIso,
        )

      const row = this.db.sqlite
        .prepare(`SELECT * FROM scheduler_tasks WHERE id = ?`)
        .get(id) as unknown as RawTaskRow
      return { task: rowToTask(row), created: true }
    })
  }

  getTask(taskId: string, scope?: RoutineScope): ScheduledTaskRecord {
    const row = this.db.sqlite
      .prepare(`SELECT * FROM scheduler_tasks WHERE id = ?`)
      .get(taskId) as RawTaskRow | undefined
    if (!row) {
      throw new SchedulerError('TASK_NOT_FOUND', `Scheduled task "${taskId}" was not found`)
    }
    if (scope) {
      assertScopeAccess(scope, { ownerId: row.owner_id, botId: row.bot_id })
    }
    return rowToTask(row)
  }

  claimNext(
    workerId: string,
    leaseMs: number,
    nowMs = Date.now(),
  ): ScheduledTaskRecord | null {
    if (leaseMs < 100) {
      throw new SchedulerError('INVALID_INPUT', 'leaseMs must be >= 100')
    }
    const nowIso = new Date(nowMs).toISOString()
    const leaseExpiresIso = new Date(nowMs + leaseMs).toISOString()

    return this.db.transaction(() => {
      const candidates = this.db.sqlite
        .prepare(
          `SELECT t.*, r.concurrency_policy, r.max_concurrent_runs,
                  r.revision AS current_revision, r.enabled AS routine_enabled,
                  r.archived_at AS routine_archived_at, r.ownership AS routine_ownership
           FROM scheduler_tasks t
           JOIN scheduler_routines r ON r.id = t.routine_id
           WHERE t.status = 'queued'
           ORDER BY t.scheduled_for ASC, t.created_at ASC
           LIMIT 50`,
        )
        .all() as unknown as Array<
        RawTaskRow & {
          concurrency_policy: string
          max_concurrent_runs: number
          current_revision: number
          routine_enabled: number
          routine_archived_at: string | null
          routine_ownership: string
        }
      >

      for (const cand of candidates) {
        // Cancel obsolete/disabled/archived/external queued tasks instead of executing them
        if (
          cand.routine_ownership !== 'ghost-bot' ||
          cand.routine_enabled !== 1 ||
          cand.routine_archived_at !== null ||
          Number(cand.routine_revision) !== Number(cand.current_revision)
        ) {
          this.db.sqlite
            .prepare(
              `UPDATE scheduler_tasks
               SET status = 'cancelled',
                   error_code = ?,
                   error_message = ?,
                   ended_at = ?,
                   updated_at = ?
               WHERE id = ? AND status = 'queued'`,
            )
            .run(
              Number(cand.routine_revision) !== Number(cand.current_revision)
                ? 'STALE_ROUTINE_REVISION'
                : 'ROUTINE_UNAVAILABLE',
              'Task cancelled before execution because routine state or revision changed.',
              nowIso,
              nowIso,
              cand.id,
            )
          continue
        }

        const activeRow = this.db.sqlite
          .prepare(
            `SELECT COUNT(*) AS cnt FROM scheduler_tasks
             WHERE routine_id = ? AND status IN ('claimed', 'running', 'awaiting_approval')`,
          )
          .get(cand.routine_id) as { cnt: number }
        const maxAllowed =
          cand.concurrency_policy === 'forbid' ? 1 : Math.max(1, cand.max_concurrent_runs)
        if (Number(activeRow?.cnt ?? 0) >= maxAllowed) {
          continue
        }

        const updated = this.db.sqlite
          .prepare(
            `UPDATE scheduler_tasks
             SET status = 'claimed',
                 attempt = attempt + 1,
                 claim_owner = ?,
                 claim_lease_expires_at = ?,
                 updated_at = ?
             WHERE id = ? AND status = 'queued'`,
          )
          .run(workerId, leaseExpiresIso, nowIso, cand.id)

        if (updated.changes === 1) {
          return this.getTask(cand.id)
        }
      }
      return null
    })
  }

  markRunning(taskId: string, workerId: string, nowMs = Date.now()): ScheduledTaskRecord {
    const nowIso = new Date(nowMs).toISOString()
    return this.db.transaction(() => {
      const task = this.getTask(taskId)
      if (isTerminalTaskStatus(task.status)) {
        throw new SchedulerError('TERMINAL_STATE_IMMUTABLE', `Task "${taskId}" is already ${task.status}`)
      }
      if (task.status !== 'claimed' || task.claimOwner !== workerId) {
        throw new SchedulerError('CLAIM_MISMATCH', `Worker "${workerId}" does not hold claim on "${taskId}"`)
      }
      this.db.sqlite
        .prepare(
          `UPDATE scheduler_tasks
           SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
           WHERE id = ?`,
        )
        .run(nowIso, nowIso, taskId)
      return this.getTask(taskId)
    })
  }

  markAwaitingApproval(taskId: string, workerId: string, nowMs = Date.now()): ScheduledTaskRecord {
    const nowIso = new Date(nowMs).toISOString()
    return this.db.transaction(() => {
      const task = this.getTask(taskId)
      if (isTerminalTaskStatus(task.status)) {
        throw new SchedulerError('TERMINAL_STATE_IMMUTABLE', `Task "${taskId}" is already ${task.status}`)
      }
      if (task.claimOwner !== workerId || (task.status !== 'claimed' && task.status !== 'running')) {
        throw new SchedulerError('CLAIM_MISMATCH', `Worker "${workerId}" cannot pause "${taskId}" for approval`)
      }
      this.db.sqlite
        .prepare(
          `UPDATE scheduler_tasks
           SET status = 'awaiting_approval', approval_required = 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(nowIso, taskId)
      return this.getTask(taskId)
    })
  }

  completeTask(taskId: string, workerId: string, nowMs = Date.now()): ScheduledTaskRecord {
    const nowIso = new Date(nowMs).toISOString()
    return this.db.transaction(() => {
      const task = this.getTask(taskId)
      if (isTerminalTaskStatus(task.status)) {
        throw new SchedulerError('TERMINAL_STATE_IMMUTABLE', `Task "${taskId}" is already ${task.status}`)
      }
      if (task.claimOwner !== workerId) {
        throw new SchedulerError('CLAIM_MISMATCH', `Worker "${workerId}" does not own "${taskId}"`)
      }
      this.db.sqlite
        .prepare(
          `UPDATE scheduler_tasks
           SET status = 'completed', claim_owner = NULL, claim_lease_expires_at = NULL,
               uncertain_execution = 0, ended_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(nowIso, nowIso, taskId)
      this.db.sqlite
        .prepare(`UPDATE scheduler_routines SET last_task_status = 'completed', updated_at = ? WHERE id = ?`)
        .run(nowIso, task.routineId)
      return this.getTask(taskId)
    })
  }

  failTask(
    taskId: string,
    workerId: string,
    errorCode: string,
    errorMessage: string,
    nowMs = Date.now(),
  ): ScheduledTaskRecord {
    const nowIso = new Date(nowMs).toISOString()
    return this.db.transaction(() => {
      const task = this.getTask(taskId)
      if (isTerminalTaskStatus(task.status)) {
        throw new SchedulerError('TERMINAL_STATE_IMMUTABLE', `Task "${taskId}" is already ${task.status}`)
      }
      if (task.claimOwner !== workerId) {
        throw new SchedulerError('CLAIM_MISMATCH', `Worker "${workerId}" does not own "${taskId}"`)
      }
      this.db.sqlite
        .prepare(
          `UPDATE scheduler_tasks
           SET status = 'failed', claim_owner = NULL, claim_lease_expires_at = NULL,
               error_code = ?, error_message = ?, ended_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(errorCode, errorMessage, nowIso, nowIso, taskId)
      this.db.sqlite
        .prepare(`UPDATE scheduler_routines SET last_task_status = 'failed', updated_at = ? WHERE id = ?`)
        .run(nowIso, task.routineId)
      return this.getTask(taskId)
    })
  }

  cancelTask(taskId: string, scope: RoutineScope, nowMs = Date.now()): ScheduledTaskRecord {
    const nowIso = new Date(nowMs).toISOString()
    return this.db.transaction(() => {
      const task = this.getTask(taskId, scope)
      if (isTerminalTaskStatus(task.status)) {
        throw new SchedulerError('TERMINAL_STATE_IMMUTABLE', `Task "${taskId}" is already ${task.status}`)
      }
      const uncertain =
        task.status === 'running' || task.status === 'claimed'
          ? 1
          : task.uncertainExecution
            ? 1
            : 0
      this.db.sqlite
        .prepare(
          `UPDATE scheduler_tasks
           SET status = 'cancelled', claim_owner = NULL, claim_lease_expires_at = NULL,
               uncertain_execution = ?, ended_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(uncertain, nowIso, nowIso, taskId)
      this.db.sqlite
        .prepare(`UPDATE scheduler_routines SET last_task_status = 'cancelled', updated_at = ? WHERE id = ?`)
        .run(nowIso, task.routineId)
      return this.getTask(taskId, scope)
    })
  }

  expireStaleClaims(nowMs = Date.now()): number {
    const nowIso = new Date(nowMs).toISOString()
    return this.db.transaction(() => {
      const res = this.db.sqlite
        .prepare(
          `UPDATE scheduler_tasks
           SET status = 'interrupted',
               uncertain_execution = 1,
               claim_owner = NULL,
               claim_lease_expires_at = NULL,
               error_code = 'LEASE_EXPIRED',
               error_message = 'Claim lease expired; external execution state is uncertain.',
               ended_at = ?,
               updated_at = ?
           WHERE status IN ('claimed', 'running')
             AND claim_lease_expires_at IS NOT NULL
             AND claim_lease_expires_at <= ?`,
        )
        .run(nowIso, nowIso, nowIso)
      return Number(res.changes)
    })
  }

  reconcileOnRestart(nowMs = Date.now()): number {
    const nowIso = new Date(nowMs).toISOString()
    return this.db.transaction(() => {
      const res = this.db.sqlite
        .prepare(
          `UPDATE scheduler_tasks
           SET status = 'interrupted',
               uncertain_execution = 1,
               claim_owner = NULL,
               claim_lease_expires_at = NULL,
               error_code = 'DAEMON_RESTARTED',
               error_message = 'Task interrupted by restart; execution state is uncertain.',
               ended_at = ?,
               updated_at = ?
           WHERE status IN ('claimed', 'running', 'awaiting_approval')`,
        )
        .run(nowIso, nowIso)
      return Number(res.changes)
    })
  }

  retryTask(
    taskId: string,
    scope: RoutineScope,
    nowMs = Date.now(),
    options: { confirmUncertain?: boolean } = {},
  ): ScheduledTaskRecord {
    const nowIso = new Date(nowMs).toISOString()
    return this.db.transaction(() => {
      const task = this.getTask(taskId, scope)
      if (isTerminalTaskStatus(task.status) && task.status !== 'failed') {
        throw new SchedulerError('RETRY_NOT_ALLOWED', `Cannot retry task in status "${task.status}"`)
      }
      if (task.status !== 'failed' && task.status !== 'interrupted') {
        throw new SchedulerError('RETRY_NOT_ALLOWED', `Cannot retry task in status "${task.status}"`)
      }
      if (task.attempt >= task.maxAttempts) {
        throw new SchedulerError('RETRY_EXHAUSTED', `Task "${taskId}" reached maxAttempts (${task.maxAttempts})`)
      }
      if (task.uncertainExecution) {
        if (!task.taskSnapshot.idempotent) {
          throw new SchedulerError(
            'NON_IDEMPOTENT_UNCERTAIN',
            'Uncertain non-idempotent task cannot be retried automatically.',
          )
        }
        if (options.confirmUncertain !== true) {
          throw new SchedulerError(
            'RETRY_CONFIRMATION_REQUIRED',
            'Explicit confirmation required before retrying an uncertain task.',
          )
        }
      }
      this.db.sqlite
        .prepare(
          `UPDATE scheduler_tasks
           SET status = 'queued',
               uncertain_execution = 0,
               error_code = NULL,
               error_message = NULL,
               ended_at = NULL,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(nowIso, taskId)
      return this.getTask(taskId, scope)
    })
  }

  /**
   * Prunes old terminal history while NEVER deleting active, quarantined, uncertain,
   * or execution/approval-linked tasks, and preserving scheduler_occurrence_dedup so
   * pruned occurrences cannot be re-enqueued.
   */
  pruneCompletedHistory(options: { olderThanIso: string }): number {
    return this.db.transaction(() => {
      const tables = new Set(
        (
          this.db.sqlite
            .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
            .all() as Array<{ name: string }>
        ).map((r) => r.name),
      )
      const linkGuard = tables.has('scheduler_execution_links') && tables.has('runs')
        ? `AND id NOT IN (
             SELECT l.scheduler_task_id FROM scheduler_execution_links l
             JOIN runs r ON r.id = l.daemon_run_id
             WHERE r.status IN ('queued', 'starting', 'running', 'awaiting_approval', 'cancelling')
           )`
        : ''
      const teamLinkGuard = tables.has('scheduler_execution_links') && tables.has('team_runs')
        ? `AND id NOT IN (
             SELECT l.scheduler_task_id FROM scheduler_execution_links l
             JOIN team_runs tr ON tr.id = l.team_run_id
             WHERE tr.status IN ('queued', 'running', 'uncertain')
           )`
        : ''
      const approvalGuard = tables.has('scheduler_approval_links') && tables.has('approvals')
        ? `AND id NOT IN (
             SELECT al.scheduler_task_id FROM scheduler_approval_links al
             JOIN approvals a ON a.id = al.daemon_approval_id
             WHERE a.status = 'pending'
           )`
        : ''
      const res = this.db.sqlite
        .prepare(
          `DELETE FROM scheduler_tasks
           WHERE status IN ('completed', 'failed', 'cancelled', 'expired')
             AND uncertain_execution = 0
             AND ended_at IS NOT NULL
             AND ended_at <= ?
             ${linkGuard}
             ${teamLinkGuard}
             ${approvalGuard}`,
        )
        .run(options.olderThanIso)
      return Number(res.changes)
    })
  }

  /**
   * Bounded cleanup of expired 'schedule' deduplication keys with durable watermark advancement.
   * - Never prunes 'manual' or 'event' deduplication keys so manual idempotency-key reuse
   *   and out-of-order / replayed events remain permanently protected.
   * - Advances dedup_watermark_at only up to the pruned 'schedule' occurrences that precede
   *   any remaining scheduled task or unexpired schedule dedup record for the same routine.
   */
  pruneExpiredDedup(options: { nowIso: string; maxKeepPerRoutine?: number }): number {
    return this.db.transaction(() => {
      const hasScheduledForCol = (
        this.db.sqlite.prepare(`PRAGMA table_info(scheduler_occurrence_dedup)`).all() as Array<{
          name: string
        }>
      ).some((c) => c.name === 'scheduled_for')

      const occExpr = hasScheduledForCol ? `COALESCE(scheduled_for, created_at)` : `created_at`
      const candidates = this.db.sqlite
        .prepare(
          `SELECT occurrence_key, routine_id, ${occExpr} AS occ_ts
           FROM scheduler_occurrence_dedup
           WHERE trigger_source = 'schedule'
             AND expires_at IS NOT NULL AND expires_at <= ?
             AND occurrence_key NOT IN (SELECT occurrence_key FROM scheduler_tasks)`,
        )
        .all(options.nowIso) as Array<{ occurrence_key: string; routine_id: string; occ_ts: string }>

      if (candidates.length === 0) return 0

      // Compute minimum retained schedule timestamp per routine so watermark never skips ahead
      // of still-retained or active scheduled occurrences.
      const retainedMinByRoutine = new Map<string, string>()
      const activeRows = this.db.sqlite
        .prepare(
          `SELECT routine_id, MIN(scheduled_for) AS min_ts
           FROM scheduler_tasks
           WHERE trigger_source = 'schedule'
           GROUP BY routine_id`,
        )
        .all() as Array<{ routine_id: string; min_ts: string | null }>
      for (const row of activeRows) {
        if (row.min_ts) retainedMinByRoutine.set(row.routine_id, row.min_ts)
      }

      const unexpiredRows = this.db.sqlite
        .prepare(
          `SELECT routine_id, MIN(${occExpr}) AS min_ts
           FROM scheduler_occurrence_dedup
           WHERE trigger_source = 'schedule'
             AND (expires_at IS NULL OR expires_at > ?)
           GROUP BY routine_id`,
        )
        .all(options.nowIso) as Array<{ routine_id: string; min_ts: string | null }>
      for (const row of unexpiredRows) {
        if (!row.min_ts) continue
        const prev = retainedMinByRoutine.get(row.routine_id)
        if (!prev || row.min_ts < prev) {
          retainedMinByRoutine.set(row.routine_id, row.min_ts)
        }
      }

      const maxSafeByRoutine = new Map<string, string>()
      const keysToDelete: string[] = []
      for (const c of candidates) {
        const retainedMin = retainedMinByRoutine.get(c.routine_id)
        if (retainedMin && c.occ_ts >= retainedMin) {
          // Keep this dedup row until earlier retained schedule slots are also pruned
          continue
        }
        keysToDelete.push(c.occurrence_key)
        const prevMax = maxSafeByRoutine.get(c.routine_id)
        if (!prevMax || c.occ_ts > prevMax) {
          maxSafeByRoutine.set(c.routine_id, c.occ_ts)
        }
      }

      for (const [routineId, maxOcc] of maxSafeByRoutine.entries()) {
        this.db.sqlite
          .prepare(
            `UPDATE scheduler_routines
             SET dedup_watermark_at = CASE
               WHEN dedup_watermark_at IS NULL OR dedup_watermark_at < ? THEN ?
               ELSE dedup_watermark_at
             END
             WHERE id = ?`,
          )
          .run(maxOcc, maxOcc, routineId)
      }

      let deleted = 0
      const delStmt = this.db.sqlite.prepare(
        `DELETE FROM scheduler_occurrence_dedup WHERE occurrence_key = ?`,
      )
      for (const key of keysToDelete) {
        deleted += Number(delStmt.run(key).changes)
      }
      return deleted
    })
  }

  /**
   * Marks a running or claimed task interrupted with uncertainExecution = true
   * when external dispatch outcome is unknown. Never auto-retries.
   */
  markUncertainInterrupted(
    taskId: string,
    workerId: string,
    errorCode: string,
    errorMessage: string,
    nowMs = Date.now(),
  ): ScheduledTaskRecord {
    const nowIso = new Date(nowMs).toISOString()
    return this.db.transaction(() => {
      const task = this.getTask(taskId)
      if (isTerminalTaskStatus(task.status)) {
        throw new SchedulerError('TERMINAL_STATE_IMMUTABLE', `Task "${taskId}" is already ${task.status}`)
      }
      if (task.claimOwner !== workerId) {
        throw new SchedulerError('CLAIM_MISMATCH', `Worker "${workerId}" does not own "${taskId}"`)
      }
      this.db.sqlite
        .prepare(
          `UPDATE scheduler_tasks
           SET status = 'interrupted',
               uncertain_execution = 1,
               claim_owner = NULL,
               claim_lease_expires_at = NULL,
               error_code = ?,
               error_message = ?,
               ended_at = ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(errorCode, errorMessage, nowIso, nowIso, taskId)
      return this.getTask(taskId)
    })
  }

  /**
   * Marks any non-terminal scoped task interrupted with uncertainExecution = true
   * when external cancellation cannot be confirmed (even if awaiting_approval / unowned).
   */
  markUncertainCancellation(
    taskId: string,
    scope: RoutineScope,
    errorCode: string,
    errorMessage: string,
    nowMs = Date.now(),
  ): ScheduledTaskRecord {
    const nowIso = new Date(nowMs).toISOString()
    return this.db.transaction(() => {
      const task = this.getTask(taskId, scope)
      if (isTerminalTaskStatus(task.status)) {
        throw new SchedulerError('TERMINAL_STATE_IMMUTABLE', `Task "${taskId}" is already ${task.status}`)
      }
      this.db.sqlite
        .prepare(
          `UPDATE scheduler_tasks
           SET status = 'interrupted',
               uncertain_execution = 1,
               claim_owner = NULL,
               claim_lease_expires_at = NULL,
               error_code = ?,
               error_message = ?,
               ended_at = ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(errorCode, errorMessage, nowIso, nowIso, taskId)
      this.db.sqlite
        .prepare(`UPDATE scheduler_routines SET last_task_status = 'interrupted', updated_at = ? WHERE id = ?`)
        .run(nowIso, task.routineId)
      return this.getTask(taskId, scope)
    })
  }
}
