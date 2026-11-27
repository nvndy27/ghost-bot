import { randomUUID } from 'node:crypto'
import type {
  CreateTeamInput,
  TeamMessageRecord,
  TeamMessageSenderType,
  TeamMessageType,
  TeamMessageVisibility,
  TeamRecord,
} from '../contracts/types.ts'
import {
  assertNonEmptyBounded,
  assertTeamOwner,
  MAX_MESSAGE_BYTES,
  MAX_TEAM_MEMBERS,
  redactTeamSecrets,
  TeamError,
  validateBounds,
  validateCreateTeamInput,
} from '../security/validation.ts'
import { createBorrowedTeamDatabaseHandle, type TeamDatabaseHandle } from './sqlite-store.ts'
export { createBorrowedTeamDatabaseHandle }

interface RawTeamRow {
  id: string
  name: string
  description: string
  owner_id: string
  lead_bot_id: string
  member_bot_ids_json: string
  memory_sharing_policy: string
  bounds_json: string
  archived_at: string | null
  created_at: string
  updated_at: string
}

interface RawMessageRow {
  id: string
  team_id: string
  team_run_id: string | null
  conversation_id: string | null
  owner_id: string
  author_bot_id: string
  target_bot_id: string | null
  originating_task_id: string
  sender_type: TeamMessageSenderType
  message_type: TeamMessageType
  visibility: TeamMessageVisibility
  untrusted: number
  seq: number
  content: string
  created_at: string
}

export class TeamRepository {
  private readonly db: TeamDatabaseHandle

  constructor(db: TeamDatabaseHandle) {
    this.db = db
  }

  getDatabase(): TeamDatabaseHandle {
    return this.db
  }

  private rowToTeam(row: RawTeamRow): TeamRecord {
    let members: unknown
    let boundsRaw: unknown
    try {
      members = JSON.parse(row.member_bot_ids_json)
      boundsRaw = JSON.parse(row.bounds_json)
    } catch {
      throw new TeamError('CORRUPT_RECORD', `Corrupt JSON in team "${row.id}"`)
    }
    if (!Array.isArray(members)) {
      throw new TeamError('CORRUPT_RECORD', `Corrupt member list in team "${row.id}"`)
    }
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      ownerId: row.owner_id,
      leadBotId: row.lead_bot_id,
      memberBotIds: members.map(String),
      memorySharingPolicy: 'explicit-only',
      bounds: validateBounds(boundsRaw as Record<string, number>),
      archivedAt: row.archived_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  createTeam(input: CreateTeamInput, nowMs = Date.now()): TeamRecord {
    const clean = validateCreateTeamInput(input)
    const id = input.id ?? `team_${randomUUID()}`
    const nowIso = new Date(nowMs).toISOString()

    return this.db.transaction(() => {
      this.db.sqlite
        .prepare(
          `INSERT INTO teams (
            id, name, description, owner_id, lead_bot_id, member_bot_ids_json,
            memory_sharing_policy, bounds_json, archived_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'explicit-only', ?, NULL, ?, ?)`,
        )
        .run(
          id,
          clean.name,
          clean.description,
          clean.ownerId,
          clean.leadBotId,
          JSON.stringify(clean.memberBotIds),
          JSON.stringify(clean.bounds),
          nowIso,
          nowIso,
        )
      return this.getTeam(id, clean.ownerId)
    })
  }

  getTeam(teamId: string, ownerId: string): TeamRecord {
    const row = this.db.sqlite
      .prepare(`SELECT * FROM teams WHERE id = ?`)
      .get(teamId) as RawTeamRow | undefined
    if (!row) {
      throw new TeamError('TEAM_NOT_FOUND', `Team "${teamId}" was not found`)
    }
    assertTeamOwner(ownerId, row.owner_id)
    return this.rowToTeam(row)
  }

  listTeams(
    ownerId: string,
    options: { limit?: number; offset?: number; includeArchived?: boolean } = {},
  ): { teams: TeamRecord[]; total: number } {
    const limit = Math.min(Math.max(1, options.limit ?? 50), 100)
    const offset = Math.max(0, options.offset ?? 0)
    const archiveClause = options.includeArchived ? '' : 'AND archived_at IS NULL'
    const cnt = this.db.sqlite
      .prepare(`SELECT COUNT(*) AS cnt FROM teams WHERE owner_id = ? ${archiveClause}`)
      .get(ownerId) as { cnt: number }
    const rows = this.db.sqlite
      .prepare(
        `SELECT * FROM teams WHERE owner_id = ? ${archiveClause}
         ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(ownerId, limit, offset) as unknown as RawTeamRow[]
    return {
      teams: rows.map((r) => this.rowToTeam(r)),
      total: Number(cnt?.cnt ?? 0),
    }
  }

  archiveTeam(teamId: string, ownerId: string, nowMs = Date.now()): TeamRecord {
    const nowIso = new Date(nowMs).toISOString()
    return this.db.transaction(() => {
      this.getTeam(teamId, ownerId)
      this.db.sqlite
        .prepare(`UPDATE teams SET archived_at = COALESCE(archived_at, ?), updated_at = ? WHERE id = ?`)
        .run(nowIso, nowIso, teamId)
      return this.getTeam(teamId, ownerId)
    })
  }

  updateTeamMembers(
    teamId: string,
    ownerId: string,
    memberBotIds: string[],
    nowMs = Date.now(),
  ): TeamRecord {
    if (!Array.isArray(memberBotIds) || memberBotIds.length === 0) {
      throw new TeamError('INVALID_INPUT', 'memberBotIds must be a non-empty array')
    }
    const nowIso = new Date(nowMs).toISOString()
    return this.db.transaction(() => {
      const team = this.getTeam(teamId, ownerId)
      if (team.archivedAt !== null) {
        throw new TeamError('TEAM_ARCHIVED', 'Cannot update members on an archived team')
      }
      const dedup = new Set<string>()
      for (const m of memberBotIds) {
        dedup.add(assertNonEmptyBounded(m, 'memberBotId', 128))
      }
      if (!dedup.has(team.leadBotId)) {
        throw new TeamError('INVALID_INPUT', 'Cannot remove leadBotId (Chief of Staff) from team')
      }
      if (dedup.size > MAX_TEAM_MEMBERS) {
        throw new TeamError('INVALID_INPUT', `Team cannot exceed ${MAX_TEAM_MEMBERS} members`)
      }
      this.db.sqlite
        .prepare(`UPDATE teams SET member_bot_ids_json = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify([...dedup]), nowIso, team.id)
      return this.getTeam(team.id, ownerId)
    })
  }

  private rowToMessage(row: RawMessageRow): TeamMessageRecord {
    return {
      id: row.id,
      teamId: row.team_id,
      teamRunId: row.team_run_id ?? null,
      conversationId: row.conversation_id ?? null,
      ownerId: row.owner_id,
      authorBotId: row.author_bot_id,
      targetBotId: row.target_bot_id,
      originatingTaskId: row.originating_task_id,
      senderType: row.sender_type ?? 'worker',
      messageType: row.message_type ?? 'worker_progress',
      visibility: row.visibility ?? 'team',
      untrusted: Number(row.untrusted ?? 1) === 1,
      seq: Number(row.seq),
      content: row.content,
      createdAt: row.created_at,
    }
  }

  /**
   * Posts a team/agent-to-agent message preserving authorBotId, originatingTaskId,
   * senderType, messageType, visibility, and untrusted flag for worker data.
   */
  postMessage(
    input: {
      teamId: string
      ownerId: string
      authorBotId: string
      targetBotId?: string | null
      originatingTaskId: string
      teamRunId?: string | null
      conversationId?: string | null
      senderType?: TeamMessageSenderType
      messageType?: TeamMessageType
      visibility?: TeamMessageVisibility
      content: string
    },
    nowMs = Date.now(),
  ): TeamMessageRecord {
    const content = assertNonEmptyBounded(
      redactTeamSecrets(input.content),
      'message.content',
      MAX_MESSAGE_BYTES,
    )
    const nowIso = new Date(nowMs).toISOString()
    const senderType: TeamMessageSenderType = input.senderType ?? 'worker'
    const messageType: TeamMessageType = input.messageType ?? 'worker_progress'
    const visibility: TeamMessageVisibility =
      input.visibility ?? (input.targetBotId ? 'direct' : 'team')
    const untrusted = senderType === 'worker' ? 1 : 0

    return this.db.transaction(() => {
      const team = this.getTeam(input.teamId, input.ownerId)
      if (senderType === 'user' && input.authorBotId !== team.ownerId) {
        throw new TeamError('SENDER_SPOOFING', 'User message authorBotId must match authenticated ownerId')
      }
      if (senderType === 'chief_of_staff' && input.authorBotId !== team.leadBotId) {
        throw new TeamError('SENDER_SPOOFING', 'Chief of Staff message authorBotId must match team leadBotId')
      }
      if (senderType === 'system' && input.authorBotId !== 'system') {
        throw new TeamError('SENDER_SPOOFING', 'System message authorBotId must be "system"')
      }
      if (senderType === 'worker' && !team.memberBotIds.includes(input.authorBotId)) {
        throw new TeamError('NON_MEMBER_BOT', `Author "${input.authorBotId}" is not a team member`)
      }
      if (input.targetBotId && !team.memberBotIds.includes(input.targetBotId)) {
        throw new TeamError('NON_MEMBER_BOT', `Target "${input.targetBotId}" is not a team member`)
      }

      const taskRow = this.db.sqlite
        .prepare(`SELECT id, team_id, owner_id, team_run_id FROM team_tasks WHERE id = ?`)
        .get(input.originatingTaskId) as
        | { id: string; team_id: string; owner_id: string; team_run_id: string | null }
        | undefined
      if (!taskRow || taskRow.team_id !== team.id || taskRow.owner_id !== input.ownerId) {
        throw new TeamError('TASK_NOT_FOUND', 'Originating task not found in team scope')
      }
      if (input.teamRunId && taskRow.team_run_id && taskRow.team_run_id !== input.teamRunId) {
        throw new TeamError('SCOPE_FORBIDDEN', 'Originating task belongs to a different team run')
      }
      const effectiveRunId = input.teamRunId ?? taskRow.team_run_id ?? null

      if (effectiveRunId) {
        const runRow = this.db.sqlite
          .prepare(`SELECT id, team_id, owner_id FROM team_runs WHERE id = ?`)
          .get(effectiveRunId) as { id: string; team_id: string; owner_id: string } | undefined
        if (!runRow || runRow.team_id !== team.id || runRow.owner_id !== input.ownerId) {
          throw new TeamError('SCOPE_FORBIDDEN', 'Team run not found in team/owner scope')
        }
      }

      if (effectiveRunId) {
        const runMsgCount = this.db.sqlite
          .prepare(`SELECT COUNT(*) AS cnt FROM team_messages WHERE team_run_id = ?`)
          .get(effectiveRunId) as { cnt: number }
        if (Number(runMsgCount?.cnt ?? 0) >= team.bounds.maxMessages) {
          throw new TeamError(
            'MESSAGE_LIMIT_EXCEEDED',
            `Team run "${effectiveRunId}" reached maxMessages (${team.bounds.maxMessages})`,
          )
        }
      } else {
        const teamMsgCount = this.db.sqlite
          .prepare(`SELECT COUNT(*) AS cnt FROM team_messages WHERE team_id = ?`)
          .get(team.id) as { cnt: number }
        if (Number(teamMsgCount?.cnt ?? 0) >= team.bounds.maxMessages) {
          throw new TeamError(
            'MESSAGE_LIMIT_EXCEEDED',
            `Team "${team.id}" reached maxMessages (${team.bounds.maxMessages})`,
          )
        }
      }

      const seqRow = this.db.sqlite
        .prepare(`SELECT COALESCE(MAX(seq), 0) AS max_seq FROM team_messages WHERE team_id = ?`)
        .get(team.id) as { max_seq: number }
      const nextSeq = Number(seqRow?.max_seq ?? 0) + 1
      const id = `tmsg_${randomUUID()}`

      this.db.sqlite
        .prepare(
          `INSERT INTO team_messages (
            id, team_id, team_run_id, conversation_id, owner_id, author_bot_id,
            target_bot_id, originating_task_id, sender_type, message_type,
            visibility, untrusted, seq, content, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          team.id,
          effectiveRunId,
          input.conversationId ?? null,
          input.ownerId,
          input.authorBotId,
          input.targetBotId ?? null,
          input.originatingTaskId,
          senderType,
          messageType,
          visibility,
          untrusted,
          nextSeq,
          content,
          nowIso,
        )

      if (effectiveRunId) {
        this.db.sqlite
          .prepare(`UPDATE team_runs SET messages_posted = messages_posted + 1, updated_at = ? WHERE id = ?`)
          .run(nowIso, effectiveRunId)
      }

      const row = this.db.sqlite
        .prepare(`SELECT * FROM team_messages WHERE id = ?`)
        .get(id) as unknown as RawMessageRow
      return this.rowToMessage(row)
    })
  }

  listMessages(
    teamId: string,
    ownerId: string,
    options: {
      limit?: number
      afterSeq?: number
      teamRunId?: string
      conversationId?: string
      viewerBotId?: string
    } = {},
  ): TeamMessageRecord[] {
    const team = this.getTeam(teamId, ownerId)
    if (options.viewerBotId && !team.memberBotIds.includes(options.viewerBotId)) {
      throw new TeamError('NON_MEMBER_BOT', `Viewer "${options.viewerBotId}" is not a team member`)
    }
    const limit = Math.min(Math.max(1, options.limit ?? 50), 200)
    const afterSeq = Math.max(0, options.afterSeq ?? 0)
    const clauses = ['team_id = ?', 'owner_id = ?', 'seq > ?']
    const params: Array<string | number> = [teamId, ownerId, afterSeq]

    if (options.teamRunId) {
      clauses.push('team_run_id = ?')
      params.push(options.teamRunId)
    }
    if (options.conversationId) {
      clauses.push('conversation_id = ?')
      params.push(options.conversationId)
    }
    if (options.viewerBotId) {
      if (options.viewerBotId === team.leadBotId) {
        clauses.push(
          `(visibility IN ('team', 'user_and_cos') OR (visibility = 'direct' AND (author_bot_id = ? OR target_bot_id = ?)))`,
        )
        params.push(options.viewerBotId, options.viewerBotId)
      } else {
        clauses.push(
          `(visibility = 'team' OR (visibility = 'direct' AND (author_bot_id = ? OR target_bot_id = ?)))`,
        )
        params.push(options.viewerBotId, options.viewerBotId)
      }
    }
    params.push(limit)

    const rows = this.db.sqlite
      .prepare(
        `SELECT * FROM team_messages
         WHERE ${clauses.join(' AND ')}
         ORDER BY seq ASC LIMIT ?`,
      )
      .all(...params) as unknown as RawMessageRow[]
    return rows.map((r) => this.rowToMessage(r))
  }

  /**
   * Prunes old terminal, confirmed team runs and messages beyond retention limits.
   * Never deletes active runs, uncertain tasks, tasks with locked reservations, or recent deduplication keys.
   */
  pruneCompletedHistory(
    teamId: string,
    ownerId: string,
    options: { retainRuns: number; retainMessages: number },
  ): { deletedRuns: number; deletedMessages: number } {
    const retainRuns = Math.max(0, Math.floor(options.retainRuns))
    const retainMessages = Math.max(0, Math.floor(options.retainMessages))

    return this.db.transaction(() => {
      const team = this.getTeam(teamId, ownerId)

      const prunableRuns = this.db.sqlite
        .prepare(
          `SELECT id FROM team_runs
           WHERE team_id = ? AND owner_id = ?
             AND status IN ('completed', 'failed', 'cancelled', 'partial_failure')
             AND NOT EXISTS (
               SELECT 1 FROM team_tasks t
               WHERE t.team_run_id = team_runs.id
                 AND (t.status IN ('queued', 'running', 'awaiting_approval', 'uncertain')
                      OR t.reserved_tokens > 0
                      OR t.termination_confirmed = 0)
             )
           ORDER BY created_at DESC`,
        )
        .all(team.id, ownerId) as Array<{ id: string }>

      let deletedRuns = 0
      const runsToDelete = prunableRuns.slice(retainRuns)
      for (const r of runsToDelete) {
        // CASCADE deletes team_task_dependencies; delete messages & tasks explicitly for clarity
        this.db.sqlite.prepare(`DELETE FROM team_messages WHERE team_run_id = ?`).run(r.id)
        this.db.sqlite.prepare(`DELETE FROM team_tasks WHERE team_run_id = ?`).run(r.id)
        const res = this.db.sqlite.prepare(`DELETE FROM team_runs WHERE id = ?`).run(r.id)
        deletedRuns += Number(res.changes)
      }

      // Prune remaining messages only if they belong to confirmed terminal tasks beyond retainMessages
      const totalMsgRow = this.db.sqlite
        .prepare(`SELECT COUNT(*) AS cnt FROM team_messages WHERE team_id = ? AND owner_id = ?`)
        .get(team.id, ownerId) as { cnt: number }
      const excess = Math.max(0, Number(totalMsgRow?.cnt ?? 0) - retainMessages)
      let deletedMessages = 0
      if (excess > 0) {
        const res = this.db.sqlite
          .prepare(
            `DELETE FROM team_messages
             WHERE id IN (
               SELECT m.id FROM team_messages m
               JOIN team_tasks t ON t.id = m.originating_task_id
               WHERE m.team_id = ? AND m.owner_id = ?
                 AND t.status IN ('completed', 'failed', 'cancelled', 'blocked', 'budget_exhausted', 'stopped_by_parent')
                 AND t.reserved_tokens = 0
                 AND t.termination_confirmed = 1
               ORDER BY m.seq ASC
               LIMIT ?
             )`,
          )
          .run(team.id, ownerId, excess)
        deletedMessages = Number(res.changes)
      }

      return { deletedRuns, deletedMessages }
    })
  }
}
