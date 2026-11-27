import type { TeamRecordDto } from '@ghost-bot/shared-types/ipc'
import type { WorkspaceBot } from '../types/workspace.ts'
import { BotAvatar } from './BotAvatar.tsx'

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
          <button
            type="button"
            onClick={onCreateBot}
            title="Create bot"
            aria-label="Create bot"
          >
            +
          </button>
          <button
            type="button"
            onClick={onCollapse}
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
          >
            «
          </button>
        </div>
      </div>

      <div className="gb-search-wrap">
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
            className="gb-btn-outline"
            style={{ padding: '2px 7px', fontSize: 11 }}
            onClick={onCreateTeam}
            aria-label="Create team"
          >
            + New
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
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {team.name}
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
        <span aria-hidden="true">⚙</span>
        <span>Settings</span>
      </button>
    </aside>
  )
}
