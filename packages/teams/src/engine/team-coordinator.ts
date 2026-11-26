import { createHash, randomUUID } from 'node:crypto'
import type {
  TeamResultSynthesizer,
  TeamRunAggregateResult,
  TeamRunRecord,
  TeamRunStatus,
  TeamTaskDispatcher,
  TeamTaskPlanner,
  TeamTaskRecord,
  TeamTaskResultEntry,
} from '../contracts/types.ts'
import type { TeamRepository } from '../repository/team-repository.ts'
import {
  assertNonEmptyBounded,
  assertPromptBounded,
  assertTeamOwner,
  TeamError,
  truncateUtf8ToByteLimit,
  validateBounds,
} from '../security/validation.ts'
import { validateTaskPlan } from '../security/validation.ts'
import type { DelegationEngine } from './delegation-engine.ts'

interface RawTeamRunRow {
  id: string
  team_id: string
  owner_id: string
  lead_bot_id: string
  root_task_id: string
  conversation_id: string
  idempotency_key: string
  goal: string
  goal_hash: string
  status: TeamRunStatus
  bounds_json: string
  tasks_created: number
  messages_posted: number
  tokens_reserved: number
  tokens_used: number
  duration_used_ms: number
  error_code: string | null
  error_message: string | null
  ended_at: string | null
  created_at: string
  updated_at: string
}

function hashGoal(teamId: string, goal: string): string {
  return createHash('sha256').update(JSON.stringify({ teamId, goal })).digest('hex')
}

function rowToTeamRun(row: RawTeamRunRow): TeamRunRecord {
  return {
    id: row.id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    leadBotId: row.lead_bot_id,
    rootTaskId: row.root_task_id,
    conversationId: row.conversation_id,
    idempotencyKey: row.idempotency_key,
    goal: row.goal,
    status: row.status,
    bounds: validateBounds(JSON.parse(row.bounds_json) as Record<string, number>),
    tasksCreated: Number(row.tasks_created),
    messagesPosted: Number(row.messages_posted),
    tokensReserved: Number(row.tokens_reserved),
    tokensUsed: Number(row.tokens_used),
    durationUsedMs: Number(row.duration_used_ms),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class TeamCoordinator {
  private readonly repository: TeamRepository
  private readonly engine: DelegationEngine

  constructor(repository: TeamRepository, engine: DelegationEngine) {
    this.repository = repository
    this.engine = engine
  }

  getTeamRun(teamRunId: string, ownerId: string): TeamRunRecord {
    const db = this.repository.getDatabase()
    const row = db.sqlite
      .prepare(`SELECT * FROM team_runs WHERE id = ?`)
      .get(teamRunId) as RawTeamRunRow | undefined
    if (!row) {
      throw new TeamError('TEAM_RUN_NOT_FOUND', `Team run "${teamRunId}" was not found`)
    }
    assertTeamOwner(ownerId, row.owner_id)
    return rowToTeamRun(row)
  }

  async startTeamRun(
    input: {
      teamId: string
      ownerId: string
      goal: string
      idempotencyKey: string
      conversationId?: string
      planner: TeamTaskPlanner
    },
    nowMs = Date.now(),
  ): Promise<{ run: TeamRunRecord; tasks: TeamTaskRecord[]; created: boolean }> {
    const db = this.repository.getDatabase()
    const goal = assertPromptBounded(input.goal, 'goal')
    const idempotencyKey = assertNonEmptyBounded(input.idempotencyKey, 'idempotencyKey', 128)
    const team = this.repository.getTeam(input.teamId, input.ownerId)
    if (team.archivedAt !== null) {
      throw new TeamError('TEAM_ARCHIVED', 'Cannot start a team run on an archived team')
    }

    const gHash = hashGoal(team.id, goal)
    const existingRow = db.sqlite
      .prepare(`SELECT * FROM team_runs WHERE team_id = ? AND idempotency_key = ?`)
      .get(team.id, idempotencyKey) as RawTeamRunRow | undefined
    if (existingRow) {
      if (existingRow.goal_hash !== gHash) {
        throw new TeamError(
          'IDEMPOTENCY_CONFLICT',
          'Team run idempotency key reused with a different goal',
        )
      }
      const existingTasks = this.listRunTasks(existingRow.id, input.ownerId)
      return { run: rowToTeamRun(existingRow), tasks: existingTasks, created: false }
    }

    const teamRunId = `trun_${randomUUID()}`
    const conversationId = input.conversationId
      ? assertNonEmptyBounded(input.conversationId, 'conversationId', 128)
      : `tconv_${randomUUID()}`

    const rawPlan = await input.planner.plan({ team, teamRunId, goal })
    const validatedPlan = validateTaskPlan(rawPlan, team)
    const nowIso = new Date(nowMs).toISOString()

    return db.transaction(() => {
      // Re-check team archive status and idempotency inside transaction after async planning
      const freshTeam = this.repository.getTeam(team.id, input.ownerId)
      if (freshTeam.archivedAt !== null) {
        throw new TeamError('TEAM_ARCHIVED', 'Team was archived during planning')
      }
      const raceRow = db.sqlite
        .prepare(`SELECT * FROM team_runs WHERE team_id = ? AND idempotency_key = ?`)
        .get(freshTeam.id, idempotencyKey) as RawTeamRunRow | undefined
      if (raceRow) {
        if (raceRow.goal_hash !== gHash) {
          throw new TeamError(
            'IDEMPOTENCY_CONFLICT',
            'Team run idempotency key reused with a different goal',
          )
        }
        return {
          run: rowToTeamRun(raceRow),
          tasks: this.listRunTasks(raceRow.id, input.ownerId),
          created: false,
        }
      }

      const plannerTokens = Math.max(0, rawPlan.estimatedUsage?.tokensUsed ?? 0)
      const plannerDuration = Math.max(0, rawPlan.estimatedUsage?.durationMs ?? 0)
      const plannerUsageReported = rawPlan.estimatedUsage?.tokensUsed !== undefined ? 1 : 0

      const { task: rootTask } = this.engine.createRootTask(
        {
          teamId: team.id,
          ownerId: input.ownerId,
          prompt: goal,
          idempotencyKey: `${idempotencyKey}:root`,
          teamRunId,
          planKey: '__root__',
        },
        nowMs,
      )

      db.sqlite
        .prepare(
          `INSERT INTO team_runs (
            id, team_id, owner_id, lead_bot_id, root_task_id, conversation_id,
            idempotency_key, goal, goal_hash, status, bounds_json,
            tasks_created, messages_posted, tokens_reserved, tokens_used, duration_used_ms,
            error_code, error_message, ended_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, 1, 0, 0, 0, 0, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          teamRunId,
          team.id,
          input.ownerId,
          team.leadBotId,
          rootTask.id,
          conversationId,
          idempotencyKey,
          goal,
          gHash,
          JSON.stringify(team.bounds),
          nowIso,
          nowIso,
        )

      // Post user prompt and Chief of Staff instruction in group conversation
      this.repository.postMessage(
        {
          teamId: team.id,
          ownerId: input.ownerId,
          authorBotId: input.ownerId,
          originatingTaskId: rootTask.id,
          teamRunId,
          conversationId,
          senderType: 'user',
          messageType: 'user_prompt',
          visibility: 'user_and_cos',
          content: goal,
        },
        nowMs,
      )

      this.repository.postMessage(
        {
          teamId: team.id,
          ownerId: input.ownerId,
          authorBotId: team.leadBotId,
          originatingTaskId: rootTask.id,
          teamRunId,
          conversationId,
          senderType: 'chief_of_staff',
          messageType: 'cos_instruction',
          visibility: 'team',
          content: `Plan: ${validatedPlan.summary}`,
        },
        nowMs,
      )

      // Create planned tasks and dependency edges while rootTask is active
      const taskByPlanKey = new Map<string, TeamTaskRecord>()
      const defaultPerTaskTokens = Math.max(
        1,
        Math.floor(team.bounds.maxTokens / validatedPlan.tasks.length),
      )

      for (const planned of validatedPlan.tasks) {
        const { task } = this.engine.delegateSubtask(
          {
            teamId: team.id,
            ownerId: input.ownerId,
            parentTaskId: rootTask.id,
            targetBotId: planned.assignedBotId,
            prompt: planned.prompt,
            idempotencyKey: `${idempotencyKey}:plan:${planned.planKey}`,
            tokenBudget: planned.tokenBudget ?? defaultPerTaskTokens,
            durationBudgetMs: planned.durationBudgetMs ?? team.bounds.maxDurationMs,
            teamRunId,
            planKey: planned.planKey,
            depthOverride: planned.depth,
          },
          nowMs,
        )
        taskByPlanKey.set(planned.planKey, task)

        this.repository.postMessage(
          {
            teamId: team.id,
            ownerId: input.ownerId,
            authorBotId: team.leadBotId,
            targetBotId: planned.assignedBotId,
            originatingTaskId: task.id,
            teamRunId,
            conversationId,
            senderType: 'chief_of_staff',
            messageType: 'task_assignment',
            visibility: 'direct',
            content: `Assigned [${planned.planKey}]: ${planned.prompt}`,
          },
          nowMs,
        )
      }

      // Mark root task completed as Chief of Staff planning step (recording planner usage if reported)
      db.sqlite
        .prepare(
          `UPDATE team_tasks
           SET status = 'completed', token_budget = ?, tokens_used = ?,
               duration_used_ms = ?, usage_reported = ?, ended_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          plannerTokens,
          plannerTokens,
          plannerDuration,
          plannerUsageReported,
          nowIso,
          nowIso,
          rootTask.id,
        )

      for (const planned of validatedPlan.tasks) {
        const child = taskByPlanKey.get(planned.planKey)!
        for (const depKey of planned.dependsOn) {
          const parentDep = taskByPlanKey.get(depKey)!
          db.sqlite
            .prepare(
              `INSERT INTO team_task_dependencies (team_run_id, task_id, depends_on_task_id)
               VALUES (?, ?, ?)`,
            )
            .run(teamRunId, child.id, parentDep.id)
        }
      }

      db.sqlite
        .prepare(
          `UPDATE team_runs
           SET tasks_created = ?, tokens_used = ?, duration_used_ms = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(1 + validatedPlan.tasks.length, plannerTokens, plannerDuration, nowIso, teamRunId)

      return {
        run: this.getTeamRun(teamRunId, input.ownerId),
        tasks: this.listRunTasks(teamRunId, input.ownerId),
        created: true,
      }
    })
  }

  listRunTasks(teamRunId: string, ownerId: string): TeamTaskRecord[] {
    this.getTeamRun(teamRunId, ownerId)
    const db = this.repository.getDatabase()
    const rows = db.sqlite
      .prepare(
        `SELECT id FROM team_tasks
         WHERE team_run_id = ? AND owner_id = ?
         ORDER BY depth ASC, created_at ASC`,
      )
      .all(teamRunId, ownerId) as Array<{ id: string }>
    return rows.map((r) => this.engine.getTask(r.id, ownerId))
  }

  async executeTeamRunStep(
    teamRunId: string,
    ownerId: string,
    dispatcher: TeamTaskDispatcher,
    nowMs = Date.now(),
  ): Promise<TeamTaskRecord[]> {
    const run = this.getTeamRun(teamRunId, ownerId)
    if (run.status === 'cancelled' || run.status === 'uncertain') {
      return []
    }

    const executed = await this.engine.runReadyTasksParallel(
      run.teamId,
      ownerId,
      dispatcher,
      nowMs,
      { teamRunId: run.id },
    )

    for (const t of executed) {
      if (t.status === 'completed' || t.status === 'failed' || t.status === 'uncertain' || t.status === 'budget_exhausted') {
        try {
          this.repository.postMessage(
            {
              teamId: run.teamId,
              ownerId,
              authorBotId: t.assignedBotId,
              targetBotId: run.leadBotId,
              originatingTaskId: t.id,
              teamRunId: run.id,
              conversationId: run.conversationId,
              senderType: 'worker',
              messageType: t.status === 'completed' ? 'worker_result' : 'error_report',
              visibility: 'direct',
              content:
                t.status === 'completed'
                  ? (t.outputText ?? `Completed [${t.planKey ?? t.id}]`)
                  : `Task [${t.planKey ?? t.id}] ended with ${t.status}: ${t.errorMessage ?? t.errorCode ?? 'unknown'}`,
            },
            nowMs,
          )
        } catch (err) {
          if (!(err instanceof TeamError && err.code === 'MESSAGE_LIMIT_EXCEEDED')) {
            throw err
          }
        }
      }
    }

    this.refreshTeamRunStatus(run.id, ownerId, nowMs)
    return executed
  }

  async runTeamRunToCompletion(
    teamRunId: string,
    ownerId: string,
    dispatcher: TeamTaskDispatcher,
    nowMs = Date.now(),
  ): Promise<TeamRunAggregateResult> {
    let wave = 0
    const maxWaves = 100
    while (wave < maxWaves) {
      const run = this.getTeamRun(teamRunId, ownerId)
      if (run.status !== 'running' && run.status !== 'planning') break
      const step = await this.executeTeamRunStep(teamRunId, ownerId, dispatcher, nowMs + wave * 10)
      this.refreshTeamRunStatus(teamRunId, ownerId, nowMs + wave * 10)
      if (step.length === 0) break
      wave += 1
    }
    this.refreshTeamRunStatus(teamRunId, ownerId, nowMs + wave * 10)
    return this.collectAggregateResult(teamRunId, ownerId)
  }

  private refreshTeamRunStatus(teamRunId: string, ownerId: string, nowMs: number): TeamRunRecord {
    const db = this.repository.getDatabase()
    const nowIso = new Date(nowMs).toISOString()
    return db.transaction(() => {
      const run = this.getTeamRun(teamRunId, ownerId)
      if (run.status === 'cancelled' || run.status === 'uncertain') {
        return run
      }
      const allTasks = this.listRunTasks(teamRunId, ownerId)
      const rootTask = allTasks.find((t) => t.planKey === '__root__')
      const tasks = allTasks.filter((t) => t.planKey !== '__root__')
      const anyActive = tasks.some(
        (t) => t.status === 'queued' || t.status === 'running' || t.status === 'awaiting_approval',
      )
      const workerTokens = tasks.reduce((acc, t) => acc + t.tokensUsed, 0)
      const plannerTokens = rootTask?.tokensUsed ?? 0
      const priorNonWorkerTokens = Math.max(0, run.tokensUsed - plannerTokens - workerTokens)
      const tokensUsed = workerTokens + plannerTokens + priorNonWorkerTokens
      const tokensReserved = tasks.reduce((acc, t) => acc + t.tokensReserved, 0)
      const durationUsed =
        tasks.reduce((acc, t) => acc + t.durationUsedMs, 0) + (rootTask?.durationUsedMs ?? 0)

      let nextStatus: TeamRunStatus = 'running'
      let endedAt: string | null = null
      if (!anyActive) {
        endedAt = nowIso
        const hasUncertain = tasks.some((t) => t.status === 'uncertain')
        const completedCount = tasks.filter((t) => t.status === 'completed').length
        const failedCount = tasks.filter(
          (t) =>
            t.status === 'failed' ||
            t.status === 'blocked' ||
            t.status === 'budget_exhausted' ||
            t.status === 'cancelled' ||
            t.status === 'stopped_by_parent',
        ).length

        if (hasUncertain) {
          nextStatus = 'uncertain'
        } else if (failedCount === 0 && completedCount === tasks.length) {
          nextStatus = 'completed'
        } else if (completedCount > 0) {
          nextStatus = 'partial_failure'
        } else {
          nextStatus = 'failed'
        }
      }

      db.sqlite
        .prepare(
          `UPDATE team_runs
           SET status = ?, tokens_reserved = ?, tokens_used = ?, duration_used_ms = ?,
               ended_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(nextStatus, tokensReserved, tokensUsed, durationUsed, endedAt, nowIso, run.id)
      return this.getTeamRun(run.id, ownerId)
    })
  }

  async cancelTeamRun(
    teamRunId: string,
    ownerId: string,
    dispatcher?: TeamTaskDispatcher,
    nowMs = Date.now(),
  ): Promise<{ run: TeamRunRecord; stoppedChildrenCount: number; uncertainCount: number }> {
    const run = this.getTeamRun(teamRunId, ownerId)
    const cancelRes = await this.engine.cancelTaskWithPropagationAsync(
      run.rootTaskId,
      ownerId,
      dispatcher,
      nowMs,
    )
    const db = this.repository.getDatabase()
    const nowIso = new Date(nowMs).toISOString()
    const nextRunStatus: TeamRunStatus = cancelRes.uncertainCount > 0 ? 'uncertain' : 'cancelled'

    db.transaction(() => {
      const tasks = this.listRunTasks(run.id, ownerId).filter((t) => t.planKey !== '__root__')
      const tokensUsed = tasks.reduce((acc, t) => acc + t.tokensUsed, 0)
      const tokensReserved = tasks.reduce((acc, t) => acc + t.tokensReserved, 0)
      db.sqlite
        .prepare(
          `UPDATE team_runs
           SET status = ?, tokens_reserved = ?, tokens_used = ?,
               error_code = ?, error_message = ?, ended_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          nextRunStatus,
          tokensReserved,
          tokensUsed,
          cancelRes.uncertainCount > 0 ? 'UNCERTAIN_CANCELLATION' : 'CANCELLED',
          cancelRes.uncertainCount > 0
            ? 'Team run cancelled with unconfirmed active execution termination.'
            : 'Team run cancelled.',
          nowIso,
          nowIso,
          run.id,
        )
    })

    try {
      this.repository.postMessage(
        {
          teamId: run.teamId,
          ownerId,
          authorBotId: run.leadBotId,
          originatingTaskId: run.rootTaskId,
          teamRunId: run.id,
          conversationId: run.conversationId,
          senderType: 'chief_of_staff',
          messageType: 'cancellation_notice',
          visibility: 'team',
          content:
            cancelRes.uncertainCount > 0
              ? `Team run cancellation requested; ${cancelRes.uncertainCount} active execution(s) unconfirmed.`
              : 'Team run cancelled; queued work stopped.',
        },
        nowMs,
      )
    } catch (err) {
      if (!(err instanceof TeamError && err.code === 'MESSAGE_LIMIT_EXCEEDED')) {
        throw err
      }
    }

    return {
      run: this.getTeamRun(run.id, ownerId),
      stoppedChildrenCount: cancelRes.stoppedChildrenCount,
      uncertainCount: cancelRes.uncertainCount,
    }
  }

  collectAggregateResult(teamRunId: string, ownerId: string): TeamRunAggregateResult {
    const run = this.getTeamRun(teamRunId, ownerId)
    const allTasks = this.listRunTasks(teamRunId, ownerId)
    const rootTask = allTasks.find((t) => t.planKey === '__root__')
    const workerTasks = allTasks
      .filter((t) => t.planKey !== '__root__')
      .sort((a, b) => a.depth - b.depth || (a.planKey ?? a.id).localeCompare(b.planKey ?? b.id))

    let completedCount = 0
    let failedCount = 0
    let cancelledCount = 0
    let blockedCount = 0
    let uncertainCount = 0
    let workerTokensUsed = 0
    let totalDurationMs = rootTask?.durationUsedMs ?? 0
    let providerInferenceCount = rootTask?.usageReported && rootTask.tokensUsed > 0 ? 1 : 0
    const unavailableUsageTaskIds: string[] = []

    const entries: TeamTaskResultEntry[] = []
    let remainingBytes = run.bounds.maxResultBytes
    let truncated = false

    for (const t of workerTasks) {
      providerInferenceCount += t.attempt
      if (t.status === 'completed') completedCount += 1
      else if (t.status === 'blocked') blockedCount += 1
      else if (t.status === 'cancelled' || t.status === 'stopped_by_parent') cancelledCount += 1
      else if (t.status === 'uncertain') uncertainCount += 1
      else if (t.status === 'failed' || t.status === 'budget_exhausted') failedCount += 1

      if (t.usageReported) {
        workerTokensUsed += t.tokensUsed
        totalDurationMs += t.durationUsedMs
      } else {
        unavailableUsageTaskIds.push(t.id)
      }

      let outputText = t.outputText
      let outputTruncated = t.outputTruncated
      if (outputText !== null) {
        if (remainingBytes <= 0) {
          outputText = null
          outputTruncated = true
          truncated = true
        } else {
          const bounded = truncateUtf8ToByteLimit(outputText, remainingBytes)
          outputText = bounded.text
          if (bounded.truncated) {
            outputTruncated = true
            truncated = true
          }
          remainingBytes -= Buffer.byteLength(outputText, 'utf8')
        }
      }

      entries.push({
        taskId: t.id,
        planKey: t.planKey,
        assignedBotId: t.assignedBotId,
        status: t.status,
        outputText,
        outputTruncated,
        errorCode: t.errorCode,
        errorMessage: t.errorMessage,
        tokensUsed: t.usageReported ? t.tokensUsed : null,
        durationMs: t.usageReported ? t.durationUsedMs : null,
        usageReported: t.usageReported,
        terminationConfirmed: t.terminationConfirmed,
      })
    }

    const plannerTokensUsed = rootTask?.tokensUsed ?? 0
    const synthesizerTokensUsed = Math.max(0, run.tokensUsed - workerTokensUsed - plannerTokensUsed)
    if (synthesizerTokensUsed > 0) {
      providerInferenceCount += 1
    }
    const totalTokensUsed = workerTokensUsed + plannerTokensUsed + synthesizerTokensUsed
    const resultBytes = Buffer.byteLength(JSON.stringify(entries), 'utf8')
    const usageComplete = unavailableUsageTaskIds.length === 0
    const synthesisInputReady = !workerTasks.some(
      (t) => t.status === 'queued' || t.status === 'running' || t.status === 'awaiting_approval',
    )

    return {
      teamRunId: run.id,
      teamId: run.teamId,
      rootTaskId: run.rootTaskId,
      status: run.status,
      completedCount,
      failedCount,
      cancelledCount,
      blockedCount,
      uncertainCount,
      totalTasks: workerTasks.length,
      providerInferenceCount,
      plannerTokensUsed,
      synthesizerTokensUsed,
      totalTokensUsed,
      totalDurationMs,
      usageComplete,
      unavailableUsageTaskIds,
      results: entries,
      resultBytes,
      truncated,
      synthesisInputReady,
    }
  }

  async synthesizeFinalResponse(
    teamRunId: string,
    ownerId: string,
    synthesizer: TeamResultSynthesizer,
    nowMs = Date.now(),
  ): Promise<{ aggregate: TeamRunAggregateResult; summaryText: string }> {
    const initialRun = this.getTeamRun(teamRunId, ownerId)
    if (initialRun.status === 'cancelled' || initialRun.status === 'uncertain') {
      throw new TeamError(
        'RUN_NOT_SYNTHESIZABLE',
        `Cannot synthesize final response for ${initialRun.status} team run`,
      )
    }
    const initialAggregate = this.collectAggregateResult(teamRunId, ownerId)
    const { summaryText, usage } = await synthesizer.synthesize(initialAggregate)
    const db = this.repository.getDatabase()
    const nowIso = new Date(nowMs).toISOString()

    return db.transaction(() => {
      const latestRun = this.getTeamRun(teamRunId, ownerId)
      if (latestRun.status === 'cancelled' || latestRun.status === 'uncertain') {
        throw new TeamError(
          'RUN_NOT_SYNTHESIZABLE',
          `Team run transitioned to ${latestRun.status} during synthesis`,
        )
      }

      const synthTokens = Math.max(0, usage?.tokensUsed ?? 0)
      const synthDuration = Math.max(0, usage?.durationMs ?? 0)
      if (synthTokens > 0 || synthDuration > 0) {
        db.sqlite
          .prepare(
            `UPDATE team_runs
             SET tokens_used = tokens_used + ?, duration_used_ms = duration_used_ms + ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(synthTokens, synthDuration, nowIso, latestRun.id)
      }

      const bounded = truncateUtf8ToByteLimit(summaryText, latestRun.bounds.maxResultBytes)
      this.repository.postMessage(
        {
          teamId: latestRun.teamId,
          ownerId,
          authorBotId: latestRun.leadBotId,
          originatingTaskId: latestRun.rootTaskId,
          teamRunId: latestRun.id,
          conversationId: latestRun.conversationId,
          senderType: 'chief_of_staff',
          messageType: 'final_response',
          visibility: 'user_and_cos',
          content: bounded.text,
        },
        nowMs,
      )

      return {
        aggregate: this.collectAggregateResult(teamRunId, ownerId),
        summaryText: bounded.text,
      }
    })
  }

  reconcileOnRestart(nowMs = Date.now()): { tasksMarkedUncertain: number; runsMarkedUncertain: number } {
    const db = this.repository.getDatabase()
    const nowIso = new Date(nowMs).toISOString()
    return db.transaction(() => {
      const tasksMarkedUncertain = this.engine.reconcileOnRestart(nowMs)
      const res = db.sqlite
        .prepare(
          `UPDATE team_runs
           SET status = 'uncertain', error_code = 'DAEMON_RESTARTED',
               error_message = 'Team run interrupted by restart; non-replayable until reconciled.',
               ended_at = ?, updated_at = ?
           WHERE status IN ('planning', 'running')`,
        )
        .run(nowIso, nowIso)
      return { tasksMarkedUncertain, runsMarkedUncertain: Number(res.changes) }
    })
  }
}
