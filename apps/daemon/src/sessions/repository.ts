import { randomUUID } from 'node:crypto'
import type { DatabaseHandle } from '../db/client.ts'
import { DaemonError, redactSecrets, redactStructuredValue } from '../errors.ts'
import { ACTIVE_RUN_STATUSES } from '../execution/state-machine.ts'
import type { RunStatus } from '../execution/state-machine.ts'

export type MessageRole = 'user' | 'assistant' | 'system'
export type MessageStatus = 'complete' | 'streaming' | 'interrupted' | 'cancelled' | 'failed'

export interface SessionRecord {
  id: string
  agentId: string
  accountId: string
  runtimeId: string
  externalSessionId: string | null
  title: string
  createdAt: string
  updatedAt: string
  archivedAt: string | null
  lastMessagePreview?: string
  activeRunId?: string | null
  activeRunStatus?: RunStatus | null
  unread?: boolean
  lastCompletedRunStatus?: RunStatus | null
  lastReadAt?: string | null
}

export interface PersistedMessage {
  id: string
  sessionId: string
  role: MessageRole
  text: string
  meta?: Record<string, unknown>
  seqOrder: number
  status: MessageStatus
  runId: string | null
  createdAt: string
  updatedAt: string
}

interface RawSessionRow {
  id: string
  agent_id: string
  account_id: string
  runtime_id: string
  external_session_id: string | null
  title: string
  created_at: string
  updated_at: string
  archived_at: string | null
}

interface RawMessageRow {
  id: string
  session_id: string
  role: string
  content_json: string
  seq_order: number
  status: string
  created_at: string
  updated_at: string
  run_id: string | null
}

const ACTIVE_SESSION_BY_BOT_KEY = 'ui.activeSessionByBot.v1'
const SESSION_READ_AT_KEY = 'ui.sessionReadAt.v1'
const COMPLETED_OR_ATTENTION_RUN_STATUSES = new Set<RunStatus>([
  'completed',
  'failed',
  'interrupted',
  'cancelled',
  'awaiting_approval',
])

function parseMessageContent(contentJson: string): { text: string; meta?: Record<string, unknown> } {
  try {
    const parsed = JSON.parse(contentJson) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>
      const text = typeof obj.text === 'string' ? obj.text : ''
      const meta =
        obj.meta && typeof obj.meta === 'object' && !Array.isArray(obj.meta)
          ? (obj.meta as Record<string, unknown>)
          : undefined
      return meta ? { text, meta } : { text }
    }
  } catch {
    // ignore malformed content_json
  }
  return { text: '' }
}

function rowToSession(row: RawSessionRow): SessionRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    accountId: row.account_id,
    runtimeId: row.runtime_id,
    externalSessionId: row.external_session_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  }
}

function rowToMessage(row: RawMessageRow): PersistedMessage {
  const content = parseMessageContent(row.content_json)
  const role: MessageRole =
    row.role === 'user' || row.role === 'assistant' || row.role === 'system' ? row.role : 'assistant'
  const status: MessageStatus =
    row.status === 'complete' ||
    row.status === 'streaming' ||
    row.status === 'interrupted' ||
    row.status === 'cancelled' ||
    row.status === 'failed'
      ? row.status
      : 'complete'

  return {
    id: row.id,
    sessionId: row.session_id,
    role,
    text: content.text,
    ...(content.meta ? { meta: content.meta } : {}),
    seqOrder: Number(row.seq_order),
    status,
    runId: row.run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function serializeMessageContent(text: string, meta?: Record<string, unknown>): string {
  const safeText = redactSecrets(text)
  const payload: Record<string, unknown> = { text: safeText }
  if (meta && Object.keys(meta).length > 0) {
    payload.meta = redactStructuredValue(meta)
  }
  return JSON.stringify(payload)
}

export class SessionRepository {
  private readonly dbHandle: DatabaseHandle

  constructor(dbHandle: DatabaseHandle) {
    this.dbHandle = dbHandle
  }

  private assertActiveBot(agentId: string): { id: string; runtimeId: string } {
    const row = this.dbHandle.sqlite
      .prepare('SELECT id, runtime_id, archived_at FROM agents WHERE id = ?')
      .get(agentId) as { id: string; runtime_id: string; archived_at: string | null } | undefined

    if (!row || row.archived_at !== null) {
      throw new DaemonError('BOT_NOT_FOUND', `Bot "${agentId}" was not found or is archived`, {
        statusCode: 404,
      })
    }
    return { id: row.id, runtimeId: row.runtime_id }
  }

  private readSettingsStringMap(key: string): Record<string, string> {
    const row = this.dbHandle.sqlite
      .prepare('SELECT value_json FROM settings WHERE key = ?')
      .get(key) as { value_json: string } | undefined

    if (!row) return {}
    try {
      const parsed = JSON.parse(row.value_json) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out: Record<string, string> = {}
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string' && v.length > 0) {
            out[k] = v
          }
        }
        return out
      }
    } catch {
      // ignore corrupted map
    }
    return {}
  }

  private writeSettingsStringMap(key: string, map: Record<string, string>, now = new Date().toISOString()): void {
    this.dbHandle.sqlite
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(map), now)
  }

  private readActiveSessionMap(): Record<string, string> {
    return this.readSettingsStringMap(ACTIVE_SESSION_BY_BOT_KEY)
  }

  private writeActiveSessionMap(map: Record<string, string>): void {
    this.writeSettingsStringMap(ACTIVE_SESSION_BY_BOT_KEY, map)
  }

  private readSessionReadAtMap(): Record<string, string> {
    return this.readSettingsStringMap(SESSION_READ_AT_KEY)
  }

  private writeSessionReadAtMap(map: Record<string, string>, now?: string): void {
    this.writeSettingsStringMap(SESSION_READ_AT_KEY, map, now)
  }

  private enrichSessionIndicatorFields(
    session: SessionRecord,
    readAtMap: Record<string, string>,
  ): SessionRecord {
    const lastRun = this.dbHandle.sqlite
      .prepare(
        `SELECT id, status, ended_at, created_at
         FROM runs
         WHERE session_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(session.id) as
      | { id: string; status: RunStatus; ended_at: string | null; created_at: string }
      | undefined

    const lastCompletedRunStatus =
      lastRun && COMPLETED_OR_ATTENTION_RUN_STATUSES.has(lastRun.status) ? lastRun.status : null

    const lastAssistantMsg = this.dbHandle.sqlite
      .prepare(
        `SELECT created_at
         FROM messages
         WHERE session_id = ? AND role != 'user'
         ORDER BY seq_order DESC, created_at DESC
         LIMIT 1`,
      )
      .get(session.id) as { created_at: string } | undefined

    const runActivityAt =
      lastRun && COMPLETED_OR_ATTENTION_RUN_STATUSES.has(lastRun.status)
        ? (lastRun.ended_at ?? lastRun.created_at)
        : null
    const msgActivityAt = lastAssistantMsg?.created_at ?? null
    const latestActivityAt =
      runActivityAt && msgActivityAt
        ? runActivityAt > msgActivityAt
          ? runActivityAt
          : msgActivityAt
        : (runActivityAt ?? msgActivityAt)

    const lastReadAt = readAtMap[session.id] ?? null
    const unread = Boolean(latestActivityAt && (!lastReadAt || latestActivityAt > lastReadAt))

    session.lastCompletedRunStatus = lastCompletedRunStatus
    session.lastReadAt = lastReadAt
    session.unread = unread
    return session
  }

  getActiveSessionId(agentId: string): string | null {
    const map = this.readActiveSessionMap()
    const candidate = map[agentId]
    if (!candidate) return null

    const row = this.dbHandle.sqlite
      .prepare('SELECT id FROM sessions WHERE id = ? AND agent_id = ? AND archived_at IS NULL')
      .get(candidate, agentId) as { id: string } | undefined

    return row?.id ?? null
  }

  setActiveSessionId(
    agentId: string,
    sessionId: string | null,
  ): { agentId: string; activeSessionId: string | null } {
    this.assertActiveBot(agentId)

    return this.dbHandle.transaction(() => {
      const map = this.readActiveSessionMap()
      if (sessionId === null) {
        delete map[agentId]
        this.writeActiveSessionMap(map)
        return { agentId, activeSessionId: null }
      }

      const row = this.dbHandle.sqlite
        .prepare('SELECT id FROM sessions WHERE id = ? AND agent_id = ? AND archived_at IS NULL')
        .get(sessionId, agentId) as { id: string } | undefined

      if (!row) {
        throw new DaemonError(
          'SESSION_NOT_FOUND',
          `Session "${sessionId}" does not exist for bot "${agentId}" or is archived`,
          { statusCode: 404 },
        )
      }

      map[agentId] = sessionId
      this.writeActiveSessionMap(map)
      const readAtMap = this.readSessionReadAtMap()
      readAtMap[sessionId] = new Date().toISOString()
      this.writeSessionReadAtMap(readAtMap)
      return { agentId, activeSessionId: sessionId }
    })
  }

  markSessionRead(sessionId: string): { sessionId: string; lastReadAt: string } {
    const existing = this.getSession(sessionId)
    if (existing.archivedAt !== null) {
      throw new DaemonError('SESSION_ARCHIVED', 'Cannot mark an archived session as read', {
        statusCode: 409,
      })
    }
    const now = new Date().toISOString()
    return this.dbHandle.transaction(() => {
      const readAtMap = this.readSessionReadAtMap()
      readAtMap[sessionId] = now
      this.writeSessionReadAtMap(readAtMap, now)
      return { sessionId, lastReadAt: now }
    })
  }

  pruneReadStateForBotInTx(agentId: string, now: string): void {
    const sessionRows = this.dbHandle.sqlite
      .prepare('SELECT id FROM sessions WHERE agent_id = ?')
      .all(agentId) as Array<{ id: string }>
    const activeMap = this.readActiveSessionMap()
    if (activeMap[agentId]) {
      delete activeMap[agentId]
      this.writeSettingsStringMap(ACTIVE_SESSION_BY_BOT_KEY, activeMap, now)
    }
    if (sessionRows.length === 0) return
    const readAtMap = this.readSessionReadAtMap()
    let changed = false
    for (const row of sessionRows) {
      if (readAtMap[row.id]) {
        delete readAtMap[row.id]
        changed = true
      }
    }
    if (changed) {
      this.writeSessionReadAtMap(readAtMap, now)
    }
  }

  listSessions(
    agentId: string,
    options?: { limit?: number; offset?: number; includeArchived?: boolean },
  ): { sessions: SessionRecord[]; activeSessionId: string | null; total: number } {
    this.assertActiveBot(agentId)

    const limit = Math.min(100, Math.max(1, Math.floor(options?.limit ?? 50)))
    const offset = Math.max(0, Math.floor(options?.offset ?? 0))
    const includeArchived = options?.includeArchived ?? false

    const whereClause = includeArchived
      ? 'WHERE agent_id = ?'
      : 'WHERE agent_id = ? AND archived_at IS NULL'

    const countRow = this.dbHandle.sqlite
      .prepare(`SELECT COUNT(*) AS cnt FROM sessions ${whereClause}`)
      .get(agentId) as { cnt: number } | undefined
    const total = Number(countRow?.cnt ?? 0)

    const rows = this.dbHandle.sqlite
      .prepare(
        `SELECT id, agent_id, account_id, runtime_id, external_session_id, title, created_at, updated_at, archived_at
         FROM sessions
         ${whereClause}
         ORDER BY updated_at DESC, created_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(agentId, limit, offset) as unknown as RawSessionRow[]

    const activePlaceholders = ACTIVE_RUN_STATUSES.map(() => '?').join(', ')
    const readAtMap = this.readSessionReadAtMap()
    const sessions: SessionRecord[] = rows.map((row) => {
      const session = rowToSession(row)
      const lastMsg = this.dbHandle.sqlite
        .prepare(
          `SELECT content_json FROM messages WHERE session_id = ? ORDER BY seq_order DESC, created_at DESC LIMIT 1`,
        )
        .get(row.id) as { content_json: string } | undefined
      if (lastMsg) {
        const { text } = parseMessageContent(lastMsg.content_json)
        session.lastMessagePreview = text.slice(0, 140)
      }

      const activeRun = this.dbHandle.sqlite
        .prepare(
          `SELECT id, status FROM runs WHERE session_id = ? AND status IN (${activePlaceholders}) ORDER BY created_at DESC LIMIT 1`,
        )
        .get(row.id, ...ACTIVE_RUN_STATUSES) as { id: string; status: RunStatus } | undefined
      session.activeRunId = activeRun?.id ?? null
      session.activeRunStatus = activeRun?.status ?? null
      return this.enrichSessionIndicatorFields(session, readAtMap)
    })

    return {
      sessions,
      activeSessionId: this.getActiveSessionId(agentId),
      total,
    }
  }

  createSession(input: { agentId: string; title?: string }): SessionRecord {
    const bot = this.assertActiveBot(input.agentId)
    const rawTitle = (input.title ?? '').trim()
    const title = (rawTitle.length > 0 ? rawTitle : 'New conversation').slice(0, 120)
    const now = new Date().toISOString()
    const id = `sess_${randomUUID()}`

    return this.dbHandle.transaction(() => {
      this.dbHandle.sqlite
        .prepare(
          `INSERT INTO sessions (id, agent_id, account_id, runtime_id, external_session_id, title, created_at, updated_at, archived_at)
           VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL)`,
        )
        .run(id, bot.id, 'local', bot.runtimeId, title, now, now)

      const map = this.readActiveSessionMap()
      map[bot.id] = id
      this.writeActiveSessionMap(map)
      const readAtMap = this.readSessionReadAtMap()
      readAtMap[id] = now
      this.writeSessionReadAtMap(readAtMap, now)

      return {
        id,
        agentId: bot.id,
        accountId: 'local',
        runtimeId: bot.runtimeId,
        externalSessionId: null,
        title,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        activeRunId: null,
        activeRunStatus: null,
        unread: false,
        lastCompletedRunStatus: null,
        lastReadAt: now,
      }
    })
  }

  getSession(sessionId: string): SessionRecord {
    const row = this.dbHandle.sqlite
      .prepare(
        `SELECT id, agent_id, account_id, runtime_id, external_session_id, title, created_at, updated_at, archived_at
         FROM sessions
         WHERE id = ?`,
      )
      .get(sessionId) as RawSessionRow | undefined

    if (!row) {
      throw new DaemonError('SESSION_NOT_FOUND', `Session "${sessionId}" was not found`, {
        statusCode: 404,
      })
    }

    const session = rowToSession(row)
    const activePlaceholders = ACTIVE_RUN_STATUSES.map(() => '?').join(', ')
    const activeRun = this.dbHandle.sqlite
      .prepare(
        `SELECT id, status FROM runs WHERE session_id = ? AND status IN (${activePlaceholders}) ORDER BY created_at DESC LIMIT 1`,
      )
      .get(row.id, ...ACTIVE_RUN_STATUSES) as { id: string; status: RunStatus } | undefined
    session.activeRunId = activeRun?.id ?? null
    session.activeRunStatus = activeRun?.status ?? null
    return this.enrichSessionIndicatorFields(session, this.readSessionReadAtMap())
  }

  renameSession(sessionId: string, title: string): SessionRecord {
    const trimmed = title.trim().slice(0, 120)
    if (!trimmed) {
      throw new DaemonError('INVALID_SESSION_TITLE', 'Session title cannot be empty', {
        statusCode: 400,
      })
    }

    const existing = this.getSession(sessionId)
    if (existing.archivedAt !== null) {
      throw new DaemonError('SESSION_ARCHIVED', 'Cannot rename an archived session', {
        statusCode: 409,
      })
    }

    const now = new Date().toISOString()
    this.dbHandle.sqlite
      .prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?')
      .run(trimmed, now, sessionId)

    return {
      ...existing,
      title: trimmed,
      updatedAt: now,
    }
  }

  archiveSession(sessionId: string): { archivedId: string; activeSessionId: string | null } {
    const existing = this.getSession(sessionId)
    if (existing.archivedAt !== null) {
      return {
        archivedId: sessionId,
        activeSessionId: this.getActiveSessionId(existing.agentId),
      }
    }

    const activePlaceholders = ACTIVE_RUN_STATUSES.map(() => '?').join(', ')
    const activeRun = this.dbHandle.sqlite
      .prepare(
        `SELECT id FROM runs WHERE session_id = ? AND status IN (${activePlaceholders}) LIMIT 1`,
      )
      .get(sessionId, ...ACTIVE_RUN_STATUSES) as { id: string } | undefined

    if (activeRun) {
      throw new DaemonError(
        'ACTIVE_RUN_EXISTS',
        `Cannot archive session "${sessionId}" while run "${activeRun.id}" is still active`,
        { statusCode: 409 },
      )
    }

    const now = new Date().toISOString()
    return this.dbHandle.transaction(() => {
      this.dbHandle.sqlite
        .prepare('UPDATE sessions SET archived_at = ?, updated_at = ? WHERE id = ?')
        .run(now, now, sessionId)

      const map = this.readActiveSessionMap()
      if (map[existing.agentId] === sessionId) {
        const nextRow = this.dbHandle.sqlite
          .prepare(
            `SELECT id FROM sessions WHERE agent_id = ? AND archived_at IS NULL ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
          )
          .get(existing.agentId) as { id: string } | undefined
        if (nextRow) {
          map[existing.agentId] = nextRow.id
        } else {
          delete map[existing.agentId]
        }
        this.writeActiveSessionMap(map)
      }

      const readAtMap = this.readSessionReadAtMap()
      if (readAtMap[sessionId]) {
        delete readAtMap[sessionId]
        this.writeSessionReadAtMap(readAtMap, now)
      }

      return {
        archivedId: sessionId,
        activeSessionId: this.getActiveSessionId(existing.agentId),
      }
    })
  }

  getSessionMessages(
    sessionId: string,
    options?: { limit?: number; offset?: number },
  ): { session: SessionRecord; messages: PersistedMessage[]; total: number; hasMore: boolean } {
    const session = this.getSession(sessionId)
    const limit = Math.min(500, Math.max(1, Math.floor(options?.limit ?? 200)))
    const offset = Math.max(0, Math.floor(options?.offset ?? 0))

    const countRow = this.dbHandle.sqlite
      .prepare('SELECT COUNT(*) AS cnt FROM messages WHERE session_id = ?')
      .get(sessionId) as { cnt: number } | undefined
    const total = Number(countRow?.cnt ?? 0)

    const rows = this.dbHandle.sqlite
      .prepare(
        `SELECT id, session_id, role, content_json, seq_order, status, created_at, updated_at, run_id
         FROM messages
         WHERE session_id = ?
         ORDER BY seq_order ASC, created_at ASC
         LIMIT ? OFFSET ?`,
      )
      .all(sessionId, limit, offset) as unknown as RawMessageRow[]

    const messages = rows.map(rowToMessage)
    return {
      session,
      messages,
      total,
      hasMore: offset + messages.length < total,
    }
  }
}
