import { randomUUID } from 'node:crypto'
import {
  TeamDiscussionRepliesSchema,
  type TeamDiscussionCancel,
  type TeamDiscussionCancelResponse,
  type TeamDiscussionList,
  type TeamDiscussionPage,
  type TeamDiscussionSend,
  type TeamDiscussionTurn,
} from '@ghost-bot/shared-types/ipc'
import type { AgentRuntime } from '@ghost-bot/shared-types/runtime'
import type { DatabaseHandle } from '../db/client.ts'
import { DaemonError } from '../errors.ts'
import type { RuntimeRegistry } from '../runtime/registry.ts'
import type { TeamMemberRoutingService } from './member-routing.ts'
import type { TeamsService } from './service.ts'

interface DiscussionRow {
  id: string
  seq: number
  prompt: string
  replies_json: string
  created_at: string
}

interface ActiveDiscussionState {
  operationId: string
  controller: AbortController
  runtime: AgentRuntime
  activeRunIds: Set<string>
}

const MAX_ACTIVE_DISCUSSIONS = 4
const MAX_DISCUSSION_CONCURRENCY = 2
const MAX_REPLY_CHARS = 8192
const MAX_TURN_TOTAL_CHARS = 24_576
const DEFAULT_DURATION_MS = 30_000
const MAX_DURATION_MS = 120_000

function toTurn(row: DiscussionRow): TeamDiscussionTurn {
  return {
    id: row.id,
    seq: row.seq,
    text: row.prompt,
    replies: TeamDiscussionRepliesSchema.parse(JSON.parse(row.replies_json)),
    createdAt: row.created_at,
  }
}

async function runWithConcurrencyLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workerCount = Math.max(1, Math.min(limit, items.length))
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const idx = nextIndex++
        results[idx] = await worker(items[idx], idx)
      }
    }),
  )
  return results
}

export class TeamDiscussion {
  private readonly db: DatabaseHandle
  private readonly teams: TeamsService
  private readonly routing: TeamMemberRoutingService
  private readonly runtime: RuntimeRegistry
  private readonly activeTurns = new Map<string, ActiveDiscussionState>()

  constructor(db: DatabaseHandle, teams: TeamsService, routing: TeamMemberRoutingService, runtime: RuntimeRegistry) {
    this.db = db
    this.teams = teams
    this.routing = routing
    this.runtime = runtime
  }

  list(input: TeamDiscussionList): TeamDiscussionPage {
    this.teams.getTeam(input.teamId)
    const rows = this.db.sqlite.prepare(`
      SELECT id, seq, prompt, replies_json, created_at FROM team_discussion_turns
      WHERE team_id = ? AND seq < ? ORDER BY seq DESC LIMIT 21
    `).all(input.teamId, input.beforeSeq ?? Number.MAX_SAFE_INTEGER) as unknown as DiscussionRow[]
    const turns = rows.slice(0, 20).map(toTurn).reverse()
    return { turns, nextBeforeSeq: rows.length > 20 ? turns[0].seq : null }
  }

  async cancel(input: TeamDiscussionCancel): Promise<TeamDiscussionCancelResponse> {
    this.teams.getTeam(input.teamId)
    const active = this.activeTurns.get(input.teamId)
    if (!active || (input.operationId && active.operationId !== input.operationId)) {
      return { teamId: input.teamId, cancelled: false }
    }
    active.controller.abort(new Error('cancelled'))
    await Promise.all(
      [...active.activeRunIds].map((runId) => active.runtime.cancel(runId).catch(() => {})),
    )
    return { teamId: input.teamId, cancelled: true }
  }

  async abortAll(): Promise<void> {
    const entries = [...this.activeTurns.values()]
    for (const active of entries) {
      active.controller.abort(new Error('daemon_stopping'))
      await Promise.all(
        [...active.activeRunIds].map((runId) => active.runtime.cancel(runId).catch(() => {})),
      )
    }
    this.activeTurns.clear()
  }

  async send(input: TeamDiscussionSend): Promise<TeamDiscussionTurn> {
    const team = this.teams.getTeam(input.teamId)
    const runtime = this.runtime.getOfflineDiscussionRuntime()
    if (!runtime || team.archivedAt) {
      throw new DaemonError('TEAM_DISCUSSION_GATED', 'Group discussion is available only in offline mock mode for active teams', { statusCode: 403 })
    }
    const existing = this.db.sqlite.prepare(`
      SELECT id, seq, prompt, replies_json, created_at
      FROM team_discussion_turns WHERE team_id = ? AND operation_id = ?
    `).get(team.id, input.operationId) as unknown as DiscussionRow | undefined
    if (existing) {
      if (existing.prompt !== input.text) {
        throw new DaemonError('IDEMPOTENCY_CONFLICT', 'The discussion operation already has different text', { statusCode: 409 })
      }
      return toTurn(existing)
    }
    if (this.activeTurns.has(team.id) || this.activeTurns.size >= MAX_ACTIVE_DISCUSSIONS) {
      throw new DaemonError('TEAM_DISCUSSION_BUSY', 'Wait for the current discussion turn to finish', { statusCode: 409 })
    }

    const mentions = new Set([...input.text.matchAll(/(?:^|\s)@([a-zA-Z0-9_-]+)(?![a-zA-Z0-9_-])/g)].map((match) => match[1]))
    if ([...mentions].some((id) => id !== 'all' && !team.memberBotIds.includes(id))) {
      throw new DaemonError('TEAM_MEMBER_UNAVAILABLE', 'Mention only members of this group', { statusCode: 400 })
    }
    const targets = mentions.size === 0 || mentions.has('all')
      ? team.memberBotIds : team.memberBotIds.filter((id) => mentions.has(id))
    const rounds = input.rounds === 2 && targets.length > 1 ? 2 : 1
    const concurrency = Math.max(1, Math.min(MAX_DISCUSSION_CONCURRENCY, team.bounds.maxConcurrentTasks || MAX_DISCUSSION_CONCURRENCY))
    const durationLimitMs = Math.max(1_000, Math.min(MAX_DURATION_MS, team.bounds.maxDurationMs || DEFAULT_DURATION_MS))
    const totalCharBudget = Math.max(MAX_REPLY_CHARS, Math.min(MAX_TURN_TOTAL_CHARS, (team.bounds.maxTokens || 6000) * 4))

    const generation = this.runtime.getGeneration()
    const controller = new AbortController()
    const state: ActiveDiscussionState = {
      operationId: input.operationId,
      controller,
      runtime,
      activeRunIds: new Set<string>(),
    }
    this.activeTurns.set(team.id, state)

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('timeout'))
      for (const runId of state.activeRunIds) {
        void runtime.cancel(runId).catch(() => {})
      }
    }, durationLimitMs)

    try {
      const resolved = await Promise.all(targets.map(async (botId) => {
        const key = { teamId: team.id, botId }
        const choice = await this.routing.get(key)
        if (!choice.supported || !choice.effective.accountId ||
            !['mock', 'mock-offline'].includes(choice.effective.runtimeId)) {
          throw new DaemonError('TEAM_ROUTING_UNAVAILABLE', 'A targeted member cannot use offline discussion', { statusCode: 409 })
        }
        return { key, choice, accountId: choice.effective.accountId }
      }))

      let totalChars = 0
      const runMemberRound = async (
        target: (typeof resolved)[number],
        promptText: string,
        round: 1 | 2,
      ): Promise<TeamDiscussionTurn['replies'][number]> => {
        if (controller.signal.aborted) {
          throw new DaemonError(
            timedOut ? 'TEAM_DISCUSSION_TIMEOUT' : 'TEAM_DISCUSSION_CANCELLED',
            timedOut ? 'Group discussion exceeded time budget' : 'Group discussion stopped',
            { statusCode: timedOut ? 504 : 499 },
          )
        }
        if (generation !== this.runtime.getGeneration() || !this.runtime.getOfflineDiscussionRuntime()) {
          throw new DaemonError('TEAM_ROUTING_CHANGED', 'Offline runtime changed during discussion', { statusCode: 409 })
        }
        this.routing.revalidate(target.key, target.choice)
        const session = await runtime.createSession({
          agentId: target.key.botId,
          accountId: target.accountId,
          modelId: target.choice.effective.modelId,
          effort: target.choice.effective.effort,
          permission: 'read-only',
          workspace: '',
          instructions: '',
        })
        let text = ''
        let completed = false
        const runId = randomUUID()
        state.activeRunIds.add(runId)
        try {
          for await (const event of runtime.run({ runId, session, text: promptText })) {
            if (controller.signal.aborted) {
              throw new DaemonError(
                timedOut ? 'TEAM_DISCUSSION_TIMEOUT' : 'TEAM_DISCUSSION_CANCELLED',
                timedOut ? 'Group discussion exceeded time budget' : 'Group discussion stopped',
                { statusCode: timedOut ? 504 : 499 },
              )
            }
            if (event.type === 'message.delta') {
              const remainingTurnBudget = Math.max(0, totalCharBudget - totalChars - text.length)
              const maxAllowed = Math.min(MAX_REPLY_CHARS - text.length, remainingTurnBudget)
              if (maxAllowed > 0) {
                text += event.text.slice(0, maxAllowed)
              }
            } else if (event.type === 'run.completed') {
              completed = true
            } else if (event.type === 'run.cancelled') {
              throw new DaemonError(
                timedOut ? 'TEAM_DISCUSSION_TIMEOUT' : 'TEAM_DISCUSSION_CANCELLED',
                timedOut ? 'Group discussion exceeded time budget' : 'Group discussion stopped',
                { statusCode: timedOut ? 504 : 499 },
              )
            } else {
              throw new DaemonError('TEAM_DISCUSSION_EVENT_REJECTED', 'Offline discussion received a disallowed event', { statusCode: 502 })
            }
          }
        } finally {
          state.activeRunIds.delete(runId)
        }
        if (!completed || !text.trim()) {
          throw new DaemonError('TEAM_DISCUSSION_INCOMPLETE', 'Offline discussion did not complete', { statusCode: 502 })
        }
        totalChars += text.length
        return {
          botId: target.key.botId,
          routing: target.choice.effective,
          revision: target.choice.revision,
          text,
          round,
        }
      }

      const round1Replies = await runWithConcurrencyLimit(
        resolved,
        concurrency,
        (target) => runMemberRound(target, input.text, 1),
      )

      const replies: TeamDiscussionTurn['replies'] = [...round1Replies]

      if (rounds === 2 && totalChars < totalCharBudget) {
        const round2Replies = await runWithConcurrencyLimit(
          resolved,
          concurrency,
          (target) => {
            const peerNotes = round1Replies
              .filter((r) => r.botId !== target.key.botId)
              .map((r) => `@${r.botId}: ${r.text.slice(0, 240)}`)
              .join(' | ')
            const rebuttalPrompt = `Rebuttal round for: ${input.text.slice(0, 600)} [Peers: ${peerNotes.slice(0, 1200)}]`
            return runMemberRound(target, rebuttalPrompt, 2)
          },
        )
        replies.push(...round2Replies)
      }

      return this.db.transaction(() => {
        for (const { key, choice } of resolved) this.routing.revalidate(key, choice)
        if (generation !== this.runtime.getGeneration() || !this.runtime.getOfflineDiscussionRuntime()) {
          throw new DaemonError('TEAM_ROUTING_CHANGED', 'Offline runtime changed before saving discussion', { statusCode: 409 })
        }
        const id = randomUUID()
        const createdAt = new Date().toISOString()
        const row = this.db.sqlite.prepare(`
          INSERT INTO team_discussion_turns(id, team_id, operation_id, prompt, replies_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?) RETURNING seq
        `).get(id, team.id, input.operationId, input.text, JSON.stringify(replies), createdAt) as { seq: number }
        return { id, seq: row.seq, text: input.text, replies, createdAt }
      })
    } finally {
      clearTimeout(timer)
      this.activeTurns.delete(team.id)
    }
  }
}
