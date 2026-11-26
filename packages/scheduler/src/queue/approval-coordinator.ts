import type { RoutineScope, ScheduledTaskRecord } from '../contracts/types.ts'
import type { NotificationRepository } from '../notifications/repository.ts'
import { RoutineRepository } from '../repository/routine-repository.ts'
import type { SchedulerDatabaseHandle } from '../repository/sqlite-store.ts'
import {
  assertNonEmptyBounded,
  assertValidIsoTimestamp,
  redactSchedulerSecrets,
  SchedulerError,
} from '../security/validation.ts'
import { ExecutionQueue, isTerminalTaskStatus } from './execution-queue.ts'

export type ApprovalCoordinationState =
  | 'approval.requested'
  | 'approval.pending'
  | 'approval.denied'
  | 'approval.expired'
  | 'approval.revoked'
  | 'provider.delivery_unknown'
  | 'authorized.continuation'
  | 'execution.outcome_unknown'

export interface RoutineApprovalBinding {
  routineId: string
  routineRevision: number
  occurrenceKey: string
  taskId: string
  scope: RoutineScope
  daemonRunId: string
  daemonApprovalId: string
  expiresAt: string
  requirePolicyRevalidation: true
  sanitizedActionSummary: string
}

export type DaemonApprovalEventKind =
  | 'denied'
  | 'expired'
  | 'revoked'
  | 'provider_delivery_unknown'
  | 'approved_for_continuation'
  | 'outcome_unknown'

export interface DaemonApprovalEvent {
  taskId: string
  scope: RoutineScope
  daemonRunId: string
  daemonApprovalId: string
  routineRevision: number
  kind: DaemonApprovalEventKind
}

export interface ApprovalTransitionResult {
  applied: boolean
  reason: string
  approvalState: ApprovalCoordinationState
  task: ScheduledTaskRecord
}

/**
 * Coordinates routine tasks awaiting daemon-owned RunOrchestrator/RuntimePolicyBroker approvals.
 * Never acts as an approval authority, never creates reusable grants, and never replays prompts.
 */
export class RoutineApprovalCoordinator {
  private readonly db: SchedulerDatabaseHandle
  private readonly repository: RoutineRepository
  private readonly queue: ExecutionQueue
  private readonly notifications?: NotificationRepository

  constructor(
    db: SchedulerDatabaseHandle,
    options: { notifications?: NotificationRepository } = {},
  ) {
    this.db = db
    this.repository = new RoutineRepository(db)
    this.queue = new ExecutionQueue(db)
    this.notifications = options.notifications
  }

  bindApprovalRequest(
    binding: RoutineApprovalBinding,
    nowMs = Date.now(),
  ): ScheduledTaskRecord {
    if (binding.requirePolicyRevalidation !== true) {
      throw new SchedulerError('INVALID_APPROVAL_BINDING', 'requirePolicyRevalidation must be true')
    }
    const daemonRunId = assertNonEmptyBounded(binding.daemonRunId, 'daemonRunId', 128)
    const daemonApprovalId = assertNonEmptyBounded(binding.daemonApprovalId, 'daemonApprovalId', 128)
    const expiresAt = assertValidIsoTimestamp(binding.expiresAt, 'binding.expiresAt')
    const summary = assertNonEmptyBounded(
      redactSchedulerSecrets(binding.sanitizedActionSummary),
      'sanitizedActionSummary',
      300,
    )
    const nowIso = new Date(nowMs).toISOString()

    return this.db.transaction(() => {
      const task = this.queue.getTask(binding.taskId, binding.scope)
      if (isTerminalTaskStatus(task.status)) {
        throw new SchedulerError('TERMINAL_STATE_IMMUTABLE', `Task "${task.id}" is ${task.status}`)
      }
      if (task.status !== 'claimed' && task.status !== 'running') {
        throw new SchedulerError(
          'INVALID_TASK_STATE',
          `Cannot bind approval to task "${task.id}" in status "${task.status}"`,
        )
      }
      if (
        task.routineId !== binding.routineId ||
        task.routineRevision !== binding.routineRevision ||
        task.occurrenceKey !== binding.occurrenceKey
      ) {
        throw new SchedulerError('APPROVAL_BINDING_MISMATCH', 'Approval binding does not match task')
      }

      const routine = this.repository.getById(binding.routineId, binding.scope)
      if (!routine.enabled || routine.archivedAt !== null || routine.ownership !== 'ghost-bot') {
        throw new SchedulerError('ROUTINE_UNAVAILABLE', 'Routine is no longer eligible for approval')
      }

      this.db.sqlite
        .prepare(
          `UPDATE scheduler_tasks
           SET status = 'awaiting_approval',
               approval_required = 1,
               daemon_run_id = ?,
               daemon_approval_id = ?,
               approval_state = 'approval.pending',
               approval_expires_at = ?,
               approval_action_summary = ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(daemonRunId, daemonApprovalId, expiresAt, summary, nowIso, task.id)

      if (this.notifications) {
        this.notifications.create(
          {
            routineId: routine.id,
            routineRevision: routine.revision,
            taskId: task.id,
            occurrenceKey: task.occurrenceKey,
            scope: binding.scope,
            category: 'approval.required',
            severity: 'critical',
            dedupKey: `approval.required:${task.id}:${daemonApprovalId}`,
            summary: `Approval required for routine "${routine.name}": ${summary}`,
          },
          nowMs,
        )
      }

      return this.queue.getTask(task.id, binding.scope)
    })
  }

  applyApprovalEvent(
    event: DaemonApprovalEvent,
    nowMs = Date.now(),
  ): ApprovalTransitionResult {
    const nowIso = new Date(nowMs).toISOString()

    return this.db.transaction(() => {
      const task = this.queue.getTask(event.taskId, event.scope)
      const row = this.db.sqlite
        .prepare(
          `SELECT daemon_run_id, daemon_approval_id, approval_state, approval_expires_at
           FROM scheduler_tasks WHERE id = ?`,
        )
        .get(task.id) as {
        daemon_run_id: string | null
        daemon_approval_id: string | null
        approval_state: string | null
        approval_expires_at: string | null
      }

      if (
        task.status !== 'awaiting_approval' ||
        row.daemon_run_id !== event.daemonRunId ||
        row.daemon_approval_id !== event.daemonApprovalId ||
        task.routineRevision !== event.routineRevision
      ) {
        return {
          applied: false,
          reason: 'STALE_APPROVAL_EVENT',
          approvalState: (row.approval_state as ApprovalCoordinationState) ?? 'approval.expired',
          task,
        }
      }

      if (row.approval_expires_at && nowMs >= Date.parse(row.approval_expires_at)) {
        this.db.sqlite
          .prepare(
            `UPDATE scheduler_tasks
             SET status = 'expired',
                 approval_state = 'approval.expired',
                 claim_owner = NULL,
                 claim_lease_expires_at = NULL,
                 error_code = 'APPROVAL_EXPIRED',
                 error_message = 'Approval expired before resolution.',
                 ended_at = ?,
                 updated_at = ?
             WHERE id = ?`,
          )
          .run(nowIso, nowIso, task.id)
        return {
          applied: true,
          reason: 'APPROVAL_EXPIRED',
          approvalState: 'approval.expired',
          task: this.queue.getTask(task.id, event.scope),
        }
      }

      if (event.kind === 'denied') {
        this.db.sqlite
          .prepare(
            `UPDATE scheduler_tasks
             SET status = 'failed',
                 approval_state = 'approval.denied',
                 claim_owner = NULL,
                 claim_lease_expires_at = NULL,
                 error_code = 'APPROVAL_DENIED',
                 error_message = 'User denied routine approval request.',
                 ended_at = ?,
                 updated_at = ?
             WHERE id = ?`,
          )
          .run(nowIso, nowIso, task.id)
        return {
          applied: true,
          reason: 'APPROVAL_DENIED',
          approvalState: 'approval.denied',
          task: this.queue.getTask(task.id, event.scope),
        }
      }

      if (event.kind === 'expired' || event.kind === 'revoked') {
        const nextStatus = event.kind === 'expired' ? 'expired' : 'cancelled'
        const state: ApprovalCoordinationState =
          event.kind === 'expired' ? 'approval.expired' : 'approval.revoked'
        this.db.sqlite
          .prepare(
            `UPDATE scheduler_tasks
             SET status = ?,
                 approval_state = ?,
                 claim_owner = NULL,
                 claim_lease_expires_at = NULL,
                 error_code = ?,
                 error_message = ?,
                 ended_at = ?,
                 updated_at = ?
             WHERE id = ?`,
          )
          .run(
            nextStatus,
            state,
            event.kind === 'expired' ? 'APPROVAL_EXPIRED' : 'APPROVAL_REVOKED',
            `Approval ${event.kind} before continuation.`,
            nowIso,
            nowIso,
            task.id,
          )
        return {
          applied: true,
          reason: state,
          approvalState: state,
          task: this.queue.getTask(task.id, event.scope),
        }
      }

      if (event.kind === 'provider_delivery_unknown' || event.kind === 'outcome_unknown') {
        const state: ApprovalCoordinationState =
          event.kind === 'provider_delivery_unknown'
            ? 'provider.delivery_unknown'
            : 'execution.outcome_unknown'
        this.db.sqlite
          .prepare(
            `UPDATE scheduler_tasks
             SET status = 'interrupted',
                 uncertain_execution = 1,
                 approval_state = ?,
                 claim_owner = NULL,
                 claim_lease_expires_at = NULL,
                 error_code = ?,
                 error_message = ?,
                 ended_at = ?,
                 updated_at = ?
             WHERE id = ?`,
          )
          .run(
            state,
            event.kind === 'provider_delivery_unknown'
              ? 'APPROVAL_DELIVERY_UNKNOWN'
              : 'EXECUTION_OUTCOME_UNKNOWN',
            'External approval delivery or execution outcome is unknown; never auto-retrying.',
            nowIso,
            nowIso,
            task.id,
          )
        return {
          applied: true,
          reason: state,
          approvalState: state,
          task: this.queue.getTask(task.id, event.scope),
        }
      }

      // approved_for_continuation: revalidate routine state & revision; continue SAME task & daemonRunId
      const routine = this.repository.getById(task.routineId, event.scope)
      const routineExpired = routine.expiresAt !== null && nowMs >= Date.parse(routine.expiresAt)
      if (
        !routine.enabled ||
        routine.archivedAt !== null ||
        routine.ownership !== 'ghost-bot' ||
        routine.revision !== task.routineRevision ||
        routineExpired
      ) {
        this.db.sqlite
          .prepare(
            `UPDATE scheduler_tasks
             SET status = 'cancelled',
                 approval_state = 'approval.revoked',
                 claim_owner = NULL,
                 claim_lease_expires_at = NULL,
                 error_code = 'ROUTINE_UNAVAILABLE_ON_CONTINUATION',
                 error_message = 'Routine state or revision changed while awaiting approval; continuation aborted.',
                 ended_at = ?,
                 updated_at = ?
             WHERE id = ?`,
          )
          .run(nowIso, nowIso, task.id)
        return {
          applied: true,
          reason: 'ROUTINE_UNAVAILABLE_ON_CONTINUATION',
          approvalState: 'approval.revoked',
          task: this.queue.getTask(task.id, event.scope),
        }
      }

      this.db.sqlite
        .prepare(
          `UPDATE scheduler_tasks
           SET status = 'running',
               approval_state = 'authorized.continuation',
               updated_at = ?
           WHERE id = ?`,
        )
        .run(nowIso, task.id)

      return {
        applied: true,
        reason: 'AUTHORIZED_CONTINUATION',
        approvalState: 'authorized.continuation',
        task: this.queue.getTask(task.id, event.scope),
      }
    })
  }

  expireAwaitingApprovals(nowMs = Date.now()): number {
    const nowIso = new Date(nowMs).toISOString()
    return this.db.transaction(() => {
      const res = this.db.sqlite
        .prepare(
          `UPDATE scheduler_tasks
           SET status = 'expired',
               approval_state = 'approval.expired',
               claim_owner = NULL,
               claim_lease_expires_at = NULL,
               error_code = 'APPROVAL_EXPIRED',
               error_message = 'Approval expired before resolution.',
               ended_at = ?,
               updated_at = ?
           WHERE status = 'awaiting_approval'
             AND approval_expires_at IS NOT NULL
             AND approval_expires_at <= ?`,
        )
        .run(nowIso, nowIso, nowIso)
      return Number(res.changes)
    })
  }
}
