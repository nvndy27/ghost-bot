import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  CreateRoutineInput,
  RoutineScope,
  ScheduledTaskRecord,
  TaskStatus,
  UpdateRoutinePatch,
} from '../contracts/types.ts'
import { diagnoseRoutine, type DiagnosticReasonCode } from '../diagnostics/diagnostics.ts'
import { SchedulerEngine } from '../engine/scheduler-engine.ts'
import { ExecutionQueue } from '../queue/execution-queue.ts'
import { RoutineRepository } from '../repository/routine-repository.ts'
import { openSchedulerDatabase } from '../repository/sqlite-store.ts'
import { DEFAULT_QUEUE_CAPACITY, SchedulerError } from '../security/validation.ts'

export const MAX_SIM_ROUTINES = 20
export const MAX_SIM_TICKS = 100
export const MAX_SIM_OCCURRENCES = 200
export const MAX_SIM_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

export type SimulationAction =
  | { atMs: number; kind: 'tick' }
  | { atMs: number; kind: 'manual'; routineIndex: number; idempotencyKey: string }
  | { atMs: number; kind: 'event'; envelope: unknown }
  | { atMs: number; kind: 'claim_and_complete'; workerId: string }
  | { atMs: number; kind: 'claim_only'; workerId: string }
  | { atMs: number; kind: 'update_routine'; routineIndex: number; patch: UpdateRoutinePatch }
  | { atMs: number; kind: 'disable_routine'; routineIndex: number }
  | { atMs: number; kind: 'restart_reconcile' }

export interface DryRunSimulationOptions {
  routines: CreateRoutineInput[]
  startMs: number
  endMs?: number
  tickIntervalMs?: number
  maxQueueCapacity?: number
  actions?: SimulationAction[]
}

export interface DryRunSimulationReport {
  simulatedOnly: true
  routineCount: number
  ticksExecuted: number
  expectedOccurrences: number
  skippedOccurrences: number
  deduplicatedOccurrences: number
  estimatedDispatchOpportunities: number
  taskStates: Record<TaskStatus, number>
  blockingReasonCodes: DiagnosticReasonCode[]
  warnings: string[]
  tasks: ScheduledTaskRecord[]
}

/**
 * Deterministic, isolated dry-run simulator.
 * Uses a temporary SQLite store cleaned up on exit; never mutates source data or invokes external runtimes.
 */
export function runDryRunSimulation(options: DryRunSimulationOptions): DryRunSimulationReport {
  if (!Array.isArray(options.routines) || options.routines.length === 0) {
    throw new SchedulerError('INVALID_SIMULATION', 'Simulation requires at least 1 routine')
  }
  if (options.routines.length > MAX_SIM_ROUTINES) {
    throw new SchedulerError(
      'SIMULATION_LIMIT_EXCEEDED',
      `Simulation routine count exceeds max ${MAX_SIM_ROUTINES}`,
    )
  }

  const startMs = options.startMs
  const endMs = options.endMs ?? startMs
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    throw new SchedulerError('INVALID_SIMULATION', 'Invalid simulation time window')
  }
  if (endMs - startMs > MAX_SIM_WINDOW_MS) {
    throw new SchedulerError(
      'SIMULATION_LIMIT_EXCEEDED',
      `Simulation window exceeds max ${MAX_SIM_WINDOW_MS}ms`,
    )
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'ghost-sched-sim-'))
  try {
    const db = openSchedulerDatabase(tempDir)
    const repo = new RoutineRepository(db)
    const queue = new ExecutionQueue(db, {
      maxQueueCapacity: options.maxQueueCapacity ?? DEFAULT_QUEUE_CAPACITY,
    })

    let simNowMs = startMs
    const engine = new SchedulerEngine({
      repository: repo,
      queue,
      clock: { nowMs: () => simNowMs },
    })

    const createdRoutines = options.routines.map((r) => repo.create(r, startMs))
    const warnings: string[] = []
    let ticksExecuted = 0
    let expectedOccurrences = 0
    let skippedOccurrences = 0
    let deduplicatedOccurrences = 0
    let estimatedDispatchOpportunities = 0

    const timeline: SimulationAction[] = [...(options.actions ?? [])]
    if (options.tickIntervalMs && options.tickIntervalMs > 0) {
      for (let t = startMs; t <= endMs; t += options.tickIntervalMs) {
        timeline.push({ atMs: t, kind: 'tick' })
        if (timeline.length > MAX_SIM_TICKS * 2) break
      }
    } else if (timeline.length === 0) {
      timeline.push({ atMs: startMs, kind: 'tick' })
    }
    timeline.sort((a, b) => a.atMs - b.atMs)

    for (const step of timeline) {
      simNowMs = step.atMs
      if (step.kind === 'tick') {
        if (ticksExecuted >= MAX_SIM_TICKS) {
          warnings.push(`Stopped after reaching MAX_SIM_TICKS (${MAX_SIM_TICKS})`)
          break
        }
        ticksExecuted += 1
        try {
          const tick = engine.tick()
          expectedOccurrences += tick.enqueuedTasks
          deduplicatedOccurrences += tick.duplicatesSuppressed
          if (tick.missedTotal > tick.enqueuedTasks) {
            skippedOccurrences += tick.missedTotal - tick.enqueuedTasks
          }
          if (expectedOccurrences >= MAX_SIM_OCCURRENCES) {
            warnings.push(`Reached MAX_SIM_OCCURRENCES (${MAX_SIM_OCCURRENCES})`)
            break
          }
        } catch (err) {
          warnings.push(err instanceof Error ? err.message : 'Tick error')
        }
      } else if (step.kind === 'manual') {
        const rtn = createdRoutines[step.routineIndex]
        if (!rtn) continue
        try {
          const res = engine.triggerManual({
            routineId: rtn.id,
            scope: { ownerId: rtn.ownerId, botId: rtn.botId },
            idempotencyKey: step.idempotencyKey,
          })
          if (res.created) expectedOccurrences += 1
          else deduplicatedOccurrences += 1
        } catch (err) {
          warnings.push(err instanceof Error ? err.message : 'Manual trigger error')
        }
      } else if (step.kind === 'event') {
        try {
          const res = engine.ingestSyntheticEvent(step.envelope)
          expectedOccurrences += res.enqueuedTasks
          deduplicatedOccurrences += res.duplicatesSuppressed
        } catch (err) {
          warnings.push(err instanceof Error ? err.message : 'Event ingest error')
        }
      } else if (step.kind === 'claim_and_complete') {
        const claimed = queue.claimNext(step.workerId, 30_000, simNowMs)
        if (claimed) {
          estimatedDispatchOpportunities += 1
          queue.markRunning(claimed.id, step.workerId, simNowMs)
          queue.completeTask(claimed.id, step.workerId, simNowMs)
        }
      } else if (step.kind === 'claim_only') {
        const claimed = queue.claimNext(step.workerId, 30_000, simNowMs)
        if (claimed) {
          estimatedDispatchOpportunities += 1
          queue.markRunning(claimed.id, step.workerId, simNowMs)
        }
      } else if (step.kind === 'update_routine') {
        const rtn = createdRoutines[step.routineIndex]
        if (rtn) {
          createdRoutines[step.routineIndex] = repo.update(
            rtn.id,
            { ownerId: rtn.ownerId, botId: rtn.botId },
            step.patch,
            simNowMs,
          )
        }
      } else if (step.kind === 'disable_routine') {
        const rtn = createdRoutines[step.routineIndex]
        if (rtn) {
          createdRoutines[step.routineIndex] = repo.disable(
            rtn.id,
            { ownerId: rtn.ownerId, botId: rtn.botId },
            simNowMs,
          )
        }
      } else if (step.kind === 'restart_reconcile') {
        queue.reconcileOnRestart(simNowMs)
      }
    }

    const allTasks: ScheduledTaskRecord[] = []
    const seenScopes = new Set<string>()
    const blockingSet = new Set<DiagnosticReasonCode>()

    for (const rtn of createdRoutines) {
      const scope: RoutineScope = { ownerId: rtn.ownerId, botId: rtn.botId }
      const diag = diagnoseRoutine(repo, rtn.id, scope, {
        nowMs: simNowMs,
        maxQueueCapacity: options.maxQueueCapacity,
      })
      for (const code of diag.reasonCodes) {
        if (code !== 'ELIGIBLE' && code !== 'NOT_YET_DUE') {
          blockingSet.add(code)
        }
      }
      const hist = repo.listExecutionHistory(rtn.id, scope, MAX_SIM_OCCURRENCES)
      for (const t of hist) {
        if (!seenScopes.has(t.id)) {
          seenScopes.add(t.id)
          allTasks.push(t)
        }
      }
    }

    const taskStates: Record<TaskStatus, number> = {
      scheduled: 0,
      queued: 0,
      claimed: 0,
      running: 0,
      awaiting_approval: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      expired: 0,
      interrupted: 0,
    }
    for (const t of allTasks) {
      taskStates[t.status] += 1
      if (t.status === 'queued') estimatedDispatchOpportunities += 1
    }

    db.close()

    return {
      simulatedOnly: true,
      routineCount: createdRoutines.length,
      ticksExecuted,
      expectedOccurrences,
      skippedOccurrences,
      deduplicatedOccurrences,
      estimatedDispatchOpportunities,
      taskStates,
      blockingReasonCodes: [...blockingSet],
      warnings,
      tasks: allTasks.slice(0, MAX_SIM_OCCURRENCES),
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}
