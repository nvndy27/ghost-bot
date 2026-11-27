import { createHash, randomUUID } from 'node:crypto'
import type {
  DaemonCancellationAck,
  DaemonPolicyRevalidationDecision,
  DaemonPolicyRevalidationRequest,
  DaemonRuntimeSelection,
  DaemonTeamBridgeContract,
  DaemonTeamRunMapping,
  DaemonWorkspaceGrant,
  TeamCancellationResult,
  TeamDispatchContext,
  TeamDispatchOutcome,
  TeamTaskDispatcher,
} from '@ghost-bot/teams'
import type { BotRepository } from '../bots/repository.ts'
import type { DatabaseHandle } from '../db/client.ts'
import { DaemonError, redactSecrets } from '../errors.ts'
import type { OfflineTeamDispatch, RunOrchestrator } from '../execution/orchestrator.ts'
import type { RuntimePolicyBroker } from '../runtime/policy-broker.ts'
import type { TeamMemberRoutingService } from './member-routing.ts'
import type { SessionRepository } from '../sessions/repository.ts'

export interface TeamsExecutionBridgeDeps {
  memberRouting?: TeamMemberRoutingService
  getRuntimeGeneration?: () => number
  dbHandle: DatabaseHandle
  botRepo: BotRepository
  sessionRepo: SessionRepository
  orchestrator: RunOrchestrator
  policyBroker: RuntimePolicyBroker
  getRuntimeState: () => {
    runtimeMode: 'codex' | 'mock'
    codexVersion: string | null
    authMethod: 'chatgpt' | 'apiKey' | 'none'
    accountId: string | null
  }
  /** Optional deterministic poll interval for awaiting RunOrchestrator child runs in tests. */
  pollIntervalMs?: number
}

const PERMISSION_RANK: Record<'read-only' | 'ask-approval' | 'workspace', number> = {
  'read-only': 1,
  'ask-approval': 2,
  workspace: 3,
}

export class TeamsExecutionBridge implements DaemonTeamBridgeContract, TeamTaskDispatcher {
  private readonly deps: TeamsExecutionBridgeDeps
  private readonly inFlightDispatches = new Map<string, { cancelled: boolean; daemonRunId?: string }>()

  constructor(deps: TeamsExecutionBridgeDeps) {
    this.deps = deps
  }

  isMockMode(): boolean {
    return this.deps.getRuntimeState().runtimeMode === 'mock'
  }

  async revalidateWorkerPolicy(
    req: DaemonPolicyRevalidationRequest,
  ): Promise<DaemonPolicyRevalidationDecision> {
    const bot = this.deps.botRepo.getBot(req.assignedBotId)
    if (!bot) {
      return {
        allowed: false,
        reasonCode: 'BOT_NOT_FOUND_OR_ARCHIVED',
        resolvedPermissionMode: 'read-only',
        runtimeId: null,
        accountId: null,
      }
    }

    const botPerm = bot.permission as 'read-only' | 'ask-approval' | 'workspace'
    if (PERMISSION_RANK[req.requestedPermissionMode] > PERMISSION_RANK[botPerm]) {
      return {
        allowed: false,
        reasonCode: 'PERMISSION_ESCALATION_DENIED',
        resolvedPermissionMode: botPerm,
        runtimeId: bot.runtimeId,
        accountId: null,
      }
    }

    const rt = this.deps.getRuntimeState()
    if (rt.runtimeMode !== 'mock') {
      // Live multi-agent Teams execution remains gated until separately verified.
      return {
        allowed: false,
        reasonCode: 'LIVE_TEAMS_GATED',
        resolvedPermissionMode: 'read-only',
        runtimeId: rt.runtimeMode,
        accountId: rt.accountId,
      }
    }

    if (rt.runtimeMode === 'mock') {
      return {
        allowed: true,
        reasonCode: 'OFFLINE_MOCK_ALLOWED',
        resolvedPermissionMode: botPerm,
        runtimeId: 'mock',
        accountId: 'mock-account',
      }
    }

    const decision = this.deps.policyBroker.authorize({
      runtimeMode: rt.runtimeMode,
      codexVersion: rt.codexVersion,
      authMethod: rt.authMethod,
      requestedPermission: req.requestedPermissionMode,
      canonicalWorkspace: bot.workspacePath,
    })

    return {
      allowed: decision.allowed,
      reasonCode: decision.allowed ? 'POLICY_AUTHORIZED' : 'POLICY_DENIED',
      resolvedPermissionMode: req.requestedPermissionMode,
      runtimeId: rt.runtimeMode,
      accountId: rt.accountId,
    }
  }

  async selectRuntimeAndWorkspace(
    ctx: TeamDispatchContext,
  ): Promise<{ runtime: DaemonRuntimeSelection; workspace: DaemonWorkspaceGrant }> {
    const bot = this.deps.botRepo.getBot(ctx.assignedBotId)
    if (!bot) {
      throw new DaemonError('BOT_NOT_FOUND', `Bot "${ctx.assignedBotId}" was not found`, { statusCode: 404 })
    }
    const rt = this.deps.getRuntimeState()
    const routing = await this.deps.memberRouting?.get({ teamId: ctx.teamId, botId: ctx.assignedBotId })
    if (routing && (!routing.supported || !routing.effective.accountId)) {
      throw new DaemonError('TEAM_ROUTING_UNAVAILABLE', 'The team member configuration is unavailable', { statusCode: 409 })
    }
    return {
      runtime: {
        botId: bot.id,
        providerId: routing?.effective.runtimeId ?? rt.runtimeMode,
        accountId: routing?.effective.accountId ?? rt.accountId ?? 'unauthenticated',
        modelId: routing?.effective.modelId ?? bot.modelId,
        runtimeVersion: rt.codexVersion ?? rt.runtimeMode,
      },
      workspace: {
        botId: bot.id,
        canonicalWorkspacePath: bot.workspacePath,
        readOnly: bot.permission === 'read-only',
        explicitSharedPaths: [],
      },
    }
  }

  async requestCancellation(mapping: DaemonTeamRunMapping): Promise<DaemonCancellationAck> {
    const res = this.deps.orchestrator.cancelRun(mapping.daemonRunId)
    const confirmed =
      res.run.status === 'cancelled' ||
      res.run.status === 'completed' ||
      res.run.status === 'failed'
    return {
      teamRunId: mapping.teamRunId,
      taskId: mapping.taskId,
      daemonRunId: mapping.daemonRunId,
      confirmedStopped: confirmed,
      reason: confirmed ? null : `Run is in "${res.run.status}" awaiting runtime stop confirmation`,
    }
  }

  private getOrCreateTeamSessionId(teamRunId: string | null, agentId: string): string {
    const title = teamRunId ? `team:${teamRunId}:${agentId}` : `team:standalone:${agentId}`
    const existing = this.deps.dbHandle.sqlite
      .prepare(
        `SELECT id FROM sessions
         WHERE agent_id = ? AND title = ? AND archived_at IS NULL
         LIMIT 1`,
      )
      .get(agentId, title) as { id: string } | undefined
    if (existing) return existing.id

    const created = this.deps.sessionRepo.createSession({ agentId, title })
    return created.id
  }

  async dispatch(ctx: TeamDispatchContext): Promise<TeamDispatchOutcome> {
    // Revalidate team membership & non-archived status immediately before dispatch
    const teamRow = this.deps.dbHandle.sqlite
      .prepare(`SELECT member_bot_ids_json, archived_at FROM teams WHERE id = ?`)
      .get(ctx.teamId) as { member_bot_ids_json: string; archived_at: string | null } | undefined
    if (!teamRow || teamRow.archived_at !== null) {
      return {
        status: 'failed',
        code: 'TEAM_NOT_ACTIVE',
        message: 'Team is missing or archived',
        retryable: false,
      }
    }
    const members = JSON.parse(teamRow.member_bot_ids_json) as string[]
    if (!members.includes(ctx.assignedBotId)) {
      return {
        status: 'failed',
        code: 'MEMBER_REMOVED',
        message: `Bot "${ctx.assignedBotId}" is no longer a member of team`,
        retryable: false,
      }
    }

    const bot = this.deps.botRepo.getBot(ctx.assignedBotId)
    if (!bot) {
      return {
        status: 'failed',
        code: 'BOT_NOT_FOUND',
        message: `Bot "${ctx.assignedBotId}" not found or archived`,
        retryable: false,
      }
    }
    const requestedPerm = bot.permission as 'read-only' | 'ask-approval' | 'workspace'
    const policy = await this.revalidateWorkerPolicy({
      teamId: ctx.teamId,
      teamRunId: ctx.teamRunId,
      taskId: ctx.taskId,
      ownerId: ctx.ownerId,
      assignedBotId: ctx.assignedBotId,
      requestedPermissionMode: requestedPerm,
      requirePolicyRevalidation: true,
      noPermissionEscalation: true,
      reusePriorApprovals: false,
    })

    if (!policy.allowed) {
      return {
        status: 'failed',
        code: policy.reasonCode,
        message: `Policy broker denied worker "${ctx.assignedBotId}" (${policy.reasonCode})`,
        retryable: false,
      }
    }

    const memberRouting = this.deps.memberRouting
    let routing: OfflineTeamDispatch | undefined
    if (memberRouting) {
      const key = { teamId: ctx.teamId, botId: ctx.assignedBotId }
      const generation = this.deps.getRuntimeGeneration?.()
      const resolved = await memberRouting.get(key)
      const { effective, revision } = resolved
      if (!resolved.supported || (effective.runtimeId !== 'mock-offline' && effective.runtimeId !== 'mock') || !effective.accountId ||
          this.deps.getRuntimeState().runtimeMode !== 'mock') {
        return { status: 'failed', code: 'TEAM_ROUTING_UNAVAILABLE', message: 'The selected member configuration cannot execute in this runtime', retryable: false }
      }
      const identity = createHash('sha256').update(JSON.stringify([ctx.teamId, ctx.teamRunId, ctx.assignedBotId, effective, revision])).digest('hex')
      routing = {
        ...effective, runtimeId: effective.runtimeId, accountId: effective.accountId,
        teamId: ctx.teamId, teamRunId: ctx.teamRunId, botId: ctx.assignedBotId, revision, identity,
        revalidate: () => {
          if (this.deps.getRuntimeGeneration?.() !== generation) {
            throw new DaemonError('TEAM_ROUTING_CHANGED', 'Runtime generation changed before dispatch', { statusCode: 409 })
          }
          memberRouting.revalidate(key, resolved)
        },
      }
    }
    const sessionId = routing
      ? this.deps.sessionRepo.getOrCreateTeamSession({
        identity: routing.identity, agentId: routing.botId, runtimeId: routing.runtimeId, accountId: routing.accountId,
      })
      : this.getOrCreateTeamSessionId(ctx.teamRunId, ctx.assignedBotId)
    const startMs = Date.now()
    const flightKey = `${ctx.taskId}:${ctx.attempt}`
    const isParentCancelling = () => {
      const tr = this.deps.dbHandle.sqlite
        .prepare(`SELECT status FROM team_runs WHERE id = ?`)
        .get(ctx.teamRunId) as { status: string } | undefined
      return Boolean(tr && (tr.status === 'cancelling' || tr.status === 'cancelled'))
    }

    if (isParentCancelling()) {
      return {
        status: 'failed',
        code: 'TEAM_RUN_CANCELLED',
        message: 'Team run is cancelling or cancelled before dispatch',
        retryable: false,
      }
    }

    const flightState: { cancelled: boolean; daemonRunId?: string } = { cancelled: false }
    this.inFlightDispatches.set(flightKey, flightState)

    try {
      const { run } = await this.deps.orchestrator.startRun({
        sessionId,
        text: ctx.prompt,
        idempotencyKey: `team:${ctx.taskId}:attempt:${ctx.attempt}`,
      }, routing)
      flightState.daemonRunId = run.id

      const rt = this.deps.getRuntimeState()
      this.deps.dbHandle.sqlite
        .prepare(
          `INSERT OR IGNORE INTO team_execution_links (
            id, team_run_id, team_task_id, agent_id, session_id, daemon_run_id,
            runtime_id, account_id, attempt, role, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'worker', ?)`,
        )
        .run(
          `texec_${randomUUID()}`,
          ctx.teamRunId,
          ctx.taskId,
          ctx.assignedBotId,
          sessionId,
          run.id,
          routing?.runtimeId ?? rt.runtimeMode,
          routing?.accountId ?? rt.accountId ?? 'local',
          ctx.attempt,
          new Date().toISOString(),
        )

      if (flightState.cancelled || isParentCancelling()) {
        this.deps.orchestrator.cancelRun(run.id)
        return {
          status: 'failed',
          code: 'TEAM_RUN_CANCELLED',
          message: 'Team run was cancelled during child run creation',
          retryable: false,
          durationMs: Math.max(1, Date.now() - startMs),
        }
      }

      // Await child run completion up to remainingDurationMs
      const deadline = startMs + Math.max(500, ctx.remainingDurationMs)
      const pollMs = this.deps.pollIntervalMs ?? 20
      while (Date.now() < deadline) {
        const latest = this.deps.orchestrator.getRun(run.id)
        if (latest.status === 'completed') {
          const msgRow = this.deps.dbHandle.sqlite
            .prepare(
              `SELECT content_json FROM messages
               WHERE run_id = ? AND role = 'assistant'
               LIMIT 1`,
            )
            .get(run.id) as { content_json: string } | undefined
          let outputText = `Completed run ${run.id}`
          if (msgRow?.content_json) {
            try {
              const parsed = JSON.parse(msgRow.content_json) as { text?: string }
              if (typeof parsed.text === 'string' && parsed.text.length > 0) {
                outputText = parsed.text
              }
            } catch {
              // ignore malformed content_json
            }
          }
          return {
            status: 'completed',
            durationMs: Math.max(1, Date.now() - startMs),
            outputText,
          }
        }
        if (latest.status === 'awaiting_approval') {
          if (flightState.cancelled || isParentCancelling()) {
            this.deps.orchestrator.cancelRun(run.id)
            return {
              status: 'failed',
              code: 'TEAM_RUN_CANCELLED',
              message: 'Team run was cancelled while awaiting worker approval',
              retryable: false,
              durationMs: Math.max(1, Date.now() - startMs),
            }
          }
          // Wait for user approval resolution or cancellation up to deadline
          await new Promise((r) => setTimeout(r, pollMs))
          continue
        }
        if (latest.status === 'failed' || latest.status === 'cancelled') {
          return {
            status: 'failed',
            code: latest.error?.code ?? 'RUN_FAILED',
            message: redactSecrets(latest.error?.message ?? `Child run ${latest.status}`),
            retryable: false,
            durationMs: Math.max(1, Date.now() - startMs),
          }
        }
        await new Promise((r) => setTimeout(r, pollMs))
      }

      // Request cancellation on timeout and preserve uncertain outcome
      this.deps.orchestrator.cancelRun(run.id)
      return {
        status: 'uncertain',
        code: 'DISPATCH_TIMEOUT',
        message: 'Child daemon run exceeded remaining duration budget; cancellation requested',
        durationMs: Math.max(1, Date.now() - startMs),
      }
    } catch (err) {
      const msg = err instanceof DaemonError ? err.message : err instanceof Error ? err.message : 'Dispatch error'
      return {
        status: 'uncertain',
        code: err instanceof DaemonError ? err.code : 'DISPATCH_UNCERTAIN',
        message: redactSecrets(msg),
        durationMs: Math.max(1, Date.now() - startMs),
      }
    } finally {
      this.inFlightDispatches.delete(flightKey)
    }
  }

  async cancelExecution(ctx: {
    teamId: string
    teamRunId: string | null
    taskId: string
    attempt: number
  }): Promise<TeamCancellationResult> {
    const flightKey = `${ctx.taskId}:${ctx.attempt}`
    const inFlight = this.inFlightDispatches.get(flightKey)
    if (inFlight) {
      inFlight.cancelled = true
      if (inFlight.daemonRunId) {
        const ack = await this.requestCancellation({
          teamRunId: ctx.teamRunId ?? '',
          taskId: ctx.taskId,
          daemonRunId: inFlight.daemonRunId,
          providerSessionId: null,
        })
        return { confirmed: ack.confirmedStopped, reason: ack.reason ?? undefined }
      }
      return {
        confirmed: false,
        reason: 'Child run creation in flight; cancellation requested but not yet confirmed',
      }
    }

    const link = this.deps.dbHandle.sqlite
      .prepare(
        `SELECT daemon_run_id FROM team_execution_links
         WHERE team_task_id = ? AND attempt = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(ctx.taskId, ctx.attempt) as { daemon_run_id: string } | undefined
    if (!link) {
      const taskRow = this.deps.dbHandle.sqlite
        .prepare(`SELECT status FROM team_tasks WHERE id = ?`)
        .get(ctx.taskId) as { status: string } | undefined
      if (taskRow && (taskRow.status === 'running' || taskRow.status === 'cancelling')) {
        return {
          confirmed: false,
          reason: 'Active task has no execution link; cancellation unconfirmed',
        }
      }
      return { confirmed: true }
    }
    const ack = await this.requestCancellation({
      teamRunId: ctx.teamRunId ?? '',
      taskId: ctx.taskId,
      daemonRunId: link.daemon_run_id,
      providerSessionId: null,
    })
    return { confirmed: ack.confirmedStopped, reason: ack.reason ?? undefined }
  }
}
