import { TeamAvatar } from './TeamAvatar.tsx'
import type { PrivateTaskChatRecord, SidebarOrganization, TeamRecordDto } from '@ghost-bot/shared-types/ipc'
import { formatProviderLabel } from '@ghost-bot/shared-types/runtime'
import {
  ChevronDown,
  ChevronUp,
  PanelLeft,
  Pin,
  Plus,
  Search,
  Settings,
} from 'lucide-react'
import type { WorkspaceBot } from '../types/workspace.ts'
import { orderSidebarItems } from '../state/sidebarOrder.ts'
import { BotAvatar } from './BotAvatar.tsx'
import { ICON_SIZE, ICON_STROKE, IconButton } from './IconButton.tsx'

export { orderSidebarItems }

export interface LeftSidebarProps {
  width: number
  bots: WorkspaceBot[]
  activeBotId: string | null
  teams: TeamRecordDto[]
  activeTeamId: string | null
  privateTasks?: PrivateTaskChatRecord[]
  activePrivateTaskId?: string | null
  organization?: SidebarOrganization
  unreadCountByBot?: Record<string, number>
  teamsLoading?: boolean
  teamsError?: string | null
  searchQuery: string
  onSearchChange: (value: string) => void
  onSelectBot: (botId: string) => void
  onSelectTeam: (teamId: string) => void
  onSelectPrivateTask?: (task: PrivateTaskChatRecord) => void
  onTogglePinBot?: (botId: string) => void
  onMoveBot?: (botId: string, direction: 'up' | 'down') => void
  onTogglePinTeam?: (teamId: string) => void
  onMoveTeam?: (teamId: string, direction: 'up' | 'down') => void
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
  privateTasks = [],
  activePrivateTaskId = null,
  organization,
  unreadCountByBot = {},
  teamsLoading = false,
  teamsError = null,
  searchQuery,
  onSearchChange,
  onSelectBot,
  onSelectTeam,
  onSelectPrivateTask,
  onTogglePinBot,
  onMoveBot,
  onTogglePinTeam,
  onMoveTeam,
  onCreateBot,
  onCreateTeam,
  onOpenSettings,
  onCollapse,
}: LeftSidebarProps) {
  const pinnedBotSet = new Set(organization?.pinnedBotIds ?? [])
  const pinnedTeamSet = new Set(organization?.pinnedTeamIds ?? [])

  const orderedBots = orderSidebarItems(
    bots,
    organization?.pinnedBotIds ?? [],
    organization?.botOrder ?? [],
  )
  const orderedTeams = orderSidebarItems(
    teams,
    organization?.pinnedTeamIds ?? [],
    organization?.teamOrder ?? [],
  )

  const q = searchQuery.trim().toLowerCase()
  const filteredBots = q
    ? orderedBots.filter(
        (b) =>
          b.name.toLowerCase().includes(q) ||
          formatProviderLabel(b.runtimeId).toLowerCase().includes(q),
      )
    : orderedBots

  const filteredTeams = q
    ? orderedTeams.filter((t) => t.name.toLowerCase().includes(q))
    : orderedTeams

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
          placeholder="Search bots & teams"
          aria-label="Search bots"
        />
      </div>

      <div className="gb-bot-list" role="listbox" aria-label="Bots">
        {filteredBots.length === 0 ? (
          <p className="gb-muted" style={{ fontSize: '12.5px', padding: '8px 6px', margin: 0 }}>
            No matching bots.
          </p>
        ) : (
          filteredBots.map((bot, idx) => {
            const active = bot.id === activeBotId
            const isPinned = pinnedBotSet.has(bot.id)
            const unreadCount = unreadCountByBot[bot.id] ?? 0
            const providerLabel = formatProviderLabel(bot.runtimeId)
            const canReorder = !q && Boolean(onMoveBot)
            const groupSamePinnedPrev = idx > 0 && pinnedBotSet.has(filteredBots[idx - 1].id) === isPinned
            const groupSamePinnedNext =
              idx < filteredBots.length - 1 && pinnedBotSet.has(filteredBots[idx + 1].id) === isPinned

            return (
              <div
                key={bot.id}
                className={`gb-sidebar-row${isPinned ? ' pinned' : ''}`}
                data-bot-id={bot.id}
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`gb-bot-item${active ? ' active' : ''}`}
                  onClick={() => onSelectBot(bot.id)}
                >
                  <BotAvatar config={bot.avatar} status={bot.avatarStatus} size={32} />
                  <span className="gb-bot-meta">
                    <span className="gb-bot-name">{bot.name}</span>
                    <span className="gb-bot-status">{providerLabel}</span>
                  </span>
                  {unreadCount > 0 && (
                    <span
                      className="gb-unread-pill"
                      aria-label={`${unreadCount} unread conversation${unreadCount === 1 ? '' : 's'}`}
                      title={`${unreadCount} unread`}
                    >
                      {unreadCount}
                    </span>
                  )}
                </button>
                {(onTogglePinBot || onMoveBot) && (
                  <div className="gb-row-actions">
                    {canReorder && (
                      <>
                        <button
                          type="button"
                          className="gb-row-action-btn"
                          aria-label={`Move ${bot.name} up`}
                          title="Move up"
                          disabled={!groupSamePinnedPrev}
                          onClick={() => onMoveBot?.(bot.id, 'up')}
                        >
                          <ChevronUp size={13} strokeWidth={ICON_STROKE} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="gb-row-action-btn"
                          aria-label={`Move ${bot.name} down`}
                          title="Move down"
                          disabled={!groupSamePinnedNext}
                          onClick={() => onMoveBot?.(bot.id, 'down')}
                        >
                          <ChevronDown size={13} strokeWidth={ICON_STROKE} aria-hidden="true" />
                        </button>
                      </>
                    )}
                    {onTogglePinBot && (
                      <button
                        type="button"
                        className="gb-row-action-btn"
                        aria-label={isPinned ? `Unpin ${bot.name}` : `Pin ${bot.name}`}
                        aria-pressed={isPinned}
                        title={isPinned ? 'Unpin bot' : 'Pin bot'}
                        onClick={() => onTogglePinBot(bot.id)}
                      >
                        <Pin size={12} strokeWidth={ICON_STROKE} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                )}
              </div>
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
        ) : filteredTeams.length === 0 ? (
          <div className="gb-muted" style={{ fontSize: 12, padding: '4px 8px' }}>
            {q ? 'No matching teams' : 'No teams yet'}
          </div>
        ) : (
          filteredTeams.map((team, idx) => {
            const isActive = team.id === activeTeamId
            const isPinned = pinnedTeamSet.has(team.id)
            const canReorder = !q && Boolean(onMoveTeam)
            const groupSamePinnedPrev = idx > 0 && pinnedTeamSet.has(filteredTeams[idx - 1].id) === isPinned
            const groupSamePinnedNext =
              idx < filteredTeams.length - 1 && pinnedTeamSet.has(filteredTeams[idx + 1].id) === isPinned

            return (
              <div
                key={team.id}
                className={`gb-sidebar-row${isPinned ? ' pinned' : ''}`}
                data-team-id={team.id}
              >
                <button
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
                    <TeamAvatar appearance={team.appearance} memberIds={team.memberBotIds} bots={bots} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {team.name}
                    </span>
                  </span>
                  <small className="gb-muted gb-team-count">{team.memberBotIds.length}</small>
                </button>
                {(onTogglePinTeam || onMoveTeam) && (
                  <div className="gb-row-actions">
                    {canReorder && (
                      <>
                        <button
                          type="button"
                          className="gb-row-action-btn"
                          aria-label={`Move ${team.name} up`}
                          title="Move up"
                          disabled={!groupSamePinnedPrev}
                          onClick={() => onMoveTeam?.(team.id, 'up')}
                        >
                          <ChevronUp size={13} strokeWidth={ICON_STROKE} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="gb-row-action-btn"
                          aria-label={`Move ${team.name} down`}
                          title="Move down"
                          disabled={!groupSamePinnedNext}
                          onClick={() => onMoveTeam?.(team.id, 'down')}
                        >
                          <ChevronDown size={13} strokeWidth={ICON_STROKE} aria-hidden="true" />
                        </button>
                      </>
                    )}
                    {onTogglePinTeam && (
                      <button
                        type="button"
                        className="gb-row-action-btn"
                        aria-label={isPinned ? `Unpin ${team.name}` : `Pin ${team.name}`}
                        aria-pressed={isPinned}
                        title={isPinned ? 'Unpin team' : 'Pin team'}
                        onClick={() => onTogglePinTeam(team.id)}
                      >
                        <Pin size={12} strokeWidth={ICON_STROKE} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      {privateTasks.length > 0 && onSelectPrivateTask && (
        <>
          <hr className="gb-divider" />
          <div>
            <div className="gb-section-label">
              <span>Private Tasks</span>
            </div>
            {privateTasks.slice(0, 8).map((task) => {
              const bot = bots.find((b) => b.id === task.assignedBotId)
              const isActive = task.teamRunId === activePrivateTaskId
              return (
                <button
                  key={task.teamRunId}
                  type="button"
                  data-sidebar-private-task={task.teamRunId}
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
                  onClick={() => onSelectPrivateTask(task)}
                >
                  <span className="gb-icon-inline" style={{ minWidth: 0, overflow: 'hidden', gap: '6px' }}>
                    {bot && <BotAvatar config={bot.avatar} status="idle" size={18} />}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
                      {bot?.name ?? task.assignedBotId}: {task.objective}
                    </span>
                  </span>
                  <span className="gb-badge">{task.status}</span>
                </button>
              )
            })}
          </div>
        </>
      )}

      <div style={{ flex: 1 }} />

      <button
        type="button"
        className="gb-settings-btn"
        onClick={onOpenSettings}
        aria-label="Open Settings"
      >
        <Settings
          size={ICON_SIZE.md}
          strokeWidth={ICON_STROKE}
          aria-hidden="true"
          style={{ color: 'var(--gb-muted)', flexShrink: 0 }}
        />
        <span>Settings</span>
      </button>
    </aside>
  )
}
