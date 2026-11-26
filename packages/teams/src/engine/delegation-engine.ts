import { createHash, randomUUID } from 'node:crypto'
import type {
  TeamAggregateUsage,
  TeamCancellationResult,
  TeamDispatchContext,
  TeamTaskDispatcher,
  TeamTaskRecord,
  TeamTaskStatus,
} from '../contracts/types.ts'
import type { TeamRepository } from '../repository/team-repository.ts'
import {
  assertNonEmptyBounded,
  assertPromptBounded,
  assertTeamOwner,
  redactTeamSecrets,
  TeamError,
  truncateUtf8ToByteLimit,
} from '../security/validation.ts'

const TERMINAL_STATUSES = new Set<TeamTaskStatus>([
  'completed',
  'failed',
  'cancelled',
  'budget_exhausted',
  'stopped_by_parent',
  'blocked',
  'uncertain',
])

export function isTerminalTeamTaskStatus(status: TeamTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

interface RawTaskRow {
  id: string
  team_id: string
  team_run_id: string | null
  plan_key: string | null
  owner_id: string
  root_task_id: string
  parent_task_id: string | null
  depth: number
  assigned_bot_id: string
  delegated_by_bot_id: string | null
  idempotency_key: string
  prompt: string
  prompt_hash: string
  status: string
  attempt: number
  max_attempts: number
  token_budget: number
  reserved_tokens: number
  tokens_used: number
  duration_budget_ms: number
  reserved_duration_ms: number
  duration_used_ms: number
  output_text: string | null
  output_truncated: number
  usage_reported: number
  termination_confirmed: number
  error_code: string | null
  error_message: string | null
  started_at: string | null
  ended_at: string | null
  created_at: string
  updated_at: string
}

function rowToTask(row: RawTaskRow): TeamTaskRecord {
  return {
    id: row.id,
    teamId: row.team_id,
    teamRunId: row.team_run_id ?? null,
    planKey: row.plan_key ?? null,
    ownerId: row.owner_id,
    rootTaskId: row.root_task_id,
    parentTaskId: row.parent_task_id,
    depth: Number(row.depth),
    assignedBotId: row.assigned_bot_id,
    delegatedByBotId: row.delegated_by_bot_id,
    idempotencyKey: row.idempotency_key,
    prompt: row.prompt,
    status: row.status as TeamTaskStatus,
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    tokenBudget: Number(row.token_budget),
    tokensReserved: Number(row.reserved_tokens ?? 0),
    tokensUsed: Number(row.tokens_used),
    durationBudgetMs: Number(row.duration_budget_ms),
    durationReservedMs: Number(row.reserved_duration_ms ?? 0),
    durationUsedMs: Number(row.duration_used_ms),
    outputText: row.output_text ?? null,
    outputTruncated: Number(row.output_truncated ?? 0) === 1,
    usageReported: Number(row.usage_reported ?? 1) === 1,
    terminationConfirmed: Number(row.termination_confirmed ?? 1) === 1,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function hashPrompt(prompt: string, targetBotId: string, parentTaskId: string | null): string {
  return createHash('sha256')
    .update(JSON.stringify({ prompt, targetBotId, parentTaskId }))
    .digest('hex')
}

export class DelegationEngine {
  private readonly repository: TeamRepository

  constructor(repository: TeamRepository) {
    this.repository = repository
  }

  getTask(taskId: string, ownerId: string): TeamTaskRecord {
    const db = this.repository.getDatabase()
    const row = db.sqlite
      .prepare(`SELECT * FROM team_tasks WHERE id = ?`)
      .get(taskId) as RawTaskRow | undefined
    if (!row) {
      throw new TeamError('TASK_NOT_FOUND', `Team task "${taskId}" was not found`)
    }
    assertTeamOwner(ownerId, row.owner_id)
    return rowToTask(row)
  }

  createRootTask(
    input: {
      teamId: string
      ownerId: string
      prompt: string
      idempotencyKey: string
      teamRunId?: string | null
      planKey?: string | null
    },
    nowMs = Date.now(),
  ): { task: TeamTaskRecord; created: boolean } {
    const db = this.repository.getDatabase()
    const prompt = assertPromptBounded(input.prompt, 'prompt')
    const idempotencyKey = assertNonEmptyBounded(input.idempotencyKey, 'idempotencyKey', 128)
    const nowIso = new Date(nowMs).toISOString()

    return db.transaction(() => {
      const team = this.repository.getTeam(input.teamId, input.ownerId)
      if (team.archivedAt !== null) {
        throw new TeamError('TEAM_ARCHIVED', 'Cannot start a task on an archived team')
      }

      const pHash = hashPrompt(prompt, team.leadBotId, null)
      const existing = db.sqlite
        .prepare(`SELECT * FROM team_tasks WHERE team_id = ? AND idempotency_key = ?`)
        .get(team.id, idempotencyKey) as RawTaskRow | undefined
      if (existing) {
        if (existing.prompt_hash !== pHash) {
          throw new TeamError(
            'IDEMPOTENCY_CONFLICT',
            'Idempotency key reused with a different prompt',
          )
        }
        return { task: rowToTask(existing), created: false }
      }

      const id = `ttsk_${randomUUID()}`
      db.sqlite
        .prepare(
          `INSERT INTO team_tasks (
            id, team_id, team_run_id, plan_key, owner_id, root_task_id, parent_task_id, depth,
            assigned_bot_id, delegated_by_bot_id, idempotency_key, prompt, prompt_hash,
            status, attempt, max_attempts, token_budget, reserved_tokens, tokens_used,
            duration_budget_ms, reserved_duration_ms, duration_used_ms,
            output_text, output_truncated, usage_reported, termination_confirmed,
            error_code, error_message, started_at, ended_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, NULL, ?, ?, ?, 'queued', 0, ?, ?, 0, 0, ?, 0, 0, NULL, 0, 1, 1, NULL, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          id,
          team.id,
          input.teamRunId ?? null,
          input.planKey ?? null,
          input.ownerId,
          id,
          team.leadBotId,
          idempotencyKey,
          prompt,
          pHash,
          team.bounds.maxAttempts,
          team.bounds.maxTokens,
          team.bounds.maxDurationMs,
          nowIso,
          nowIso,
        )

      return { task: this.getTask(id, input.ownerId), created: true }
    })
  }

  delegateSubtask(
    input: {
      teamId: string
      ownerId: string
      parentTaskId: string
      targetBotId: string
      prompt: string
      idempotencyKey: string
      tokenBudget?: number
      durationBudgetMs?: number
      teamRunId?: string | null
      planKey?: string | null
      depthOverride?: number
    },
    nowMs = Date.now(),
  ): { task: TeamTaskRecord; created: boolean } {
    const db = this.repository.getDatabase()
    const prompt = assertPromptBounded(input.prompt, 'prompt')
    const idempotencyKey = assertNonEmptyBounded(input.idempotencyKey, 'idempotencyKey', 128)
    const nowIso = new Date(nowMs).toISOString()

    return db.transaction(() => {
      const team = this.repository.getTeam(input.teamId, input.ownerId)
      if (team.archivedAt !== null) {
        throw new TeamError('TEAM_ARCHIVED', 'Cannot delegate on an archived team')
      }
      if (!team.memberBotIds.includes(input.targetBotId)) {
        throw new TeamError('NON_MEMBER_BOT', `Bot "${input.targetBotId}" is not a member of team`)
      }

      const parent = this.getTask(input.parentTaskId, input.ownerId)
      if (parent.teamId !== team.id) {
        throw new TeamError('SCOPE_FORBIDDEN', 'Parent task belongs to a different team')
      }
      if (isTerminalTeamTaskStatus(parent.status)) {
        throw new TeamError(
          'PARENT_NOT_ACTIVE',
          `Cannot delegate from terminal parent task (${parent.status})`,
        )
      }

      // Guard against ancestor cycle in parent_task_id
      const visited = new Set<string>([parent.id])
      let cursorParentId = parent.parentTaskId
      while (cursorParentId) {
        if (visited.has(cursorParentId)) {
          throw new TeamError('RECURSIVE_CYCLE', 'Cycle detected in task delegation hierarchy')
        }
        visited.add(cursorParentId)
        const ancestor = db.sqlite
          .prepare(`SELECT parent_task_id FROM team_tasks WHERE id = ?`)
          .get(cursorParentId) as { parent_task_id: string | null } | undefined
        cursorParentId = ancestor?.parent_task_id ?? null
      }

      const nextDepth = input.depthOverride ?? parent.depth + 1
      if (nextDepth > team.bounds.maxDepth) {
        throw new TeamError(
          'MAX_DEPTH_EXCEEDED',
          `Delegation depth ${nextDepth} exceeds team maxDepth (${team.bounds.maxDepth})`,
        )
      }

      const pHash = hashPrompt(prompt, input.targetBotId, parent.id)
      const existing = db.sqlite
        .prepare(`SELECT * FROM team_tasks WHERE team_id = ? AND idempotency_key = ?`)
        .get(team.id, idempotencyKey) as RawTaskRow | undefined
      if (existing) {
        if (existing.prompt_hash !== pHash) {
          throw new TeamError(
            'IDEMPOTENCY_CONFLICT',
            'Delegation idempotency key reused with different prompt or target',
          )
        }
        return { task: rowToTask(existing), created: false }
      }

      // Enforce maxTasksPerRun across the root task tree
      const treeCountRow = db.sqlite
        .prepare(`SELECT COUNT(*) AS cnt FROM team_tasks WHERE root_task_id = ?`)
        .get(parent.rootTaskId) as { cnt: number }
      if (Number(treeCountRow?.cnt ?? 0) >= team.bounds.maxTasksPerRun) {
        throw new TeamError(
          'TASK_LIMIT_EXCEEDED',
          `Task count reached maxTasksPerRun (${team.bounds.maxTasksPerRun})`,
        )
      }

      // Compute remaining tree token budget accounting for both used and reserved tokens
      const treeUsedRow = db.sqlite
        .prepare(
          `SELECT COALESCE(SUM(tokens_used + reserved_tokens), 0) AS committed
           FROM team_tasks WHERE root_task_id = ?`,
        )
        .get(parent.rootTaskId) as { committed: number }
      const treeRemaining = Math.max(0, team.bounds.maxTokens - Number(treeUsedRow?.committed ?? 0))
      const requestedTokens = input.tokenBudget ?? treeRemaining
      if (requestedTokens <= 0 || treeRemaining <= 0 || requestedTokens > treeRemaining) {
        throw new TeamError(
          'PARENT_BUDGET_EXHAUSTED',
          `Insufficient remaining token budget (${treeRemaining}) for delegation`,
        )
      }

      // Carve delegated budget from parent's unspent/unreserved budget so parent cannot starve children
      const parentAvailable = Math.max(
        0,
        parent.tokenBudget - parent.tokensUsed - parent.tokensReserved,
      )
      if (requestedTokens > parentAvailable && parent.status !== 'completed') {
        throw new TeamError(
          'PARENT_BUDGET_EXHAUSTED',
          `Insufficient parent token budget (${parentAvailable}) for delegation`,
        )
      }
      if (parent.status !== 'completed') {
        db.sqlite
          .prepare(`UPDATE team_tasks SET token_budget = token_budget - ? WHERE id = ?`)
          .run(requestedTokens, parent.id)
      }

      const requestedDuration = Math.min(
        input.durationBudgetMs ?? parent.durationBudgetMs,
        parent.durationBudgetMs,
      )

      const id = `ttsk_${randomUUID()}`
      db.sqlite
        .prepare(
          `INSERT INTO team_tasks (
            id, team_id, team_run_id, plan_key, owner_id, root_task_id, parent_task_id, depth,
            assigned_bot_id, delegated_by_bot_id, idempotency_key, prompt, prompt_hash,
            status, attempt, max_attempts, token_budget, reserved_tokens, tokens_used,
            duration_budget_ms, reserved_duration_ms, duration_used_ms,
            output_text, output_truncated, usage_reported, termination_confirmed,
            error_code, error_message, started_at, ended_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, 0, 0, ?, 0, 0, NULL, 0, 1, 1, NULL, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          id,
          team.id,
          input.teamRunId ?? parent.teamRunId ?? null,
          input.planKey ?? null,
          input.ownerId,
          parent.rootTaskId,
          parent.id,
          nextDepth,
          input.targetBotId,
          parent.assignedBotId,
          idempotencyKey,
          prompt,
          pHash,
          team.bounds.maxAttempts,
          requestedTokens,
          requestedDuration,
          nowIso,
          nowIso,
        )

      return { task: this.getTask(id, input.ownerId), created: true }
    })
  }

  /**
   * Claims and executes up to `maxConcurrentTasks` queued tasks in parallel.
   * Never holds an open SQLite transaction across `await dispatcher.dispatch(...)`.
   */
  async runReadyTasksParallel(
    teamId: string,
    ownerId: string,
    dispatcher: TeamTaskDispatcher,
    nowMs = Date.now(),
    options: { teamRunId?: string } = {},
  ): Promise<TeamTaskRecord[]> {
    const db = this.repository.getDatabase()
    const teamCheck = this.repository.getTeam(teamId, ownerId)
    if (teamCheck.archivedAt !== null) {
      throw new TeamError('TEAM_ARCHIVED', 'Cannot execute tasks on an archived team')
    }

    const claimed = db.transaction(() => {
      const team = this.repository.getTeam(teamId, ownerId)
      const runningCountRow = db.sqlite
        .prepare(
          `SELECT COUNT(*) AS cnt FROM team_tasks
           WHERE team_id = ? AND status IN ('running', 'awaiting_approval')`,
        )
        .get(team.id) as { cnt: number }
      const slots = Math.max(
        0,
        team.bounds.maxConcurrentTasks - Number(runningCountRow?.cnt ?? 0),
      )
      if (slots === 0) return [] as TeamTaskRecord[]

      const runFilter = options.teamRunId ? 'AND team_run_id = ?' : ''
      const params: Array<string | number> = options.teamRunId
        ? [team.id, ownerId, options.teamRunId]
        : [team.id, ownerId]
      const queuedRows = db.sqlite
        .prepare(
          `SELECT * FROM team_tasks
           WHERE team_id = ? AND owner_id = ? AND status = 'queued' ${runFilter}
           ORDER BY depth ASC, created_at ASC`,
        )
        .all(...params) as unknown as RawTaskRow[]

      const started: TeamTaskRecord[] = []
      const nowIso = new Date(nowMs).toISOString()

      for (const row of queuedRows) {
        if (started.length >= slots) break

        // Verify assigned bot is still a current team member
        if (!team.memberBotIds.includes(row.assigned_bot_id)) {
          db.sqlite
            .prepare(
              `UPDATE team_tasks
               SET status = 'cancelled', error_code = 'MEMBER_REMOVED',
                   error_message = 'Assigned bot is no longer a team member.',
                   reserved_tokens = 0, reserved_duration_ms = 0,
                   termination_confirmed = 1, ended_at = ?, updated_at = ?
               WHERE id = ? AND status = 'queued'`,
            )
            .run(nowIso, nowIso, row.id)
          continue
        }

        if (row.parent_task_id) {
          const parent = this.getTask(row.parent_task_id, ownerId)
          if (
            parent.status === 'cancelled' ||
            parent.status === 'stopped_by_parent' ||
            parent.status === 'budget_exhausted' ||
            parent.status === 'failed' ||
            parent.status === 'uncertain' ||
            parent.status === 'blocked'
          ) {
            db.sqlite
              .prepare(
                `UPDATE team_tasks
                 SET status = 'stopped_by_parent', error_code = 'PARENT_STOPPED',
                     error_message = 'Stopped because parent task is no longer active.',
                     reserved_tokens = 0, reserved_duration_ms = 0,
                     ended_at = ?, updated_at = ?
                 WHERE id = ? AND status = 'queued'`,
              )
              .run(nowIso, nowIso, row.id)
            continue
          }
        }

        // Check explicit task dependencies
        const deps = db.sqlite
          .prepare(
            `SELECT d.depends_on_task_id, t.status
             FROM team_task_dependencies d
             JOIN team_tasks t ON t.id = d.depends_on_task_id
             WHERE d.task_id = ?`,
          )
          .all(row.id) as Array<{ depends_on_task_id: string; status: TeamTaskStatus }>

        let hasFailedDep = false
        let hasPendingDep = false
        for (const dep of deps) {
          if (
            dep.status === 'failed' ||
            dep.status === 'cancelled' ||
            dep.status === 'budget_exhausted' ||
            dep.status === 'stopped_by_parent' ||
            dep.status === 'blocked' ||
            dep.status === 'uncertain'
          ) {
            hasFailedDep = true
            break
          }
          if (dep.status !== 'completed') {
            hasPendingDep = true
          }
        }

        if (hasFailedDep) {
          db.sqlite
            .prepare(
              `UPDATE team_tasks
               SET status = 'blocked', error_code = 'PREREQUISITE_FAILED',
                   error_message = 'Blocked because a required prerequisite task did not complete.',
                   reserved_tokens = 0, reserved_duration_ms = 0,
                   ended_at = ?, updated_at = ?
               WHERE id = ? AND status = 'queued'`,
            )
            .run(nowIso, nowIso, row.id)
          continue
        }
        if (hasPendingDep) {
          continue
        }

        // Atomic budget reservation before dispatch
        const treeCommittedRow = db.sqlite
          .prepare(
            `SELECT COALESCE(SUM(tokens_used + reserved_tokens), 0) AS committed
             FROM team_tasks WHERE root_task_id = ? AND id != ?`,
          )
          .get(row.root_task_id, row.id) as { committed: number }
        const treeRemaining = Math.max(
          0,
          team.bounds.maxTokens - Number(treeCommittedRow?.committed ?? 0),
        )
        const taskRemainingTokens = Math.max(0, Number(row.token_budget) - Number(row.tokens_used))
        const reserveTokens = Math.min(taskRemainingTokens, treeRemaining)
        const reserveDuration = Math.max(0, Number(row.duration_budget_ms) - Number(row.duration_used_ms))

        if (reserveTokens <= 0 || reserveDuration <= 0) {
          db.sqlite
            .prepare(
              `UPDATE team_tasks
               SET status = 'budget_exhausted', error_code = 'BUDGET_EXHAUSTED',
                   error_message = 'No remaining token or duration budget available for reservation.',
                   reserved_tokens = 0, reserved_duration_ms = 0,
                   ended_at = ?, updated_at = ?
               WHERE id = ? AND status = 'queued'`,
            )
            .run(nowIso, nowIso, row.id)
          continue
        }

        const res = db.sqlite
          .prepare(
            `UPDATE team_tasks
             SET status = 'running', attempt = attempt + 1,
                 reserved_tokens = ?, reserved_duration_ms = ?,
                 started_at = COALESCE(started_at, ?), updated_at = ?
             WHERE id = ? AND status = 'queued'`,
          )
          .run(reserveTokens, reserveDuration, nowIso, nowIso, row.id)
        if (res.changes === 1) {
          started.push(this.getTask(row.id, ownerId))
        }
      }
      return started
    })

    if (claimed.length === 0) return []

    const results = await Promise.all(
      claimed.map(async (task) => {
        const ctx: TeamDispatchContext = {
          teamId: task.teamId,
          teamRunId: task.teamRunId,
          taskId: task.id,
          rootTaskId: task.rootTaskId,
          parentTaskId: task.parentTaskId,
          depth: task.depth,
          attempt: task.attempt,
          ownerId: task.ownerId,
          assignedBotId: task.assignedBotId,
          prompt: task.prompt,
          remainingTokenBudget: Math.min(
            task.tokensReserved,
            Math.max(0, task.tokenBudget - task.tokensUsed),
          ),
          remainingDurationMs: Math.max(0, task.durationBudgetMs - task.durationUsedMs),
          requirePolicyRevalidation: true,
          noPermissionEscalation: true,
          noImplicitMemorySharing: true,
          reusePriorApprovals: false,
        }

        try {
          const outcome = await dispatcher.dispatch(ctx)
          const doneIso = new Date(nowMs + Math.max(0, outcome.durationMs ?? 0)).toISOString()

          return db.transaction(() => {
            const latest = this.getTask(task.id, ownerId)
            // Late callback guard: never reopen terminal or mismatched-attempt tasks
            if (latest.status !== 'running' || latest.attempt !== task.attempt) {
              return latest
            }

            const usageReported = outcome.tokensUsed !== undefined && outcome.durationMs !== undefined ? 1 : 0
            const newTokens = latest.tokensUsed + Math.max(0, outcome.tokensUsed ?? 0)
            const newDuration = latest.durationUsedMs + Math.max(0, outcome.durationMs ?? 0)

            const treeUsedRow = db.sqlite
              .prepare(
                `SELECT COALESCE(SUM(tokens_used + reserved_tokens), 0) AS committed FROM team_tasks
                 WHERE root_task_id = ? AND id != ?`,
              )
              .get(latest.rootTaskId, latest.id) as { committed: number }
            const treeTotalTokens = Number(treeUsedRow?.committed ?? 0) + newTokens

            if (
              newTokens > latest.tokenBudget ||
              newDuration > latest.durationBudgetMs ||
              treeTotalTokens > teamCheck.bounds.maxTokens
            ) {
              db.sqlite
                .prepare(
                  `UPDATE team_tasks
                   SET status = 'budget_exhausted', tokens_used = ?, duration_used_ms = ?,
                       reserved_tokens = 0, reserved_duration_ms = 0, usage_reported = ?,
                       error_code = 'BUDGET_EXHAUSTED', error_message = 'Token or duration budget exceeded.',
                       ended_at = ?, updated_at = ?
                   WHERE id = ?`,
                )
                .run(newTokens, newDuration, usageReported, doneIso, doneIso, latest.id)
              return this.getTask(latest.id, ownerId)
            }

            if (outcome.status === 'completed') {
              const boundedOutput =
                outcome.outputText !== undefined
                  ? truncateUtf8ToByteLimit(outcome.outputText, teamCheck.bounds.maxResultBytes)
                  : { text: null, truncated: false }
              db.sqlite
                .prepare(
                  `UPDATE team_tasks
                   SET status = 'completed', tokens_used = ?, duration_used_ms = ?,
                       reserved_tokens = 0, reserved_duration_ms = 0,
                       output_text = ?, output_truncated = ?, usage_reported = ?,
                       termination_confirmed = 1, ended_at = ?, updated_at = ?
                   WHERE id = ?`,
                )
                .run(
                  newTokens,
                  newDuration,
                  boundedOutput.text,
                  boundedOutput.truncated ? 1 : 0,
                  usageReported,
                  doneIso,
                  doneIso,
                  latest.id,
                )
              return this.getTask(latest.id, ownerId)
            }

            if (outcome.status === 'awaiting_approval') {
              db.sqlite
                .prepare(
                  `UPDATE team_tasks
                   SET status = 'awaiting_approval', tokens_used = ?, duration_used_ms = ?,
                       usage_reported = ?, updated_at = ?
                   WHERE id = ?`,
                )
                .run(newTokens, newDuration, usageReported, doneIso, latest.id)
              return this.getTask(latest.id, ownerId)
            }

            if (outcome.status === 'uncertain') {
              // Uncertain outcome: keep reserved_tokens locked so uncontrolled dispatches cannot proceed
              db.sqlite
                .prepare(
                  `UPDATE team_tasks
                   SET status = 'uncertain', tokens_used = ?, duration_used_ms = ?,
                       usage_reported = ?, termination_confirmed = 0,
                       error_code = ?, error_message = ?,
                       ended_at = ?, updated_at = ?
                   WHERE id = ?`,
                )
                .run(
                  newTokens,
                  newDuration,
                  usageReported,
                  outcome.code,
                  redactTeamSecrets(outcome.message),
                  doneIso,
                  doneIso,
                  latest.id,
                )
              return this.getTask(latest.id, ownerId)
            }

            // Failed outcome: retry only if retryable and attempts remain
            const canRetry = Boolean(outcome.retryable) && latest.attempt < latest.maxAttempts
            db.sqlite
              .prepare(
                `UPDATE team_tasks
                 SET status = ?, tokens_used = ?, duration_used_ms = ?,
                     reserved_tokens = 0, reserved_duration_ms = 0, usage_reported = ?,
                     error_code = ?, error_message = ?,
                     ended_at = ?, updated_at = ?
                 WHERE id = ?`,
              )
              .run(
                canRetry ? 'queued' : 'failed',
                newTokens,
                newDuration,
                usageReported,
                outcome.code,
                redactTeamSecrets(outcome.message),
                canRetry ? null : doneIso,
                doneIso,
                latest.id,
              )
            return this.getTask(latest.id, ownerId)
          })
        } catch (err) {
          const errIso = new Date(nowMs).toISOString()
          return db.transaction(() => {
            const latest = this.getTask(task.id, ownerId)
            if (latest.status !== 'running' || latest.attempt !== task.attempt) return latest
            // Dispatcher exception does not prove external execution stopped: mark uncertain & retain reservation
            db.sqlite
              .prepare(
                `UPDATE team_tasks
                 SET status = 'uncertain', termination_confirmed = 0, usage_reported = 0,
                     error_code = 'DISPATCH_UNCERTAIN', error_message = ?,
                     ended_at = ?, updated_at = ?
                 WHERE id = ?`,
              )
              .run(
                redactTeamSecrets(err instanceof Error ? err.message : 'Dispatch threw unexpected error'),
                errIso,
                errIso,
                latest.id,
              )
            return this.getTask(latest.id, ownerId)
          })
        }
      }),
    )

    return results
  }

  /**
   * Cancels a task and propagates stop to all non-terminal descendant tasks in the delegation tree.
   * For active running/awaiting_approval tasks, requests cancellation via dispatcher.cancelExecution
   * and marks unconfirmed terminations as 'uncertain' (non-replayable).
   */
  async cancelTaskWithPropagationAsync(
    taskId: string,
    ownerId: string,
    dispatcher?: TeamTaskDispatcher,
    nowMs = Date.now(),
  ): Promise<{ cancelledTask: TeamTaskRecord; stoppedChildrenCount: number; uncertainCount: number }> {
    const db = this.repository.getDatabase()
    const targetInitial = this.getTask(taskId, ownerId)

    const treeRowsInitial = db.sqlite
      .prepare(
        `SELECT id, team_id, team_run_id, parent_task_id, status, attempt
         FROM team_tasks WHERE root_task_id = ?`,
      )
      .all(targetInitial.rootTaskId) as Array<{
      id: string
      team_id: string
      team_run_id: string | null
      parent_task_id: string | null
      status: TeamTaskStatus
      attempt: number
    }>

    const childrenByParent = new Map<string, string[]>()
    const rowById = new Map(treeRowsInitial.map((r) => [r.id, r]))
    for (const r of treeRowsInitial) {
      if (r.parent_task_id) {
        const list = childrenByParent.get(r.parent_task_id) ?? []
        list.push(r.id)
        childrenByParent.set(r.parent_task_id, list)
      }
    }

    const subtreeIds: string[] = [targetInitial.id]
    const bfs = [...(childrenByParent.get(targetInitial.id) ?? [])]
    while (bfs.length > 0) {
      const cid = bfs.shift()!
      subtreeIds.push(cid)
      const gc = childrenByParent.get(cid)
      if (gc) bfs.push(...gc)
    }

    const cancelConfirmations = new Map<string, TeamCancellationResult>()
    for (const id of subtreeIds) {
      const row = rowById.get(id)
      if (row && (row.status === 'running' || row.status === 'awaiting_approval')) {
        if (dispatcher?.cancelExecution) {
          try {
            const ack = await dispatcher.cancelExecution({
              teamId: row.team_id,
              teamRunId: row.team_run_id,
              taskId: row.id,
              attempt: Number(row.attempt),
            })
            cancelConfirmations.set(id, ack)
          } catch (err) {
            cancelConfirmations.set(id, {
              confirmed: false,
              reason: err instanceof Error ? err.message : 'Cancellation call failed',
            })
          }
        } else {
          cancelConfirmations.set(id, {
            confirmed: false,
            reason: 'No cancellation acknowledgement channel available',
          })
        }
      }
    }

    const nowIso = new Date(nowMs).toISOString()
    return db.transaction(() => {
      let stoppedChildrenCount = 0
      let uncertainCount = 0

      for (let i = 0; i < subtreeIds.length; i += 1) {
        const id = subtreeIds[i]!
        const latest = this.getTask(id, ownerId)
        if (isTerminalTeamTaskStatus(latest.status)) continue

        const isRootTarget = i === 0
        const wasActive = latest.status === 'running' || latest.status === 'awaiting_approval'
        if (wasActive) {
          const ack = cancelConfirmations.get(id)
          if (!ack?.confirmed) {
            uncertainCount += 1
            db.sqlite
              .prepare(
                `UPDATE team_tasks
                 SET status = 'uncertain', termination_confirmed = 0,
                     error_code = 'UNCERTAIN_CANCELLATION',
                     error_message = ?, ended_at = ?, updated_at = ?
                 WHERE id = ?`,
              )
              .run(
                redactTeamSecrets(ack?.reason ?? 'External execution stop unconfirmed'),
                nowIso,
                nowIso,
                id,
              )
            if (!isRootTarget) stoppedChildrenCount += 1
            continue
          }
        }

        const nextStatus = isRootTarget ? 'cancelled' : 'stopped_by_parent'
        const errCode = isRootTarget ? 'CANCELLED' : 'PARENT_CANCELLED'
        const errMsg = isRootTarget ? 'Task cancelled.' : 'Stopped by parent task cancellation.'
        const res = db.sqlite
          .prepare(
            `UPDATE team_tasks
             SET status = ?, error_code = ?, error_message = ?,
                 reserved_tokens = 0, reserved_duration_ms = 0,
                 termination_confirmed = 1, ended_at = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(nextStatus, errCode, errMsg, nowIso, nowIso, id)
        if (!isRootTarget) stoppedChildrenCount += Number(res.changes)
      }

      return {
        cancelledTask: this.getTask(targetInitial.id, ownerId),
        stoppedChildrenCount,
        uncertainCount,
      }
    })
  }

  cancelTaskWithPropagation(
    taskId: string,
    ownerId: string,
    nowMs = Date.now(),
  ): { cancelledTask: TeamTaskRecord; stoppedChildrenCount: number } {
    const db = this.repository.getDatabase()
    const nowIso = new Date(nowMs).toISOString()

    return db.transaction(() => {
      const target = this.getTask(taskId, ownerId)
      if (!isTerminalTeamTaskStatus(target.status)) {
        const wasActive = target.status === 'running' || target.status === 'awaiting_approval'
        db.sqlite
          .prepare(
            `UPDATE team_tasks
             SET status = ?, error_code = ?, error_message = ?,
                 reserved_tokens = ?, reserved_duration_ms = ?,
                 termination_confirmed = ?, ended_at = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            wasActive ? 'uncertain' : 'cancelled',
            wasActive ? 'UNCERTAIN_CANCELLATION' : 'CANCELLED',
            wasActive ? 'Active execution stop unconfirmed.' : 'Task cancelled.',
            wasActive ? target.tokensReserved : 0,
            wasActive ? target.durationReservedMs : 0,
            wasActive ? 0 : 1,
            nowIso,
            nowIso,
            target.id,
          )
      }

      const treeRows = db.sqlite
        .prepare(`SELECT id, parent_task_id, status FROM team_tasks WHERE root_task_id = ?`)
        .all(target.rootTaskId) as Array<{
        id: string
        parent_task_id: string | null
        status: TeamTaskStatus
      }>

      const childrenByParent = new Map<string, string[]>()
      for (const r of treeRows) {
        if (r.parent_task_id) {
          const list = childrenByParent.get(r.parent_task_id) ?? []
          list.push(r.id)
          childrenByParent.set(r.parent_task_id, list)
        }
      }

      const queueIds = [...(childrenByParent.get(target.id) ?? [])]
      const statusMap = new Map(treeRows.map((r) => [r.id, r.status]))
      let stoppedChildrenCount = 0

      while (queueIds.length > 0) {
        const cid = queueIds.shift()!
        const cStatus = statusMap.get(cid)
        if (cStatus && !isTerminalTeamTaskStatus(cStatus)) {
          const wasActive = cStatus === 'running' || cStatus === 'awaiting_approval'
          const res = db.sqlite
            .prepare(
              `UPDATE team_tasks
               SET status = ?, error_code = ?, error_message = ?,
                   termination_confirmed = ?, ended_at = ?, updated_at = ?
               WHERE id = ?`,
            )
            .run(
              wasActive ? 'uncertain' : 'stopped_by_parent',
              wasActive ? 'UNCERTAIN_CANCELLATION' : 'PARENT_CANCELLED',
              wasActive ? 'Active child execution stop unconfirmed.' : 'Stopped by parent task cancellation.',
              wasActive ? 0 : 1,
              nowIso,
              nowIso,
              cid,
            )
          stoppedChildrenCount += Number(res.changes)
        }
        const grandChildren = childrenByParent.get(cid)
        if (grandChildren) queueIds.push(...grandChildren)
      }

      return {
        cancelledTask: this.getTask(target.id, ownerId),
        stoppedChildrenCount,
      }
    })
  }

  getAggregateUsage(rootTaskId: string, ownerId: string): TeamAggregateUsage {
    const db = this.repository.getDatabase()
    const root = this.getTask(rootTaskId, ownerId)
    const rows = db.sqlite
      .prepare(`SELECT * FROM team_tasks WHERE root_task_id = ? AND owner_id = ?`)
      .all(root.rootTaskId, ownerId) as unknown as RawTaskRow[]

    const byStatus: Record<TeamTaskStatus, number> = {
      queued: 0,
      running: 0,
      awaiting_approval: 0,
      blocked: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      budget_exhausted: 0,
      stopped_by_parent: 0,
      uncertain: 0,
    }
    const byBotId: Record<string, { tasks: number; tokensUsed: number; durationMs: number }> = {}
    let totalTokensUsed = 0
    let totalDurationMs = 0

    for (const r of rows) {
      const s = r.status as TeamTaskStatus
      byStatus[s] += 1
      const tokens = Number(r.tokens_used)
      const dur = Number(r.duration_used_ms)
      totalTokensUsed += tokens
      totalDurationMs += dur
      const botEntry = byBotId[r.assigned_bot_id] ?? { tasks: 0, tokensUsed: 0, durationMs: 0 }
      botEntry.tasks += 1
      botEntry.tokensUsed += tokens
      botEntry.durationMs += dur
      byBotId[r.assigned_bot_id] = botEntry
    }

    return {
      rootTaskId: root.rootTaskId,
      teamId: root.teamId,
      totalTasks: rows.length,
      totalTokensUsed,
      totalDurationMs,
      byStatus,
      byBotId,
    }
  }

  reconcileOnRestart(nowMs = Date.now()): number {
    const db = this.repository.getDatabase()
    const nowIso = new Date(nowMs).toISOString()
    return db.transaction(() => {
      const res = db.sqlite
        .prepare(
          `UPDATE team_tasks
           SET status = 'uncertain', termination_confirmed = 0,
               error_code = 'DAEMON_RESTARTED',
               error_message = 'Team task interrupted by restart; non-replayable until reconciled.',
               ended_at = ?, updated_at = ?
           WHERE status IN ('running', 'awaiting_approval')`,
        )
        .run(nowIso, nowIso)
      return Number(res.changes)
    })
  }
}
