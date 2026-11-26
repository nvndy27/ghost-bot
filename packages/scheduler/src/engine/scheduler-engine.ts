import type {
  Clock,
  FutureExecutionAuthorizationContext,
  FutureRoutineDispatcher,
  RoutineScope,
  ScheduledTaskRecord,
} from '../contracts/types.ts'
import type { ExecutionQueue } from '../queue/execution-queue.ts'
import type { RoutineRepository } from '../repository/routine-repository.ts'
import { evaluateDueOccurrences } from '../schedules/calculator.ts'
import { matchesEventTrigger, validateEventEnvelope } from '../schedules/event-matcher.ts'
import { assertNonEmptyBounded, redactSchedulerSecrets, SchedulerError } from '../security/validation.ts'

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
   * Atomically evaluates due Ghost Bot-owned routines and advances schedule cursors.
   * Never dispatches inside an open SQLite transaction.
   */
  tick(): TickSummary {
    const nowMs = this.clock.nowMs()
    const nowIso = new Date(nowMs).toISOString()
    const routines = this.repository.listAllEnabledForEngine()
    const db = this.repository.getDatabase()

    let enqueuedTasks = 0
    let duplicatesSuppressed = 0
    let missedTotal = 0

    for (const routine of routines) {
      if (routine.ownership !== 'ghost-bot') continue
      if (routine.trigger.kind === 'event') continue

      const evalRes = evaluateDueOccurrences(routine, nowMs, this.graceWindowMs)
      missedTotal += evalRes.missedCount

      db.transaction(() => {
        for (const scheduledFor of evalRes.dueOccurrences) {
          const res = this.queue.enqueueOccurrence(routine, scheduledFor, nowMs, {
            triggerSource: 'schedule',
          })
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
      })
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
   * Deterministic manual trigger with explicit scope, idempotency, capacity, and revision preservation.
   */
  triggerManual(input: {
    routineId: string
    scope: RoutineScope
    idempotencyKey: string
  }): { task: ScheduledTaskRecord; created: boolean } {
    const nowMs = this.clock.nowMs()
    const nowIso = new Date(nowMs).toISOString()
    const idempotencyKey = assertNonEmptyBounded(input.idempotencyKey, 'idempotencyKey', 128)
    const routine = this.repository.getById(input.routineId, input.scope)

    if (routine.ownership !== 'ghost-bot') {
      throw new SchedulerError(
        'EXTERNAL_ROUTINE_OWNERSHIP',
        `Cannot manually trigger externally owned routine (${routine.ownership})`,
      )
    }
    if (routine.archivedAt !== null) {
      throw new SchedulerError('ROUTINE_ARCHIVED', 'Cannot trigger an archived routine')
    }
    if (!routine.enabled) {
      throw new SchedulerError('ROUTINE_DISABLED', 'Cannot trigger a disabled routine')
    }
    if (routine.expiresAt !== null && nowMs >= Date.parse(routine.expiresAt)) {
      throw new SchedulerError('ROUTINE_EXPIRED', 'Cannot trigger an expired routine')
    }

    return this.queue.enqueueOccurrence(routine, nowIso, nowMs, {
      triggerSource: 'manual',
      occurrenceKeyOverride: `manual:${routine.id}:${idempotencyKey}`,
    })
  }

  /**
   * Evaluates a synthetic untrusted event envelope against Ghost Bot-owned event routines
   * in the matching scope, deduplicating by (routineId, trustedSource, eventId).
   */
  ingestSyntheticEvent(rawEnvelope: unknown): {
    matchedRoutines: number
    enqueuedTasks: number
    duplicatesSuppressed: number
    tasks: ScheduledTaskRecord[]
  } {
    const envelope = validateEventEnvelope(rawEnvelope)
    const nowMs = this.clock.nowMs()
    const routines = this.repository.listEnabledEventRoutines(envelope.scope)

    let matchedRoutines = 0
    let enqueuedTasks = 0
    let duplicatesSuppressed = 0
    const tasks: ScheduledTaskRecord[] = []

    for (const routine of routines) {
      if (routine.ownership !== 'ghost-bot') continue
      if (routine.expiresAt !== null && nowMs >= Date.parse(routine.expiresAt)) continue
      if (!matchesEventTrigger(routine.trigger, envelope)) continue

      matchedRoutines += 1
      const res = this.queue.enqueueOccurrence(routine, envelope.timestamp, nowMs, {
        triggerSource: 'event',
        occurrenceKeyOverride: `event:${routine.id}:${envelope.trustedSource}:${envelope.eventId}`,
      })
      tasks.push(res.task)
      if (res.created) enqueuedTasks += 1
      else duplicatesSuppressed += 1
    }

    return { matchedRoutines, enqueuedTasks, duplicatesSuppressed, tasks }
  }

  /**
   * Claims and dispatches at most one queued task through the injected FutureRoutineDispatcher.
   * Never holds an open SQLite transaction while awaiting asynchronous dispatch.
   */
  async dispatchNext(
    dispatcher: FutureRoutineDispatcher,
    workerId: string,
    leaseMs = 30_000,
  ): Promise<ScheduledTaskRecord | null> {
    const claimed = this.queue.claimNext(workerId, leaseMs, this.clock.nowMs())
    if (!claimed) return null

    // Revalidate routine revision & eligibility at the dispatch boundary before calling dispatcher
    let currentRoutine
    try {
      currentRoutine = this.repository.getById(claimed.routineId, {
        ownerId: claimed.ownerId,
        botId: claimed.botId,
      })
    } catch {
      return this.queue.failTask(
        claimed.id,
        workerId,
        'ROUTINE_NOT_FOUND',
        'Routine removed before dispatch.',
        this.clock.nowMs(),
      )
    }
    if (
      !currentRoutine.enabled ||
      currentRoutine.archivedAt !== null ||
      currentRoutine.ownership !== 'ghost-bot' ||
      currentRoutine.revision !== claimed.routineRevision
    ) {
      return this.queue.failTask(
        claimed.id,
        workerId,
        currentRoutine.revision !== claimed.routineRevision
          ? 'STALE_ROUTINE_REVISION'
          : 'ROUTINE_UNAVAILABLE',
        'Routine state or revision changed between claim and dispatch; aborted before execution.',
        this.clock.nowMs(),
      )
    }

    const running = this.queue.markRunning(claimed.id, workerId, this.clock.nowMs())
    const ctx: FutureExecutionAuthorizationContext = {
      routineId: running.routineId,
      routineRevision: running.routineRevision,
      triggerSource: running.triggerSource,
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
