import {
  SidebarOrganizationSchema,
  UpdateSidebarOrganizationInputSchema,
} from '@ghost-bot/shared-types/ipc'
import type {
  SidebarOrganization,
  UpdateSidebarOrganizationInput,
} from '@ghost-bot/shared-types/ipc'
import type { DatabaseHandle } from '../db/client.ts'
import { DaemonError } from '../errors.ts'

const SIDEBAR_ORGANIZATION_KEY = 'ui.sidebarOrganization.v1'

function dedupeOrderedIds(ids: readonly string[], validSet: ReadonlySet<string>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (!validSet.has(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

export class SidebarOrganizationRepository {
  private readonly handle: DatabaseHandle

  constructor(handle: DatabaseHandle) {
    this.handle = handle
  }

  private getActiveBotIds(): Set<string> {
    const rows = this.handle.sqlite
      .prepare('SELECT id FROM agents WHERE archived_at IS NULL')
      .all() as Array<{ id: string }>
    return new Set(rows.map((r) => r.id))
  }

  private getActiveTeamIds(): Set<string> {
    const rows = this.handle.sqlite
      .prepare('SELECT id FROM teams WHERE archived_at IS NULL')
      .all() as Array<{ id: string }>
    return new Set(rows.map((r) => r.id))
  }

  private readRaw(): SidebarOrganization {
    const row = this.handle.sqlite
      .prepare('SELECT value_json FROM settings WHERE key = ?')
      .get(SIDEBAR_ORGANIZATION_KEY) as { value_json: string } | undefined

    if (!row) {
      return SidebarOrganizationSchema.parse({})
    }

    try {
      const parsed = JSON.parse(row.value_json) as unknown
      const checked = SidebarOrganizationSchema.safeParse(parsed)
      return checked.success ? checked.data : SidebarOrganizationSchema.parse({})
    } catch {
      return SidebarOrganizationSchema.parse({})
    }
  }

  private normalize(raw: SidebarOrganization): SidebarOrganization {
    const validBots = this.getActiveBotIds()
    const validTeams = this.getActiveTeamIds()
    return {
      pinnedBotIds: dedupeOrderedIds(raw.pinnedBotIds, validBots),
      botOrder: dedupeOrderedIds(raw.botOrder, validBots),
      pinnedTeamIds: dedupeOrderedIds(raw.pinnedTeamIds, validTeams),
      teamOrder: dedupeOrderedIds(raw.teamOrder, validTeams),
    }
  }

  private writeRawInTx(org: SidebarOrganization, now: string): void {
    this.handle.sqlite
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(SIDEBAR_ORGANIZATION_KEY, JSON.stringify(org), now)
  }

  getOrganization(): SidebarOrganization {
    const raw = this.readRaw()
    return this.normalize(raw)
  }

  updateOrganization(rawInput: UpdateSidebarOrganizationInput): SidebarOrganization {
    const parsed = UpdateSidebarOrganizationInputSchema.safeParse(rawInput)
    if (!parsed.success) {
      throw new DaemonError(
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid sidebar organization payload',
        { statusCode: 400 },
      )
    }

    const input = parsed.data
    const now = new Date().toISOString()

    return this.handle.transaction(() => {
      const current = this.readRaw()
      const merged = this.normalize({
        pinnedBotIds: input.pinnedBotIds ?? current.pinnedBotIds,
        botOrder: input.botOrder ?? current.botOrder,
        pinnedTeamIds: input.pinnedTeamIds ?? current.pinnedTeamIds,
        teamOrder: input.teamOrder ?? current.teamOrder,
      })
      this.writeRawInTx(merged, now)
      return merged
    })
  }

  pruneBotInTx(botId: string, now: string): void {
    const current = this.readRaw()
    const next: SidebarOrganization = {
      pinnedBotIds: current.pinnedBotIds.filter((id) => id !== botId),
      botOrder: current.botOrder.filter((id) => id !== botId),
      pinnedTeamIds: current.pinnedTeamIds,
      teamOrder: current.teamOrder,
    }
    if (
      next.pinnedBotIds.length !== current.pinnedBotIds.length ||
      next.botOrder.length !== current.botOrder.length
    ) {
      this.writeRawInTx(next, now)
    }
  }

  pruneTeam(teamId: string): void {
    const now = new Date().toISOString()
    this.handle.transaction(() => {
      const current = this.readRaw()
      const next: SidebarOrganization = {
        pinnedBotIds: current.pinnedBotIds,
        botOrder: current.botOrder,
        pinnedTeamIds: current.pinnedTeamIds.filter((id) => id !== teamId),
        teamOrder: current.teamOrder.filter((id) => id !== teamId),
      }
      if (
        next.pinnedTeamIds.length !== current.pinnedTeamIds.length ||
        next.teamOrder.length !== current.teamOrder.length
      ) {
        this.writeRawInTx(next, now)
      }
    })
  }
}
