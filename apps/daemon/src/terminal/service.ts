import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import type { BotRepository } from '../bots/repository.ts'

function getMinimalEtcBinds(): string[] {
  const candidates = [
    '/etc/ld.so.cache',
    '/etc/ld.so.conf',
    '/etc/ld.so.conf.d',
    '/etc/nsswitch.conf',
    '/etc/ssl',
    '/etc/pki',
    '/etc/fonts',
    '/etc/alternatives',
    '/etc/localtime',
  ]
  const args: string[] = []
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      args.push('--ro-bind', p, p)
    }
  }
  return args
}
import type { DatabaseHandle } from '../db/client.ts'
import { DaemonError, redactSecrets } from '../errors.ts'
import { LOCAL_USER_ID } from '../memory/service.ts'

const MAX_OUTPUT_BYTES = 256 * 1024
const MAX_DURATION_MS = 60_000
const DEFAULT_APPROVAL_TTL_MS = 120_000
const MAX_CONCURRENT_COMMANDS = 2
const TERMINAL_POLICY_ID = 'core2.bwrap.v1'
const PERMITTED_TERMINAL_RUN_STATES = new Set(['running'])

export interface TerminalCapabilitiesDto {
  bubblewrapAvailable: boolean
  interactivePtySupported: false
  hostUnisolatedFallbackAllowed: false
  maxOutputBytes: number
  maxDurationMs: number
  maxConcurrentCommands: number
  notes: string[]
}

export interface TerminalCommandDto {
  id: string
  ownerId: string
  botId: string
  runId: string
  canonicalWorkspace: string
  executable: string
  args: string[]
  permissionMode: string
  policyId: string
  commandHash: string
  status: 'awaiting_approval' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'uncertain'
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  terminationConfirmed: boolean | null
  stdoutPreview: string
  stderrPreview: string
  truncated: boolean
  replayAllowed: false
  errorCode: string | null
  expiresAt: string
  createdAt: string
  startedAt: string | null
  endedAt: string | null
  updatedAt: string
}

interface ActiveProcessEntry {
  child: ChildProcess
  cancelRequested: boolean
}

function computeCommandHash(params: {
  ownerId: string
  botId: string
  runId: string
  canonicalWorkspace: string
  executable: string
  args: string[]
  permissionMode: string
  policyId: string
}): string {
  return createHash('sha256')
    .update(JSON.stringify(params))
    .digest('hex')
}

function validateExecutableAndArgs(executable: string, args: string[]): void {
  if (!executable || executable.includes('\0') || /[\r\n]/.test(executable)) {
    throw new DaemonError('VALIDATION_ERROR', 'Invalid executable path or name', { statusCode: 400 })
  }
  if (executable.includes('..')) {
    throw new DaemonError('VALIDATION_ERROR', 'Executable cannot contain path traversal', {
      statusCode: 400,
    })
  }
  if (args.length > 64) {
    throw new DaemonError('VALIDATION_ERROR', 'Too many command arguments (max 64)', {
      statusCode: 400,
    })
  }
  for (const arg of args) {
    if (arg.includes('\0') || arg.length > 4096) {
      throw new DaemonError('VALIDATION_ERROR', 'Invalid or oversized command argument', {
        statusCode: 400,
      })
    }
  }
}

export class ScopedTerminalService {
  private readonly dbHandle: DatabaseHandle
  private readonly botRepo: BotRepository
  private readonly activeProcesses = new Map<string, ActiveProcessEntry>()
  private readonly bwrapPath: string

  constructor(
    dbHandle: DatabaseHandle,
    botRepo: BotRepository,
    options: { bwrapPath?: string } = {},
  ) {
    this.dbHandle = dbHandle
    this.botRepo = botRepo
    this.bwrapPath = options.bwrapPath ?? 'bwrap'
  }

  async getCapabilities(): Promise<TerminalCapabilitiesDto> {
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(
        this.bwrapPath,
        [
          '--unshare-all',
          '--die-with-parent',
          '--new-session',
          '--cap-drop',
          'ALL',
          '--ro-bind',
          '/usr',
          '/usr',
          '--symlink',
          'usr/lib64',
          '/lib64',
          '--symlink',
          'usr/lib',
          '/lib',
          '--symlink',
          'usr/bin',
          '/bin',
          '--proc',
          '/proc',
          '--dev',
          '/dev',
          '/bin/true',
        ],
        { stdio: 'ignore' },
      )
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve(false)
      }, 4_000)
      child.once('error', () => {
        clearTimeout(timer)
        resolve(false)
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        resolve(code === 0)
      })
    })

    return {
      bubblewrapAvailable: ok,
      interactivePtySupported: false,
      hostUnisolatedFallbackAllowed: false,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      maxDurationMs: MAX_DURATION_MS,
      maxConcurrentCommands: MAX_CONCURRENT_COMMANDS,
      notes: ok
        ? [
            'Ghost Bot-owned scoped command execution via Bubblewrap (--unshare-all, --cap-drop ALL).',
            'Interactive PTY shells are disabled; non-interactive structured argv only.',
            'No host $HOME, keyring, DBus, display, or provider/MCP credentials are mounted.',
          ]
        : ['Bubblewrap sandbox is unavailable; scoped command execution is disabled (fail-closed).'],
    }
  }

  private revalidateAuthority(params: {
    botId: string
    runId: string
    expectedWorkspace?: string
  }): { canonicalWorkspace: string; permissionMode: string } {
    const bot = this.botRepo.getBot(params.botId)
    if (!bot) {
      throw new DaemonError('BOT_NOT_FOUND', `Bot "${params.botId}" not found or archived`, {
        statusCode: 404,
      })
    }
    if (bot.permission === 'read-only') {
      throw new DaemonError(
        'TERMINAL_READ_ONLY_FORBIDDEN',
        'Read-Only permission mode forbids scoped command execution',
        { statusCode: 403 },
      )
    }
    if ((bot.permission as string) === 'full-access') {
      throw new DaemonError(
        'FULL_ACCESS_DISABLED',
        'Full Access permission mode is disabled',
        { statusCode: 403 },
      )
    }

    let canonicalWorkspace: string
    try {
      const stat = fs.lstatSync(bot.workspacePath)
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('Workspace must be a real directory')
      }
      canonicalWorkspace = fs.realpathSync(bot.workspacePath)
    } catch {
      throw new DaemonError(
        'TERMINAL_WORKSPACE_INVALID',
        'Bot workspace directory is missing or invalid',
        { statusCode: 403 },
      )
    }

    if (params.expectedWorkspace && canonicalWorkspace !== params.expectedWorkspace) {
      throw new DaemonError(
        'TERMINAL_WORKSPACE_CHANGED',
        'Bot workspace changed or was replaced since approval',
        { statusCode: 409 },
      )
    }

    const runRow = this.dbHandle.sqlite
      .prepare(`SELECT id, agent_id, session_id, status, permission_mode FROM runs WHERE id = ?`)
      .get(params.runId) as
      | { id: string; agent_id: string; session_id: string; status: string; permission_mode: string }
      | undefined
    if (!runRow || runRow.agent_id !== params.botId) {
      throw new DaemonError(
        'TERMINAL_RUN_MISMATCH',
        `Authoritative daemon run "${params.runId}" not found for bot "${params.botId}"`,
        { statusCode: 403 },
      )
    }
    if (!PERMITTED_TERMINAL_RUN_STATES.has(runRow.status)) {
      throw new DaemonError(
        'TERMINAL_RUN_NOT_ACTIVE',
        `Daemon run "${params.runId}" is not active (status=${runRow.status})`,
        { statusCode: 403 },
      )
    }
    if (runRow.permission_mode === 'read-only' || runRow.permission_mode === 'full-access') {
      throw new DaemonError(
        'TERMINAL_PERMISSION_FORBIDDEN',
        `Run permission mode "${runRow.permission_mode}" forbids command execution`,
        { statusCode: 403 },
      )
    }

    const chatSess = this.dbHandle.sqlite
      .prepare(`SELECT id, agent_id, archived_at FROM sessions WHERE id = ?`)
      .get(runRow.session_id) as { id: string; agent_id: string; archived_at: string | null } | undefined
    if (!chatSess || chatSess.agent_id !== params.botId || chatSess.archived_at !== null) {
      throw new DaemonError(
        'TERMINAL_SESSION_ARCHIVED',
        'Parent daemon session is missing or archived',
        { statusCode: 403 },
      )
    }

    return { canonicalWorkspace, permissionMode: bot.permission }
  }

  requestCommandApproval(input: {
    botId: string
    runId?: string
    executable: string
    args: string[]
    ttlMs?: number
  }): TerminalCommandDto {
    validateExecutableAndArgs(input.executable, input.args)
    const bot = this.botRepo.getBot(input.botId)
    if (!bot) {
      throw new DaemonError('BOT_NOT_FOUND', `Bot "${input.botId}" not found or archived`, {
        statusCode: 404,
      })
    }

    let authoritativeRunId = input.runId
    if (!authoritativeRunId) {
      if (bot.permission === 'read-only' || (bot.permission as string) === 'full-access') {
        throw new DaemonError(
          'TERMINAL_PERMISSION_FORBIDDEN',
          `Permission mode "${bot.permission}" forbids command execution`,
          { statusCode: 403 },
        )
      }
      const nowRunIso = new Date().toISOString()
      const sessId = `sess_term_${randomUUID()}`
      authoritativeRunId = `run_term_${randomUUID()}`
      this.dbHandle.sqlite
        .prepare(
          `INSERT INTO sessions (id, agent_id, account_id, runtime_id, external_session_id, title, created_at, updated_at, archived_at)
           VALUES (?, ?, 'local', ?, NULL, 'Scoped Terminal Session', ?, ?, NULL)`,
        )
        .run(sessId, bot.id, bot.runtimeId, nowRunIso, nowRunIso)
      this.dbHandle.sqlite
        .prepare(
          `INSERT INTO runs (id, session_id, agent_id, idempotency_key, runtime_id, model_id, effort, permission_mode, config_snapshot_json, status, started_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', 'running', ?, ?)`,
        )
        .run(
          authoritativeRunId,
          sessId,
          bot.id,
          `term:${authoritativeRunId}`,
          bot.runtimeId,
          bot.modelId,
          bot.effort,
          bot.permission,
          nowRunIso,
          nowRunIso,
        )
    }

    const { canonicalWorkspace, permissionMode } = this.revalidateAuthority({
      botId: input.botId,
      runId: authoritativeRunId,
    })

    const commandId = `termcmd_${randomUUID()}`
    const commandHash = computeCommandHash({
      ownerId: LOCAL_USER_ID,
      botId: input.botId,
      runId: authoritativeRunId,
      canonicalWorkspace,
      executable: input.executable,
      args: input.args,
      permissionMode,
      policyId: TERMINAL_POLICY_ID,
    })

    const ttlMs = Math.max(5_000, Math.min(300_000, input.ttlMs ?? DEFAULT_APPROVAL_TTL_MS))
    const nowMs = Date.now()
    const nowIso = new Date(nowMs).toISOString()
    const expiresAt = new Date(nowMs + ttlMs).toISOString()

    this.dbHandle.sqlite
      .prepare(
        `INSERT INTO terminal_commands (
          id, owner_id, bot_id, run_id, canonical_workspace,
          executable, args_json, permission_mode, policy_id, command_hash,
          status, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_approval', ?, ?, ?)`,
      )
      .run(
        commandId,
        LOCAL_USER_ID,
        input.botId,
        authoritativeRunId,
        canonicalWorkspace,
        input.executable,
        JSON.stringify(input.args),
        permissionMode,
        TERMINAL_POLICY_ID,
        commandHash,
        expiresAt,
        nowIso,
        nowIso,
      )

    return this.getCommand(commandId)
  }

  async resolveCommandApproval(input: {
    commandId: string
    decision: 'approved' | 'denied'
    timeoutMs?: number
    expectedCommandHash?: string
  }): Promise<TerminalCommandDto> {
    const cmd = this.getCommand(input.commandId)
    if (cmd.status !== 'awaiting_approval') {
      throw new DaemonError(
        'TERMINAL_NOT_AWAITING_APPROVAL',
        `Command "${cmd.id}" is ${cmd.status}`,
        { statusCode: 409 },
      )
    }

    if (input.expectedCommandHash && input.expectedCommandHash !== cmd.commandHash) {
      throw new DaemonError(
        'TERMINAL_COMMAND_HASH_MISMATCH',
        'Command hash does not match approved command payload',
        { statusCode: 403 },
      )
    }

    const nowMs = Date.now()
    const nowIso = new Date(nowMs).toISOString()

    if (input.decision === 'denied') {
      this.dbHandle.sqlite
        .prepare(
          `UPDATE terminal_commands
           SET status = 'cancelled', error_code = 'TERMINAL_APPROVAL_DENIED', ended_at = ?, updated_at = ?
           WHERE id = ? AND status = 'awaiting_approval'`,
        )
        .run(nowIso, nowIso, cmd.id)
      return this.getCommand(cmd.id)
    }

    if (nowMs >= Date.parse(cmd.expiresAt)) {
      this.dbHandle.sqlite
        .prepare(
          `UPDATE terminal_commands
           SET status = 'cancelled', error_code = 'TERMINAL_APPROVAL_EXPIRED', ended_at = ?, updated_at = ?
           WHERE id = ? AND status = 'awaiting_approval'`,
        )
        .run(nowIso, nowIso, cmd.id)
      throw new DaemonError('TERMINAL_APPROVAL_EXPIRED', 'Command approval expired', {
        statusCode: 409,
      })
    }

    // Revalidate authority immediately before consuming approval and spawning
    this.revalidateAuthority({
      botId: cmd.botId,
      runId: cmd.runId,
      expectedWorkspace: cmd.canonicalWorkspace,
    })

    if (this.activeProcesses.size >= MAX_CONCURRENT_COMMANDS) {
      throw new DaemonError(
        'TERMINAL_CONCURRENCY_LIMIT',
        `Maximum concurrent terminal commands (${MAX_CONCURRENT_COMMANDS}) reached`,
        { statusCode: 429 },
      )
    }

    const caps = await this.getCapabilities()
    if (!caps.bubblewrapAvailable) {
      throw new DaemonError(
        'TERMINAL_SANDBOX_UNAVAILABLE',
        'Bubblewrap sandbox is unavailable; failing closed',
        { statusCode: 503 },
      )
    }

    // Atomically consume single-use approval
    const consumed = this.dbHandle.sqlite
      .prepare(
        `UPDATE terminal_commands
         SET status = 'running', started_at = ?, updated_at = ?
         WHERE id = ? AND status = 'awaiting_approval' AND command_hash = ?`,
      )
      .run(nowIso, nowIso, cmd.id, cmd.commandHash)
    if (Number(consumed.changes) !== 1) {
      throw new DaemonError(
        'TERMINAL_APPROVAL_ALREADY_CONSUMED',
        'Command approval was already consumed or invalidated',
        { statusCode: 409 },
      )
    }

    await this.executeInBwrap(cmd, Math.min(MAX_DURATION_MS, Math.max(100, input.timeoutMs ?? 15_000)))
    return this.getCommand(cmd.id)
  }

  private async executeInBwrap(cmd: TerminalCommandDto, timeoutMs: number): Promise<void> {
    const bwrapArgs = [
      '--unshare-all',
      '--die-with-parent',
      '--new-session',
      '--cap-drop',
      'ALL',
      '--ro-bind',
      '/usr',
      '/usr',
      ...getMinimalEtcBinds(),
      '--symlink',
      'usr/lib64',
      '/lib64',
      '--symlink',
      'usr/lib',
      '/lib',
      '--symlink',
      'usr/bin',
      '/bin',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--tmpfs',
      '/tmp',
      '--tmpfs',
      '/tmp-home',
      '--tmpfs',
      '/dev/shm',
      '--bind',
      cmd.canonicalWorkspace,
      '/workspace',
      '--chdir',
      '/workspace',
      '--clearenv',
      '--setenv',
      'PATH',
      '/usr/local/bin:/usr/bin:/bin',
      '--setenv',
      'HOME',
      '/tmp-home',
      '--setenv',
      'TMPDIR',
      '/tmp',
      '--setenv',
      'TERM',
      'dumb',
      '--setenv',
      'LC_ALL',
      'C.UTF-8',
      '--',
      cmd.executable,
      ...cmd.args,
    ]

    const child = spawn(this.bwrapPath, bwrapArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })

    const entry: ActiveProcessEntry = { child, cancelRequested: false }
    this.activeProcesses.set(cmd.id, entry)

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let totalBytes = 0
    let truncated = false

    const appendBounded = (target: Buffer[], chunk: Buffer) => {
      if (totalBytes >= MAX_OUTPUT_BYTES) {
        truncated = true
        return
      }
      const remaining = MAX_OUTPUT_BYTES - totalBytes
      if (chunk.length > remaining) {
        target.push(chunk.subarray(0, remaining))
        totalBytes += remaining
        truncated = true
      } else {
        target.push(chunk)
        totalBytes += chunk.length
      }
    }

    child.stdout?.on('data', (c: Buffer) => appendBounded(stdoutChunks, c))
    child.stderr?.on('data', (c: Buffer) => appendBounded(stderrChunks, c))

    let timedOut = false
    let termTimer: NodeJS.Timeout | undefined
    let killTimer: NodeJS.Timeout | undefined

    const exitResult = await new Promise<{
      code: number | null
      signal: string | null
      confirmed: boolean
    }>((resolveExit) => {
      let settled = false
      const settle = (res: { code: number | null; signal: string | null; confirmed: boolean }) => {
        if (settled) return
        settled = true
        if (termTimer) clearTimeout(termTimer)
        if (killTimer) clearTimeout(killTimer)
        resolveExit(res)
      }

      termTimer = setTimeout(() => {
        timedOut = true
        this.signalProcessTree(child, 'SIGTERM')
        killTimer = setTimeout(() => {
          this.signalProcessTree(child, 'SIGKILL')
          setTimeout(() => {
            settle({ code: null, signal: 'SIGKILL', confirmed: false })
          }, 500)
        }, 1500)
      }, timeoutMs)

      child.once('error', () => {
        settle({ code: 1, signal: null, confirmed: true })
      })

      child.once('exit', (code, signal) => {
        settle({ code, signal: signal ?? null, confirmed: true })
      })
    })

    this.activeProcesses.delete(cmd.id)

    const stdoutPreview = redactSecrets(Buffer.concat(stdoutChunks).toString('utf8'))
    const stderrPreview = redactSecrets(Buffer.concat(stderrChunks).toString('utf8'))
    const endIso = new Date().toISOString()

    let finalStatus: TerminalCommandDto['status']
    let errorCode: string | null = null
    if (!exitResult.confirmed) {
      finalStatus = 'uncertain'
      errorCode = 'TERMINAL_TERMINATION_UNCONFIRMED'
    } else if (entry.cancelRequested) {
      finalStatus = 'cancelled'
      errorCode = 'TERMINAL_CANCELLED'
    } else if (timedOut) {
      finalStatus = 'failed'
      errorCode = 'TERMINAL_TIMEOUT'
    } else if (exitResult.code === 0) {
      finalStatus = 'completed'
    } else {
      finalStatus = 'failed'
      errorCode = 'TERMINAL_NONZERO_EXIT'
    }

    this.dbHandle.sqlite
      .prepare(
        `UPDATE terminal_commands
         SET status = ?, exit_code = ?, signal = ?, timed_out = ?,
             termination_confirmed = ?, stdout_preview = ?, stderr_preview = ?,
             truncated = ?, error_code = ?, ended_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        finalStatus,
        exitResult.code,
        exitResult.signal,
        timedOut ? 1 : 0,
        exitResult.confirmed ? 1 : 0,
        stdoutPreview,
        stderrPreview,
        truncated ? 1 : 0,
        errorCode,
        endIso,
        endIso,
        cmd.id,
      )
  }

  private signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
    const pid = child.pid
    if (!pid) return
    try {
      process.kill(-pid, signal)
    } catch {
      try {
        child.kill(signal)
      } catch {
        // Process may already have exited
      }
    }
  }

  async cancelCommand(commandId: string): Promise<TerminalCommandDto> {
    const cmd = this.getCommand(commandId)
    const nowIso = new Date().toISOString()
    if (cmd.status === 'awaiting_approval' || cmd.status === 'queued') {
      this.dbHandle.sqlite
        .prepare(
          `UPDATE terminal_commands
           SET status = 'cancelled', error_code = 'TERMINAL_CANCELLED', termination_confirmed = 1, ended_at = ?, updated_at = ?
           WHERE id = ? AND status IN ('awaiting_approval', 'queued')`,
        )
        .run(nowIso, nowIso, commandId)
      return this.getCommand(commandId)
    }

    const entry = this.activeProcesses.get(commandId)
    if (!entry) {
      return this.getCommand(commandId)
    }

    entry.cancelRequested = true
    this.signalProcessTree(entry.child, 'SIGTERM')

    const confirmed = await new Promise<boolean>((resolveStop) => {
      if (entry.child.exitCode !== null) {
        resolveStop(true)
        return
      }
      const timer = setTimeout(() => {
        this.signalProcessTree(entry.child, 'SIGKILL')
        setTimeout(() => {
          resolveStop(entry.child.exitCode !== null)
        }, 500)
      }, 1500)
      entry.child.once('exit', () => {
        clearTimeout(timer)
        resolveStop(true)
      })
    })

    if (!confirmed) {
      this.dbHandle.sqlite
        .prepare(
          `UPDATE terminal_commands
           SET status = 'uncertain', termination_confirmed = 0, error_code = 'TERMINAL_TERMINATION_UNCONFIRMED', ended_at = COALESCE(ended_at, ?), updated_at = ?
           WHERE id = ?`,
        )
        .run(nowIso, nowIso, commandId)
    }
    return this.getCommand(commandId)
  }

  getCommand(commandId: string): TerminalCommandDto {
    const row = this.dbHandle.sqlite
      .prepare(`SELECT * FROM terminal_commands WHERE id = ? AND owner_id = ?`)
      .get(commandId, LOCAL_USER_ID) as Record<string, unknown> | undefined
    if (!row) {
      throw new DaemonError('TERMINAL_COMMAND_NOT_FOUND', `Command "${commandId}" not found`, {
        statusCode: 404,
      })
    }
    return this.rowToDto(row)
  }

  listCommands(botId?: string, limit = 50): TerminalCommandDto[] {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)))
    const rows = botId
      ? (this.dbHandle.sqlite
          .prepare(
            `SELECT * FROM terminal_commands WHERE owner_id = ? AND bot_id = ? ORDER BY created_at DESC LIMIT ?`,
          )
          .all(LOCAL_USER_ID, botId, safeLimit) as Record<string, unknown>[])
      : (this.dbHandle.sqlite
          .prepare(`SELECT * FROM terminal_commands WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?`)
          .all(LOCAL_USER_ID, safeLimit) as Record<string, unknown>[])
    return rows.map((r) => this.rowToDto(r))
  }

  reconcileOnStartup(): { uncertainCommands: number; cancelledApprovals: number } {
    const nowIso = new Date().toISOString()
    return this.dbHandle.transaction(() => {
      const runningRes = this.dbHandle.sqlite
        .prepare(
          `UPDATE terminal_commands
           SET status = 'uncertain', termination_confirmed = 0, error_code = 'TERMINAL_DAEMON_RESTARTED', ended_at = COALESCE(ended_at, ?), updated_at = ?
           WHERE status = 'running'`,
        )
        .run(nowIso, nowIso)
      const pendingRes = this.dbHandle.sqlite
        .prepare(
          `UPDATE terminal_commands
           SET status = 'cancelled', error_code = 'TERMINAL_DAEMON_RESTARTED', ended_at = COALESCE(ended_at, ?), updated_at = ?
           WHERE status IN ('awaiting_approval', 'queued')`,
        )
        .run(nowIso, nowIso)
      return {
        uncertainCommands: Number(runningRes.changes),
        cancelledApprovals: Number(pendingRes.changes),
      }
    })
  }

  pruneHistory(olderThanIso: string): number {
    return this.dbHandle.transaction(() => {
      const res = this.dbHandle.sqlite
        .prepare(
          `DELETE FROM terminal_commands
           WHERE status IN ('completed', 'failed', 'cancelled')
             AND created_at <= ?`,
        )
        .run(olderThanIso)
      return Number(res.changes)
    })
  }

  async shutdownAll(): Promise<void> {
    for (const commandId of Array.from(this.activeProcesses.keys())) {
      await this.cancelCommand(commandId).catch(() => {})
    }
  }

  private rowToDto(r: Record<string, unknown>): TerminalCommandDto {
    return {
      id: String(r.id),
      ownerId: String(r.owner_id),
      botId: String(r.bot_id),
      runId: String(r.run_id),
      canonicalWorkspace: String(r.canonical_workspace),
      executable: String(r.executable),
      args: JSON.parse(String(r.args_json)) as string[],
      permissionMode: String(r.permission_mode),
      policyId: String(r.policy_id),
      commandHash: String(r.command_hash),
      status: r.status as TerminalCommandDto['status'],
      exitCode: r.exit_code === null || r.exit_code === undefined ? null : Number(r.exit_code),
      signal: r.signal === null || r.signal === undefined ? null : String(r.signal),
      timedOut: Number(r.timed_out) === 1,
      terminationConfirmed:
        r.termination_confirmed === null || r.termination_confirmed === undefined
          ? null
          : Number(r.termination_confirmed) === 1,
      stdoutPreview: String(r.stdout_preview ?? ''),
      stderrPreview: String(r.stderr_preview ?? ''),
      truncated: Number(r.truncated) === 1,
      replayAllowed: false,
      errorCode: r.error_code === null || r.error_code === undefined ? null : String(r.error_code),
      expiresAt: String(r.expires_at),
      createdAt: String(r.created_at),
      startedAt: r.started_at === null || r.started_at === undefined ? null : String(r.started_at),
      endedAt: r.ended_at === null || r.ended_at === undefined ? null : String(r.ended_at),
      updatedAt: String(r.updated_at),
    }
  }
}
