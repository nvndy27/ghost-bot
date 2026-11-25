import type { WorkspaceBot } from '../types/workspace.ts'
import { BotAvatar } from './BotAvatar.tsx'

export interface ChatHeaderProps {
  bot: WorkspaceBot | null
  leftCollapsed: boolean
  rightCollapsed: boolean
  isMockMode: boolean
  onEditBot: () => void
  onToggleLeft: () => void
  onToggleRight: () => void
}

export function ChatHeader({
  bot,
  leftCollapsed,
  rightCollapsed,
  isMockMode,
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
