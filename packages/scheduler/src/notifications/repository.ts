import { randomUUID } from 'node:crypto'
import type { RoutineScope } from '../contracts/types.ts'
import type { SchedulerDatabaseHandle } from '../repository/sqlite-store.ts'
import {
  assertNonEmptyBounded,
  assertScopeAccess,
  redactSchedulerSecrets,
  SchedulerError,
} from '../security/validation.ts'
import type {
  CreateNotificationInput,
  NotificationCategory,
  NotificationDeliveryStatus,
  NotificationSeverity,
  RoutineNotificationRecord,
} from './types.ts'

export const MAX_NOTIFICATION_SUMMARY_CHARS = 500
export const MAX_NOTIFICATIONS_CAPACITY = 2000

interface RawNotificationRow {
  id: string
  routine_id: string
  routine_revision: number
  task_id: string | null
  occurrence_key: string | null
  owner_id: string
  bot_id: string
  category: string
  severity: string
  dedup_key: string
  summary: string
  read_at: string | null
  dismissed_at: string | null
  delivery_status: string
  created_at: string
  expires_at: string | null
}

function rowToNotification(row: RawNotificationRow): RoutineNotificationRecord {
  return {
    id: row.id,
    routineId: row.routine_id,
    routineRevision: Number(row.routine_revision),
    taskId: row.task_id,
    occurrenceKey: row.occurrence_key,
    ownerId: row.owner_id,
    botId: row.bot_id,
    category: row.category as NotificationCategory,
    severity: row.severity as NotificationSeverity,
    dedupKey: row.dedup_key,
    summary: row.summary,
    readAt: row.read_at,
    dismissedAt: row.dismissed_at,
    deliveryStatus: row.delivery_status as NotificationDeliveryStatus,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }
}

export class NotificationRepository {
  private readonly db: SchedulerDatabaseHandle
  private readonly maxCapacity: number

  constructor(db: SchedulerDatabaseHandle, maxCapacity = MAX_NOTIFICATIONS_CAPACITY) {
    this.db = db
    this.maxCapacity = maxCapacity
  }

  create(
    input: CreateNotificationInput,
    nowMs = Date.now(),
  ): { notification: RoutineNotificationRecord; created: boolean } {
    const dedupKey = assertNonEmptyBounded(input.dedupKey, 'notification.dedupKey', 256)
    const rawSummary = assertNonEmptyBounded(
      redactSchedulerSecrets(input.summary),
      'notification.summary',
      MAX_NOTIFICATION_SUMMARY_CHARS,
    )
    const nowIso = new Date(nowMs).toISOString()

    return this.db.transaction(() => {
      const existing = this.db.sqlite
        .prepare(`SELECT * FROM scheduler_notifications WHERE dedup_key = ?`)
        .get(dedupKey) as RawNotificationRow | undefined
      if (existing) {
        assertScopeAccess(input.scope, { ownerId: existing.owner_id, botId: existing.bot_id })
        return { notification: rowToNotification(existing), created: false }
      }

      const countRow = this.db.sqlite
        .prepare(`SELECT COUNT(*) AS cnt FROM scheduler_notifications`)
        .get() as { cnt: number }
      if (Number(countRow?.cnt ?? 0) >= this.maxCapacity) {
        throw new SchedulerError(
          'NOTIFICATION_CAPACITY_EXCEEDED',
          `Notification store reached capacity limit (${this.maxCapacity})`,
        )
      }

      const id = `ntf_${randomUUID()}`
      this.db.sqlite
        .prepare(
          `INSERT INTO scheduler_notifications (
            id, routine_id, routine_revision, task_id, occurrence_key,
            owner_id, bot_id, category, severity, dedup_key, summary,
            read_at, dismissed_at, delivery_status, created_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
        )
        .run(
          id,
          input.routineId,
          input.routineRevision,
          input.taskId ?? null,
          input.occurrenceKey ?? null,
          input.scope.ownerId,
          input.scope.botId,
          input.category,
          input.severity,
          dedupKey,
          rawSummary,
          input.deliveryStatus ?? 'pending',
          nowIso,
          input.expiresAt ?? null,
        )

      const row = this.db.sqlite
        .prepare(`SELECT * FROM scheduler_notifications WHERE id = ?`)
        .get(id) as unknown as RawNotificationRow
      return { notification: rowToNotification(row), created: true }
    })
  }

  getById(id: string, scope: RoutineScope): RoutineNotificationRecord {
    const row = this.db.sqlite
      .prepare(`SELECT * FROM scheduler_notifications WHERE id = ?`)
      .get(id) as RawNotificationRow | undefined
    if (!row) {
      throw new SchedulerError('NOTIFICATION_NOT_FOUND', `Notification "${id}" was not found`)
    }
    assertScopeAccess(scope, { ownerId: row.owner_id, botId: row.bot_id })
    return rowToNotification(row)
  }

  list(
    scope: RoutineScope,
    options: {
      limit?: number
      offset?: number
      unreadOnly?: boolean
      includeDismissed?: boolean
    } = {},
  ): { notifications: RoutineNotificationRecord[]; total: number } {
    const limit = Math.min(Math.max(1, options.limit ?? 50), 100)
    const offset = Math.max(0, options.offset ?? 0)
    const unreadClause = options.unreadOnly ? 'AND read_at IS NULL' : ''
    const dismissClause = options.includeDismissed ? '' : 'AND dismissed_at IS NULL'

    const countRow = this.db.sqlite
      .prepare(
        `SELECT COUNT(*) AS cnt FROM scheduler_notifications
         WHERE owner_id = ? AND bot_id = ? ${unreadClause} ${dismissClause}`,
      )
      .get(scope.ownerId, scope.botId) as { cnt: number }

    const rows = this.db.sqlite
      .prepare(
        `SELECT * FROM scheduler_notifications
         WHERE owner_id = ? AND bot_id = ? ${unreadClause} ${dismissClause}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(scope.ownerId, scope.botId, limit, offset) as unknown as RawNotificationRow[]

    return {
      notifications: rows.map(rowToNotification),
      total: Number(countRow?.cnt ?? 0),
    }
  }

  countUnread(scope: RoutineScope): number {
    const row = this.db.sqlite
      .prepare(
        `SELECT COUNT(*) AS cnt FROM scheduler_notifications
         WHERE owner_id = ? AND bot_id = ? AND read_at IS NULL AND dismissed_at IS NULL`,
      )
      .get(scope.ownerId, scope.botId) as { cnt: number }
    return Number(row?.cnt ?? 0)
  }

  markAsRead(id: string, scope: RoutineScope, nowMs = Date.now()): RoutineNotificationRecord {
    const nowIso = new Date(nowMs).toISOString()
    return this.db.transaction(() => {
      this.getById(id, scope)
      this.db.sqlite
        .prepare(
          `UPDATE scheduler_notifications SET read_at = COALESCE(read_at, ?) WHERE id = ?`,
        )
        .run(nowIso, id)
      return this.getById(id, scope)
    })
  }

  markSelectedAsRead(ids: string[], scope: RoutineScope, nowMs = Date.now()): number {
    const nowIso = new Date(nowMs).toISOString()
    return this.db.transaction(() => {
      let updated = 0
      for (const id of ids) {
        this.getById(id, scope)
        const res = this.db.sqlite
          .prepare(
            `UPDATE scheduler_notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND read_at IS NULL`,
          )
          .run(nowIso, id)
        updated += Number(res.changes)
      }
      return updated
    })
  }

  /**
   * UI/in-app dismissal only; never mutates task authorization, approvals, or execution state.
   */
  dismiss(id: string, scope: RoutineScope, nowMs = Date.now()): RoutineNotificationRecord {
    const nowIso = new Date(nowMs).toISOString()
    return this.db.transaction(() => {
      this.getById(id, scope)
      this.db.sqlite
        .prepare(
          `UPDATE scheduler_notifications SET dismissed_at = COALESCE(dismissed_at, ?) WHERE id = ?`,
        )
        .run(nowIso, id)
      return this.getById(id, scope)
    })
  }

  pruneExpired(olderThanIso: string): number {
    return this.db.transaction(() => {
      const res = this.db.sqlite
        .prepare(
          `DELETE FROM scheduler_notifications
           WHERE (expires_at IS NOT NULL AND expires_at <= ?)
              OR (dismissed_at IS NOT NULL AND dismissed_at <= ?)`,
        )
        .run(olderThanIso, olderThanIso)
      return Number(res.changes)
    })
  }
}
