export type TeamTaskStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'budget_exhausted'
  | 'stopped_by_parent'

export interface TeamExecutionBounds {
  maxDepth: number
  maxAttempts: number
  maxTokens: number
  maxDurationMs: number
  maxConcurrentTasks: number
}

export interface TeamRecord {
  id: string
  name: string
  description: string
  ownerId: string
  leadBotId: string
  memberBotIds: string[]
  /** Private agent memory is never implicitly shared across team members. */
  memorySharingPolicy: 'explicit-only'
  bounds: TeamExecutionBounds
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateTeamInput {
  id?: string
  name: string
  description?: string
  ownerId: string
  leadBotId: string
  memberBotIds: string[]
  bounds?: Partial<TeamExecutionBounds>
}

export interface TeamTaskRecord {
  id: string
  teamId: string
  ownerId: string
  rootTaskId: string
  parentTaskId: string | null
  depth: number
  assignedBotId: string
  delegatedByBotId: string | null
  idempotencyKey: string
  prompt: string
  status: TeamTaskStatus
  attempt: number
  maxAttempts: number
  tokenBudget: number
  tokensUsed: number
  durationBudgetMs: number
  durationUsedMs: number
  errorCode: string | null
  errorMessage: string | null
  startedAt: string | null
  endedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface TeamMessageRecord {
  id: string
  teamId: string
  ownerId: string
  authorBotId: string
  targetBotId: string | null
  originatingTaskId: string
  seq: number
  content: string
  createdAt: string
}

export interface TeamAggregateUsage {
  rootTaskId: string
  teamId: string
  totalTasks: number
  totalTokensUsed: number
  totalDurationMs: number
  byStatus: Record<TeamTaskStatus, number>
  byBotId: Record<string, { tasks: number; tokensUsed: number; durationMs: number }>
}

export interface TeamDispatchContext {
  teamId: string
  taskId: string
  rootTaskId: string
  parentTaskId: string | null
  depth: number
  ownerId: string
  assignedBotId: string
  prompt: string
  remainingTokenBudget: number
  remainingDurationMs: number
  requirePolicyRevalidation: true
  noPermissionEscalation: true
  noImplicitMemorySharing: true
  reusePriorApprovals: false
}

export type TeamDispatchOutcome =
  | { status: 'completed'; tokensUsed: number; durationMs: number; outputText?: string }
  | { status: 'awaiting_approval'; tokensUsed: number; durationMs: number; reason: string }
  | { status: 'failed'; code: string; message: string; retryable?: boolean; tokensUsed?: number; durationMs?: number }

export interface TeamTaskDispatcher {
  dispatch(ctx: TeamDispatchContext): Promise<TeamDispatchOutcome>
}
