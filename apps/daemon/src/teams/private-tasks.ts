import { createHash, randomUUID } from 'node:crypto'
import type {
  CancelPrivateTaskInput,
  DelegateTeamTaskInput,
  ListPrivateTasksInput,
  PrivateTaskChatRecord,
  TaskSummaryMeta,
} from '@ghost-bot/shared-types/ipc'
import type { DatabaseHandle } from '../db/client.ts'
import { DaemonError, redactSecrets } from '../errors.ts'
import type { SessionRepository } from '../sessions/repository.ts'
import type { TeamMemberRoutingService } from './member-routing.ts'
import type { TeamsService } from './service.ts'

import {
  PRIVATE_TASK_META_PREFIX, privateTaskSessionIdentity, readPrivateTaskExecution, readPrivateTaskMeta,
  type StoredTaskMeta,
} from './private-task-identity.ts'

const TASK_SUMMARY_TURN_PREFIX = 'teams.task-summary-turn:'
const TERMINAL_TASK_STATUSES = new Set<PrivateTaskChatRecord['status']>([
  'completed',
  'failed',
  'cancelled',
  'blocked',
  'denied',
  'uncertain',
  'budget_exhausted',
  'stopped_by_parent',
])

function deterministicUuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export class PrivateTaskChatService {
  private readonly db: DatabaseHandle
  private readonly teams: TeamsService
  private readonly routing: TeamMemberRoutingService
  private readonly sessions: SessionRepository
  private readonly isMockRuntime: () => boolean

  constructor(
    db: DatabaseHandle,
    teams: TeamsService,
    routing: TeamMemberRoutingService,
    sessions: SessionRepository,
    isMockRuntime: () => boolean,
  ) {
    this.db = db
    this.teams = teams
    this.routing = routing
    this.sessions = sessions
    this.isMockRuntime = isMockRuntime
  }

  async delegate(input: DelegateTeamTaskInput): Promise<PrivateTaskChatRecord> {
    const team = this.teams.getTeam(input.teamId)
    if (team.archivedAt !== null) {
      throw new DaemonError('TEAM_ARCHIVED', 'Cannot delegate tasks in an archived group', { statusCode: 409 })
    }
    if (!team.memberBotIds.includes(input.assignedBotId)) {
      throw new DaemonError('NON_MEMBER_BOT', `Bot "${input.assignedBotId}" is not a member of this group`, {
        statusCode: 403,
      })
    }

    const idempotencyKey = `private-task:${input.operationId}`
    const existingRun = this.db.sqlite
      .prepare(`SELECT id, goal FROM team_runs WHERE team_id = ? AND idempotency_key = ?`)
      .get(team.id, idempotencyKey) as { id: string; goal: string } | undefined
    if (existingRun) {
      const meta = readPrivateTaskMeta(this.db, existingRun.id)
      if (!meta) {
        throw new DaemonError('DELEGATION_INTERRUPTED', 'Previous task creation has no valid binding and cannot be replayed', { statusCode: 409 })
      }
      if (meta.objective !== input.objective || meta.assignedBotId !== input.assignedBotId) {
        throw new DaemonError(
          'IDEMPOTENCY_CONFLICT',
          'Delegation operationId already exists with a different bot or objective',
          { statusCode: 409 },
        )
      }
      const existingRecord = this.list({ teamId: team.id }).tasks.find((t) => t.teamRunId === existingRun.id)
      if (existingRecord) return existingRecord
    }

    if (!this.isMockRuntime()) {
      throw new DaemonError(
        'LIVE_TEAMS_GATED',
        'Private Task Chat delegation is gated outside offline mock mode',
        { statusCode: 403 },
      )
    }

    const memberChoice = await this.routing.get({ teamId: team.id, botId: input.assignedBotId })
    if (
      !memberChoice.supported ||
      !memberChoice.effective.accountId ||
      !['mock', 'mock-offline'].includes(memberChoice.effective.runtimeId)
    ) {
      throw new DaemonError(
        'TEAM_ROUTING_UNAVAILABLE',
        'The selected member configuration cannot execute in this runtime',
        { statusCode: 409 },
      )
    }

    const started = await this.teams.startTeamRun({
      teamId: team.id,
      goal: input.objective,
      idempotencyKey,
      plan: {
        summary: input.objective,
        tasks: [
          {
            planKey: 'delegated_task',
            assignedBotId: input.assignedBotId,
            prompt: input.objective,
          },
        ],
      },
      autoExecute: false,
      onCreate: (run, tasks) => {
        this.routing.revalidate({ teamId: team.id, botId: input.assignedBotId }, memberChoice)
        const task = tasks.find((entry) => entry.planKey === 'delegated_task')
        if (!task || task.assignedBotId !== input.assignedBotId || !memberChoice.effective.accountId) {
          throw new DaemonError('DELEGATION_FAILED', 'Failed to bind delegated task', { statusCode: 500 })
        }
        const scope = {
          teamId: team.id, teamRunId: run.id, assignedBotId: input.assignedBotId,
          routing: memberChoice.effective, revision: memberChoice.revision,
        }
        const sessionId = this.sessions.getOrCreateTeamSessionInTx({
          identity: privateTaskSessionIdentity(scope), agentId: input.assignedBotId,
          runtimeId: scope.routing.runtimeId, accountId: memberChoice.effective.accountId,
        })
        const meta: StoredTaskMeta = {
          ...scope, taskId: task.id, teamName: team.name,
          objective: input.objective, sessionId, createdAt: run.createdAt,
        }
        this.db.sqlite.prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)')
          .run(PRIVATE_TASK_META_PREFIX + run.id, JSON.stringify(meta), run.createdAt)
      },
    })
    const meta = readPrivateTaskMeta(this.db, started.run.id)
    if (!meta || meta.assignedBotId !== input.assignedBotId || meta.objective !== input.objective) {
      throw new DaemonError('IDEMPOTENCY_CONFLICT', 'Delegation operation already belongs to a different or interrupted task', { statusCode: 409 })
    }

    if (started.created) {
      void this.teams
        .executeTeamRunToCompletion(started.run.id)
        .finally(() => {
          this.publishTerminalSummaryIfNeeded(started.run.id)
        })
        .catch(() => {
          // The durable task and its summary are reconciled after interruption.
        })
    }

    return this.list({ teamId: team.id }).tasks.find((task) => task.teamRunId === meta.teamRunId)!
  }

  list(filter?: ListPrivateTasksInput): { tasks: PrivateTaskChatRecord[] } {
    const metaRows = this.db.sqlite
      .prepare(`SELECT key FROM settings WHERE key LIKE ?`)
      .all(`${PRIVATE_TASK_META_PREFIX}%`) as Array<{ key: string }>

    const results: PrivateTaskChatRecord[] = []
    for (const row of metaRows) {
      const meta = readPrivateTaskMeta(this.db, row.key.slice(PRIVATE_TASK_META_PREFIX.length))
      if (!meta) continue
      if (filter?.teamId && meta.teamId !== filter.teamId) continue
      if (filter?.botId && meta.assignedBotId !== filter.botId) continue

      const taskRow = this.db.sqlite
        .prepare(
          `SELECT tt.id, tt.status, tt.error_message, tt.updated_at,
                  tr.status AS run_status, t.archived_at AS team_archived_at
           FROM team_tasks tt
           JOIN team_runs tr ON tr.id = tt.team_run_id
           JOIN teams t ON t.id = tr.team_id
           WHERE tt.id = ? AND tt.team_run_id = ?`,
        )
        .get(meta.taskId, meta.teamRunId) as
        | {
            id: string
            status: PrivateTaskChatRecord['status']
            error_message: string | null
            updated_at: string
            run_status: string
            team_archived_at: string | null
          }
        | undefined

      if (!taskRow || taskRow.team_archived_at !== null) continue

      const link = readPrivateTaskExecution(this.db, meta)
      let effectiveStatus = taskRow.status
      if (!link && !TERMINAL_TASK_STATUSES.has(effectiveStatus) && taskRow.run_status === 'uncertain') effectiveStatus = 'uncertain'
      if (link?.status === 'awaiting_approval' && effectiveStatus === 'running') effectiveStatus = 'awaiting_approval'

      if (TERMINAL_TASK_STATUSES.has(effectiveStatus)) {
        this.publishTerminalSummaryIfNeeded(meta.teamRunId)
      }

      results.push({
        taskId: meta.taskId,
        teamRunId: meta.teamRunId,
        teamId: meta.teamId,
        teamName: meta.teamName,
        assignedBotId: meta.assignedBotId,
        objective: meta.objective,
        sessionId: meta.sessionId,
        daemonRunId: link?.daemon_run_id ?? null,
        status: effectiveStatus,
        routing: meta.routing ?? null,
        errorMessage: taskRow.error_message ?? null,
        createdAt: meta.createdAt,
        updatedAt: taskRow.updated_at,
      })
    }

    results.sort((a, b) => (a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : 0))
    return { tasks: results }
  }

  async cancel(input: CancelPrivateTaskInput): Promise<{ teamRunId: string; cancelled: boolean }> {
    const meta = readPrivateTaskMeta(this.db, input.teamRunId)
    if (!meta || meta.teamId !== input.teamId || meta.taskId !== input.taskId) {
      throw new DaemonError('SCOPE_FORBIDDEN', 'Task does not belong to this group', { statusCode: 403 })
    }
    const current = this.list({ teamId: meta.teamId }).tasks.find((task) => task.taskId === meta.taskId)
    if (!current || TERMINAL_TASK_STATUSES.has(current.status)) {
      return { teamRunId: input.teamRunId, cancelled: current?.status === 'cancelled' }
    }
    const res = await this.teams.cancelTeamRun(input.teamRunId)
    this.publishTerminalSummaryIfNeeded(input.teamRunId)
    return {
      teamRunId: input.teamRunId,
      cancelled: res.run.status === 'cancelled' && res.uncertainCount === 0,
    }
  }

  reconcileTerminalSummaries(): number {
    const { tasks } = this.list({})
    let published = 0
    for (const task of tasks) {
      if (TERMINAL_TASK_STATUSES.has(task.status)) {
        if (this.publishTerminalSummaryIfNeeded(task.teamRunId)) {
          published += 1
        }
      }
    }
    return published
  }

  publishTerminalSummaryIfNeeded(teamRunId: string): boolean {
    const meta = readPrivateTaskMeta(this.db, teamRunId)
    if (!meta) return false

    const taskRow = this.db.sqlite
      .prepare(
        `SELECT tt.status, tt.error_message, tr.status AS run_status, t.archived_at AS team_archived_at
         FROM team_tasks tt
         JOIN team_runs tr ON tr.id = tt.team_run_id
         JOIN teams t ON t.id = tr.team_id
         WHERE tt.id = ? AND tt.team_run_id = ?`,
      )
      .get(meta.taskId, meta.teamRunId) as
      | {
          status: PrivateTaskChatRecord['status']
          run_status: string
          error_message: string | null
          team_archived_at: string | null
        }
      | undefined

    if (!taskRow || taskRow.team_archived_at !== null) return false
    if (!TERMINAL_TASK_STATUSES.has(taskRow.status) && taskRow.run_status === 'uncertain') taskRow.status = 'uncertain'
    if (!TERMINAL_TASK_STATUSES.has(taskRow.status)) return false

    // Summary identity includes the canonical terminal status.
    const operationId = deterministicUuid(
      `task-summary:${meta.teamId}:${meta.teamRunId}:${meta.taskId}:${taskRow.status}`,
    )

    const existing = this.db.sqlite
      .prepare(`SELECT id FROM team_discussion_turns WHERE team_id = ? AND operation_id = ?`)
      .get(meta.teamId, operationId) as { id: string } | undefined
    if (existing) return false

    const link = readPrivateTaskExecution(this.db, meta)
    const sessionId = meta.sessionId
    const safeObjective = redactSecrets(meta.objective).slice(0, 300)
    const safeBlocker = taskRow.error_message ? redactSecrets(taskRow.error_message).slice(0, 400) : null

    // Publish bounded, redacted text from this execution only.
    let summaryBody = ''
    if (taskRow.status === 'completed') {
      let assistantText = ''
      if (link?.status === 'completed') {
        const msg = this.db.sqlite.prepare(`
          SELECT CASE WHEN length(content_json) <= 65536 THEN content_json END AS content_json
          FROM messages WHERE session_id = ? AND run_id = ? AND role = 'assistant' AND status = 'complete'
          ORDER BY seq_order DESC LIMIT 1
        `).get(sessionId, link.daemon_run_id) as { content_json: string | null } | undefined
        if (msg?.content_json) {
          try {
            const { text } = JSON.parse(msg.content_json) as { text?: unknown }
            if (typeof text === 'string') assistantText = redactSecrets(text).trim().slice(0, 800)
          } catch {
            // Malformed outputs are omitted.
          }
        }
      }
      summaryBody = assistantText
        ? `Task completed: ${assistantText}`
        : `Task completed (no assistant text output recorded).`
    } else if (taskRow.status === 'cancelled' || taskRow.status === 'stopped_by_parent') {
      summaryBody = `Task ${taskRow.status}${safeBlocker ? `: ${safeBlocker}` : ' by user or parent cancellation.'}`
    } else if (taskRow.status === 'uncertain') {
      summaryBody = `Task outcome uncertain (interrupted or unconfirmed — not auto-replayed)${safeBlocker ? `: ${safeBlocker}` : '.'}`
    } else {
      summaryBody = `Task ${taskRow.status}${safeBlocker ? ` — blocker: ${safeBlocker}` : '.'}`
    }

    const boundedBody = redactSecrets(summaryBody).slice(0, 1200)
    const prompt = `Task Summary: ${safeObjective}`
    const replies = [
      {
        botId: meta.assignedBotId,
        routing: meta.routing,
        revision: randomUUID(),
        text: boundedBody,
        round: 1 as const,
      },
    ]

    const turnId = randomUUID()
    const now = new Date().toISOString()
    const summaryMeta: TaskSummaryMeta = {
      teamRunId: meta.teamRunId,
      taskId: meta.taskId,
      assignedBotId: meta.assignedBotId,
      sessionId,
      status: taskRow.status,
      objective: safeObjective,
      blocker: safeBlocker,
    }

    return this.db.transaction(() => {
      const info = this.db.sqlite
        .prepare(
          `INSERT OR IGNORE INTO team_discussion_turns(id, team_id, operation_id, prompt, replies_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(turnId, meta.teamId, operationId, prompt, JSON.stringify(replies), now)
      if (info.changes === 0) return false

      this.db.sqlite
        .prepare(
          `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        )
        .run(`${TASK_SUMMARY_TURN_PREFIX}${turnId}`, JSON.stringify(summaryMeta), now)
      return true
    })
  }
}
