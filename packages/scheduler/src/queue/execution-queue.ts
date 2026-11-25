import { randomUUID } from 'node:crypto'
import type {
  RoutineRecord,
  RoutineScope,
  ScheduledTaskRecord,
  TaskStatus,
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
  ): { task: ScheduledTaskRecord; created: boolean } {
    const occurrenceKey = `${routine.id}:${scheduledFor}`
    const nowIso = new Date(nowMs).toISOString()

    return this.db.transaction(() => {
      const existing = this.db.sqlite
        .prepare(`SELECT * FROM scheduler_tasks WHERE occurrence_key = ?`)
        .get(occurrenceKey) as RawTaskRow | undefined
      if (existing) {
        return { task: rowToTask(existing), created: false }
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
      this.db.sqlite
        .prepare(
          `INSERT INTO scheduler_tasks (
            id, routine_id, owner_id, bot_id, occurrence_key, scheduled_for,
            status, attempt, max_attempts, claim_owner, claim_lease_expires_at,
            uncertain_execution, approval_required, task_snapshot_json,
            error_code, error_message, started_at, ended_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, NULL, NULL, 0, 0, ?, NULL, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          id,
          routine.id,
          routine.ownerId,
          routine.botId,
          occurrenceKey,
          scheduledFor,
          routine.retryPolicy.maxAttempts,
          JSON.stringify(routine.task),
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
          `SELECT t.*, r.concurrency_policy, r.max_concurrent_runs
           FROM scheduler_tasks t
           JOIN scheduler_routines r ON r.id = t.routine_id
           WHERE t.status = 'queued' AND r.enabled = 1 AND r.archived_at IS NULL
           ORDER BY t.scheduled_for ASC, t.created_at ASC
           LIMIT 25`,
        )
        .all() as unknown as Array<
        RawTaskRow & { concurrency_policy: string; max_concurrent_runs: number }
      >

      for (const cand of candidates) {
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
      const uncertain = task.status === 'running' || task.status === 'claimed' ? 1 : task.uncertainExecution ? 1 : 0
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

  /**
   * Lease expiration does NOT prove external execution stopped; marks task interrupted
   * with uncertainExecution = true so it is never auto-re-dispatched.
   */
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

  /**
   * Restart reconciliation marks any in-flight tasks interrupted with uncertainExecution = true.
   * Never automatically replays interrupted tasks.
   */
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
}
