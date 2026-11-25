import type {
  Clock,
  FutureExecutionAuthorizationContext,
  FutureRoutineDispatcher,
  ScheduledTaskRecord,
} from '../contracts/types.ts'
import type { ExecutionQueue } from '../queue/execution-queue.ts'
import type { RoutineRepository } from '../repository/routine-repository.ts'
import { evaluateDueOccurrences } from '../schedules/calculator.ts'
import { redactSchedulerSecrets } from '../security/validation.ts'

export interface TickSummary {
  evaluatedAt: string
  evaluatedRoutines: number
  enqueuedTasks: number
  duplicatesSuppressed: number
  missedTotal: number
}

export interface SchedulerEngineOptions {
  repository: RoutineRepository
  queue: ExecutionQueue
  clock?: Clock
  graceWindowMs?: number
}

export class SchedulerEngine {
  private readonly repository: RoutineRepository
  private readonly queue: ExecutionQueue
  private readonly clock: Clock
  private readonly graceWindowMs: number

  constructor(options: SchedulerEngineOptions) {
    this.repository = options.repository
    this.queue = options.queue
    this.clock = options.clock ?? { nowMs: () => Date.now() }
    this.graceWindowMs = options.graceWindowMs ?? 60_000
  }

  /**
   * Evaluates due routine occurrences and enqueues unique occurrence tasks.
   * Separated from task dispatch so schedule evaluation never triggers direct execution.
   */
  tick(): TickSummary {
    const nowMs = this.clock.nowMs()
    const nowIso = new Date(nowMs).toISOString()
    const routines = this.repository.listAllEnabledForEngine()

    let enqueuedTasks = 0
    let duplicatesSuppressed = 0
    let missedTotal = 0

    for (const routine of routines) {
      const evalRes = evaluateDueOccurrences(routine, nowMs, this.graceWindowMs)
      missedTotal += evalRes.missedCount

      for (const scheduledFor of evalRes.dueOccurrences) {
        const res = this.queue.enqueueOccurrence(routine, scheduledFor, nowMs)
        if (res.created) {
          enqueuedTasks += 1
        } else {
          duplicatesSuppressed += 1
        }
      }

      const lastScheduled =
        evalRes.dueOccurrences.length > 0
          ? evalRes.dueOccurrences[evalRes.dueOccurrences.length - 1]!
          : null

      this.repository.updateScheduleCursor(
        routine.id,
        evalRes.nextRunAt,
        lastScheduled,
        nowIso,
        nowMs,
      )
    }

    return {
      evaluatedAt: nowIso,
      evaluatedRoutines: routines.length,
      enqueuedTasks,
      duplicatesSuppressed,
      missedTotal,
    }
  }

  /**
   * Claims and dispatches at most one queued task through the injected FutureRoutineDispatcher.
   * Never directly launches Codex, OpenClaw, MCP, shell, or network tools.
   */
  async dispatchNext(
    dispatcher: FutureRoutineDispatcher,
    workerId: string,
    leaseMs = 30_000,
  ): Promise<ScheduledTaskRecord | null> {
    const claimed = this.queue.claimNext(workerId, leaseMs, this.clock.nowMs())
    if (!claimed) return null

    const running = this.queue.markRunning(claimed.id, workerId, this.clock.nowMs())
    const ctx: FutureExecutionAuthorizationContext = {
      routineId: running.routineId,
      taskId: running.id,
      occurrenceKey: running.occurrenceKey,
      ownerId: running.ownerId,
      botId: running.botId,
      untrustedTask: running.taskSnapshot,
      requirePolicyRevalidation: true,
      reusePriorApprovals: false,
    }

    try {
      const outcome = await dispatcher.dispatch(ctx)
      const nowMs = this.clock.nowMs()
      if (outcome.status === 'completed') {
        return this.queue.completeTask(running.id, workerId, nowMs)
      }
      if (outcome.status === 'awaiting_approval') {
        return this.queue.markAwaitingApproval(running.id, workerId, nowMs)
      }
      return this.queue.failTask(
        running.id,
        workerId,
        outcome.code,
        redactSchedulerSecrets(outcome.message),
        nowMs,
      )
    } catch (err) {
      return this.queue.failTask(
        running.id,
        workerId,
        'DISPATCH_ERROR',
        redactSchedulerSecrets(err instanceof Error ? err.message : 'Dispatch error'),
        this.clock.nowMs(),
      )
    }
  }
}
