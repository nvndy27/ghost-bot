import type { TeamTaskRecord, TeamTaskStatus } from '../contracts/types.ts'
import type { TeamRepository } from '../repository/team-repository.ts'
import { redactTeamSecrets, TeamError } from '../security/validation.ts'
import type { DelegationEngine } from './delegation-engine.ts'
import type { TeamCoordinator } from './team-coordinator.ts'

export type TeamDiagnosticReasonCode =
  | 'TEAM_RUN_READY'
  | 'WAITING_FOR_DEPENDENCIES'
  | 'BLOCKED_PREREQUISITE'
  | 'CONCURRENCY_LIMIT_REACHED'
  | 'BUDGET_EXHAUSTED'
  | 'MAX_DEPTH_REACHED'
  | 'MEMBER_UNAVAILABLE'
  | 'AWAITING_AUTHORIZATION'
  | 'AWAITING_APPROVAL'
  | 'CANCELLATION_PENDING'
  | 'EXECUTION_UNCERTAIN'
  | 'COMPLETED_WITH_PARTIAL_RESULTS'
  | 'COMPLETED'

export type TeamTaskDependencyState = 'ready' | 'waiting' | 'satisfied' | 'blocked'

export interface TeamTaskLedgerSummary {
  taskId: string
  planKey: string | null
  assignedBotId: string
  dependencyState: TeamTaskDependencyState
  status: TeamTaskStatus
  sanitizedFailureReason: string | null
  tokensUsed: number
  tokensReserved: number
}

export interface TeamRunDiagnosticsReport {
  teamRunId: string
  teamId: string
  runStatus: string
  reasonCodes: TeamDiagnosticReasonCode[]
  activeCount: number
  queuedCount: number
  completedCount: number
  uncertainCount: number
  tokensCommitted: number
  tokenLimit: number
  taskLedger: TeamTaskLedgerSummary[]
  readOnly: true
}

/**
 * Pure read-only diagnostics over TeamRepository, DelegationEngine, and TeamCoordinator.
 * Never authorizes, dispatches, or mutates any state.
 */
export class TeamDiagnosticsService {
  private readonly repository: TeamRepository
  private readonly engine: DelegationEngine
  private readonly coordinator: TeamCoordinator

  constructor(
    repository: TeamRepository,
    engine: DelegationEngine,
    coordinator: TeamCoordinator,
  ) {
    this.repository = repository
    this.engine = engine
    this.coordinator = coordinator
  }

  inspectTeamRun(teamRunId: string, ownerId: string): TeamRunDiagnosticsReport {
    const run = this.coordinator.getTeamRun(teamRunId, ownerId)
    const team = this.repository.getTeam(run.teamId, ownerId)
    const db = this.repository.getDatabase()
    const tasks = this.coordinator
      .listRunTasks(run.id, ownerId)
      .filter((t) => t.planKey !== '__root__')

    const depRows = db.sqlite
      .prepare(
        `SELECT d.task_id, t.status AS dep_status
         FROM team_task_dependencies d
         JOIN team_tasks t ON t.id = d.depends_on_task_id
         WHERE d.team_run_id = ?`,
      )
      .all(run.id) as Array<{ task_id: string; dep_status: TeamTaskStatus }>

    const depsByTask = new Map<string, TeamTaskStatus[]>()
    for (const row of depRows) {
      const list = depsByTask.get(row.task_id) ?? []
      list.push(row.dep_status)
      depsByTask.set(row.task_id, list)
    }

    const reasonSet = new Set<TeamDiagnosticReasonCode>()
    let activeCount = 0
    let queuedCount = 0
    let completedCount = 0
    let uncertainCount = 0
    let tokensCommitted = 0
    const ledger: TeamTaskLedgerSummary[] = []

    for (const t of tasks) {
      tokensCommitted += t.tokensUsed + t.tokensReserved
      if (t.status === 'running') activeCount += 1
      else if (t.status === 'queued') queuedCount += 1
      else if (t.status === 'completed') completedCount += 1
      else if (t.status === 'uncertain') uncertainCount += 1

      if (t.status === 'awaiting_approval') {
        activeCount += 1
        reasonSet.add('AWAITING_APPROVAL')
        reasonSet.add('AWAITING_AUTHORIZATION')
      }
      if (t.status === 'budget_exhausted') reasonSet.add('BUDGET_EXHAUSTED')
      if (t.status === 'uncertain') reasonSet.add('EXECUTION_UNCERTAIN')
      if (t.status === 'blocked') reasonSet.add('BLOCKED_PREREQUISITE')
      if (t.depth >= team.bounds.maxDepth) reasonSet.add('MAX_DEPTH_REACHED')
      if (!team.memberBotIds.includes(t.assignedBotId)) reasonSet.add('MEMBER_UNAVAILABLE')

      const depStatuses = depsByTask.get(t.id) ?? []
      let depState: TeamTaskDependencyState = 'satisfied'
      if (t.status === 'blocked') {
        depState = 'blocked'
      } else if (depStatuses.some((s) => s === 'failed' || s === 'cancelled' || s === 'blocked' || s === 'budget_exhausted' || s === 'stopped_by_parent' || s === 'uncertain')) {
        depState = 'blocked'
        reasonSet.add('BLOCKED_PREREQUISITE')
      } else if (depStatuses.some((s) => s !== 'completed')) {
        depState = 'waiting'
        if (t.status === 'queued') reasonSet.add('WAITING_FOR_DEPENDENCIES')
      } else if (t.status === 'queued') {
        depState = 'ready'
      }

      ledger.push({
        taskId: t.id,
        planKey: t.planKey,
        assignedBotId: t.assignedBotId,
        dependencyState: depState,
        status: t.status,
        sanitizedFailureReason: t.errorMessage ? redactTeamSecrets(t.errorMessage) : null,
        tokensUsed: t.tokensUsed,
        tokensReserved: t.tokensReserved,
      })
    }

    if (run.status === 'cancelled') {
      reasonSet.add('CANCELLATION_PENDING')
    }
    if (activeCount >= team.bounds.maxConcurrentTasks && queuedCount > 0) {
      reasonSet.add('CONCURRENCY_LIMIT_REACHED')
    }
    if (tokensCommitted >= team.bounds.maxTokens) {
      reasonSet.add('BUDGET_EXHAUSTED')
    }
    if (run.status === 'partial_failure') {
      reasonSet.add('COMPLETED_WITH_PARTIAL_RESULTS')
    } else if (run.status === 'completed') {
      reasonSet.add('COMPLETED')
    } else if (ledger.some((l) => l.dependencyState === 'ready') && activeCount < team.bounds.maxConcurrentTasks) {
      reasonSet.add('TEAM_RUN_READY')
    }

    return {
      teamRunId: run.id,
      teamId: run.teamId,
      runStatus: run.status,
      reasonCodes: [...reasonSet],
      activeCount,
      queuedCount,
      completedCount,
      uncertainCount,
      tokensCommitted,
      tokenLimit: team.bounds.maxTokens,
      taskLedger: ledger,
      readOnly: true,
    }
  }

  inspectTask(taskId: string, ownerId: string): TeamTaskRecord {
    const task = this.engine.getTask(taskId, ownerId)
    if (!task) {
      throw new TeamError('TASK_NOT_FOUND', 'Task not found')
    }
    return task
  }
}
