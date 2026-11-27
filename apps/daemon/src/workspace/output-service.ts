import {
  WorkspaceOutputCancelInputSchema,
  WorkspaceOutputQuerySchema,
  type WorkspaceOutputCancelResponse,
  type WorkspaceOutputEntry,
  type WorkspaceOutputResponse,
  type WorkspaceOutputRunSummary,
} from '@ghost-bot/shared-types/workspace-output'
import type { DatabaseHandle } from '../db/client.ts'
import { DaemonError, redactSecrets } from '../errors.ts'

interface RunRow {
  id: string
  session_id: string
  agent_id: string
  status: string
  error_json: string | null
  started_at: string
  ended_at: string | null
}

interface RunEventRow {
  id: string
  run_id: string
  seq: number
  type: string
  payload_json: string
  timestamp: string
}

interface TerminalCommandRow {
  id: string
  bot_id: string
  run_id: string
  executable: string
  args_json: string
  status: string
  exit_code: number | null
  stdout_preview: string
  stderr_preview: string
  started_at: string | null
  ended_at: string | null
  created_at: string
}

const HIDDEN_EVENT_TYPES = new Set([
  'reasoning',
  'thinking',
  'hidden_reasoning',
  'run.reasoning',
  'item.reasoning',
])

const BUILD_EXECUTABLES = new Set(['pnpm', 'npm', 'yarn', 'node', 'tsc', 'eslint', 'cargo', 'pytest', 'vitest'])

function clipText(raw: string, maxLen = 3800): string {
  const clean = redactSecrets(raw)
  return clean.length <= maxLen ? clean : `${clean.slice(0, maxLen - 3)}...`
}

function mapRunStatus(
  raw: string,
): { status: WorkspaceOutputEntry['status']; cancellable: boolean } {
  switch (raw) {
    case 'queued':
    case 'starting':
    case 'running':
    case 'awaiting_approval':
      return { status: 'running', cancellable: true }
    case 'completed':
      return { status: 'completed', cancellable: false }
    case 'cancelled':
      return { status: 'cancelled', cancellable: false }
    case 'interrupted':
      return { status: 'uncertain', cancellable: false }
    default:
      return { status: 'failed', cancellable: false }
  }
}

function mapTerminalStatus(
  raw: string,
): { status: WorkspaceOutputEntry['status']; cancellable: boolean } {
  switch (raw) {
    case 'pending':
    case 'approved':
    case 'running':
      return { status: 'running', cancellable: true }
    case 'completed':
      return { status: 'completed', cancellable: false }
    case 'cancelled':
      return { status: 'cancelled', cancellable: false }
    case 'interrupted':
    case 'unconfirmed':
      return { status: 'uncertain', cancellable: false }
    default:
      return { status: 'failed', cancellable: false }
  }
}

function computeDurationMs(startIso: string | null, endIso: string | null): number | null {
  if (!startIso || !endIso) return null
  const diff = Date.parse(endIso) - Date.parse(startIso)
  return Number.isFinite(diff) && diff >= 0 ? Math.trunc(diff) : null
}

function formatEventPayload(type: string, payload: Record<string, unknown>): {
  source: WorkspaceOutputEntry['source']
  severity: WorkspaceOutputEntry['severity']
  title: string
  message: string
} {
  const isTool = type.includes('tool') || type.includes('mcp') || type.includes('approval')
  const source: WorkspaceOutputEntry['source'] = isTool ? 'tool' : 'run'
  const isError = type.includes('failed') || type.includes('error') || type.includes('denied')
  const isWarn = type.includes('cancel') || type.includes('interrupt') || type.includes('timeout')
  const severity: WorkspaceOutputEntry['severity'] = isError ? 'error' : isWarn ? 'warn' : 'info'

  const detailParts: string[] = []
  for (const key of ['toolName', 'label', 'message', 'reason', 'delta', 'text', 'summary']) {
    const val = payload[key]
    if (typeof val === 'string' && val.trim().length > 0) {
      detailParts.push(val.trim())
    }
  }
  const message =
    detailParts.length > 0 ? clipText(detailParts.join(' · ')) : clipText(JSON.stringify(payload))
  return { source, severity, title: clipText(type, 200), message }
}

export interface WorkspaceOutputCancelHandlers {
  cancelRun: (runId: string) => Promise<{ status: string } | void>
  cancelTerminalCommand?: (commandId: string, ownerId: string) => Promise<void>
}

export class WorkspaceOutputService {
  private readonly db: DatabaseHandle

  constructor(db: DatabaseHandle) {
    this.db = db
  }

  listOutput(rawInput: unknown): WorkspaceOutputResponse {
    const input = WorkspaceOutputQuerySchema.parse(rawInput)

    if (input.teamId) {
      const team = this.db.sqlite
        .prepare('SELECT id, archived_at FROM teams WHERE id = ?')
        .get(input.teamId) as { id: string; archived_at: string | null } | undefined
      if (!team || team.archived_at !== null) {
        return {
          authorized: false,
          ownerKind: 'team',
          ownerId: input.teamId,
          runs: [],
          entries: [],
          truncated: false,
          reason: 'Team is missing or archived.',
        }
      }
      // Prevent private bot execution logs from leaking into group discussions.
      return {
        authorized: true,
        ownerKind: 'team',
        ownerId: input.teamId,
        runs: [],
        entries: [],
        truncated: false,
        reason: 'Private bot execution logs are isolated from group conversations.',
      }
    }

    const botId = input.botId!
    const bot = this.db.sqlite
      .prepare('SELECT id, archived_at FROM agents WHERE id = ?')
      .get(botId) as { id: string; archived_at: string | null } | undefined
    if (!bot || bot.archived_at !== null) {
      return {
        authorized: false,
        ownerKind: 'bot',
        ownerId: botId,
        runs: [],
        entries: [],
        truncated: false,
        reason: 'Bot is missing or archived.',
      }
    }

    if (input.sessionId) {
      const sess = this.db.sqlite
        .prepare('SELECT id, agent_id FROM sessions WHERE id = ?')
        .get(input.sessionId) as { id: string; agent_id: string } | undefined
      if (!sess || sess.agent_id !== botId) {
        throw new DaemonError(
          'OUTPUT_SESSION_UNAUTHORIZED',
          'Session does not belong to the authorized bot',
          { statusCode: 403 },
        )
      }
    }

    const runConditions = ['agent_id = ?']
    const runParams: Array<string | number> = [botId]
    if (input.sessionId) {
      runConditions.push('session_id = ?')
      runParams.push(input.sessionId)
    }
    if (input.runId) {
      runConditions.push('id = ?')
      runParams.push(input.runId)
    }
    runParams.push(25)

    const runRows = this.db.sqlite
      .prepare(
        `SELECT id, session_id, agent_id, status, error_json, started_at, ended_at
         FROM runs
         WHERE ${runConditions.join(' AND ')}
         ORDER BY started_at DESC
         LIMIT ?`,
      )
      .all(...runParams) as unknown as RunRow[]

    const runs: WorkspaceOutputRunSummary[] = runRows.map((r) => {
      const mapped = mapRunStatus(r.status)
      return {
        id: r.id,
        sessionId: r.session_id,
        status: mapped.status,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        durationMs: computeDurationMs(r.started_at, r.ended_at),
        cancellable: mapped.cancellable,
      }
    })

    if (runRows.length === 0) {
      return {
        authorized: true,
        ownerKind: 'bot',
        ownerId: botId,
        runs: [],
        entries: [],
        truncated: false,
        reason: null,
      }
    }

    const entries: WorkspaceOutputEntry[] = []
    const runMap = new Map(runRows.map((r) => [r.id, r]))
    const placeholders = runRows.map(() => '?').join(', ')
    const runIds = runRows.map((r) => r.id)

    for (const r of runRows) {
      const mapped = mapRunStatus(r.status)
      entries.push({
        id: `run-summary:${r.id}`,
        runId: r.id,
        sessionId: r.session_id,
        taskId: null,
        source: 'run',
        severity: mapped.status === 'failed' ? 'error' : mapped.status === 'uncertain' ? 'warn' : 'info',
        status: mapped.status,
        timestamp: r.ended_at ?? r.started_at,
        title: `Run ${r.status}`,
        message: r.error_json ? clipText(r.error_json) : `Run ${r.id.slice(0, 8)} (${r.status})`,
        exitCode: null,
        durationMs: computeDurationMs(r.started_at, r.ended_at),
        cancellable: mapped.cancellable,
      })
    }

    const eventRows = this.db.sqlite
      .prepare(
        `SELECT id, run_id, seq, type, payload_json, timestamp
         FROM run_events
         WHERE run_id IN (${placeholders})
         ORDER BY timestamp DESC, seq DESC
         LIMIT ?`,
      )
      .all(...runIds, input.limit) as unknown as RunEventRow[]

    for (const ev of eventRows) {
      if (HIDDEN_EVENT_TYPES.has(ev.type)) continue
      const run = runMap.get(ev.run_id)
      if (!run) continue
      let payload: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(ev.payload_json) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          payload = parsed as Record<string, unknown>
        }
      } catch {
        payload = {}
      }
      const formatted = formatEventPayload(ev.type, payload)
      const mapped = mapRunStatus(run.status)
      entries.push({
        id: `event:${ev.id}`,
        runId: ev.run_id,
        sessionId: run.session_id,
        taskId: typeof payload.taskId === 'string' ? payload.taskId : null,
        source: formatted.source,
        severity: formatted.severity,
        status: mapped.status,
        timestamp: ev.timestamp,
        title: formatted.title,
        message: formatted.message,
        exitCode: null,
        durationMs: null,
        cancellable: mapped.cancellable,
      })
    }

    const termRows = this.db.sqlite
      .prepare(
        `SELECT id, bot_id, run_id, executable, args_json, status, exit_code, stdout_preview, stderr_preview, started_at, ended_at, created_at
         FROM terminal_commands
         WHERE bot_id = ? AND run_id IN (${placeholders})
         ORDER BY created_at DESC
         LIMIT 50`,
      )
      .all(botId, ...runIds) as unknown as TerminalCommandRow[]

    for (const cmd of termRows) {
      const run = runMap.get(cmd.run_id)
      const mapped = mapTerminalStatus(cmd.status)
      const isBuild = BUILD_EXECUTABLES.has(cmd.executable.toLowerCase())
      let argsText = ''
      try {
        const arr = JSON.parse(cmd.args_json) as unknown
        if (Array.isArray(arr)) argsText = arr.map(String).join(' ')
      } catch {
        argsText = ''
      }
      const outputParts = [
        cmd.stdout_preview ? `stdout: ${cmd.stdout_preview}` : '',
        cmd.stderr_preview ? `stderr: ${cmd.stderr_preview}` : '',
      ].filter(Boolean)
      entries.push({
        id: `term:${cmd.id}`,
        runId: cmd.run_id,
        sessionId: run?.session_id ?? null,
        taskId: cmd.id,
        source: isBuild ? 'build' : 'terminal',
        severity:
          mapped.status === 'failed' || (cmd.exit_code !== null && cmd.exit_code !== 0)
            ? 'error'
            : mapped.status === 'uncertain'
              ? 'warn'
              : 'info',
        status: mapped.status,
        timestamp: cmd.ended_at ?? cmd.started_at ?? cmd.created_at,
        title: clipText(`${cmd.executable} ${argsText}`.trim(), 200),
        message: outputParts.length > 0 ? clipText(outputParts.join('\n')) : `Status: ${cmd.status}`,
        exitCode: cmd.exit_code,
        durationMs: computeDurationMs(cmd.started_at, cmd.ended_at),
        cancellable: mapped.cancellable,
      })
    }

    entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    const truncated = entries.length > input.limit
    const bounded = truncated ? entries.slice(entries.length - input.limit) : entries

    return {
      authorized: true,
      ownerKind: 'bot',
      ownerId: botId,
      runs,
      entries: bounded,
      truncated,
      reason: null,
    }
  }

  async cancelExecution(
    rawInput: unknown,
    handlers: WorkspaceOutputCancelHandlers,
  ): Promise<WorkspaceOutputCancelResponse> {
    const input = WorkspaceOutputCancelInputSchema.parse(rawInput)
    if (input.teamId) {
      throw new DaemonError(
        'OUTPUT_CANCEL_UNAUTHORIZED',
        'Group view cannot cancel private bot executions directly',
        { statusCode: 403 },
      )
    }

    const botId = input.botId!
    const run = this.db.sqlite
      .prepare('SELECT id, agent_id, status FROM runs WHERE id = ?')
      .get(input.runId) as { id: string; agent_id: string; status: string } | undefined
    if (!run || run.agent_id !== botId) {
      throw new DaemonError('OUTPUT_RUN_NOT_FOUND', 'Run not found for authorized bot', {
        statusCode: 404,
      })
    }

    if (input.terminalCommandId) {
      const cmd = this.db.sqlite
        .prepare('SELECT id, owner_id, bot_id, run_id FROM terminal_commands WHERE id = ?')
        .get(input.terminalCommandId) as
        | { id: string; owner_id: string; bot_id: string; run_id: string }
        | undefined
      if (!cmd || cmd.bot_id !== botId || cmd.run_id !== input.runId) {
        throw new DaemonError(
          'OUTPUT_TERMINAL_NOT_FOUND',
          'Terminal command not found for authorized run',
          { statusCode: 404 },
        )
      }
      if (!handlers.cancelTerminalCommand) {
        throw new DaemonError('OUTPUT_CANCEL_UNAVAILABLE', 'Terminal cancellation unavailable', {
          statusCode: 503,
        })
      }
      await handlers.cancelTerminalCommand(cmd.id, cmd.owner_id)
      return { cancelled: true, runId: input.runId, status: 'cancelled' }
    }

    await handlers.cancelRun(input.runId)
    return { cancelled: true, runId: input.runId, status: 'cancelled' }
  }
}
