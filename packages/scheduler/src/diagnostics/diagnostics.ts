import type { RoutineScope } from '../contracts/types.ts'
import type { RoutineRepository } from '../repository/routine-repository.ts'
import { DEFAULT_QUEUE_CAPACITY } from '../security/validation.ts'

export type DiagnosticReasonCode =
  | 'ELIGIBLE'
  | 'NOT_YET_DUE'
  | 'DISABLED'
  | 'ARCHIVED'
  | 'EXPIRED'
  | 'EXTERNALLY_MANAGED'
  | 'INVALID_SCHEDULE'
  | 'BLOCKED_BY_CONCURRENCY'
  | 'BLOCKED_BY_QUEUE_CAPACITY'
  | 'HAS_UNCERTAIN_EXECUTION'
  | 'STALE_TASK_REVISION'
  | 'AWAITING_EXECUTION_AUTHORIZATION'
  | 'EVENT_DRIVEN_ONLY'

export interface RoutineDiagnosticReport {
  routineId: string
  ownerId: string
  botId: string
  revision: number
  eligibleForScheduling: boolean
  reasonCodes: DiagnosticReasonCode[]
  nextRunAt: string | null
  activeTaskCount: number
  uncertainTaskCount: number
  staleQueuedTaskCount: number
  awaitingApprovalCount: number
  authorizationNote: string
}

/**
 * Read-only, scope-aware routine diagnostics using existing repository & SQLite state.
 */
export function diagnoseRoutine(
  repository: RoutineRepository,
  routineId: string,
  scope: RoutineScope,
  options: { nowMs?: number; maxQueueCapacity?: number } = {},
): RoutineDiagnosticReport {
  const nowMs = options.nowMs ?? Date.now()
  const maxQueueCapacity = options.maxQueueCapacity ?? DEFAULT_QUEUE_CAPACITY
  const db = repository.getDatabase()
  const routine = repository.getById(routineId, scope)

  const reasons: DiagnosticReasonCode[] = []

  if (routine.ownership !== 'ghost-bot') {
    reasons.push('EXTERNALLY_MANAGED')
  }
  if (routine.archivedAt !== null) {
    reasons.push('ARCHIVED')
  }
  if (!routine.enabled) {
    reasons.push('DISABLED')
  }
  if (routine.expiresAt !== null && nowMs >= Date.parse(routine.expiresAt)) {
    reasons.push('EXPIRED')
  }
  if (routine.trigger.kind === 'event') {
    reasons.push('EVENT_DRIVEN_ONLY')
  }

  const activeRow = db.sqlite
    .prepare(
      `SELECT COUNT(*) AS cnt FROM scheduler_tasks
       WHERE routine_id = ? AND status IN ('claimed', 'running', 'awaiting_approval')`,
    )
    .get(routine.id) as { cnt: number }
  const activeTaskCount = Number(activeRow?.cnt ?? 0)

  const maxAllowed =
    routine.concurrencyPolicy === 'forbid' ? 1 : Math.max(1, routine.maxConcurrentRuns)
  if (activeTaskCount >= maxAllowed) {
    reasons.push('BLOCKED_BY_CONCURRENCY')
  }

  const totalActiveRow = db.sqlite
    .prepare(
      `SELECT COUNT(*) AS cnt FROM scheduler_tasks
       WHERE status IN ('scheduled', 'queued', 'claimed', 'running', 'awaiting_approval', 'interrupted')`,
    )
    .get() as { cnt: number }
  if (Number(totalActiveRow?.cnt ?? 0) >= maxQueueCapacity) {
    reasons.push('BLOCKED_BY_QUEUE_CAPACITY')
  }

  const uncertainRow = db.sqlite
    .prepare(
      `SELECT COUNT(*) AS cnt FROM scheduler_tasks WHERE routine_id = ? AND uncertain_execution = 1`,
    )
    .get(routine.id) as { cnt: number }
  const uncertainTaskCount = Number(uncertainRow?.cnt ?? 0)
  if (uncertainTaskCount > 0) {
    reasons.push('HAS_UNCERTAIN_EXECUTION')
  }

  const staleRow = db.sqlite
    .prepare(
      `SELECT COUNT(*) AS cnt FROM scheduler_tasks
       WHERE routine_id = ? AND status = 'queued' AND routine_revision != ?`,
    )
    .get(routine.id, routine.revision) as { cnt: number }
  const staleQueuedTaskCount = Number(staleRow?.cnt ?? 0)
  if (staleQueuedTaskCount > 0) {
    reasons.push('STALE_TASK_REVISION')
  }

  const apprRow = db.sqlite
    .prepare(
      `SELECT COUNT(*) AS cnt FROM scheduler_tasks
       WHERE routine_id = ? AND status = 'awaiting_approval'`,
    )
    .get(routine.id) as { cnt: number }
  const awaitingApprovalCount = Number(apprRow?.cnt ?? 0)
  if (awaitingApprovalCount > 0) {
    reasons.push('AWAITING_EXECUTION_AUTHORIZATION')
  }

  const blocked = reasons.some(
    (r) =>
      r === 'EXTERNALLY_MANAGED' ||
      r === 'ARCHIVED' ||
      r === 'DISABLED' ||
      r === 'EXPIRED' ||
      r === 'BLOCKED_BY_CONCURRENCY' ||
      r === 'BLOCKED_BY_QUEUE_CAPACITY' ||
      r === 'EVENT_DRIVEN_ONLY',
  )

  if (!blocked) {
    if (routine.nextRunAt !== null && Date.parse(routine.nextRunAt) <= nowMs) {
      reasons.push('ELIGIBLE')
    } else {
      reasons.push('NOT_YET_DUE')
    }
  }

  return {
    routineId: routine.id,
    ownerId: routine.ownerId,
    botId: routine.botId,
    revision: routine.revision,
    eligibleForScheduling: reasons.includes('ELIGIBLE'),
    reasonCodes: reasons,
    nextRunAt: routine.nextRunAt,
    activeTaskCount,
    uncertainTaskCount,
    staleQueuedTaskCount,
    awaitingApprovalCount,
    authorizationNote:
      'Scheduler eligibility does not grant daemon execution authorization; RuntimePolicyBroker revalidates on dispatch.',
  }
}
