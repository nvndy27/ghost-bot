import { useEffect, useState } from 'react'
import type { TeamMemberRoutingDto, TeamMemberRoutingOverride, TeamRecordDto } from '@ghost-bot/shared-types/ipc'
import type { WorkspaceBot } from '../types/workspace.ts'

export function TeamMemberRouting({ team, bots, expanded }: { team: TeamRecordDto; bots: WorkspaceBot[]; expanded?: boolean }) {
  const [selection, setSelection] = useState(team.leadBotId)
  const [routing, setRouting] = useState<TeamMemberRoutingDto | null>(null)
  const [override, setOverride] = useState<TeamMemberRoutingOverride>({})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const botId = team.memberBotIds.includes(selection) ? selection : team.leadBotId
  const bridge = window.ghostBot

  useEffect(() => {
    if (!bridge) return
    let active = true
    setRouting(null)
    setError(null)
    void bridge.getTeamMemberRouting({ teamId: team.id, botId }).then((result) => {
      if (!active) return
      setRouting(result)
      setOverride(result.override ?? {})
    }).catch((err: unknown) => {
      if (active) setError(err instanceof Error ? err.message : 'Member routing unavailable')
    })
    return () => { active = false }
  }, [bridge, team.id, team.updatedAt, botId])

  if (!bridge) return null

  const catalog = routing?.catalogs.find((entry) =>
    entry.runtimeId === (override.runtimeId ?? routing.effective.runtimeId) &&
    entry.accountId === (override.accountId ?? routing.effective.accountId))
  const model = catalog?.models.find((entry) => entry.id === (override.modelId ?? routing?.effective.modelId))
  const update = async (value: TeamMemberRoutingOverride | null) => {
    setSaving(true)
    setError(null)
    try {
      const result = await bridge.setTeamMemberRouting({ teamId: team.id, botId, override: value })
      setRouting(result)
      setOverride(result.override ?? {})
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Member routing could not be saved')
    } finally {
      setSaving(false)
    }
  }

  return (
    <details className="gb-team-card" open={expanded}>
      <summary>Member model settings</summary>
      <fieldset disabled={saving}>
        <legend>Team-scoped configuration</legend>
        <label>
          Member
          <select aria-label="Member" value={botId} onChange={(event) => {
            setRouting(null)
            setSelection(event.target.value)
          }}>
            {team.memberBotIds.map((id) => (
              <option key={id} value={id}>{bots.find((bot) => bot.id === id)?.name ?? id}</option>
            ))}
          </select>
        </label>
        {routing && <>
          <p>{routing.supported ? 'Effective' : 'Unavailable'}: {routing.effective.runtimeId} · {routing.effective.modelId} · {routing.effective.effort}</p>
          <label>
            Provider runtime
            <select aria-label="Provider runtime" value={override.runtimeId ?? ''} onChange={(event) => setOverride({ runtimeId: event.target.value || undefined })}>
              <option value="">Inherit provider</option>
              {[...new Set(routing.catalogs.map((entry) => entry.runtimeId))].map((id) => <option key={id}>{id}</option>)}
            </select>
          </label>
          <label>
            Account
            <select aria-label="Account" value={override.accountId ?? ''} onChange={(event) => setOverride({
              runtimeId: override.runtimeId, accountId: event.target.value || undefined,
            })}>
              <option value="">Inherit account</option>
              {routing.catalogs.filter((entry) => entry.runtimeId === (override.runtimeId ?? routing.effective.runtimeId))
                .map((entry) => <option key={entry.accountId}>{entry.accountId}</option>)}
            </select>
          </label>
          <label>
            Model
            <select aria-label="Model" value={override.modelId ?? ''} onChange={(event) => setOverride({
              ...override, modelId: event.target.value || undefined, effort: undefined,
            })}>
              <option value="">Inherit model</option>
              {catalog?.models.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
            </select>
          </label>
          <label>
            Reasoning effort
            <select aria-label="Reasoning effort" value={override.effort ?? ''} onChange={(event) => setOverride({ ...override, effort: event.target.value || undefined })}>
              <option value="">Inherit effort</option>
              {model?.efforts.map((effort) => <option key={effort}>{effort}</option>)}
            </select>
          </label>
          <button type="button" className="gb-btn-outline" onClick={() => void update(override)}>Save member settings</button>
          {routing.override && <button type="button" className="gb-btn-outline" onClick={() => void update(null)}>Reset to bot defaults</button>}
        </>}
        {error && <p role="alert">{error}</p>}
      </fieldset>
    </details>
  )
}
