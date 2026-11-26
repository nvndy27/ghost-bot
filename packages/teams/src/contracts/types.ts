export type TeamTaskStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'budget_exhausted'
  | 'stopped_by_parent'
  | 'uncertain'

export type TeamRunStatus =
  | 'planning'
  | 'running'
  | 'completed'
  | 'partial_failure'
  | 'failed'
  | 'cancelled'
  | 'uncertain'

export interface TeamExecutionBounds {
  maxDepth: number
  maxAttempts: number
  maxTokens: number
  maxDurationMs: number
  maxConcurrentTasks: number
  maxTasksPerRun: number
  maxMessages: number
  maxResultBytes: number
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

export interface TeamRunRecord {
  id: string
  teamId: string
  ownerId: string
  leadBotId: string
  rootTaskId: string
  conversationId: string
  idempotencyKey: string
  goal: string
  status: TeamRunStatus
  bounds: TeamExecutionBounds
  tasksCreated: number
  messagesPosted: number
  tokensReserved: number
  tokensUsed: number
  durationUsedMs: number
  errorCode: string | null
  errorMessage: string | null
  endedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface TeamTaskRecord {
  id: string
  teamId: string
  teamRunId: string | null
  planKey: string | null
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
  tokensReserved: number
  tokensUsed: number
  durationBudgetMs: number
  durationReservedMs: number
  durationUsedMs: number
  outputText: string | null
  outputTruncated: boolean
  usageReported: boolean
  terminationConfirmed: boolean
  errorCode: string | null
  errorMessage: string | null
  startedAt: string | null
  endedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface TeamTaskDependencyRecord {
  teamRunId: string
  taskId: string
  dependsOnTaskId: string
}

export type TeamMessageSenderType = 'user' | 'chief_of_staff' | 'worker' | 'system'

export type TeamMessageType =
  | 'user_prompt'
  | 'cos_instruction'
  | 'task_assignment'
  | 'worker_progress'
  | 'worker_result'
  | 'error_report'
  | 'cancellation_notice'
  | 'clarification_request'
  | 'final_response'

export type TeamMessageVisibility = 'team' | 'direct' | 'user_and_cos'

export interface TeamMessageRecord {
  id: string
  teamId: string
  teamRunId: string | null
  conversationId: string | null
  ownerId: string
  authorBotId: string
  targetBotId: string | null
  originatingTaskId: string
  senderType: TeamMessageSenderType
  messageType: TeamMessageType
  visibility: TeamMessageVisibility
  untrusted: boolean
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
  teamRunId: string | null
  taskId: string
  rootTaskId: string
  parentTaskId: string | null
  depth: number
  attempt: number
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
  | {
      status: 'completed'
      tokensUsed?: number
      durationMs?: number
      outputText?: string
    }
  | {
      status: 'awaiting_approval'
      tokensUsed?: number
      durationMs?: number
      reason: string
    }
  | {
      status: 'failed'
      code: string
      message: string
      retryable?: boolean
      tokensUsed?: number
      durationMs?: number
    }
  | {
      status: 'uncertain'
      code: string
      message: string
      tokensUsed?: number
      durationMs?: number
    }

export interface TeamCancellationResult {
  confirmed: boolean
  reason?: string
}

export interface TeamTaskDispatcher {
  dispatch(ctx: TeamDispatchContext): Promise<TeamDispatchOutcome>
  cancelExecution?(ctx: {
    teamId: string
    teamRunId: string | null
    taskId: string
    attempt: number
  }): Promise<TeamCancellationResult>
}

export interface PlannedTeamTaskInput {
  planKey: string
  assignedBotId: string
  prompt: string
  dependsOn?: string[]
  tokenBudget?: number
  durationBudgetMs?: number
}

export interface TeamTaskPlan {
  summary: string
  tasks: PlannedTeamTaskInput[]
}

export interface TeamTaskPlanner {
  plan(input: {
    team: TeamRecord
    teamRunId: string
    goal: string
  }): Promise<TeamTaskPlan>
}

export interface TeamTaskResultEntry {
  taskId: string
  planKey: string | null
  assignedBotId: string
  status: TeamTaskStatus
  outputText: string | null
  outputTruncated: boolean
  errorCode: string | null
  errorMessage: string | null
  tokensUsed: number | null
  durationMs: number | null
  usageReported: boolean
  terminationConfirmed: boolean
}

export interface TeamRunAggregateResult {
  teamRunId: string
  teamId: string
  rootTaskId: string
  status: TeamRunStatus
  completedCount: number
  failedCount: number
  cancelledCount: number
  blockedCount: number
  uncertainCount: number
  totalTasks: number
  totalTokensUsed: number
  totalDurationMs: number
  usageComplete: boolean
  unavailableUsageTaskIds: string[]
  results: TeamTaskResultEntry[]
  resultBytes: number
  truncated: boolean
  synthesisInputReady: boolean
}

export interface TeamResultSynthesizer {
  synthesize(aggregate: TeamRunAggregateResult): Promise<{ summaryText: string }>
}
