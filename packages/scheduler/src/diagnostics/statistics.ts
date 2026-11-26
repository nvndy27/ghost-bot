import type { RoutineScope } from '../contracts/types.ts'
import type { RoutineRepository } from '../repository/routine-repository.ts'

export interface RoutineExecutionStatistics {
  routineId: string
  ownerId: string
  botId: string
  scheduledOccurrences: number
  completedTasks: number
  failedTasks: number
  cancelledTasks: number
  expiredTasks: number
  interruptedTasks: number
  uncertainExecutionCount: number
  /**
   * Explicitly defined as completedTasks / (completedTasks + failedTasks + cancelledTasks + interruptedTasks),
   * or null when denominator is 0.
   */
  successRate: number | null
  successRateDenominator: number
  averageDurationMs: number | null
  durationSampleCount: number
  lastExecutionAt: string | null
  nextScheduledAt: string | null
  retentionNote: string
}

/**
 * Scope-aware aggregation of existing execution history.
 * Never fabricates token counts, inference costs, or provider quota.
 */
export function getRoutineStatistics(
  repository: RoutineRepository,
  routineId: string,
  scope: RoutineScope,
): RoutineExecutionStatistics {
  const db = repository.getDatabase()
  const routine = repository.getById(routineId, scope)

  const rows = db.sqlite
    .prepare(
      `SELECT status, uncertain_execution, started_at, ended_at
       FROM scheduler_tasks
       WHERE routine_id = ? AND owner_id = ? AND bot_id = ?`,
    )
    .all(routine.id, scope.ownerId, scope.botId) as Array<{
    status: string
    uncertain_execution: number
    started_at: string | null
    ended_at: string | null
  }>

  let completedTasks = 0
  let failedTasks = 0
  let cancelledTasks = 0
  let expiredTasks = 0
  let interruptedTasks = 0
  let uncertainExecutionCount = 0
  let durationSumMs = 0
  let durationSampleCount = 0
  let lastExecutionAt: string | null = routine.lastRunAt

  for (const r of rows) {
    if (r.status === 'completed') completedTasks += 1
    else if (r.status === 'failed') failedTasks += 1
    else if (r.status === 'cancelled') cancelledTasks += 1
    else if (r.status === 'expired') expiredTasks += 1
    else if (r.status === 'interrupted') interruptedTasks += 1

    if (r.uncertain_execution === 1) uncertainExecutionCount += 1

    if (r.started_at && r.ended_at) {
      const sMs = Date.parse(r.started_at)
      const eMs = Date.parse(r.ended_at)
      if (Number.isFinite(sMs) && Number.isFinite(eMs) && eMs >= sMs) {
        durationSumMs += eMs - sMs
        durationSampleCount += 1
      }
    }
    if (r.ended_at && (!lastExecutionAt || r.ended_at > lastExecutionAt)) {
      lastExecutionAt = r.ended_at
    }
  }

  const denominator = completedTasks + failedTasks + cancelledTasks + interruptedTasks
  const successRate = denominator > 0 ? Number((completedTasks / denominator).toFixed(4)) : null
  const averageDurationMs =
    durationSampleCount > 0 ? Math.round(durationSumMs / durationSampleCount) : null

  return {
    routineId: routine.id,
    ownerId: routine.ownerId,
    botId: routine.botId,
    scheduledOccurrences: rows.length,
    completedTasks,
    failedTasks,
    cancelledTasks,
    expiredTasks,
    interruptedTasks,
    uncertainExecutionCount,
    successRate,
    successRateDenominator: denominator,
    averageDurationMs,
    durationSampleCount,
    lastExecutionAt,
    nextScheduledAt: routine.nextRunAt,
    retentionNote:
      'Statistics reflect retained scheduler_tasks rows; pruned terminal history is excluded while deduplication keys remain in scheduler_occurrence_dedup.',
  }
}
