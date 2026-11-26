import { getZonedParts } from '../schedules/calculator.ts'
import { assertValidTimezone, SchedulerError } from '../security/validation.ts'
import type {
  NotificationCategory,
  NotificationDeliveryStatus,
  NotificationPolicyConfig,
  NotificationSeverity,
  QuietHoursConfig,
} from './types.ts'

const CRITICAL_CATEGORIES = new Set<NotificationCategory>([
  'approval.required',
  'approval.expired',
  'execution.uncertain',
])

export function isCriticalNotification(
  category: NotificationCategory,
  severity: NotificationSeverity,
): boolean {
  return severity === 'critical' || CRITICAL_CATEGORIES.has(category)
}

export function isWithinQuietHours(quiet: QuietHoursConfig, nowMs: number): boolean {
  if (!quiet.enabled) return false
  const tz = assertValidTimezone(quiet.timezone)
  if (
    !Number.isInteger(quiet.startHour) ||
    quiet.startHour < 0 ||
    quiet.startHour > 23 ||
    !Number.isInteger(quiet.startMinute) ||
    quiet.startMinute < 0 ||
    quiet.startMinute > 59 ||
    !Number.isInteger(quiet.endHour) ||
    quiet.endHour < 0 ||
    quiet.endHour > 23 ||
    !Number.isInteger(quiet.endMinute) ||
    quiet.endMinute < 0 ||
    quiet.endMinute > 59
  ) {
    throw new SchedulerError('INVALID_NOTIFICATION_POLICY', 'Invalid quiet-hours time bounds')
  }

  const local = getZonedParts(nowMs, tz)
  const currentMins = local.hour * 60 + local.minute
  const startMins = quiet.startHour * 60 + quiet.startMinute
  const endMins = quiet.endHour * 60 + quiet.endMinute

  if (startMins === endMins) return false
  if (startMins < endMins) {
    return currentMins >= startMins && currentMins < endMins
  }
  // Overnight quiet hours (e.g. 22:00 -> 07:00)
  return currentMins >= startMins || currentMins < endMins
}

export interface NotificationPolicyDecision {
  persistInApp: true
  deliveryStatus: NotificationDeliveryStatus
  deliverExternallyNow: boolean
  reason: string
}

/**
 * Deterministic notification policy evaluation.
 * Critical execution uncertainty and approval status are ALWAYS persisted in-app
 * even when external delivery is deferred by quiet hours or rate limits.
 */
export function evaluateNotificationPolicy(
  policy: NotificationPolicyConfig,
  category: NotificationCategory,
  severity: NotificationSeverity,
  nowMs: number,
  recentDeliveredInLastHour: number,
): NotificationPolicyDecision {
  const critical = isCriticalNotification(category, severity)
  const enabledSet = new Set(policy.enabledCategories)

  if (!enabledSet.has(category) && !critical) {
    return {
      persistInApp: true,
      deliveryStatus: 'suppressed_category',
      deliverExternallyNow: false,
      reason: `Category "${category}" is disabled by notification policy`,
    }
  }

  if (policy.quietHours && isWithinQuietHours(policy.quietHours, nowMs)) {
    return {
      persistInApp: true,
      deliveryStatus: 'deferred_quiet_hours',
      deliverExternallyNow: false,
      reason: critical
        ? 'External delivery deferred by quiet hours; critical notification remains visible in-app'
        : 'Deferred by quiet hours',
    }
  }

  if (recentDeliveredInLastHour >= policy.maxPerHour && !critical) {
    return {
      persistInApp: true,
      deliveryStatus: 'suppressed_rate_limit',
      deliverExternallyNow: false,
      reason: `Rate limit reached (${policy.maxPerHour}/hour)`,
    }
  }

  if (policy.digestMode && !critical) {
    return {
      persistInApp: true,
      deliveryStatus: 'digest_queued',
      deliverExternallyNow: false,
      reason: 'Queued for periodic digest',
    }
  }

  return {
    persistInApp: true,
    deliveryStatus: 'eligible',
    deliverExternallyNow: true,
    reason: 'Eligible for delivery',
  }
}
