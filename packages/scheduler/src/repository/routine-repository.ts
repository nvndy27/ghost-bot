import { randomUUID } from 'node:crypto'
import type {
  CreateRoutineInput,
  RoutineOwnership,
  RoutineRecord,
  RoutineScope,
  ScheduledTaskRecord,
  TaskStatus,
  TaskTriggerSource,
  UpdateRoutinePatch,
} from '../contracts/types.ts'
import { computeNextRunMs } from '../schedules/calculator.ts'
import {
  assertScopeAccess,
  assertValidIsoTimestamp,
  assertValidTimezone,
  MAX_CATCHUP_RUNS,
  MAX_CONCURRENT_RUNS,
  SchedulerError,
  validateCreateRoutineInput,
  validateTriggerConfig,
  validateUntrustedTask,
} from '../security/validation.ts'
import type { SchedulerDatabaseHandle } from './sqlite-store.ts'

interface RawRoutineRow {
  id: string
  name: string
  description: string
  owner_id: string
  bot_id: string
  ownership: string
  revision: number
  trigger_json: string
  timezone: string
  task_json: string
  enabled: number
  archived_at: string | null
  missed_run_policy: string
  max_catch_up_runs: number
  concurrency_policy: string
  max_concurrent_runs: number
  retry_policy_json: string
  expires_at: string | null
  next_run_at: string | null
  last_run_at: string | null
  last_evaluated_at: string | null
  last_task_status: string | null
  created_at: string
  updated_at: string
}

export interface RawTaskRow {
  id: string
  routine_id: string
  routine_revision: number
  trigger_source: string
  owner_id: string
  bot_id: string
  occurrence_key: string
  scheduled_for: string
  status: string
  attempt: number
  max_attempts: number
  claim_owner: string | null
  claim_lease_expires_at: string | null
  uncertain_execution: number
  approval_required: number
  task_snapshot_json: string
  error_code: string | null
  error_message: string | null
  started_at: string | null
  ended_at: string | null
  created_at: string
  updated_at: string
}

export function rowToTask(row: RawTaskRow): ScheduledTaskRecord {
  let parsedTask: unknown
  try {
    parsedTask = JSON.parse(row.task_snapshot_json)
  } catch {
    throw new SchedulerError('CORRUPT_RECORD', `Corrupt task snapshot JSON on task "${row.id}"`)
  }
  return {
    id: row.id,
    routineId: row.routine_id,
    routineRevision: Number(row.routine_revision ?? 1),
    triggerSource: (row.trigger_source ?? 'schedule') as TaskTriggerSource,
    ownerId: row.owner_id,
    botId: row.bot_id,
    occurrenceKey: row.occurrence_key,
    scheduledFor: row.scheduled_for,
    status: row.status as TaskStatus,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    claimOwner: row.claim_owner,
    claimLeaseExpiresAt: row.claim_lease_expires_at,
    uncertainExecution: row.uncertain_execution === 1,
    approvalRequired: row.approval_required === 1,
    taskSnapshot: validateUntrustedTask(parsedTask),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class RoutineRepository {
  private readonly db: SchedulerDatabaseHandle

  constructor(db: SchedulerDatabaseHandle) {
    this.db = db
  }

  getDatabase(): SchedulerDatabaseHandle {
    return this.db
  }

  private rowToRoutine(row: RawRoutineRow): RoutineRecord {
    let triggerRaw: unknown
    let taskRaw: unknown
    let retryRaw: unknown
    try {
      triggerRaw = JSON.parse(row.trigger_json)
      taskRaw = JSON.parse(row.task_json)
      retryRaw = JSON.parse(row.retry_policy_json)
    } catch {
      throw new SchedulerError('CORRUPT_RECORD', `Corrupt JSON payload in routine "${row.id}"`)
    }
    const trigger = validateTriggerConfig(triggerRaw)
    const task = validateUntrustedTask(taskRaw)
    const timezone = assertValidTimezone(row.timezone)
    if (
      !retryRaw ||
      typeof retryRaw !== 'object' ||
      typeof (retryRaw as { maxAttempts?: unknown }).maxAttempts !== 'number' ||
      typeof (retryRaw as { backoffMs?: unknown }).backoffMs !== 'number'
    ) {
      throw new SchedulerError('CORRUPT_RECORD', `Corrupt retryPolicy in routine "${row.id}"`)
    }
    const ownership = (row.ownership ?? 'ghost-bot') as RoutineOwnership
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      ownerId: row.owner_id,
      botId: row.bot_id,
      ownership,
      revision: Number(row.revision ?? 1),
      trigger,
      timezone,
      task,
      enabled: row.enabled === 1,
      archivedAt: row.archived_at,
      missedRunPolicy: row.missed_run_policy as RoutineRecord['missedRunPolicy'],
      maxCatchUpRuns: row.max_catch_up_runs,
      concurrencyPolicy: row.concurrency_policy as RoutineRecord['concurrencyPolicy'],
      maxConcurrentRuns: row.max_concurrent_runs,
      retryPolicy: {
        maxAttempts: (retryRaw as { maxAttempts: number }).maxAttempts,
        backoffMs: (retryRaw as { backoffMs: number }).backoffMs,
        retryNonIdempotent: false,
      },
      expiresAt: row.expires_at,
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at,
      lastEvaluatedAt: row.last_evaluated_at,
      lastTaskStatus: row.last_task_status as TaskStatus | null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  create(input: CreateRoutineInput, nowMs = Date.now()): RoutineRecord {
    const clean = validateCreateRoutineInput(input)
    const id = input.id ?? `rtn_${randomUUID()}`
    const nowIso = new Date(nowMs).toISOString()
    const nextMs =
      clean.enabled && clean.ownership === 'ghost-bot'
        ? computeNextRunMs(clean.trigger, clean.timezone, nowMs - 1)
        : null
    const nextRunAt =
      nextMs !== null && (clean.expiresAt === null || nextMs < Date.parse(clean.expiresAt))
        ? new Date(nextMs).toISOString()
        : null

    return this.db.transaction(() => {
      this.db.sqlite
        .prepare(
          `INSERT INTO scheduler_routines (
            id, name, description, owner_id, bot_id, ownership, revision, trigger_json, timezone, task_json,
            enabled, archived_at, missed_run_policy, max_catch_up_runs,
            concurrency_policy, max_concurrent_runs, retry_policy_json,
            expires_at, next_run_at, last_run_at, last_evaluated_at, last_task_status,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          id,
          clean.name,
          clean.description,
          clean.ownerId,
          clean.botId,
          clean.ownership,
          JSON.stringify(clean.trigger),
          clean.timezone,
          JSON.stringify(clean.task),
          clean.enabled ? 1 : 0,
          clean.missedRunPolicy,
          clean.maxCatchUpRuns,
          clean.concurrencyPolicy,
          clean.maxConcurrentRuns,
          JSON.stringify(clean.retryPolicy),
          clean.expiresAt,
          nextRunAt,
          nowIso,
          nowIso,
        )
      return this.getById(id, { ownerId: clean.ownerId, botId: clean.botId })
    })
  }

  getById(id: string, scope: RoutineScope): RoutineRecord {
    const row = this.db.sqlite
      .prepare(`SELECT * FROM scheduler_routines WHERE id = ?`)
      .get(id) as RawRoutineRow | undefined
    if (!row) {
      throw new SchedulerError('ROUTINE_NOT_FOUND', `Routine "${id}" was not found`)
    }
    assertScopeAccess(scope, { ownerId: row.owner_id, botId: row.bot_id })
    return this.rowToRoutine(row)
  }

  list(
    scope: RoutineScope,
    options: { limit?: number; offset?: number; includeArchived?: boolean } = {},
  ): { routines: RoutineRecord[]; total: number } {
    const limit = Math.min(Math.max(1, options.limit ?? 50), 100)
    const offset = Math.max(0, options.offset ?? 0)
    const archiveClause = options.includeArchived ? '' : 'AND archived_at IS NULL'

    const countRow = this.db.sqlite
      .prepare(
        `SELECT COUNT(*) AS cnt FROM scheduler_routines WHERE owner_id = ? AND bot_id = ? ${archiveClause}`,
      )
      .get(scope.ownerId, scope.botId) as { cnt: number }

    const rows = this.db.sqlite
      .prepare(
        `SELECT * FROM scheduler_routines
         WHERE owner_id = ? AND bot_id = ? ${archiveClause}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(scope.ownerId, scope.botId, limit, offset) as unknown as RawRoutineRow[]

    return {
      routines: rows.map((r) => this.rowToRoutine(r)),
      total: Number(countRow?.cnt ?? 0),
    }
  }

  listAllEnabledForEngine(): RoutineRecord[] {
    const rows = this.db.sqlite
      .prepare(
        `SELECT * FROM scheduler_routines
         WHERE enabled = 1 AND archived_at IS NULL AND ownership = 'ghost-bot'
         ORDER BY next_run_at ASC`,
      )
      .all() as unknown as RawRoutineRow[]
    return rows.map((r) => this.rowToRoutine(r))
  }

  listEnabledEventRoutines(scope: RoutineScope): RoutineRecord[] {
    const rows = this.db.sqlite
      .prepare(
        `SELECT * FROM scheduler_routines
         WHERE owner_id = ? AND bot_id = ?
           AND enabled = 1 AND archived_at IS NULL AND ownership = 'ghost-bot'`,
      )
      .all(scope.ownerId, scope.botId) as unknown as RawRoutineRow[]
    return rows
      .map((r) => this.rowToRoutine(r))
      .filter((r) => r.trigger.kind === 'event')
  }

  update(
    id: string,
    scope: RoutineScope,
    patch: UpdateRoutinePatch,
    nowMs = Date.now(),
  ): RoutineRecord {
    return this.db.transaction(() => {
      const existing = this.getById(id, scope)
      const merged = validateCreateRoutineInput({
        name: patch.name ?? existing.name,
        description: patch.description ?? existing.description,
        ownerId: existing.ownerId,
        botId: existing.botId,
        ownership: existing.ownership,
        trigger: patch.trigger ?? existing.trigger,
        timezone: patch.timezone ?? existing.timezone,
        task: patch.task ?? existing.task,
        enabled: existing.enabled,
        missedRunPolicy: patch.missedRunPolicy ?? existing.missedRunPolicy,
        maxCatchUpRuns: Math.min(
          patch.maxCatchUpRuns ?? existing.maxCatchUpRuns,
          MAX_CATCHUP_RUNS,
        ),
        concurrencyPolicy: patch.concurrencyPolicy ?? existing.concurrencyPolicy,
        maxConcurrentRuns: Math.min(
          patch.maxConcurrentRuns ?? existing.maxConcurrentRuns,
          MAX_CONCURRENT_RUNS,
        ),
        retryPolicy: patch.retryPolicy ?? existing.retryPolicy,
        expiresAt: patch.expiresAt !== undefined ? patch.expiresAt : existing.expiresAt,
      })

      const nextMs =
        existing.enabled && existing.ownership === 'ghost-bot'
          ? computeNextRunMs(merged.trigger, merged.timezone, nowMs - 1)
          : null
      const nextRunAt =
        nextMs !== null && (merged.expiresAt === null || nextMs < Date.parse(merged.expiresAt))
          ? new Date(nextMs).toISOString()
          : null

      this.db.sqlite
        .prepare(
          `UPDATE scheduler_routines
           SET name = ?, description = ?, revision = revision + 1,
               trigger_json = ?, timezone = ?, task_json = ?,
               missed_run_policy = ?, max_catch_up_runs = ?, concurrency_policy = ?,
               max_concurrent_runs = ?, retry_policy_json = ?, expires_at = ?,
               next_run_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          merged.name,
          merged.description,
          JSON.stringify(merged.trigger),
          merged.timezone,
          JSON.stringify(merged.task),
          merged.missedRunPolicy,
          merged.maxCatchUpRuns,
          merged.concurrencyPolicy,
          merged.maxConcurrentRuns,
          JSON.stringify(merged.retryPolicy),
          merged.expiresAt,
          nextRunAt,
          new Date(nowMs).toISOString(),
          id,
        )
      return this.getById(id, scope)
    })
  }

  enable(id: string, scope: RoutineScope, nowMs = Date.now()): RoutineRecord {
    return this.db.transaction(() => {
      const existing = this.getById(id, scope)
      if (existing.archivedAt !== null) {
        throw new SchedulerError('ROUTINE_ARCHIVED', 'Cannot enable an archived routine')
      }
      const nextMs =
        existing.ownership === 'ghost-bot'
          ? computeNextRunMs(existing.trigger, existing.timezone, nowMs - 1)
          : null
      const nextRunAt =
        nextMs !== null &&
        (existing.expiresAt === null || nextMs < Date.parse(existing.expiresAt))
          ? new Date(nextMs).toISOString()
          : null
      this.db.sqlite
        .prepare(
          `UPDATE scheduler_routines SET enabled = 1, next_run_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(nextRunAt, new Date(nowMs).toISOString(), id)
      return this.getById(id, scope)
    })
  }

  disable(id: string, scope: RoutineScope, nowMs = Date.now()): RoutineRecord {
    const nowIso = new Date(nowMs).toISOString()
    return this.db.transaction(() => {
      this.getById(id, scope)
      this.db.sqlite
        .prepare(`UPDATE scheduler_routines SET enabled = 0, updated_at = ? WHERE id = ?`)
        .run(nowIso, id)
      this.db.sqlite
        .prepare(
          `UPDATE scheduler_tasks
           SET status = 'cancelled', error_code = 'ROUTINE_DISABLED',
               error_message = 'Routine disabled before dispatch.', ended_at = ?, updated_at = ?
           WHERE routine_id = ? AND status = 'queued'`,
        )
        .run(nowIso, nowIso, id)
      return this.getById(id, scope)
    })
  }

  archive(id: string, scope: RoutineScope, nowMs = Date.now()): RoutineRecord {
    const nowIso = new Date(nowMs).toISOString()
    return this.db.transaction(() => {
      this.getById(id, scope)
      this.db.sqlite
        .prepare(
          `UPDATE scheduler_routines
           SET enabled = 0, archived_at = ?, next_run_at = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(nowIso, nowIso, id)
      this.db.sqlite
        .prepare(
          `UPDATE scheduler_tasks
           SET status = 'cancelled', error_code = 'ROUTINE_ARCHIVED',
               error_message = 'Routine archived before dispatch.', ended_at = ?, updated_at = ?
           WHERE routine_id = ? AND status = 'queued'`,
        )
        .run(nowIso, nowIso, id)
      return this.getById(id, scope)
    })
  }

  delete(id: string, scope: RoutineScope): void {
    this.db.transaction(() => {
      this.getById(id, scope)
      this.db.sqlite.prepare(`DELETE FROM scheduler_routines WHERE id = ?`).run(id)
    })
  }

  updateScheduleCursor(
    id: string,
    nextRunAt: string | null,
    lastRunAt: string | null,
    lastEvaluatedAt: string,
    nowMs = Date.now(),
  ): void {
    const cleanEval = assertValidIsoTimestamp(lastEvaluatedAt, 'lastEvaluatedAt')
    this.db.sqlite
      .prepare(
        `UPDATE scheduler_routines
         SET next_run_at = ?, last_run_at = COALESCE(?, last_run_at), last_evaluated_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(nextRunAt, lastRunAt, cleanEval, new Date(nowMs).toISOString(), id)
  }

  listExecutionHistory(
    routineId: string,
    scope: RoutineScope,
    limit = 50,
  ): ScheduledTaskRecord[] {
    this.getById(routineId, scope)
    const bounded = Math.min(Math.max(1, limit), 100)
    const rows = this.db.sqlite
      .prepare(
        `SELECT * FROM scheduler_tasks
         WHERE routine_id = ? AND owner_id = ? AND bot_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(routineId, scope.ownerId, scope.botId, bounded) as unknown as RawTaskRow[]
    return rows.map((r) => rowToTask(r))
  }
}
