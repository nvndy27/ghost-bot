import type { SessionRecord } from '@ghost-bot/shared-types/ipc'
import type { WorkspaceBot } from '../types/workspace.ts'
import { BotAvatar } from './BotAvatar.tsx'

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
        <button
          type="button"
          onClick={onToggleLeft}
          title="Expand left sidebar"
          aria-label="Expand left sidebar"
        >
          ☰
        </button>
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
              style={{ fontSize: 12, padding: '4px 10px' }}
            >
              + New chat
            </button>
          )}
          <button
            type="button"
            onClick={onEditBot}
            title="Edit bot configuration"
            aria-label="Edit bot"
          >
            ⋯
          </button>
        </>
      ) : (
        <>
          <strong className="gb-chat-header-title">No bot selected</strong>
          <div style={{ flex: 1 }} />
        </>
      )}
      <button
        type="button"
        onClick={onToggleRight}
        title={rightCollapsed ? 'Expand right workspace' : 'Collapse right workspace'}
        aria-label={rightCollapsed ? 'Expand right workspace' : 'Collapse right workspace'}
      >
        ▥
      </button>
    </header>
  )
}
