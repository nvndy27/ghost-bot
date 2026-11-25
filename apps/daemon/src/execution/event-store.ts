import { randomUUID } from 'node:crypto'
import type { DatabaseHandle } from '../db/client.ts'
import { DaemonError, redactStructuredValue } from '../errors.ts'

export const MAX_EVENT_PAYLOAD_BYTES = 65_536

export interface PersistedRunEvent {
  id: string
  runId: string
  seq: number
  eventKey: string
  type: string
  payload: Record<string, unknown>
  timestamp: string
}

export interface AppendRunEventInput {
  eventKey: string
  type: string
  payload: Record<string, unknown>
  timestamp?: string
}

export interface AppendRunEventResult {
  inserted: boolean
  event: PersistedRunEvent
}

export interface ListRunEventsResult {
  events: PersistedRunEvent[]
  hasMore: boolean
  lastSeq: number
}

interface RawEventRow {
  id: string
  run_id: string
  seq: number
  event_key: string
  type: string
  payload_json: string
  timestamp: string
}

function rowToEvent(row: RawEventRow): PersistedRunEvent {
  let payload: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(row.payload_json) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>
    }
  } catch {
    payload = {}
  }

  return {
    id: row.id,
    runId: row.run_id,
    seq: Number(row.seq),
    eventKey: row.event_key,
    type: row.type,
    payload,
    timestamp: row.timestamp,
  }
}

export class RunEventStore {
  private readonly dbHandle: DatabaseHandle

  constructor(dbHandle: DatabaseHandle) {
    this.dbHandle = dbHandle
  }

  appendEvent(runId: string, input: AppendRunEventInput): AppendRunEventResult {
    const redacted = redactStructuredValue(input.payload) as Record<string, unknown>
    const payloadJson = JSON.stringify(redacted)
    if (Buffer.byteLength(payloadJson, 'utf8') > MAX_EVENT_PAYLOAD_BYTES) {
      throw new DaemonError(
        'EVENT_PAYLOAD_TOO_LARGE',
        `Run event payload exceeds maximum size of ${MAX_EVENT_PAYLOAD_BYTES} bytes`,
        { statusCode: 400 },
      )
    }

    const timestamp = input.timestamp ?? new Date().toISOString()

    const writeEvent = (): AppendRunEventResult => {
      const existing = this.dbHandle.sqlite
        .prepare(
          `SELECT id, run_id, seq, event_key, type, payload_json, timestamp
           FROM run_events
           WHERE run_id = ? AND event_key = ?`,
        )
        .get(runId, input.eventKey) as RawEventRow | undefined

      if (existing) {
        return {
          inserted: false,
          event: rowToEvent(existing),
        }
      }

      const maxRow = this.dbHandle.sqlite
        .prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM run_events WHERE run_id = ?')
        .get(runId) as { max_seq: number } | undefined

      const nextSeq = Number(maxRow?.max_seq ?? 0) + 1
      const id = `evt_${randomUUID()}`

      this.dbHandle.sqlite
        .prepare(
          `INSERT INTO run_events (id, run_id, seq, event_key, type, payload_json, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, runId, nextSeq, input.eventKey, input.type, payloadJson, timestamp)

      return {
        inserted: true,
        event: {
          id,
          runId,
          seq: nextSeq,
          eventKey: input.eventKey,
          type: input.type,
          payload: redacted,
          timestamp,
        },
      }
    }

    if (this.dbHandle.sqlite.isTransaction) {
      return writeEvent()
    }
    return this.dbHandle.transaction(writeEvent)
  }

  listEventsAfter(runId: string, afterSeq = 0, limit = 200): ListRunEventsResult {
    const safeAfter = Math.max(0, Math.floor(afterSeq))
    const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)))

    const rows = this.dbHandle.sqlite
      .prepare(
        `SELECT id, run_id, seq, event_key, type, payload_json, timestamp
         FROM run_events
         WHERE run_id = ? AND seq > ?
         ORDER BY seq ASC
         LIMIT ?`,
      )
      .all(runId, safeAfter, safeLimit + 1) as unknown as RawEventRow[]

    const hasMore = rows.length > safeLimit
    const sliced = hasMore ? rows.slice(0, safeLimit) : rows
    const events = sliced.map(rowToEvent)

    if (events.length > 0) {
      let expected = safeAfter + 1
      for (const evt of events) {
        if (evt.seq !== expected) {
          throw new DaemonError(
            'EVENT_SEQUENCE_GAP',
            `Detected run_events sequence gap for run ${runId}: expected ${expected}, got ${evt.seq}`,
            { statusCode: 500 },
          )
        }
        expected += 1
      }
    }

    const lastSeq = events.length > 0 ? events[events.length - 1]!.seq : safeAfter
    return { events, hasMore, lastSeq }
  }

  getLastSeq(runId: string): number {
    const row = this.dbHandle.sqlite
      .prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM run_events WHERE run_id = ?')
      .get(runId) as { max_seq: number } | undefined
    return Number(row?.max_seq ?? 0)
  }
}
