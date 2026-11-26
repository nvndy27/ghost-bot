import { randomUUID } from 'node:crypto'
import type {
  FutureDispatchOutcome,
  FutureExecutionAuthorizationContext,
  FutureRoutineDispatcher,
  RoutineScope,
} from '@ghost-bot/scheduler/contracts'
import type { RoutineApprovalCoordinator } from '@ghost-bot/scheduler/approvals'
import type { BotRepository } from '../bots/repository.ts'
import type { DatabaseHandle } from '../db/client.ts'
import { DaemonError, redactSecrets } from '../errors.ts'
import type { RunOrchestrator } from '../execution/orchestrator.ts'
import type { RuntimePolicyBroker } from '../runtime/policy-broker.ts'
import type { SessionRepository } from '../sessions/repository.ts'
import type { TeamsService } from '../teams/service.ts'

export interface DaemonRoutineDispatcherDeps {
  dbHandle: DatabaseHandle
  botRepo: BotRepository
  sessionRepo: SessionRepository
  orchestrator: RunOrchestrator
  policyBroker: RuntimePolicyBroker
  teamsService: TeamsService
  approvalCoordinator: RoutineApprovalCoordinator
  getRuntimeState: () => {
    runtimeMode: 'codex' | 'mock'
    codexVersion: string | null
    authMethod: 'chatgpt' | 'apiKey' | 'none'
    accountId: string | null
  }
  pollIntervalMs?: number
  dispatchTimeoutMs?: number
}

export class DaemonRoutineDispatcher implements FutureRoutineDispatcher {
  private readonly deps: DaemonRoutineDispatcherDeps

  constructor(deps: DaemonRoutineDispatcherDeps) {
    this.deps = deps
  }

  private getOrCreateRoutineSessionId(routineId: string, botId: string): string {
    const title = `routine:${routineId}:${botId}`
    const existing = this.deps.dbHandle.sqlite
      .prepare(
        `SELECT id FROM sessions
         WHERE agent_id = ? AND title = ? AND archived_at IS NULL
         LIMIT 1`,
      )
      .get(botId, title) as { id: string } | undefined
    if (existing) return existing.id
    return this.deps.sessionRepo.createSession({ agentId: botId, title }).id
  }

  async dispatch(ctx: FutureExecutionAuthorizationContext): Promise<FutureDispatchOutcome> {
    if (ctx.requirePolicyRevalidation !== true || ctx.reusePriorApprovals !== false) {
      return {
        status: 'failed',
        code: 'INVALID_AUTHORIZATION_CONTEXT',
        message: 'Routine dispatch requires policy revalidation and forbids approval reuse',
      }
    }

    const routineRow = this.deps.dbHandle.sqlite
      .prepare(
        `SELECT id, owner_id, bot_id, target_type, team_id, enabled, archived_at,
                ownership, revision, expires_at
         FROM scheduler_routines WHERE id = ?`,
      )
      .get(ctx.routineId) as
      | {
          id: string
          owner_id: string
          bot_id: string
          target_type: 'bot' | 'team'
          team_id: string | null
          enabled: number
          archived_at: string | null
          ownership: string
          revision: number
          expires_at: string | null
        }
      | undefined

    if (!routineRow) {
      return { status: 'failed', code: 'ROUTINE_NOT_FOUND', message: 'Routine no longer exists' }
    }
    if (routineRow.owner_id !== ctx.ownerId) {
      return { status: 'failed', code: 'SCOPE_FORBIDDEN', message: 'Routine owner mismatch' }
    }
    if (routineRow.ownership !== 'ghost-bot') {
      return {
        status: 'failed',
        code: 'EXTERNAL_ROUTINE_OWNERSHIP',
        message: `Externally owned routine (${routineRow.ownership}) cannot dispatch`,
      }
    }
    if (routineRow.enabled !== 1 || routineRow.archived_at !== null) {
      return {
        status: 'failed',
        code: 'ROUTINE_UNAVAILABLE',
        message: 'Routine was disabled or archived before dispatch',
      }
    }
    if (routineRow.revision !== ctx.routineRevision) {
      return {
        status: 'failed',
        code: 'STALE_ROUTINE_REVISION',
        message: 'Routine revision changed before dispatch',
      }
    }
    if (routineRow.expires_at !== null && Date.now() >= Date.parse(routineRow.expires_at)) {
      return { status: 'failed', code: 'ROUTINE_EXPIRED', message: 'Routine has expired' }
    }

    const taskRow = this.deps.dbHandle.sqlite
      .prepare(`SELECT id, status, attempt FROM scheduler_tasks WHERE id = ?`)
      .get(ctx.taskId) as { id: string; status: string; attempt: number } | undefined
    if (!taskRow || taskRow.status !== 'running') {
      return {
        status: 'failed',
        code: 'TASK_NOT_RUNNING',
        message: 'Scheduler task is no longer in running state',
      }
    }

    const bot = this.deps.botRepo.getBot(ctx.botId)
    if (!bot) {
      return {
        status: 'failed',
        code: 'BOT_NOT_FOUND_OR_ARCHIVED',
        message: `Target bot "${ctx.botId}" not found or archived`,
      }
    }
    if (bot.permission === 'full-access') {
      return {
        status: 'failed',
        code: 'AUTONOMOUS_FULL_ACCESS_DENIED',
        message: 'Autonomous routines cannot run with full-access permission',
      }
    }

    const rt = this.deps.getRuntimeState()
    if (rt.runtimeMode !== 'mock') {
      return {
        status: 'failed',
        code:
          routineRow.target_type === 'team'
            ? 'LIVE_TEAMS_GATED'
            : 'AUTONOMOUS_LIVE_EXECUTION_GATED',
        message: 'Autonomous live provider inference is disabled in Phase 5B (mock mode only)',
      }
    }

    const pollMs = this.deps.pollIntervalMs ?? 20
    const timeoutMs = this.deps.dispatchTimeoutMs ?? 15_000
    const deadline = Date.now() + timeoutMs
    const accountId = rt.accountId ?? 'mock-account'

    if (routineRow.target_type === 'team') {
      if (!routineRow.team_id) {
        return { status: 'failed', code: 'TEAM_NOT_CONFIGURED', message: 'Missing teamId on team routine' }
      }
      let team
      try {
        team = this.deps.teamsService.getTeam(routineRow.team_id)
      } catch {
        return { status: 'failed', code: 'TEAM_NOT_FOUND', message: 'Target team not found' }
      }
      if (team.archivedAt !== null) {
        return { status: 'failed', code: 'TEAM_ARCHIVED', message: 'Target team is archived' }
      }

      try {
        const started = await this.deps.teamsService.startTeamRun({
          teamId: team.id,
          goal: ctx.untrustedTask.prompt,
          idempotencyKey: `sched:${ctx.taskId}:attempt:${taskRow.attempt}`,
          autoExecute: true,
        })
        this.deps.dbHandle.sqlite
          .prepare(
            `INSERT OR IGNORE INTO scheduler_execution_links (
              id, routine_id, routine_revision, occurrence_key, scheduler_task_id,
              target_type, bot_id, team_id, session_id, daemon_run_id, team_run_id,
              runtime_id, account_id, attempt, created_at
            ) VALUES (?, ?, ?, ?, ?, 'team', ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
          )
          .run(
            `sexec_${randomUUID()}`,
            ctx.routineId,
            ctx.routineRevision,
            ctx.occurrenceKey,
            ctx.taskId,
            ctx.botId,
            team.id,
            started.run.id,
            rt.runtimeMode,
            accountId,
            taskRow.attempt,
            new Date().toISOString(),
          )

        while (Date.now() < deadline) {
          const run = this.deps.teamsService.getTeamRun(started.run.id)
          if (run.status === 'completed') {
            return { status: 'completed' }
          }
          if (run.status === 'failed' || run.status === 'cancelled') {
            return {
              status: 'failed',
              code: 'TEAM_RUN_FAILED',
              message: `Team run ended with status "${run.status}"`,
            }
          }
          if (run.status === 'uncertain') {
            return {
              status: 'unknown',
              reason: 'Team run ended in uncertain state; manual review required',
            }
          }
          await new Promise((r) => setTimeout(r, pollMs))
        }
        return { status: 'unknown', reason: 'Team routine exceeded dispatch timeout' }
      } catch (err) {
        const code = err instanceof DaemonError ? err.code : 'TEAM_DISPATCH_ERROR'
        const msg = err instanceof Error ? err.message : 'Team routine dispatch failed'
        return { status: 'failed', code, message: redactSecrets(msg) }
      }
    }

    // Individual bot target routed through authoritative RunOrchestrator
    const sessionId = this.getOrCreateRoutineSessionId(ctx.routineId, ctx.botId)
    try {
      const { run } = await this.deps.orchestrator.startRun({
        sessionId,
        text: ctx.untrustedTask.prompt,
        idempotencyKey: `sched:${ctx.taskId}:attempt:${taskRow.attempt}`,
      })

      this.deps.dbHandle.sqlite
        .prepare(
          `INSERT OR IGNORE INTO scheduler_execution_links (
            id, routine_id, routine_revision, occurrence_key, scheduler_task_id,
            target_type, bot_id, team_id, session_id, daemon_run_id, team_run_id,
            runtime_id, account_id, attempt, created_at
          ) VALUES (?, ?, ?, ?, ?, 'bot', ?, NULL, ?, ?, NULL, ?, ?, ?, ?)`,
        )
        .run(
          `sexec_${randomUUID()}`,
          ctx.routineId,
          ctx.routineRevision,
          ctx.occurrenceKey,
          ctx.taskId,
          ctx.botId,
          sessionId,
          run.id,
          rt.runtimeMode,
          accountId,
          taskRow.attempt,
          new Date().toISOString(),
        )

      while (Date.now() < deadline) {
        const latest = this.deps.orchestrator.getRun(run.id)
        if (latest.status === 'completed') {
          return { status: 'completed' }
        }
        if (latest.status === 'awaiting_approval') {
          const pendingApp = this.deps.dbHandle.sqlite
            .prepare(
              `SELECT id, action_type, action_summary, expires_at
               FROM approvals
               WHERE run_id = ? AND status = 'pending'
               ORDER BY created_at DESC LIMIT 1`,
            )
            .get(run.id) as
            | { id: string; action_type: string; action_summary: string; expires_at: string }
            | undefined

          if (pendingApp) {
            this.deps.approvalCoordinator.bindApprovalRequest({
              routineId: ctx.routineId,
              routineRevision: ctx.routineRevision,
              occurrenceKey: ctx.occurrenceKey,
              taskId: ctx.taskId,
              scope: { ownerId: ctx.ownerId, botId: ctx.botId },
              daemonRunId: run.id,
              daemonApprovalId: pendingApp.id,
              expiresAt: pendingApp.expires_at,
              requirePolicyRevalidation: true,
              sanitizedActionSummary: `${pendingApp.action_type}: ${pendingApp.action_summary}`,
            })
            const nowIso = new Date().toISOString()
            this.deps.dbHandle.sqlite
              .prepare(
                `INSERT OR IGNORE INTO scheduler_approval_links (
                  id, scheduler_task_id, routine_id, routine_revision, occurrence_key,
                  daemon_run_id, daemon_approval_id, state, expires_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'approval.pending', ?, ?, ?)`,
              )
              .run(
                `sapp_${randomUUID()}`,
                ctx.taskId,
                ctx.routineId,
                ctx.routineRevision,
                ctx.occurrenceKey,
                run.id,
                pendingApp.id,
                pendingApp.expires_at,
                nowIso,
                nowIso,
              )
          }
          return {
            status: 'awaiting_approval',
            reason: pendingApp
              ? `Awaiting approval ${pendingApp.id} (${pendingApp.action_type})`
              : 'Awaiting daemon approval',
          }
        }
        if (latest.status === 'failed' || latest.status === 'cancelled') {
          return {
            status: 'failed',
            code: latest.error?.code ?? 'RUN_FAILED',
            message: redactSecrets(latest.error?.message ?? `Child run ${latest.status}`),
          }
        }
        await new Promise((r) => setTimeout(r, pollMs))
      }

      return {
        status: 'unknown',
        reason: 'Bot routine exceeded dispatch poll deadline',
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Routine dispatch error'
      return {
        status: 'unknown',
        reason: redactSecrets(msg),
      }
    }
  }

  /**
   * Recovers crash-window orphans where runs were created with sched:<taskId>:attempt:<n>
   * before scheduler_execution_links was persisted, validating authoritative task, routine,
   * session, agent, and attempt relationships.
   */
  recoverMissingExecutionLinks(): number {
    let recovered = 0
    const orphanRuns = this.deps.dbHandle.sqlite
      .prepare(
        `SELECT r.id AS daemon_run_id, r.session_id, r.agent_id, r.idempotency_key,
                r.runtime_id, r.created_at AS run_created_at,
                s.title AS session_title, s.agent_id AS session_agent_id
         FROM runs r
         JOIN sessions s ON s.id = r.session_id
         LEFT JOIN scheduler_execution_links l ON l.daemon_run_id = r.id
         WHERE l.id IS NULL
           AND r.idempotency_key LIKE 'sched:%:attempt:%'
           AND s.title LIKE 'routine:%'`,
      )
      .all() as Array<{
      daemon_run_id: string
      session_id: string
      agent_id: string
      idempotency_key: string
      runtime_id: string
      run_created_at: string
      session_title: string
      session_agent_id: string
    }>

    if (orphanRuns.length === 0) return 0

    const insertLink = this.deps.dbHandle.sqlite.prepare(
      `INSERT OR IGNORE INTO scheduler_execution_links (
        id, routine_id, routine_revision, occurrence_key, scheduler_task_id,
        target_type, bot_id, team_id, session_id, daemon_run_id, team_run_id,
        runtime_id, account_id, attempt, created_at
      ) VALUES (?, ?, ?, ?, ?, 'bot', ?, NULL, ?, ?, NULL, ?, 'local', ?, ?)`,
    )

    for (const row of orphanRuns) {
      if (row.session_agent_id !== row.agent_id) continue
      const keyMatch = /^sched:([^:]+):attempt:(\d+)$/.exec(row.idempotency_key)
      const titleMatch = /^routine:([^:]+):([^:]+)$/.exec(row.session_title)
      if (!keyMatch || !titleMatch) continue
      const taskId = keyMatch[1]!
      const attempt = Number(keyMatch[2]!)
      const routineIdFromTitle = titleMatch[1]!
      const botIdFromTitle = titleMatch[2]!
      if (botIdFromTitle !== row.agent_id) continue

      const authRow = this.deps.dbHandle.sqlite
        .prepare(
          `SELECT t.id, t.routine_id, t.routine_revision, t.occurrence_key, t.bot_id,
                  t.attempt, t.status, t.created_at AS task_created_at,
                  r.target_type, r.archived_at
           FROM scheduler_tasks t
           JOIN scheduler_routines r ON r.id = t.routine_id
           WHERE t.id = ? AND t.routine_id = ?`,
        )
        .get(taskId, routineIdFromTitle) as
        | {
            id: string
            routine_id: string
            routine_revision: number
            occurrence_key: string
            bot_id: string
            attempt: number
            status: string
            task_created_at: string
            target_type: string
            archived_at: string | null
          }
        | undefined

      if (!authRow) continue
      if (authRow.archived_at !== null || authRow.target_type !== 'bot') continue
      if (authRow.bot_id !== row.agent_id || authRow.attempt !== attempt) continue
      if (!['running', 'awaiting_approval', 'claimed'].includes(authRow.status)) continue
      if (row.run_created_at < authRow.task_created_at) continue

      const info = insertLink.run(
        `sexec_rec_${row.daemon_run_id}`,
        authRow.routine_id,
        authRow.routine_revision,
        authRow.occurrence_key,
        authRow.id,
        authRow.bot_id,
        row.session_id,
        row.daemon_run_id,
        row.runtime_id,
        attempt,
        new Date().toISOString(),
      )
      if (info.changes > 0) recovered += 1
    }

    return recovered
  }

  async cancelTaskExecution(taskId: string, scope: RoutineScope): Promise<{ confirmed: boolean }> {
    const link = this.deps.dbHandle.sqlite
      .prepare(
        `SELECT l.target_type, l.daemon_run_id, l.team_run_id
         FROM scheduler_execution_links l
         JOIN scheduler_tasks t ON t.id = l.scheduler_task_id
         WHERE l.scheduler_task_id = ? AND t.owner_id = ?
         ORDER BY l.attempt DESC LIMIT 1`,
      )
      .get(taskId, scope.ownerId) as
      | { target_type: string; daemon_run_id: string | null; team_run_id: string | null }
      | undefined
    if (!link) return { confirmed: true }

    if (link.target_type === 'team' && link.team_run_id) {
      const res = await this.deps.teamsService.cancelTeamRun(link.team_run_id)
      return { confirmed: res.run.status === 'cancelled' || res.run.status === 'completed' }
    }
    if (link.daemon_run_id) {
      const res = this.deps.orchestrator.cancelRun(link.daemon_run_id)
      return {
        confirmed:
          res.run.status === 'cancelled' ||
          res.run.status === 'completed' ||
          res.run.status === 'failed',
      }
    }
    return { confirmed: true }
  }
}
