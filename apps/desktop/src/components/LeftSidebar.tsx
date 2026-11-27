import type { TeamRecordDto } from '@ghost-bot/shared-types/ipc'
import { PanelLeft, Plus, Search, Settings, UsersRound } from 'lucide-react'
import type { WorkspaceBot } from '../types/workspace.ts'
import { BotAvatar } from './BotAvatar.tsx'
import { ICON_SIZE, ICON_STROKE, IconButton } from './IconButton.tsx'

export interface LeftSidebarProps {
  width: number
  bots: WorkspaceBot[]
  activeBotId: string | null
  teams: TeamRecordDto[]
  activeTeamId: string | null
  teamsLoading?: boolean
  teamsError?: string | null
  searchQuery: string
  onSearchChange: (value: string) => void
  onSelectBot: (botId: string) => void
  onSelectTeam: (teamId: string) => void
  onCreateBot: () => void
  onCreateTeam: () => void
  onOpenSettings: () => void
  onCollapse: () => void
  isMockMode: boolean
}

export function LeftSidebar({
  width,
  bots,
  activeBotId,
  teams,
  activeTeamId,
  teamsLoading = false,
  teamsError = null,
  searchQuery,
  onSearchChange,
  onSelectBot,
  onSelectTeam,
  onCreateBot,
  onCreateTeam,
  onOpenSettings,
  onCollapse,
  isMockMode,
}: LeftSidebarProps) {
  const filtered = bots.filter((b) =>
    b.name.toLowerCase().includes(searchQuery.trim().toLowerCase()),
  )

  return (
    <aside
      className="gb-left-sidebar"
      style={{ width: `${width}px` }}
      aria-label="My Bots sidebar"
    >
      <div className="gb-sidebar-head">
        <h1>My bots</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
          <IconButton label="Create bot" onClick={onCreateBot}>
            <Plus size={ICON_SIZE.md} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </IconButton>
          <IconButton label="Collapse sidebar" onClick={onCollapse} pressed={false}>
            <PanelLeft size={ICON_SIZE.md} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </IconButton>
        </div>
      </div>

      <div className="gb-search-wrap">
        <Search
          size={ICON_SIZE.sm}
          strokeWidth={ICON_STROKE}
          className="gb-search-icon"
          aria-hidden="true"
        />
        <input
          className="gb-search-input"
          type="search"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search bots"
          aria-label="Search bots"
        />
      </div>

      <div className="gb-bot-list" role="listbox" aria-label="Bots">
        {filtered.length === 0 ? (
          <p className="gb-muted" style={{ fontSize: '12.5px', padding: '8px 6px', margin: 0 }}>
            No matching bots.
          </p>
        ) : (
          filtered.map((bot) => {
            const active = bot.id === activeBotId
            return (
              <button
                key={bot.id}
                type="button"
                role="option"
                aria-selected={active}
                className={`gb-bot-item${active ? ' active' : ''}`}
                onClick={() => onSelectBot(bot.id)}
              >
                <BotAvatar config={bot.avatar} status={bot.avatarStatus} size={32} />
                <span className="gb-bot-meta">
                  <span className="gb-bot-name">{bot.name}</span>
                  <span className="gb-bot-status">{bot.statusLabel}</span>
                </span>
              </button>
            )
          })
        )}
      </div>

      <hr className="gb-divider" />

      <div>
        <div
          className="gb-section-label"
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <span>Teams</span>
          <button
            type="button"
            className="gb-btn-outline gb-icon-inline"
            style={{ padding: '2px 7px', fontSize: 11, gap: '4px' }}
            onClick={onCreateTeam}
            aria-label="Create team"
          >
            <Plus size={12} strokeWidth={2.1} aria-hidden="true" />
            <span>New</span>
          </button>
        </div>
        {teamsLoading ? (
          <div className="gb-muted" style={{ fontSize: 12, padding: '4px 8px' }}>
            Loading teams...
          </div>
        ) : teamsError ? (
          <div style={{ color: 'var(--gb-danger)', fontSize: 12, padding: '4px 8px' }}>
            {teamsError}
          </div>
        ) : teams.length === 0 ? (
          <div className="gb-muted" style={{ fontSize: 12, padding: '4px 8px' }}>
            No teams yet
          </div>
        ) : (
          teams.map((team) => {
            const isActive = team.id === activeTeamId
            return (
              <button
                key={team.id}
                type="button"
                className={`gb-team-item${isActive ? ' active' : ''}`}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  background: isActive ? 'var(--gb-surface-elevated)' : 'transparent',
                  border: isActive ? '1px solid var(--gb-border)' : '1px solid transparent',
                  cursor: 'pointer',
                  font: 'inherit',
                  color: 'inherit',
                }}
                onClick={() => onSelectTeam(team.id)}
              >
                <span
                  className="gb-icon-inline"
                  style={{ minWidth: 0, overflow: 'hidden', gap: '7px' }}
                >
                  <UsersRound size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} aria-hidden="true" style={{ flexShrink: 0, color: 'var(--gb-muted)' }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {team.name}
                  </span>
                </span>
                <span className="gb-badge">
                  {isMockMode ? `${team.memberBotIds.length} mock` : `${team.memberBotIds.length}`}
                </span>
              </button>
            )
          })
        )}
      </div>

      <div style={{ flex: 1 }} />

      <button
        type="button"
        className="gb-settings-btn"
        onClick={onOpenSettings}
        aria-label="Open Settings"
      >
        <Settings size={ICON_SIZE.md} strokeWidth={ICON_STROKE} aria-hidden="true" style={{ color: 'var(--gb-muted)', flexShrink: 0 }} />
        <span>Settings</span>
      </button>
    </aside>
  )
}
