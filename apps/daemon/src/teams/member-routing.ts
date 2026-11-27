import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  TeamMemberRoutingOverrideSchema,
  type TeamMemberRoutingDto,
  type TeamMemberRoutingKey,
  type SetTeamMemberRouting,
} from '@ghost-bot/shared-types/ipc'
import { LOCAL_USER_ID } from '../memory/service.ts'
import type { BotRepository } from '../bots/repository.ts'
import type { DatabaseHandle } from '../db/client.ts'
import { DaemonError } from '../errors.ts'

const rowSchema = z.object({ override: TeamMemberRoutingOverrideSchema, revision: z.uuid() })
const storageKey = (teamId: string, botId: string) => `teams.member-routing:${teamId}:${botId}`
type CatalogLoader = () => Promise<TeamMemberRoutingDto['catalogs']>

export function clearRemovedMemberRouting(db: DatabaseHandle, teamId: string, previous: readonly string[], next: readonly string[]): void {
  const retained = new Set(next)
  const remove = db.sqlite.prepare('DELETE FROM settings WHERE key = ?')
  for (const botId of previous) {
    if (!retained.has(botId)) remove.run(storageKey(teamId, botId))
  }
}

export class TeamMemberRoutingService {
  private readonly db: DatabaseHandle
  private readonly bots: BotRepository
  private readonly loadCatalogs: CatalogLoader

  constructor(db: DatabaseHandle, bots: BotRepository, loadCatalogs: CatalogLoader) {
    this.db = db
    this.bots = bots
    this.loadCatalogs = loadCatalogs
  }

  private read(key: TeamMemberRoutingKey) {
    const team = this.db.sqlite.prepare('SELECT member_bot_ids_json, updated_at FROM teams WHERE id = ? AND owner_id = ? AND archived_at IS NULL')
      .get(key.teamId, LOCAL_USER_ID) as { member_bot_ids_json: string; updated_at: string } | undefined
    const bot = this.bots.getBot(key.botId)
    if (!team || !bot || !(JSON.parse(team.member_bot_ids_json) as string[]).includes(key.botId)) {
      throw new DaemonError('TEAM_MEMBER_UNAVAILABLE', 'This bot is not an active team member', { statusCode: 404 })
    }
    const raw = this.db.sqlite.prepare('SELECT value_json FROM settings WHERE key = ?')
      .get(storageKey(key.teamId, key.botId)) as { value_json: string } | undefined
    const stored = raw ? rowSchema.parse(JSON.parse(raw.value_json)) : null
    return { bot, stored, teamUpdatedAt: team.updated_at }
  }

  private resolve(state: ReturnType<TeamMemberRoutingService['read']>, catalogs: TeamMemberRoutingDto['catalogs']): TeamMemberRoutingDto {
    const { bot, stored } = state
    const runtimeId = stored?.override.runtimeId ?? bot.runtimeId
    const globalCatalog = catalogs.find((entry) => entry.runtimeId === bot.runtimeId)
    const accountId = stored?.override.accountId ?? (runtimeId === bot.runtimeId ? globalCatalog?.accountId ?? null : null)
    const modelId = stored?.override.modelId ?? bot.modelId
    const effort = stored?.override.effort ?? bot.effort
    const catalog = catalogs.find((entry) => entry.runtimeId === runtimeId && entry.accountId === accountId)
    const model = catalog?.models.find((entry) => entry.id === modelId)
    return {
      override: stored?.override ?? null,
      effective: { runtimeId, accountId, modelId, effort },
      supported: Boolean(model?.efforts.includes(effort)),
      revision: JSON.stringify([state.teamUpdatedAt, bot.updatedAt, stored?.revision ?? null]),
      catalogs,
    }
  }

  async get(key: TeamMemberRoutingKey): Promise<TeamMemberRoutingDto> {
    const catalogs = await this.loadCatalogs()
    return this.resolve(this.read(key), catalogs)
  }

  revalidate(key: TeamMemberRoutingKey, expected: TeamMemberRoutingDto): void {
    const current = this.resolve(this.read(key), expected.catalogs)
    if (!current.supported || current.revision !== expected.revision ||
        JSON.stringify(current.effective) !== JSON.stringify(expected.effective)) {
      throw new DaemonError('TEAM_ROUTING_CHANGED', 'Team member configuration changed before dispatch', { statusCode: 409 })
    }
  }

  async set(input: SetTeamMemberRouting): Promise<TeamMemberRoutingDto> {
    const catalogs = await this.loadCatalogs()
    return this.db.transaction(() => {
      const state = this.read(input)
      const override = input.override && Object.keys(input.override).length ? input.override : null
      const stored = override ? { override, revision: randomUUID() } : null
      const result = this.resolve({ ...state, stored }, catalogs)
      if (stored && !result.supported) {
        throw new DaemonError('TEAM_ROUTING_UNSUPPORTED', 'Choose a compatible runtime, account, model and effort', { statusCode: 400 })
      }
      const key = storageKey(input.teamId, input.botId)
      if (!stored) {
        this.db.sqlite.prepare('DELETE FROM settings WHERE key = ?').run(key)
      } else {
        this.db.sqlite.prepare(`INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
          .run(key, JSON.stringify(stored), new Date().toISOString())
      }
      return result
    })
  }
}
