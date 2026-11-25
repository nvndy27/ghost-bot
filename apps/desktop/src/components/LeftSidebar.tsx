import type { WorkspaceBot } from '../types/workspace.ts'
import { MOCK_TEAMS } from '../data/mockWorkspace.ts'
import { BotAvatar } from './BotAvatar.tsx'

export interface LeftSidebarProps {
  width: number
  bots: WorkspaceBot[]
  activeBotId: string | null
  searchQuery: string
  onSearchChange: (value: string) => void
  onSelectBot: (botId: string) => void
  onCreateBot: () => void
  onOpenSettings: () => void
  onCollapse: () => void
  isMockMode: boolean
}

export function LeftSidebar({
  width,
  bots,
  activeBotId,
  searchQuery,
  onSearchChange,
  onSelectBot,
  onCreateBot,
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
        <div className="gb-section-label">Teams</div>
        {MOCK_TEAMS.map((team) => (
          <div key={team.id} className="gb-team-item">
            <span>{team.name}</span>
            <span className="gb-badge">{isMockMode ? 'Preview' : 'Phase 4'}</span>
          </div>
        ))}
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
