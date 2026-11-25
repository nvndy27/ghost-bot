import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { sanitizeCustomSvg } from '@ghost-bot/avatar/svg-sanitizer'
import {
  BotAvatarConfigSchema,
  BotPermissionSchema,
  BotRecordSchema,
  CreateBotInputSchema,
  UpdateBotInputSchema,
} from '@ghost-bot/shared-types/ipc'
import type {
  BotRecord,
  BotsListResponse,
  CreateBotInput,
  UpdateBotInput,
} from '@ghost-bot/shared-types/ipc'
import type { DatabaseHandle } from '../db/client.ts'
import { DaemonError } from '../errors.ts'

interface AgentRow {
  id: string
  name: string
  description: string
  instructions: string
  avatar_json: string
  runtime_id: string
  model_id: string
  effort: string
  workspace_path: string
  permission_mode: string
  created_at: string
  updated_at: string
}

const FALLBACK_AVATAR = {
  kind: 'preset' as const,
  shape: 'ghost' as const,
  color: '#292929',
  eyes: 'classic' as const,
  rotation: 0,
  animation: true,
}

function validateCustomAvatarDataUrl(dataUrl: string): string {
  const prefix = 'data:image/svg+xml;base64,'
  if (!dataUrl.startsWith(prefix)) {
    throw new DaemonError('INVALID_AVATAR', 'Custom avatar must be a sanitized SVG data URL', {
      statusCode: 400,
    })
  }
  const decoded = Buffer.from(dataUrl.slice(prefix.length), 'base64').toString('utf8')
  const sanitized = sanitizeCustomSvg(decoded)
  if (!sanitized.ok) {
    throw new DaemonError('INVALID_AVATAR', `Rejected custom SVG: ${sanitized.reason}`, {
      statusCode: 400,
    })
  }
  return sanitized.dataUrl
}

function rowToBotRecord(row: AgentRow): BotRecord {
  let parsedAvatar: unknown = FALLBACK_AVATAR
  try {
    parsedAvatar = JSON.parse(row.avatar_json)
  } catch {
    parsedAvatar = FALLBACK_AVATAR
  }
  const avatarCheck = BotAvatarConfigSchema.safeParse(parsedAvatar)
  const avatar = avatarCheck.success ? avatarCheck.data : FALLBACK_AVATAR

  const permCheck = BotPermissionSchema.safeParse(row.permission_mode)
  const permission = permCheck.success ? permCheck.data : 'ask-approval'

  const effort =
    row.effort === 'low' || row.effort === 'medium' || row.effort === 'high'
      ? row.effort
      : 'medium'

  return BotRecordSchema.parse({
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    avatar,
    runtimeId: row.runtime_id,
    modelId: row.model_id,
    effort,
    workspacePath: row.workspace_path,
    permission,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

async function validateAndCanonicalizeWorkspace(rawPath: string): Promise<string> {
  const trimmed = rawPath.trim()
  if (!trimmed || trimmed.includes('\0')) {
    throw new DaemonError('INVALID_WORKSPACE', 'Workspace path is empty or contains NUL bytes', {
      statusCode: 400,
    })
  }
  const segments = trimmed.split(/[\\/]+/)
  if (segments.includes('..')) {
    throw new DaemonError('INVALID_WORKSPACE', 'Relative traversal (..) is not allowed in workspace path', {
      statusCode: 400,
    })
  }

  let expanded = trimmed
  if (trimmed === '~') {
    expanded = homedir()
  } else if (trimmed.startsWith('~/')) {
    expanded = join(homedir(), trimmed.slice(2))
  } else if (!isAbsolute(trimmed)) {
    throw new DaemonError('INVALID_WORKSPACE', 'Workspace path must be absolute or start with ~/', {
      statusCode: 400,
    })
  }

  const resolved = resolve(expanded)
  try {
    const canonical = await realpath(resolved)
    const st = await stat(canonical)
    if (!st.isDirectory()) {
      throw new DaemonError('INVALID_WORKSPACE', 'Workspace path is not a directory', {
        statusCode: 400,
      })
    }
    return canonical
  } catch (err) {
    if (err instanceof DaemonError) throw err
    throw new DaemonError('INVALID_WORKSPACE', 'Workspace directory does not exist or is inaccessible', {
      statusCode: 400,
    })
  }
}

export class BotRepository {
  private readonly handle: DatabaseHandle

  constructor(handle: DatabaseHandle) {
    this.handle = handle
  }

  listBots(): BotsListResponse {
    const rows = this.handle.sqlite
      .prepare(
        `SELECT id, name, description, instructions, avatar_json, runtime_id,
                model_id, effort, workspace_path, permission_mode, created_at, updated_at
         FROM agents
         WHERE archived_at IS NULL
         ORDER BY created_at ASC, name ASC`,
      )
      .all() as unknown as AgentRow[]

    const bots = rows.map(rowToBotRecord)
    const activeSetting = this.handle.sqlite
      .prepare('SELECT value_json FROM settings WHERE key = ?')
      .get('ui.activeBotId') as { value_json: string } | undefined

    let activeBotId: string | null = null
    if (activeSetting) {
      try {
        const parsed = JSON.parse(activeSetting.value_json) as unknown
        if (typeof parsed === 'string' && bots.some((b) => b.id === parsed)) {
          activeBotId = parsed
        }
      } catch {
        activeBotId = null
      }
    }
    if (!activeBotId && bots.length > 0) {
      activeBotId = bots[0].id
    }

    return { bots, activeBotId }
  }

  getBot(id: string): BotRecord | null {
    const row = this.handle.sqlite
      .prepare(
        `SELECT id, name, description, instructions, avatar_json, runtime_id,
                model_id, effort, workspace_path, permission_mode, created_at, updated_at
         FROM agents
         WHERE id = ? AND archived_at IS NULL`,
      )
      .get(id) as unknown as AgentRow | undefined
    return row ? rowToBotRecord(row) : null
  }

  async createBot(rawInput: CreateBotInput): Promise<BotRecord> {
    const input = CreateBotInputSchema.parse(rawInput)
    const canonicalWorkspace = await validateAndCanonicalizeWorkspace(input.workspacePath)
    const avatar =
      input.avatar.kind === 'custom'
        ? {
            ...input.avatar,
            svgDataUrl: validateCustomAvatarDataUrl(input.avatar.svgDataUrl),
          }
        : input.avatar

    const id = `bot-${randomUUID().slice(0, 8)}`
    const now = new Date().toISOString()

    return this.handle.transaction(() => {
      this.handle.sqlite
        .prepare(
          `INSERT INTO agents (
            id, name, description, instructions, avatar_json,
            runtime_id, model_profile_id, model_id, effort,
            workspace_path, permission_mode, archived_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          id,
          input.name,
          input.description,
          input.instructions,
          JSON.stringify(avatar),
          input.runtimeId,
          input.modelId,
          input.effort,
          canonicalWorkspace,
          input.permission,
          now,
          now,
        )

      this.handle.sqlite
        .prepare('INSERT OR REPLACE INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)')
        .run('ui.activeBotId', JSON.stringify(id), now)

      this.writeAudit('user', 'bot.create', id, 'ok', { name: input.name }, now)
      return this.getBot(id)!
    })
  }

  async updateBot(rawInput: UpdateBotInput): Promise<BotRecord> {
    const { id, patch } = UpdateBotInputSchema.parse(rawInput)
    const existing = this.getBot(id)
    if (!existing) {
      throw new DaemonError('NOT_FOUND', `Bot ${id} not found`, { statusCode: 404 })
    }

    const nextWorkspace =
      patch.workspacePath !== undefined
        ? await validateAndCanonicalizeWorkspace(patch.workspacePath)
        : existing.workspacePath

    const nextAvatar =
      patch.avatar?.kind === 'custom'
        ? {
            ...patch.avatar,
            svgDataUrl: validateCustomAvatarDataUrl(patch.avatar.svgDataUrl),
          }
        : (patch.avatar ?? existing.avatar)

    const now = new Date().toISOString()
    return this.handle.transaction(() => {
      this.handle.sqlite
        .prepare(
          `UPDATE agents
           SET name = ?, description = ?, instructions = ?, avatar_json = ?,
               runtime_id = ?, model_id = ?, effort = ?, workspace_path = ?,
               permission_mode = ?, updated_at = ?
           WHERE id = ? AND archived_at IS NULL`,
        )
        .run(
          patch.name ?? existing.name,
          patch.description ?? existing.description,
          patch.instructions ?? existing.instructions,
          JSON.stringify(nextAvatar),
          patch.runtimeId ?? existing.runtimeId,
          patch.modelId ?? existing.modelId,
          patch.effort ?? existing.effort,
          nextWorkspace,
          patch.permission ?? existing.permission,
          now,
          id,
        )

      this.writeAudit('user', 'bot.update', id, 'ok', { fields: Object.keys(patch) }, now)
      return this.getBot(id)!
    })
  }

  async duplicateBot(id: string): Promise<BotRecord> {
    const existing = this.getBot(id)
    if (!existing) {
      throw new DaemonError('NOT_FOUND', `Bot ${id} not found`, { statusCode: 404 })
    }
    const copyName = `${existing.name.slice(0, 52)} (Copy)`
    return this.createBot({
      name: copyName,
      description: existing.description,
      instructions: existing.instructions,
      avatar: existing.avatar,
      runtimeId: existing.runtimeId,
      modelId: existing.modelId,
      effort: existing.effort,
      workspacePath: existing.workspacePath,
      permission: existing.permission,
    })
  }

  deleteBot(id: string): { deletedId: string; activeBotId: string | null } {
    const existing = this.getBot(id)
    if (!existing) {
      throw new DaemonError('NOT_FOUND', `Bot ${id} not found`, { statusCode: 404 })
    }
    const now = new Date().toISOString()

    return this.handle.transaction(() => {
      const activeRun = this.handle.sqlite
        .prepare(
          `SELECT id FROM runs WHERE agent_id = ? AND status IN ('queued', 'starting', 'running', 'awaiting_approval', 'cancelling') LIMIT 1`,
        )
        .get(id) as { id: string } | undefined
      if (activeRun) {
        throw new DaemonError(
          'ACTIVE_RUN_EXISTS',
          `Cannot archive bot "${id}" while run "${activeRun.id}" is still active`,
          { statusCode: 409 },
        )
      }

      // Soft-archive agent so historical sessions, messages, usage_records, and audit_logs remain intact.
      this.handle.sqlite
        .prepare('UPDATE agents SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL')
        .run(now, now, id)
      const remaining = this.handle.sqlite
        .prepare(
          'SELECT id FROM agents WHERE archived_at IS NULL ORDER BY created_at ASC, name ASC LIMIT 1',
        )
        .get() as { id: string } | undefined

      const nextActiveId = remaining?.id ?? null
      this.handle.sqlite
        .prepare('INSERT OR REPLACE INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)')
        .run('ui.activeBotId', JSON.stringify(nextActiveId), now)

      this.writeAudit('user', 'bot.delete', id, 'ok', { name: existing.name }, now)
      return { deletedId: id, activeBotId: nextActiveId }
    })
  }

  setActiveBot(id: string | null): { activeBotId: string | null } {
    if (id !== null && !this.getBot(id)) {
      throw new DaemonError('NOT_FOUND', `Bot ${id} not found`, { statusCode: 404 })
    }
    const now = new Date().toISOString()
    this.handle.sqlite
      .prepare('INSERT OR REPLACE INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)')
      .run('ui.activeBotId', JSON.stringify(id), now)
    return { activeBotId: id }
  }

  private writeAudit(
    actor: string,
    action: string,
    target: string,
    outcome: string,
    meta: Record<string, unknown>,
    timestamp: string,
  ): void {
    this.handle.sqlite
      .prepare(
        `INSERT INTO audit_logs (id, actor, action, target, outcome, redacted_json, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), actor, action, target, outcome, JSON.stringify(meta), timestamp)
  }
}
