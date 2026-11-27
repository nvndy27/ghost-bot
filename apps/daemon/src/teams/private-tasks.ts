import { createHash } from 'node:crypto'
import type {
  CancelPrivateTaskInput,
  DelegateTeamTaskInput,
  ListPrivateTasksInput,
  PrivateTaskChatRecord,
  TeamMemberRoutingTuple,
} from '@ghost-bot/shared-types/ipc'
import type { DatabaseHandle } from '../db/client.ts'
import { DaemonError } from '../errors.ts'
import type { SessionRepository } from '../sessions/repository.ts'
import type { TeamMemberRoutingService } from './member-routing.ts'
import type { TeamsService } from './service.ts'

const PRIVATE_TASK_META_PREFIX = 'teams.private-task-meta:'

interface StoredTaskMeta {
  teamId: string
  teamName: string
  teamRunId: string
  taskId: string
  assignedBotId: string
  objective: string
  sessionId: string
  routing: TeamMemberRoutingTuple
  createdAt: string
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
      const metaRow = this.db.sqlite
        .prepare(`SELECT value_json FROM settings WHERE key = ?`)
        .get(`${PRIVATE_TASK_META_PREFIX}${existingRun.id}`) as { value_json: string } | undefined
      const meta = metaRow ? (JSON.parse(metaRow.value_json) as StoredTaskMeta) : null
      if (!meta || meta.objective !== input.objective || meta.assignedBotId !== input.assignedBotId) {
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
    })

    const task = started.tasks[0]
    if (!task) {
      throw new DaemonError('DELEGATION_FAILED', 'Failed to create delegated task', { statusCode: 500 })
    }

    const identity = createHash('sha256')
      .update(
        JSON.stringify([
          team.id,
          started.run.id,
          input.assignedBotId,
          memberChoice.effective,
          memberChoice.revision,
        ]),
      )
      .digest('hex')

    const sessionId = this.sessions.getOrCreateTeamSession({
      identity,
      agentId: input.assignedBotId,
      runtimeId: memberChoice.effective.runtimeId,
      accountId: memberChoice.effective.accountId,
    })

    const now = new Date().toISOString()
    const meta: StoredTaskMeta = {
      teamId: team.id,
      teamName: team.name,
      teamRunId: started.run.id,
      taskId: task.id,
      assignedBotId: input.assignedBotId,
      objective: input.objective,
      sessionId,
      routing: memberChoice.effective,
      createdAt: started.run.createdAt,
    }
    this.db.sqlite
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(`${PRIVATE_TASK_META_PREFIX}${started.run.id}`, JSON.stringify(meta), now)

    if (started.created) {
      void this.teams.executeTeamRunToCompletion(started.run.id).catch(() => {})
    }

    return {
      taskId: task.id,
      teamRunId: started.run.id,
      teamId: team.id,
      teamName: team.name,
      assignedBotId: input.assignedBotId,
      objective: input.objective,
      sessionId,
      daemonRunId: null,
      status: task.status,
      routing: memberChoice.effective,
      errorMessage: task.errorMessage,
      createdAt: started.run.createdAt,
      updatedAt: started.run.updatedAt,
    }
  }

  list(filter?: ListPrivateTasksInput): { tasks: PrivateTaskChatRecord[] } {
    const metaRows = this.db.sqlite
      .prepare(`SELECT key, value_json FROM settings WHERE key LIKE ?`)
      .all(`${PRIVATE_TASK_META_PREFIX}%`) as Array<{ key: string; value_json: string }>

    const results: PrivateTaskChatRecord[] = []
    for (const row of metaRows) {
      let meta: StoredTaskMeta | null = null
      try {
        meta = JSON.parse(row.value_json) as StoredTaskMeta
      } catch {
        continue
      }
      if (!meta || !meta.teamRunId) continue
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

      const linkRow = this.db.sqlite
        .prepare(
          `SELECT session_id, daemon_run_id FROM team_execution_links
           WHERE team_task_id = ? ORDER BY attempt DESC, created_at DESC LIMIT 1`,
        )
        .get(meta.taskId) as { session_id: string; daemon_run_id: string } | undefined

      let effectiveStatus = taskRow.status
      let daemonRunId: string | null = linkRow?.daemon_run_id ?? null
      if (daemonRunId) {
        const runRow = this.db.sqlite
          .prepare(`SELECT status FROM runs WHERE id = ?`)
          .get(daemonRunId) as { status: string } | undefined
        if (runRow?.status === 'awaiting_approval' && effectiveStatus === 'running') {
          effectiveStatus = 'awaiting_approval'
        }
      } else {
        daemonRunId = null
      }

      results.push({
        taskId: meta.taskId,
        teamRunId: meta.teamRunId,
        teamId: meta.teamId,
        teamName: meta.teamName,
        assignedBotId: meta.assignedBotId,
        objective: meta.objective,
        sessionId: linkRow?.session_id ?? meta.sessionId ?? null,
        daemonRunId,
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
    const run = this.teams.getTeamRun(input.teamRunId)
    if (run.teamId !== input.teamId) {
      throw new DaemonError('SCOPE_FORBIDDEN', 'Task does not belong to this group', { statusCode: 403 })
    }
    const res = await this.teams.cancelTeamRun(input.teamRunId)
    return {
      teamRunId: input.teamRunId,
      cancelled: res.run.status === 'cancelled' || res.run.status === 'uncertain',
    }
  }
}
