import {
  createBorrowedTeamDatabaseHandle,
  DelegationEngine,
  previewTeamPlan,
  TeamCoordinator,
  TeamDiagnosticsService,
  TeamError,
  TeamRepository,
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
  }): Promise<{ run: TeamRunRecord; tasks: TeamTaskRecord[]; created: boolean }> {
    try {
      const team = this.repository.getTeam(input.teamId, LOCAL_USER_ID)
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
      return await this.coordinator.startTeamRun({
        teamId: team.id,
        ownerId: LOCAL_USER_ID,
        goal: input.goal,
        idempotencyKey: input.idempotencyKey,
        planner,
      })
    } catch (err) {
      mapTeamError(err)
    }
  }

  async executeTeamRunToCompletion(
    teamRunId: string,
    synthesizer?: TeamResultSynthesizer,
  ): Promise<TeamRunAggregateResult> {
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
    }
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
