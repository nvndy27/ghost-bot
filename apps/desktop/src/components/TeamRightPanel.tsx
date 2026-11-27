import type { TeamRecordDto, WorkspaceTabId } from '@ghost-bot/shared-types/ipc'
import { Activity, RefreshCw } from 'lucide-react'
import type { WorkspaceBot } from '../types/workspace.ts'
import { WorkspacePanelShell } from './WorkspacePanelShell.tsx'
import { BotAvatar } from './BotAvatar.tsx'
import { ICON_SIZE, ICON_STROKE, IconButton } from './IconButton.tsx'

export interface TeamRightPanelProps {
  width: number
  team: TeamRecordDto
  bots: WorkspaceBot[]
  activeRun: Record<string, unknown> | null
  tasks: Array<Record<string, unknown>>
  diagnostics: Record<string, unknown> | null
  aggregateUsage: Record<string, unknown> | null
  isMockMode: boolean
  onRefresh: () => void
  onCollapse: () => void
  activeTab: WorkspaceTabId
  onTabChange: (tab: WorkspaceTabId) => void
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asString(value: unknown, fallback = 'none'): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

export function TeamRightPanel({
  width,
  team,
  bots,
  activeRun,
  tasks,
  diagnostics,
  aggregateUsage,
  isMockMode,
  onRefresh,
  onCollapse,
  activeTab,
  onTabChange,
}: TeamRightPanelProps) {
  const botById = new Map(bots.map((b) => [b.id, b]))
  const leadBot = botById.get(team.leadBotId)

  const counts = {
    active: tasks.filter((t) => t.status === 'running' || t.status === 'awaiting_approval').length,
    queued: tasks.filter((t) => t.status === 'pending' || t.status === 'queued').length,
    completed: tasks.filter((t) => t.status === 'completed').length,
    blocked: tasks.filter((t) => t.status === 'blocked' || t.status === 'failed' || t.status === 'denied').length,
    uncertain: tasks.filter((t) => t.status === 'uncertain').length,
  }

  const reportedTokens = asNumber(aggregateUsage?.totalTokens)
  const reportedDurationMs = asNumber(aggregateUsage?.totalDurationMs)
  const unknownUsageCount = asNumber(aggregateUsage?.unknownUsageCount) ?? 0
  const maxTokens = asNumber(team.bounds.maxTokens)
  const maxDurationMs = asNumber(team.bounds.maxDurationMs)
  const maxConcurrent = asNumber(team.bounds.maxConcurrentTasks)

  const runStatus = activeRun ? asString(activeRun.status, 'unknown') : 'idle'
  const quarantineReason = diagnostics ? asString(diagnostics.quarantineReason, '') : ''
  const cancellationState = diagnostics ? asString(diagnostics.cancellationState, '') : ''

  const overview = (
    <section aria-label="Team activity panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="gb-section-label gb-icon-inline" style={{ margin: 0 }}>
          <Activity size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} aria-hidden="true" />
          <span>Team Activity</span>
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          <IconButton label="Refresh team activity" onClick={onRefresh}>
            <RefreshCw size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </IconButton>
        </div>
      </div>

      <div className="gb-card" style={{ display: 'grid', gap: 8 }}>
        <div className="gb-section-label" style={{ margin: 0 }}>
          Chief of Staff
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {leadBot && <BotAvatar config={leadBot.avatar} status="idle" size={26} />}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{leadBot?.name ?? team.leadBotId}</div>
            <div className="gb-muted" style={{ fontSize: 12 }}>
              {leadBot ? `${leadBot.permission} · ${isMockMode ? 'Simulated (Mock)' : 'Live gated'}` : 'Missing bot'}
            </div>
          </div>
        </div>
      </div>

      <div className="gb-card" style={{ display: 'grid', gap: 8 }}>
        <div className="gb-section-label" style={{ margin: 0 }}>
          Members ({team.memberBotIds.length})
        </div>
        <div style={{ display: 'grid', gap: 6 }}>
          {team.memberBotIds.map((memberId) => {
            const bot = botById.get(memberId)
            const isLead = memberId === team.leadBotId
            return (
              <div
                key={memberId}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, fontSize: 12 }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  {bot && <BotAvatar config={bot.avatar} status="idle" size={20} />}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {bot?.name ?? memberId}
                  </span>
                </span>
                <span className="gb-badge">{isLead ? 'Lead' : bot?.permission ?? 'worker'}</span>
              </div>
            )
          })}
        </div>
      </div>

      <div className="gb-card" style={{ display: 'grid', gap: 6, fontSize: 12 }}>
        <div className="gb-section-label" style={{ margin: 0 }}>
          Task Progress & Concurrency
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span className="gb-muted">Run status</span>
          <strong>{runStatus}</strong>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span className="gb-muted">Active / Queued</span>
          <span>
            {counts.active} / {counts.queued}
          </span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span className="gb-muted">Completed / Blocked</span>
          <span>
            {counts.completed} / {counts.blocked}
          </span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span className="gb-muted">Uncertain</span>
          <span>{counts.uncertain}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span className="gb-muted">Concurrency limit</span>
          <span>{maxConcurrent ?? '—'}</span>
        </div>
      </div>

      <div className="gb-card" style={{ display: 'grid', gap: 6, fontSize: 12 }}>
        <div className="gb-section-label" style={{ margin: 0 }}>
          Budget vs Actual Usage
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span className="gb-muted">Estimated token cap</span>
          <span>{maxTokens !== null ? maxTokens.toLocaleString() : '—'}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span className="gb-muted">Actual reported tokens</span>
          <span>{reportedTokens !== null ? reportedTokens.toLocaleString() : 'Unknown'}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span className="gb-muted">Estimated duration cap</span>
          <span>{maxDurationMs !== null ? `${Math.round(maxDurationMs / 1000)}s` : '—'}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span className="gb-muted">Actual reported duration</span>
          <span>{reportedDurationMs !== null ? `${reportedDurationMs}ms` : 'Unknown'}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span className="gb-muted">Unknown usage tasks</span>
          <span>{unknownUsageCount}</span>
        </div>
        <div className="gb-muted" style={{ fontSize: 11 }}>
          Memory sharing: {team.memorySharingPolicy}
        </div>
      </div>

      {(quarantineReason || cancellationState || counts.uncertain > 0) && (
        <div
          className="gb-card"
          style={{
            display: 'grid',
            gap: 4,
            fontSize: 12,
            borderColor: 'var(--gb-danger)',
          }}
        >
          <strong style={{ color: 'var(--gb-danger)' }}>Safety & Quarantine</strong>
          {cancellationState && <div>Cancellation: {cancellationState}</div>}
          {quarantineReason && <div>Quarantine: {quarantineReason}</div>}
          {counts.uncertain > 0 && (
            <div className="gb-muted">
              {counts.uncertain} uncertain task(s) will not be auto-replayed.
            </div>
          )}
        </div>
      )}
    </section>
  )

  return (
    <WorkspacePanelShell
      width={width}
      contextKey={`team:${team.id}`}
      contextLabel={team.name}
      contextKind="team"
      ownerId={team.id}
      isMockMode={isMockMode}
      onCollapse={onCollapse}
      activeTab={activeTab}
      onTabChange={onTabChange}
      overviewContent={overview}
    />
  )
}
