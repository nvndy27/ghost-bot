import { createHash, randomUUID } from 'node:crypto'
import type {
  TeamAggregateUsage,
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
} from '../security/validation.ts'

const TERMINAL_STATUSES = new Set<TeamTaskStatus>([
  'completed',
  'failed',
  'cancelled',
  'budget_exhausted',
  'stopped_by_parent',
])

export function isTerminalTeamTaskStatus(status: TeamTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

interface RawTaskRow {
  id: string
  team_id: string
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
  tokens_used: number
  duration_budget_ms: number
  duration_used_ms: number
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
    tokensUsed: Number(row.tokens_used),
    durationBudgetMs: Number(row.duration_budget_ms),
    durationUsedMs: Number(row.duration_used_ms),
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
            id, team_id, owner_id, root_task_id, parent_task_id, depth,
            assigned_bot_id, delegated_by_bot_id, idempotency_key, prompt, prompt_hash,
            status, attempt, max_attempts, token_budget, tokens_used,
            duration_budget_ms, duration_used_ms, error_code, error_message,
            started_at, ended_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, NULL, 0, ?, NULL, ?, ?, ?, 'queued', 0, ?, ?, 0, ?, 0, NULL, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          id,
          team.id,
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

      const nextDepth = parent.depth + 1
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

      // Compute remaining tree token budget
      const treeUsedRow = db.sqlite
        .prepare(`SELECT COALESCE(SUM(tokens_used), 0) AS used FROM team_tasks WHERE root_task_id = ?`)
        .get(parent.rootTaskId) as { used: number }
      const treeRemaining = Math.max(0, team.bounds.maxTokens - Number(treeUsedRow?.used ?? 0))
      const requestedTokens = input.tokenBudget ?? treeRemaining
      if (treeRemaining <= 0 || requestedTokens > treeRemaining) {
        throw new TeamError(
          'PARENT_BUDGET_EXHAUSTED',
          `Insufficient remaining token budget (${treeRemaining}) for delegation`,
        )
      }

      const requestedDuration = Math.min(
        input.durationBudgetMs ?? parent.durationBudgetMs,
        parent.durationBudgetMs,
      )

      const id = `ttsk_${randomUUID()}`
      db.sqlite
        .prepare(
          `INSERT INTO team_tasks (
            id, team_id, owner_id, root_task_id, parent_task_id, depth,
            assigned_bot_id, delegated_by_bot_id, idempotency_key, prompt, prompt_hash,
            status, attempt, max_attempts, token_budget, tokens_used,
            duration_budget_ms, duration_used_ms, error_code, error_message,
            started_at, ended_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, 0, ?, 0, NULL, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          id,
          team.id,
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
  ): Promise<TeamTaskRecord[]> {
    const db = this.repository.getDatabase()
    const team = this.repository.getTeam(teamId, ownerId)
    if (team.archivedAt !== null) {
      throw new TeamError('TEAM_ARCHIVED', 'Cannot execute tasks on an archived team')
    }

    const claimed = db.transaction(() => {
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

      const queuedRows = db.sqlite
        .prepare(
          `SELECT * FROM team_tasks
           WHERE team_id = ? AND owner_id = ? AND status = 'queued'
           ORDER BY depth ASC, created_at ASC
           LIMIT ?`,
        )
        .all(team.id, ownerId, slots) as unknown as RawTaskRow[]

      const started: TeamTaskRecord[] = []
      const nowIso = new Date(nowMs).toISOString()
      for (const row of queuedRows) {
        if (row.parent_task_id) {
          const parent = this.getTask(row.parent_task_id, ownerId)
          if (
            parent.status === 'cancelled' ||
            parent.status === 'stopped_by_parent' ||
            parent.status === 'budget_exhausted' ||
            parent.status === 'failed'
          ) {
            db.sqlite
              .prepare(
                `UPDATE team_tasks
                 SET status = 'stopped_by_parent', error_code = 'PARENT_STOPPED',
                     error_message = 'Stopped because parent task is no longer active.',
                     ended_at = ?, updated_at = ?
                 WHERE id = ? AND status = 'queued'`,
              )
              .run(nowIso, nowIso, row.id)
            continue
          }
        }

        const res = db.sqlite
          .prepare(
            `UPDATE team_tasks
             SET status = 'running', attempt = attempt + 1,
                 started_at = COALESCE(started_at, ?), updated_at = ?
             WHERE id = ? AND status = 'queued'`,
          )
          .run(nowIso, nowIso, row.id)
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
          taskId: task.id,
          rootTaskId: task.rootTaskId,
          parentTaskId: task.parentTaskId,
          depth: task.depth,
          ownerId: task.ownerId,
          assignedBotId: task.assignedBotId,
          prompt: task.prompt,
          remainingTokenBudget: Math.max(0, task.tokenBudget - task.tokensUsed),
          remainingDurationMs: Math.max(0, task.durationBudgetMs - task.durationUsedMs),
          requirePolicyRevalidation: true,
          noPermissionEscalation: true,
          noImplicitMemorySharing: true,
          reusePriorApprovals: false,
        }

        try {
          const outcome = await dispatcher.dispatch(ctx)
          const doneIso = new Date(nowMs + (outcome.durationMs ?? 0)).toISOString()

          return db.transaction(() => {
            const latest = this.getTask(task.id, ownerId)
            if (isTerminalTeamTaskStatus(latest.status)) {
              return latest
            }

            const newTokens = latest.tokensUsed + Math.max(0, outcome.tokensUsed ?? 0)
            const newDuration = latest.durationUsedMs + Math.max(0, outcome.durationMs ?? 0)

            // Check tree-wide and task-level budgets
            const treeUsedRow = db.sqlite
              .prepare(
                `SELECT COALESCE(SUM(tokens_used), 0) AS used FROM team_tasks
                 WHERE root_task_id = ? AND id != ?`,
              )
              .get(latest.rootTaskId, latest.id) as { used: number }
            const treeTotalTokens = Number(treeUsedRow?.used ?? 0) + newTokens

            if (
              newTokens > latest.tokenBudget ||
              newDuration > latest.durationBudgetMs ||
              treeTotalTokens > team.bounds.maxTokens
            ) {
              db.sqlite
                .prepare(
                  `UPDATE team_tasks
                   SET status = 'budget_exhausted', tokens_used = ?, duration_used_ms = ?,
                       error_code = 'BUDGET_EXHAUSTED', error_message = 'Token or duration budget exceeded.',
                       ended_at = ?, updated_at = ?
                   WHERE id = ?`,
                )
                .run(newTokens, newDuration, doneIso, doneIso, latest.id)
              return this.getTask(latest.id, ownerId)
            }

            if (outcome.status === 'completed') {
              db.sqlite
                .prepare(
                  `UPDATE team_tasks
                   SET status = 'completed', tokens_used = ?, duration_used_ms = ?,
                       ended_at = ?, updated_at = ?
                   WHERE id = ?`,
                )
                .run(newTokens, newDuration, doneIso, doneIso, latest.id)
              return this.getTask(latest.id, ownerId)
            }

            if (outcome.status === 'awaiting_approval') {
              db.sqlite
                .prepare(
                  `UPDATE team_tasks
                   SET status = 'awaiting_approval', tokens_used = ?, duration_used_ms = ?, updated_at = ?
                   WHERE id = ?`,
                )
                .run(newTokens, newDuration, doneIso, latest.id)
              return this.getTask(latest.id, ownerId)
            }

            // Failed outcome: retry only if retryable and attempts remain
            const canRetry = Boolean(outcome.retryable) && latest.attempt < latest.maxAttempts
            db.sqlite
              .prepare(
                `UPDATE team_tasks
                 SET status = ?, tokens_used = ?, duration_used_ms = ?,
                     error_code = ?, error_message = ?,
                     ended_at = ?, updated_at = ?
                 WHERE id = ?`,
              )
              .run(
                canRetry ? 'queued' : 'failed',
                newTokens,
                newDuration,
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
            if (isTerminalTeamTaskStatus(latest.status)) return latest
            db.sqlite
              .prepare(
                `UPDATE team_tasks
                 SET status = 'failed', error_code = 'DISPATCH_ERROR', error_message = ?,
                     ended_at = ?, updated_at = ?
                 WHERE id = ?`,
              )
              .run(
                redactTeamSecrets(err instanceof Error ? err.message : 'Dispatch failed'),
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
   */
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
        db.sqlite
          .prepare(
            `UPDATE team_tasks
             SET status = 'cancelled', error_code = 'CANCELLED',
                 error_message = 'Task cancelled.', ended_at = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(nowIso, nowIso, target.id)
      }

      // BFS through descendants in the same root_task_id tree
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
          const res = db.sqlite
            .prepare(
              `UPDATE team_tasks
               SET status = 'stopped_by_parent', error_code = 'PARENT_CANCELLED',
                   error_message = 'Stopped by parent task cancellation.',
                   ended_at = ?, updated_at = ?
               WHERE id = ?`,
            )
            .run(nowIso, nowIso, cid)
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
      completed: 0,
      failed: 0,
      cancelled: 0,
      budget_exhausted: 0,
      stopped_by_parent: 0,
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
           SET status = 'failed', error_code = 'DAEMON_RESTARTED',
               error_message = 'Team task interrupted by restart; never auto-replaying.',
               ended_at = ?, updated_at = ?
           WHERE status IN ('running', 'awaiting_approval')`,
        )
        .run(nowIso, nowIso)
      return Number(res.changes)
    })
  }
}
