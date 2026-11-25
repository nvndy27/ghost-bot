export type EventMatchOperator = 'eq' | 'neq' | 'prefix' | 'contains' | 'in'

export interface EventMatchCondition {
  field: string
  op: EventMatchOperator
  value: string | string[]
}

export type TriggerConfig =
  | { kind: 'one-time'; runAt: string }
  | { kind: 'interval'; intervalMs: number; anchorAt: string }
  | { kind: 'daily'; hour: number; minute: number; second?: number }
  | { kind: 'weekly'; daysOfWeek: number[]; hour: number; minute: number; second?: number }
  | { kind: 'cron'; expression: string }
  | { kind: 'event'; eventType: string; conditions?: EventMatchCondition[] }

export type RoutineOwnership = 'ghost-bot' | 'openclaw' | 'external-unknown'
export type TaskTriggerSource = 'schedule' | 'manual' | 'event'

export type MissedRunPolicy = 'skip' | 'run-once' | 'bounded-catch-up'
export type ConcurrencyPolicy = 'forbid' | 'allow-bounded'

export interface RetryPolicy {
  maxAttempts: number
  backoffMs: number
  /** Never automatically retry uncertain/non-idempotent external side effects. */
  retryNonIdempotent: false
}

export interface RoutineScope {
  ownerId: string
  botId: string
}

/**
 * Untrusted routine task payload.
 * Never grants tool permissions, sandbox bypasses, or runtime authority.
 */
export interface RoutineTaskDefinition {
  prompt: string
  metadata?: Record<string, string>
  requestedPermissionHint?: 'read-only' | 'ask-approval' | 'workspace'
  idempotent: boolean
}

export type TaskStatus =
  | 'scheduled'
  | 'queued'
  | 'claimed'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'interrupted'

export interface RoutineRecord {
  id: string
  name: string
  description: string
  ownerId: string
  botId: string
  ownership: RoutineOwnership
  revision: number
  trigger: TriggerConfig
  timezone: string
  task: RoutineTaskDefinition
  enabled: boolean
  archivedAt: string | null
  missedRunPolicy: MissedRunPolicy
  maxCatchUpRuns: number
  concurrencyPolicy: ConcurrencyPolicy
  maxConcurrentRuns: number
  retryPolicy: RetryPolicy
  expiresAt: string | null
  nextRunAt: string | null
  lastRunAt: string | null
  lastEvaluatedAt: string | null
  lastTaskStatus: TaskStatus | null
  createdAt: string
  updatedAt: string
}

export interface CreateRoutineInput {
  id?: string
  name: string
  description?: string
  ownerId: string
  botId: string
  ownership?: RoutineOwnership
  trigger: TriggerConfig
  timezone: string
  task: RoutineTaskDefinition
  enabled?: boolean
  missedRunPolicy?: MissedRunPolicy
  maxCatchUpRuns?: number
  concurrencyPolicy?: ConcurrencyPolicy
  maxConcurrentRuns?: number
  retryPolicy?: RetryPolicy
  expiresAt?: string | null
}

export interface UpdateRoutinePatch {
  name?: string
  description?: string
  trigger?: TriggerConfig
  timezone?: string
  task?: RoutineTaskDefinition
  missedRunPolicy?: MissedRunPolicy
  maxCatchUpRuns?: number
  concurrencyPolicy?: ConcurrencyPolicy
  maxConcurrentRuns?: number
  retryPolicy?: RetryPolicy
  expiresAt?: string | null
}

export interface ScheduledTaskRecord {
  id: string
  routineId: string
  routineRevision: number
  triggerSource: TaskTriggerSource
  ownerId: string
  botId: string
  occurrenceKey: string
  scheduledFor: string
  status: TaskStatus
  attempt: number
  maxAttempts: number
  claimOwner: string | null
  claimLeaseExpiresAt: string | null
  uncertainExecution: boolean
  approvalRequired: boolean
  taskSnapshot: RoutineTaskDefinition
  errorCode: string | null
  errorMessage: string | null
  startedAt: string | null
  endedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface SyntheticEventEnvelope {
  eventId: string
  trustedSource: string
  eventType: string
  timestamp: string
  scope: RoutineScope
  payload: Record<string, string | number | boolean>
}

export interface Clock {
  nowMs(): number
}

/**
 * Contract for future daemon-owned execution through RunOrchestrator & RuntimePolicyBroker.
 * Revalidates owner, bot, account, workspace, runtime capabilities, and permission policy
 * on every invocation; never reuses prior approvals.
 */
export interface FutureExecutionAuthorizationContext {
  routineId: string
  routineRevision: number
  triggerSource: TaskTriggerSource
  taskId: string
  occurrenceKey: string
  ownerId: string
  botId: string
  untrustedTask: RoutineTaskDefinition
  requirePolicyRevalidation: true
  reusePriorApprovals: false
}

export type FutureDispatchOutcome =
  | { status: 'completed' }
  | { status: 'awaiting_approval'; reason: string }
  | { status: 'failed'; code: string; message: string }

export interface FutureRoutineDispatcher {
  dispatch(ctx: FutureExecutionAuthorizationContext): Promise<FutureDispatchOutcome>
}
