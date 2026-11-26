import {
  assertNonEmptyBounded,
  assertTeamOwner,
  createBorrowedTeamDatabaseHandle,
  DelegationEngine,
  previewTeamPlan,
  TeamCoordinator,
  TeamDiagnosticsService,
  TeamError,
  TeamRepository,
  validateBounds,
  type TeamExecutionBounds,
  type TeamMessageRecord,
  type TeamPlanPreview,
  type TeamRecord,
  type TeamResultSynthesizer,
  type TeamRunAggregateResult,
  type TeamRunDiagnosticsReport,
  type TeamRunRecord,
  type TeamTaskPlan,
  type TeamTaskPlanner,
  type TeamTaskRecord,
} from '@ghost-bot/teams'
import type { BotRepository } from '../bots/repository.ts'
import type { DatabaseHandle } from '../db/client.ts'
import { DaemonError } from '../errors.ts'
import { LOCAL_USER_ID } from '../memory/service.ts'
import type { TeamsExecutionBridge } from './execution-bridge.ts'

function mapTeamError(err: unknown): never {
  if (err instanceof DaemonError) throw err
  if (err instanceof TeamError) {
    const status =
      err.code === 'TEAM_NOT_FOUND' || err.code === 'TEAM_RUN_NOT_FOUND' || err.code === 'TASK_NOT_FOUND'
        ? 404
        : err.code === 'SCOPE_FORBIDDEN'
          ? 403
          : err.code === 'IDEMPOTENCY_CONFLICT'
            ? 409
            : 400
    throw new DaemonError(err.code, err.message, { statusCode: status })
  }
  throw err
}

export class TeamsService {
  private readonly dbHandle: DatabaseHandle
  private readonly botRepo: BotRepository
  private readonly repository: TeamRepository
  private readonly engine: DelegationEngine
  private readonly coordinator: TeamCoordinator
  private readonly diagnostics: TeamDiagnosticsService
  private readonly bridge: TeamsExecutionBridge
  private readonly activeRunExecutions = new Set<string>()

  constructor(
    dbHandle: DatabaseHandle,
    botRepo: BotRepository,
    bridge: TeamsExecutionBridge,
  ) {
    this.dbHandle = dbHandle
    this.botRepo = botRepo
    this.bridge = bridge
    const borrowed = createBorrowedTeamDatabaseHandle(
      dbHandle.sqlite,
      dbHandle.transaction.bind(dbHandle),
      dbHandle.dbPath,
    )
    this.repository = new TeamRepository(borrowed)
    this.engine = new DelegationEngine(this.repository)
    this.coordinator = new TeamCoordinator(this.repository, this.engine)
    this.diagnostics = new TeamDiagnosticsService(this.repository, this.engine, this.coordinator)
  }

  private assertValidBots(leadBotId: string, memberBotIds: string[]): void {
    const allIds = new Set([leadBotId, ...memberBotIds])
    for (const botId of allIds) {
      const bot = this.botRepo.getBot(botId)
      if (!bot) {
        throw new DaemonError('BOT_NOT_FOUND', `Bot "${botId}" was not found or is archived`, { statusCode: 404 })
      }
    }
  }

  private syncPhase1cTeamMembers(teamId: string, leadBotId: string, memberBotIds: string[]): void {
    this.dbHandle.sqlite
      .prepare(`UPDATE teams SET leader_agent_id = ? WHERE id = ?`)
      .run(leadBotId, teamId)
    this.dbHandle.sqlite.prepare(`DELETE FROM team_members WHERE team_id = ?`).run(teamId)
    const insert = this.dbHandle.sqlite.prepare(
      `INSERT INTO team_members (team_id, agent_id, role) VALUES (?, ?, ?)`,
    )
    for (const botId of memberBotIds) {
      insert.run(teamId, botId, botId === leadBotId ? 'lead' : 'member')
    }
  }

  listTeams(options?: { limit?: number; offset?: number; includeArchived?: boolean }): {
    teams: TeamRecord[]
    total: number
  } {
    try {
      return this.repository.listTeams(LOCAL_USER_ID, options)
    } catch (err) {
      mapTeamError(err)
    }
  }

  getTeam(teamId: string): TeamRecord {
    try {
      return this.repository.getTeam(teamId, LOCAL_USER_ID)
    } catch (err) {
      mapTeamError(err)
    }
  }

  createTeam(input: {
    name: string
    description?: string
    leadBotId: string
    memberBotIds: string[]
    bounds?: Partial<TeamExecutionBounds>
  }): TeamRecord {
    try {
      this.assertValidBots(input.leadBotId, input.memberBotIds)
      return this.repository.getDatabase().transaction(() => {
        const team = this.repository.createTeam({
          ...input,
          ownerId: LOCAL_USER_ID,
        })
        this.syncPhase1cTeamMembers(team.id, team.leadBotId, team.memberBotIds)
        return team
      })
    } catch (err) {
      mapTeamError(err)
    }
  }

  updateTeam(input: {
    teamId: string
    name?: string
    description?: string
    leadBotId?: string
    memberBotIds?: string[]
    bounds?: Partial<TeamExecutionBounds>
  }): TeamRecord {
    try {
      const existing = this.repository.getTeam(input.teamId, LOCAL_USER_ID)
      assertTeamOwner(LOCAL_USER_ID, existing.ownerId)
      if (existing.archivedAt !== null) {
        throw new DaemonError('TEAM_ARCHIVED', 'Cannot update an archived team', { statusCode: 409 })
      }
      const nextLead = input.leadBotId ?? existing.leadBotId
      const nextMembers = new Set<string>([nextLead, ...(input.memberBotIds ?? existing.memberBotIds)])
      this.assertValidBots(nextLead, [...nextMembers])

      const nextName =
        input.name !== undefined ? assertNonEmptyBounded(input.name, 'name', 120) : existing.name
      const nextDescription =
        input.description !== undefined ? input.description.trim().slice(0, 1000) : existing.description
      const nextBounds = input.bounds
        ? validateBounds({ ...existing.bounds, ...input.bounds })
        : existing.bounds
      const nowIso = new Date().toISOString()

      return this.repository.getDatabase().transaction(() => {
        this.dbHandle.sqlite
          .prepare(
            `UPDATE teams
             SET name = ?, description = ?, lead_bot_id = ?, member_bot_ids_json = ?,
                 bounds_json = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            nextName,
            nextDescription,
            nextLead,
            JSON.stringify([...nextMembers]),
            JSON.stringify(nextBounds),
            nowIso,
            existing.id,
          )
        this.syncPhase1cTeamMembers(existing.id, nextLead, [...nextMembers])
        return this.repository.getTeam(existing.id, LOCAL_USER_ID)
      })
    } catch (err) {
      mapTeamError(err)
    }
  }

  updateTeamMembers(teamId: string, memberBotIds: string[]): TeamRecord {
    try {
      const existing = this.repository.getTeam(teamId, LOCAL_USER_ID)
      this.assertValidBots(existing.leadBotId, memberBotIds)
      return this.repository.getDatabase().transaction(() => {
        const updated = this.repository.updateTeamMembers(teamId, LOCAL_USER_ID, memberBotIds)
        this.syncPhase1cTeamMembers(updated.id, updated.leadBotId, updated.memberBotIds)
        return updated
      })
    } catch (err) {
      mapTeamError(err)
    }
  }

  archiveTeam(teamId: string): TeamRecord {
    try {
      return this.repository.archiveTeam(teamId, LOCAL_USER_ID)
    } catch (err) {
      mapTeamError(err)
    }
  }

  previewPlan(teamId: string, plan: TeamTaskPlan): TeamPlanPreview {
    try {
      const team = this.repository.getTeam(teamId, LOCAL_USER_ID)
      return previewTeamPlan(team, plan)
    } catch (err) {
      mapTeamError(err)
    }
  }

  async startTeamRun(input: {
    teamId: string
    goal: string
    idempotencyKey: string
    plan?: TeamTaskPlan
    planner?: TeamTaskPlanner
    autoExecute?: boolean
  }): Promise<{ run: TeamRunRecord; tasks: TeamTaskRecord[]; created: boolean }> {
    try {
      const team = this.repository.getTeam(input.teamId, LOCAL_USER_ID)
      const leadPolicy = await this.bridge.revalidateWorkerPolicy({
        teamId: team.id,
        teamRunId: null,
        taskId: 'planner-preflight',
        ownerId: LOCAL_USER_ID,
        assignedBotId: team.leadBotId,
        requestedPermissionMode: 'read-only',
        requirePolicyRevalidation: true,
        noPermissionEscalation: true,
        reusePriorApprovals: false,
      })
      if (!leadPolicy.allowed) {
        throw new DaemonError(
          leadPolicy.reasonCode,
          `Chief of Staff policy check failed (${leadPolicy.reasonCode})`,
          { statusCode: 403 },
        )
      }

      const planner: TeamTaskPlanner =
        input.planner ??
        ({
          async plan() {
            if (input.plan) return input.plan
            return {
              summary: input.goal,
              tasks: [
                {
                  planKey: 'lead_task',
                  assignedBotId: team.leadBotId,
                  prompt: input.goal,
                },
              ],
            }
          },
        })
      const result = await this.coordinator.startTeamRun({
        teamId: team.id,
        ownerId: LOCAL_USER_ID,
        goal: input.goal,
        idempotencyKey: input.idempotencyKey,
        planner,
      })
      if (input.autoExecute && result.created) {
        void this.executeTeamRunToCompletion(result.run.id).catch(() => {})
      }
      return result
    } catch (err) {
      mapTeamError(err)
    }
  }

  async executeTeamRunToCompletion(
    teamRunId: string,
    synthesizer?: TeamResultSynthesizer,
  ): Promise<TeamRunAggregateResult> {
    if (this.activeRunExecutions.has(teamRunId)) {
      return this.getAggregateUsage(teamRunId)
    }
    this.activeRunExecutions.add(teamRunId)
    try {
      const agg = await this.coordinator.runTeamRunToCompletion(
        teamRunId,
        LOCAL_USER_ID,
        this.bridge,
      )
      if (synthesizer && agg.synthesisInputReady && agg.status !== 'cancelled' && agg.status !== 'uncertain') {
        const res = await this.coordinator.synthesizeFinalResponse(
          teamRunId,
          LOCAL_USER_ID,
          synthesizer,
        )
        return res.aggregate
      }
      return agg
    } catch (err) {
      mapTeamError(err)
    } finally {
      this.activeRunExecutions.delete(teamRunId)
    }
  }

  listRunsForTeam(teamId: string, limit = 20): Array<{
    id: string
    teamId: string
    goal: string
    status: string
    createdAt: string
    endedAt: string | null
  }> {
    this.repository.getTeam(teamId, LOCAL_USER_ID)
    const bounded = Math.min(Math.max(1, limit), 50)
    const rows = this.dbHandle.sqlite
      .prepare(
        `SELECT id, team_id, goal, status, created_at, ended_at
         FROM team_runs
         WHERE team_id = ? AND owner_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(teamId, LOCAL_USER_ID, bounded) as Array<{
      id: string
      team_id: string
      goal: string
      status: string
      created_at: string
      ended_at: string | null
    }>
    return rows.map((r) => ({
      id: r.id,
      teamId: r.team_id,
      goal: r.goal,
      status: r.status,
      createdAt: r.created_at,
      endedAt: r.ended_at,
    }))
  }

  listPendingApprovalsForRun(teamRunId: string): Array<{
    approvalId: string
    daemonRunId: string
    teamTaskId: string
    workerBotId: string
    title: string
    command: string
    permissionMode: string
    status: string
    expiresAt: string
  }> {
    this.coordinator.getTeamRun(teamRunId, LOCAL_USER_ID)
    const rows = this.dbHandle.sqlite
      .prepare(
        `SELECT a.id AS approval_id, a.run_id AS daemon_run_id, l.team_task_id,
                l.agent_id AS worker_bot_id, a.action_type AS title, a.action_summary AS command,
                a.permission_mode, a.status, a.expires_at
         FROM team_execution_links l
         JOIN approvals a ON a.run_id = l.daemon_run_id
         WHERE l.team_run_id = ? AND a.status = 'pending'
         ORDER BY a.created_at ASC`,
      )
      .all(teamRunId) as Array<{
      approval_id: string
      daemon_run_id: string
      team_task_id: string
      worker_bot_id: string
      title: string
      command: string
      permission_mode: string
      status: string
      expires_at: string
    }>
    return rows.map((r) => ({
      approvalId: r.approval_id,
      daemonRunId: r.daemon_run_id,
      teamTaskId: r.team_task_id,
      workerBotId: r.worker_bot_id,
      title: r.title,
      command: r.command,
      permissionMode: r.permission_mode,
      status: r.status,
      expiresAt: r.expires_at,
    }))
  }

  getTeamRun(teamRunId: string): TeamRunRecord {
    try {
      return this.coordinator.getTeamRun(teamRunId, LOCAL_USER_ID)
    } catch (err) {
      mapTeamError(err)
    }
  }

  listRunTasks(teamRunId: string): TeamTaskRecord[] {
    try {
      return this.coordinator.listRunTasks(teamRunId, LOCAL_USER_ID)
    } catch (err) {
      mapTeamError(err)
    }
  }

  async cancelTeamRun(teamRunId: string) {
    try {
      return await this.coordinator.cancelTeamRun(teamRunId, LOCAL_USER_ID, this.bridge)
    } catch (err) {
      mapTeamError(err)
    }
  }

  getDiagnostics(teamRunId: string): TeamRunDiagnosticsReport {
    try {
      return this.diagnostics.inspectTeamRun(teamRunId, LOCAL_USER_ID)
    } catch (err) {
      mapTeamError(err)
    }
  }

  getAggregateUsage(teamRunId: string): TeamRunAggregateResult {
    try {
      return this.coordinator.collectAggregateResult(teamRunId, LOCAL_USER_ID)
    } catch (err) {
      mapTeamError(err)
    }
  }

  listMessages(
    teamId: string,
    options?: { limit?: number; afterSeq?: number; teamRunId?: string; viewerBotId?: string },
  ): TeamMessageRecord[] {
    try {
      return this.repository.listMessages(teamId, LOCAL_USER_ID, options)
    } catch (err) {
      mapTeamError(err)
    }
  }

  reconcileOnStartup(): { tasksMarkedUncertain: number; runsMarkedUncertain: number } {
    return this.coordinator.reconcileOnRestart()
  }
}
