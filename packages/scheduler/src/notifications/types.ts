import type { RoutineScope } from '../contracts/types.ts'

export type NotificationCategory =
  | 'routine.completed'
  | 'routine.failed'
  | 'routine.interrupted'
  | 'routine.missed'
  | 'routine.expired'
  | 'approval.required'
  | 'approval.expired'
  | 'execution.uncertain'
  | 'routine.blocked'

export type NotificationSeverity = 'info' | 'warning' | 'critical'

export type NotificationDeliveryStatus =
  | 'pending'
  | 'eligible'
  | 'deferred_quiet_hours'
  | 'suppressed_category'
  | 'suppressed_rate_limit'
  | 'digest_queued'

export interface RoutineNotificationRecord {
  id: string
  routineId: string
  routineRevision: number
  taskId: string | null
  occurrenceKey: string | null
  ownerId: string
  botId: string
  category: NotificationCategory
  severity: NotificationSeverity
  dedupKey: string
  summary: string
  readAt: string | null
  dismissedAt: string | null
  deliveryStatus: NotificationDeliveryStatus
  createdAt: string
  expiresAt: string | null
}

export interface CreateNotificationInput {
  routineId: string
  routineRevision: number
  taskId?: string | null
  occurrenceKey?: string | null
  scope: RoutineScope
  category: NotificationCategory
  severity: NotificationSeverity
  dedupKey: string
  summary: string
  deliveryStatus?: NotificationDeliveryStatus
  expiresAt?: string | null
}

export interface QuietHoursConfig {
  enabled: boolean
  timezone: string
  startHour: number
  startMinute: number
  endHour: number
  endMinute: number
}

export interface NotificationPolicyConfig {
  enabledCategories: NotificationCategory[]
  quietHours?: QuietHoursConfig
  maxPerHour: number
  digestMode?: boolean
}
