import type {
  Clock,
  CreateRoutineInput,
  RoutineOwnership,
  RoutineRecord,
  RoutineScope,
  ScheduledTaskRecord,
  UpdateRoutinePatch,
} from '@ghost-bot/scheduler/contracts'
import { createBorrowedSchedulerDatabaseHandle } from '@ghost-bot/scheduler/db'
import { SchedulerEngine, type TickSummary } from '@ghost-bot/scheduler/engine'
import { ExecutionQueue } from '@ghost-bot/scheduler/queue'
import { RoutineRepository, rowToTask, type RawTaskRow } from '@ghost-bot/scheduler/repository'
import { previewRoutineSchedule } from '@ghost-bot/scheduler/preview'
import { diagnoseRoutine } from '@ghost-bot/scheduler/diagnostics'
import { getRoutineStatistics } from '@ghost-bot/scheduler/statistics'
import { runDryRunSimulation } from '@ghost-bot/scheduler/simulator'
import {
  commitImportRoutines,
  exportRoutines,
  previewImportRoutines,
  type ImportConflictPolicy,
} from '@ghost-bot/scheduler/portability'
import { NotificationRepository } from '@ghost-bot/scheduler/notifications'
import { evaluateNotificationPolicy } from '@ghost-bot/scheduler/notification-policy'
import { RoutineApprovalCoordinator } from '@ghost-bot/scheduler/approvals'
import { SchedulerError } from '@ghost-bot/scheduler/security'
import type { BotRepository } from '../bots/repository.ts'
import type { DatabaseHandle } from '../db/client.ts'
import { DaemonError } from '../errors.ts'
import { LOCAL_USER_ID } from '../memory/service.ts'
import type { TeamsService } from '../teams/service.ts'
import type { DaemonRoutineDispatcher } from './execution-bridge.ts'

function mapSchedulerError(err: unknown): never {
  if (err instanceof DaemonError) throw err
  if (err instanceof SchedulerError) {
    const status =
      err.code === 'ROUTINE_NOT_FOUND' || err.code === 'TASK_NOT_FOUND' || err.code === 'NOTIFICATION_NOT_FOUND'
        ? 404
        : err.code === 'SCOPE_FORBIDDEN' || err.code === 'EXTERNAL_ROUTINE_OWNERSHIP'
          ? 403
          : err.code === 'IDEMPOTENCY_CONFLICT' ||
              err.code === 'IMPORT_CONFLICT_ACTIVE_EXECUTION' ||
              err.code === 'TERMINAL_STATE_IMMUTABLE' ||
              err.code === 'STALE_OCCURRENCE_BEFORE_WATERMARK'
            ? 409
            : 400
    throw new DaemonError(err.code, err.message, { statusCode: status })
  }
  throw err
}

export type RoutineTargetType = 'bot' | 'team'

export interface SchedulerServiceOptions {
  clock?: Clock
  tickIntervalMs?: number
  maxTasksPerTick?: number
  historyRetentionMs?: number
  maintenanceIntervalMs?: number
}

export class SchedulerService {
  private readonly dbHandle: DatabaseHandle
  private readonly botRepo: BotRepository
  private readonly teamsService: TeamsService
  private readonly repository: RoutineRepository
  private readonly queue: ExecutionQueue
  private readonly engine: SchedulerEngine
  private readonly notifications: NotificationRepository
  readonly approvals: RoutineApprovalCoordinator
  private dispatcher: DaemonRoutineDispatcher | null = null
  private readonly clock: Clock
  private readonly tickIntervalMs: number
  private readonly maxTasksPerTick: number
  private readonly historyRetentionMs: number
  private readonly maintenanceIntervalMs: number

  private timer: ReturnType<typeof setInterval> | null = null
  private cycleInFlight = false
  private shuttingDown = false
  private reconciled = false
  private lastClockMs: number
  private lastMaintenanceMs = 0

  constructor(
    dbHandle: DatabaseHandle,
    botRepo: BotRepository,
    teamsService: TeamsService,
    options: SchedulerServiceOptions = {},
  ) {
    this.dbHandle = dbHandle
    this.botRepo = botRepo
    this.teamsService = teamsService
    this.clock = options.clock ?? { nowMs: () => Date.now() }
    this.tickIntervalMs = Math.max(50, Math.min(300_000, options.tickIntervalMs ?? 5_000))
    this.maxTasksPerTick = Math.max(1, Math.min(20, options.maxTasksPerTick ?? 4))
    this.historyRetentionMs = Math.max(60_000, options.historyRetentionMs ?? 30 * 24 * 60 * 60 * 1_000)
    this.maintenanceIntervalMs = Math.max(1_000, options.maintenanceIntervalMs ?? 60 * 60 * 1_000)
    this.lastClockMs = this.clock.nowMs()

    const borrowed = createBorrowedSchedulerDatabaseHandle(
      dbHandle.sqlite,
      dbHandle.transaction.bind(dbHandle),
      dbHandle.dbPath,
    )
    this.repository = new RoutineRepository(borrowed)
    this.queue = new ExecutionQueue(borrowed)
    this.engine = new SchedulerEngine({
      repository: this.repository,
      queue: this.queue,
      clock: this.clock,
    })
    this.notifications = new NotificationRepository(borrowed)
    this.approvals = new RoutineApprovalCoordinator(borrowed, {
      notifications: this.notifications,
    })
  }

  attachDispatcher(dispatcher: DaemonRoutineDispatcher): void {
    this.dispatcher = dispatcher
  }

  private assertTargetValid(botId: string, targetType: RoutineTargetType = 'bot', teamId?: string | null): void {
    const bot = this.botRepo.getBot(botId)
    if (!bot) {
      throw new DaemonError('BOT_NOT_FOUND', `Bot "${botId}" was not found or is archived`, { statusCode: 404 })
    }
    if (targetType === 'team') {
      if (!teamId) {
        throw new DaemonError('VALIDATION_ERROR', 'teamId is required for team-targeted routines', { statusCode: 400 })
      }
      const team = this.teamsService.getTeam(teamId)
      if (team.archivedAt !== null) {
        throw new DaemonError('TEAM_ARCHIVED', `Team "${teamId}" is archived`, { statusCode: 409 })
      }
      if (!team.memberBotIds.includes(botId)) {
        throw new DaemonError('VALIDATION_ERROR', `Bot "${botId}" is not a member of team "${teamId}"`, { statusCode: 400 })
      }
    }
  }

  private scopeForBot(botId: string): RoutineScope {
    return { ownerId: LOCAL_USER_ID, botId }
  }

  private emitNotificationForTask(task: ScheduledTaskRecord, routine: RoutineRecord): void {
    const nowMs = this.clock.nowMs()
    const category =
      task.status === 'completed'
        ? ('routine.completed' as const)
        : task.status === 'awaiting_approval'
          ? ('approval.required' as const)
          : task.status === 'interrupted' && task.uncertainExecution
            ? ('execution.uncertain' as const)
            : task.status === 'failed'
              ? ('routine.failed' as const)
              : null
    if (!category) return

    const severity =
      category === 'approval.required' || category === 'execution.uncertain'
        ? ('critical' as const)
        : category === 'routine.failed'
          ? ('warning' as const)
          : ('info' as const)

    const scope = { ownerId: task.ownerId, botId: task.botId }
    const recentCount = this.notifications.list(scope, { limit: 50 }).notifications.length
    const decision = evaluateNotificationPolicy(
      {
        enabledCategories: [
          'routine.completed',
          'routine.failed',
          'approval.required',
          'execution.uncertain',
        ],
        maxPerHour: 30,
      },
      category,
      severity,
      nowMs,
      recentCount,
    )

    const summary =
      category === 'routine.completed'
        ? `Routine "${routine.name}" completed.`
        : category === 'approval.required'
          ? `Routine "${routine.name}" requires approval.`
          : category === 'execution.uncertain'
            ? `Routine "${routine.name}" ended with uncertain execution outcome.`
            : `Routine "${routine.name}" failed (${task.errorCode ?? 'FAILED'}).`

    this.notifications.create(
      {
        routineId: routine.id,
        routineRevision: task.routineRevision,
        taskId: task.id,
        occurrenceKey: task.occurrenceKey,
        scope,
        category,
        severity,
        dedupKey: `notif:${category}:${task.id}`,
        summary,
        deliveryStatus: decision.deliveryStatus,
      },
      nowMs,
    )
  }

  runMaintenance(nowMs = this.clock.nowMs()): {
    prunedHistory: number
    prunedDedup: number
    prunedNotifications: number
  } {
    const olderThanIso = new Date(Math.max(0, nowMs - this.historyRetentionMs)).toISOString()
    const nowIso = new Date(nowMs).toISOString()
    const prunedHistory = this.queue.pruneCompletedHistory({ olderThanIso })
    const prunedDedup = this.queue.pruneExpiredDedup({ nowIso })
    const prunedNotifications = this.notifications.pruneExpired(nowIso)
    this.lastMaintenanceMs = nowMs
    return { prunedHistory, prunedDedup, prunedNotifications }
  }

  reconcileOnStartup(): { interruptedTasks: number; recoveredLinks: number } {
    const recoveredLinks = this.dispatcher ? this.dispatcher.recoverMissingExecutionLinks() : 0
    const interruptedTasks = this.queue.reconcileOnRestart(this.clock.nowMs())
    this.reconciled = true
    return { interruptedTasks, recoveredLinks }
  }

  startTimer(): void {
    if (this.shuttingDown || this.timer) return
    if (!this.reconciled) {
      this.reconcileOnStartup()
    }
    this.timer = setInterval(() => {
      void this.runCycle()
    }, this.tickIntervalMs)
    this.timer.unref?.()
  }

  async stopTimer(): Promise<void> {
    this.shuttingDown = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    while (this.cycleInFlight) {
      await new Promise((r) => setTimeout(r, 15))
    }
  }

  async runCycle(): Promise<{ tick: TickSummary; dispatched: number }> {
    if (this.shuttingDown || this.cycleInFlight) {
      return {
        tick: {
          evaluatedAt: new Date(this.clock.nowMs()).toISOString(),
          evaluatedRoutines: 0,
          enqueuedTasks: 0,
          duplicatesSuppressed: 0,
          missedTotal: 0,
        },
        dispatched: 0,
      }
    }
    const nowMs = this.clock.nowMs()
    if (nowMs < this.lastClockMs) {
      return {
        tick: {
          evaluatedAt: new Date(nowMs).toISOString(),
          evaluatedRoutines: 0,
          enqueuedTasks: 0,
          duplicatesSuppressed: 0,
          missedTotal: 0,
        },
        dispatched: 0,
      }
    }
    this.lastClockMs = nowMs
    this.cycleInFlight = true
    try {
      this.approvals.expireAwaitingApprovals(nowMs)
      this.syncContinuedTasks(nowMs)
      const tick = this.engine.tick()
      let dispatched = 0
      if (this.dispatcher && !this.shuttingDown) {
        for (let i = 0; i < this.maxTasksPerTick; i += 1) {
          if (this.shuttingDown) break
          const task = await this.engine.dispatchNext(this.dispatcher, 'daemon-scheduler')
          if (!task) break
          dispatched += 1
          try {
            const routine = this.repository.getById(task.routineId, {
              ownerId: task.ownerId,
              botId: task.botId,
            })
            this.emitNotificationForTask(task, routine)
          } catch {
            // ignore notification if routine was archived mid-flight
          }
        }
      }
      if (!this.shuttingDown && nowMs - this.lastMaintenanceMs >= this.maintenanceIntervalMs) {
        this.runMaintenance(nowMs)
      }
      return { tick, dispatched }
    } finally {
      this.cycleInFlight = false
    }
  }

  createRoutine(
    input: Omit<CreateRoutineInput, 'ownerId'> & {
      targetType?: RoutineTargetType
      teamId?: string | null
      ownership?: RoutineOwnership
    },
  ): RoutineRecord & { targetType: RoutineTargetType; teamId: string | null } {
    try {
      const targetType: RoutineTargetType = input.targetType ?? 'bot'
      const teamId = input.teamId ?? null
      this.assertTargetValid(input.botId, targetType, teamId)
      const created = this.repository.create(
        {
          ...input,
          ownerId: LOCAL_USER_ID,
        },
        this.clock.nowMs(),
      )
      this.dbHandle.sqlite
        .prepare(`UPDATE scheduler_routines SET target_type = ?, team_id = ? WHERE id = ?`)
        .run(targetType, teamId, created.id)
      return { ...created, targetType, teamId }
    } catch (err) {
      mapSchedulerError(err)
    }
  }

  getRoutine(routineId: string, botId: string): RoutineRecord & { targetType: RoutineTargetType; teamId: string | null } {
    try {
      const r = this.repository.getById(routineId, this.scopeForBot(botId))
      const row = this.dbHandle.sqlite
        .prepare(`SELECT target_type, team_id FROM scheduler_routines WHERE id = ?`)
        .get(routineId) as { target_type: RoutineTargetType; team_id: string | null } | undefined
      return { ...r, targetType: row?.target_type ?? 'bot', teamId: row?.team_id ?? null }
    } catch (err) {
      mapSchedulerError(err)
    }
  }

  listRoutines(options: { botId?: string; includeArchived?: boolean } = {}): Array<
    RoutineRecord & { targetType: RoutineTargetType; teamId: string | null }
  > {
    try {
      const targetRows = new Map<string, { target_type: RoutineTargetType; team_id: string | null }>()
      const rawTargets = this.dbHandle.sqlite
        .prepare(`SELECT id, target_type, team_id FROM scheduler_routines WHERE owner_id = ?`)
        .all(LOCAL_USER_ID) as Array<{ id: string; target_type: RoutineTargetType; team_id: string | null }>
      for (const row of rawTargets) {
        targetRows.set(row.id, row)
      }

      if (options.botId) {
        return this.repository
          .list(this.scopeForBot(options.botId), { includeArchived: options.includeArchived })
          .routines.map((r) => {
            const t = targetRows.get(r.id)
            return { ...r, targetType: t?.target_type ?? 'bot', teamId: t?.team_id ?? null }
          })
      }

      const botRows = this.dbHandle.sqlite
        .prepare(`SELECT DISTINCT bot_id FROM scheduler_routines WHERE owner_id = ?`)
        .all(LOCAL_USER_ID) as Array<{ bot_id: string }>
      const all: Array<RoutineRecord & { targetType: RoutineTargetType; teamId: string | null }> = []
      for (const { bot_id: bId } of botRows) {
        for (const r of this.repository.list(this.scopeForBot(bId), {
          includeArchived: options.includeArchived,
        }).routines) {
          const t = targetRows.get(r.id)
          all.push({ ...r, targetType: t?.target_type ?? 'bot', teamId: t?.team_id ?? null })
        }
      }
      return all
    } catch (err) {
      mapSchedulerError(err)
    }
  }

  updateRoutine(
    routineId: string,
    botId: string,
    patch: UpdateRoutinePatch & { targetType?: RoutineTargetType; teamId?: string | null },
  ): RoutineRecord & { targetType: RoutineTargetType; teamId: string | null } {
    try {
      const current = this.getRoutine(routineId, botId)
      const nextTargetType = patch.targetType ?? current.targetType
      const nextTeamId = patch.teamId !== undefined ? patch.teamId : current.teamId
      this.assertTargetValid(botId, nextTargetType, nextTeamId)
      const updated = this.repository.update(routineId, this.scopeForBot(botId), patch, this.clock.nowMs())
      this.dbHandle.sqlite
        .prepare(`UPDATE scheduler_routines SET target_type = ?, team_id = ? WHERE id = ?`)
        .run(nextTargetType, nextTeamId, updated.id)
      return { ...updated, targetType: nextTargetType, teamId: nextTeamId }
    } catch (err) {
      mapSchedulerError(err)
    }
  }

  enableRoutine(routineId: string, botId: string): RoutineRecord {
    try {
      const r = this.getRoutine(routineId, botId)
      this.assertTargetValid(botId, r.targetType, r.teamId)
      return this.repository.enable(routineId, this.scopeForBot(botId), this.clock.nowMs())
    } catch (err) {
      mapSchedulerError(err)
    }
  }

  disableRoutine(routineId: string, botId: string): RoutineRecord {
    try {
      return this.repository.disable(routineId, this.scopeForBot(botId), this.clock.nowMs())
    } catch (err) {
      mapSchedulerError(err)
    }
  }

  archiveRoutine(routineId: string, botId: string): RoutineRecord {
    try {
      return this.repository.archive(routineId, this.scopeForBot(botId), this.clock.nowMs())
    } catch (err) {
      mapSchedulerError(err)
    }
  }

  triggerManual(routineId: string, botId: string, idempotencyKey: string): { task: ScheduledTaskRecord; created: boolean } {
    try {
      const r = this.getRoutine(routineId, botId)
      this.assertTargetValid(botId, r.targetType, r.teamId)
      return this.engine.triggerManual({
        routineId,
        scope: this.scopeForBot(botId),
        idempotencyKey,
      })
    } catch (err) {
      mapSchedulerError(err)
    }
  }

  getTask(taskId: string, botId: string): ScheduledTaskRecord & {
    executionLink?: { daemonRunId: string | null; teamRunId: string | null; sessionId: string | null } | null
    approvalLink?: { daemonApprovalId: string; daemonRunId: string; state: string; expiresAt: string } | null
  } {
    try {
      const task = this.queue.getTask(taskId, this.scopeForBot(botId))
      const execRow = this.dbHandle.sqlite
        .prepare(
          `SELECT daemon_run_id, team_run_id, session_id
           FROM scheduler_execution_links
           WHERE scheduler_task_id = ?
           ORDER BY attempt DESC LIMIT 1`,
        )
        .get(taskId) as
        | { daemon_run_id: string | null; team_run_id: string | null; session_id: string | null }
        | undefined
      const appRow = this.dbHandle.sqlite
        .prepare(
          `SELECT daemon_approval_id, daemon_run_id, state, expires_at
           FROM scheduler_approval_links
           WHERE scheduler_task_id = ?
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(taskId) as
        | { daemon_approval_id: string; daemon_run_id: string; state: string; expires_at: string }
        | undefined
      return {
        ...task,
        executionLink: execRow
          ? {
              daemonRunId: execRow.daemon_run_id,
              teamRunId: execRow.team_run_id,
              sessionId: execRow.session_id,
            }
          : null,
        approvalLink: appRow
          ? {
              daemonApprovalId: appRow.daemon_approval_id,
              daemonRunId: appRow.daemon_run_id,
              state: appRow.state,
              expiresAt: appRow.expires_at,
            }
          : null,
      }
    } catch (err) {
      mapSchedulerError(err)
    }
  }

  handleDaemonApprovalResolved(
    daemonRunId: string,
    daemonApprovalId: string,
    decision: 'approved' | 'denied',
  ): void {
    const link = this.dbHandle.sqlite
      .prepare(
        `SELECT l.scheduler_task_id, l.routine_id, l.routine_revision, t.owner_id, t.bot_id
         FROM scheduler_approval_links l
         JOIN scheduler_tasks t ON t.id = l.scheduler_task_id
         WHERE l.daemon_run_id = ? AND l.daemon_approval_id = ?
         LIMIT 1`,
      )
      .get(daemonRunId, daemonApprovalId) as
      | {
          scheduler_task_id: string
          routine_id: string
          routine_revision: number
          owner_id: string
          bot_id: string
        }
      | undefined
    if (!link) return

    const nowMs = this.clock.nowMs()
    const res = this.approvals.applyApprovalEvent(
      {
        taskId: link.scheduler_task_id,
        scope: { ownerId: link.owner_id, botId: link.bot_id },
        daemonRunId,
        daemonApprovalId,
        routineRevision: link.routine_revision,
        kind: decision === 'approved' ? 'approved_for_continuation' : 'denied',
      },
      nowMs,
    )
    this.dbHandle.sqlite
      .prepare(
        `UPDATE scheduler_approval_links
         SET state = ?, updated_at = ?
         WHERE scheduler_task_id = ? AND daemon_approval_id = ?`,
      )
      .run(res.approvalState, new Date(nowMs).toISOString(), link.scheduler_task_id, daemonApprovalId)

    if (res.applied && res.reason === 'AUTHORIZED_CONTINUATION') {
      this.syncContinuedTasks(nowMs)
    } else if (res.applied && res.reason === 'ROUTINE_UNAVAILABLE_ON_CONTINUATION' && this.dispatcher) {
      void this.dispatcher.cancelTaskExecution(link.scheduler_task_id, {
        ownerId: link.owner_id,
        botId: link.bot_id,
      })
    }
  }

  syncContinuedTasks(nowMs = this.clock.nowMs()): number {
    const rows = this.dbHandle.sqlite
      .prepare(
        `SELECT t.id, t.routine_id, t.routine_revision, t.occurrence_key, t.owner_id, t.bot_id,
                t.daemon_run_id, r.status AS run_status, r.error_json AS run_error_json
         FROM scheduler_tasks t
         JOIN runs r ON r.id = t.daemon_run_id
         WHERE t.status = 'running'
           AND t.approval_state = 'authorized.continuation'
           AND t.daemon_run_id IS NOT NULL`,
      )
      .all() as Array<{
      id: string
      routine_id: string
      routine_revision: number
      occurrence_key: string
      owner_id: string
      bot_id: string
      daemon_run_id: string
      run_status: string
      run_error_json: string | null
    }>

    let synced = 0
    const nowIso = new Date(nowMs).toISOString()
    for (const row of rows) {
      if (row.run_status === 'completed') {
        this.dbHandle.sqlite
          .prepare(
            `UPDATE scheduler_tasks
             SET status = 'completed', claim_owner = NULL, claim_lease_expires_at = NULL,
                 ended_at = ?, updated_at = ?
             WHERE id = ? AND status = 'running'`,
          )
          .run(nowIso, nowIso, row.id)
        synced += 1
      } else if (row.run_status === 'failed' || row.run_status === 'cancelled') {
        const nextStatus = row.run_status === 'cancelled' ? 'cancelled' : 'failed'
        let parsedErr: { code?: string; message?: string } | null = null
        if (row.run_error_json) {
          try {
            parsedErr = JSON.parse(row.run_error_json) as { code?: string; message?: string }
          } catch {
            parsedErr = null
          }
        }
        this.dbHandle.sqlite
          .prepare(
            `UPDATE scheduler_tasks
             SET status = ?, claim_owner = NULL, claim_lease_expires_at = NULL,
                 error_code = ?, error_message = ?, ended_at = ?, updated_at = ?
             WHERE id = ? AND status = 'running'`,
          )
          .run(
            nextStatus,
            parsedErr?.code ?? (nextStatus === 'cancelled' ? 'RUN_CANCELLED' : 'RUN_FAILED'),
            parsedErr?.message ?? `Continued run ended with status "${row.run_status}"`,
            nowIso,
            nowIso,
            row.id,
          )
        synced += 1
      } else if (row.run_status === 'awaiting_approval') {
        const pendingApp = this.dbHandle.sqlite
          .prepare(
            `SELECT id, action_type, action_summary, expires_at
             FROM approvals
             WHERE run_id = ? AND status = 'pending'
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(row.daemon_run_id) as
          | { id: string; action_type: string; action_summary: string; expires_at: string }
          | undefined
        if (pendingApp) {
          this.approvals.bindApprovalRequest({
            routineId: row.routine_id,
            routineRevision: row.routine_revision,
            occurrenceKey: row.occurrence_key,
            taskId: row.id,
            scope: { ownerId: row.owner_id, botId: row.bot_id },
            daemonRunId: row.daemon_run_id,
            daemonApprovalId: pendingApp.id,
            expiresAt: pendingApp.expires_at,
            requirePolicyRevalidation: true,
            sanitizedActionSummary: `${pendingApp.action_type}: ${pendingApp.action_summary}`,
          })
          this.dbHandle.sqlite
            .prepare(
              `UPDATE scheduler_tasks
               SET status = 'awaiting_approval', claim_owner = NULL, claim_lease_expires_at = NULL,
                   updated_at = ?
               WHERE id = ? AND status = 'running'`,
            )
            .run(nowIso, row.id)
          synced += 1
        }
      }
    }
    return synced
  }

  async cancelTask(taskId: string, botId: string): Promise<ScheduledTaskRecord> {
    try {
      const scope = this.scopeForBot(botId)
      if (this.dispatcher) {
        const res = await this.dispatcher.cancelTaskExecution(taskId, scope)
        if (!res.confirmed) {
          return this.queue.markUncertainCancellation(
            taskId,
            scope,
            'CANCELLATION_UNCONFIRMED',
            'External cancellation could not be confirmed',
            this.clock.nowMs(),
          )
        }
      }
      return this.queue.cancelTask(taskId, scope, this.clock.nowMs())
    } catch (err) {
      mapSchedulerError(err)
    }
  }

  listTaskHistory(routineId: string, botId: string, limit = 50): ScheduledTaskRecord[] {
    try {
      const scope = this.scopeForBot(botId)
      this.repository.getById(routineId, scope)
      const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)))
      const rows = this.dbHandle.sqlite
        .prepare(
          `SELECT * FROM scheduler_tasks
           WHERE routine_id = ? AND owner_id = ? AND bot_id = ?
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(routineId, scope.ownerId, scope.botId, safeLimit) as unknown as RawTaskRow[]
      return rows.map(rowToTask)
    } catch (err) {
      mapSchedulerError(err)
    }
  }

  previewRoutineSchedule(routineId: string, botId: string, count = 5) {
    try {
      const routine = this.repository.getById(routineId, this.scopeForBot(botId))
      return previewRoutineSchedule(routine, { startAtMs: this.clock.nowMs(), count })
    } catch (err) {
      mapSchedulerError(err)
    }
  }

  diagnoseRoutine(routineId: string, botId: string) {
    try {
      return diagnoseRoutine(this.repository, routineId, this.scopeForBot(botId), {
        nowMs: this.clock.nowMs(),
      })
    } catch (err) {
      mapSchedulerError(err)
    }
  }

  getExecutionStatistics(routineId: string, botId: string) {
    try {
      return getRoutineStatistics(this.repository, routineId, this.scopeForBot(botId))
    } catch (err) {
      mapSchedulerError(err)
    }
  }

  simulateRoutine(routineId: string, botId: string, steps = 5) {
    try {
      const routine = this.repository.getById(routineId, this.scopeForBot(botId))
      return runDryRunSimulation({
        routines: [
          {
            name: routine.name,
            description: routine.description,
            ownerId: routine.ownerId,
            botId: routine.botId,
            trigger: routine.trigger,
            timezone: routine.timezone,
            task: routine.task,
            enabled: routine.enabled,
            missedRunPolicy: routine.missedRunPolicy,
            maxCatchUpRuns: routine.maxCatchUpRuns,
            concurrencyPolicy: routine.concurrencyPolicy,
            maxConcurrentRuns: routine.maxConcurrentRuns,
            retryPolicy: routine.retryPolicy,
            expiresAt: routine.expiresAt,
          },
        ],
        startMs: this.clock.nowMs(),
        endMs: this.clock.nowMs() + Math.max(1, steps) * 86_400_000,
      })
    } catch (err) {
      mapSchedulerError(err)
    }
  }

  exportRoutines(botId: string) {
    try {
      const scope = this.scopeForBot(botId)
      const ids = this.repository.list(scope, { includeArchived: false }).routines.map((r) => r.id)
      return exportRoutines(this.repository, ids, scope, this.clock.nowMs())
    } catch (err) {
      mapSchedulerError(err)
    }
  }

  previewImport(rawBundle: unknown, botId: string, conflictPolicy: ImportConflictPolicy = 'skip') {
    try {
      this.assertTargetValid(botId, 'bot')
      const rawJson = typeof rawBundle === 'string' ? rawBundle : JSON.stringify(rawBundle)
      return previewImportRoutines(
        rawJson,
        this.scopeForBot(botId),
        this.repository,
        conflictPolicy,
      )
    } catch (err) {
      mapSchedulerError(err)
    }
  }

  commitImport(rawBundle: unknown, botId: string, conflictPolicy: ImportConflictPolicy = 'skip') {
    try {
      this.assertTargetValid(botId, 'bot')
      const rawJson = typeof rawBundle === 'string' ? rawBundle : JSON.stringify(rawBundle)
      return commitImportRoutines(
        rawJson,
        this.scopeForBot(botId),
        this.repository,
        conflictPolicy,
        this.clock.nowMs(),
      )
    } catch (err) {
      mapSchedulerError(err)
    }
  }

  listNotifications(botId: string, options: { unreadOnly?: boolean; limit?: number } = {}) {
    try {
      return this.notifications.list(this.scopeForBot(botId), {
        unreadOnly: options.unreadOnly,
        limit: options.limit,
      }).notifications
    } catch (err) {
      mapSchedulerError(err)
    }
  }

  getUnreadNotificationCount(botId: string): number {
    try {
      return this.notifications.countUnread(this.scopeForBot(botId))
    } catch (err) {
      mapSchedulerError(err)
    }
  }

  markNotificationRead(notificationId: string, botId: string) {
    try {
      return this.notifications.markAsRead(notificationId, this.scopeForBot(botId), this.clock.nowMs())
    } catch (err) {
      mapSchedulerError(err)
    }
  }

  dismissNotification(notificationId: string, botId: string) {
    try {
      return this.notifications.dismiss(notificationId, this.scopeForBot(botId), this.clock.nowMs())
    } catch (err) {
      mapSchedulerError(err)
    }
  }
}
