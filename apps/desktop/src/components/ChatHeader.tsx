import type { SessionRecord } from '@ghost-bot/shared-types/ipc'
import { Ellipsis, PanelLeft, PanelRight, SquarePen } from 'lucide-react'
import type { WorkspaceBot } from '../types/workspace.ts'
import { BotAvatar } from './BotAvatar.tsx'
import { ICON_SIZE, ICON_STROKE, IconButton } from './IconButton.tsx'

export interface ChatHeaderProps {
  bot: WorkspaceBot | null
  leftCollapsed: boolean
  rightCollapsed: boolean
  isMockMode: boolean
  sessions?: SessionRecord[]
  activeSessionId?: string | null
  onSelectSession?: (sessionId: string) => void
  onNewChat?: () => void
  onEditBot: () => void
  onToggleLeft: () => void
  onToggleRight: () => void
}

export function ChatHeader({
  bot,
  leftCollapsed,
  rightCollapsed,
  isMockMode,
  sessions,
  activeSessionId,
  onSelectSession,
  onNewChat,
  onEditBot,
  onToggleLeft,
  onToggleRight,
}: ChatHeaderProps) {
  return (
    <header className="gb-chat-header">
      {leftCollapsed && (
        <IconButton
          label="Expand left sidebar"
          onClick={onToggleLeft}
          pressed={!leftCollapsed}
        >
          <PanelLeft size={ICON_SIZE.md} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </IconButton>
      )}
      {bot ? (
        <>
          <BotAvatar
            config={bot.avatar}
            status={bot.avatarStatus}
            size={32}
            label={`${bot.name} avatar`}
          />
          <strong className="gb-chat-header-title">{bot.name}</strong>
          <span className="gb-badge">
            {isMockMode ? 'Mock UI' : 'Codex Ready'}
          </span>
          <div style={{ flex: 1 }} />
          {sessions && sessions.length > 0 && onSelectSession && (
            <select
              aria-label="Conversation session"
              value={activeSessionId ?? sessions[0]?.id ?? ''}
              onChange={(e) => onSelectSession(e.target.value)}
              style={{
                maxWidth: 200,
                height: 28,
                fontSize: 12,
                borderRadius: 6,
                border: '1px solid var(--gb-border)',
                background: 'var(--gb-surface-elevated)',
                color: 'var(--gb-text-primary)',
                padding: '0 8px',
              }}
            >
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          )}
          {onNewChat && (
            <button
              type="button"
              onClick={onNewChat}
              title="New conversation"
              aria-label="New conversation"
              className="gb-btn-outline gb-icon-inline"
              style={{ fontSize: 12, padding: '4px 10px' }}
            >
              <SquarePen size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} aria-hidden="true" />
              <span>New chat</span>
            </button>
          )}
          <IconButton
            label="Edit bot"
            title="Edit bot configuration"
            onClick={onEditBot}
          >
            <Ellipsis size={ICON_SIZE.md} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </IconButton>
        </>
      ) : (
        <>
          <strong className="gb-chat-header-title">No bot selected</strong>
          <div style={{ flex: 1 }} />
        </>
      )}
      <IconButton
        label={rightCollapsed ? 'Expand right workspace' : 'Collapse right workspace'}
        onClick={onToggleRight}
        active={!rightCollapsed}
        pressed={!rightCollapsed}
      >
        <PanelRight size={ICON_SIZE.md} strokeWidth={ICON_STROKE} aria-hidden="true" />
      </IconButton>
    </header>
  )
}
