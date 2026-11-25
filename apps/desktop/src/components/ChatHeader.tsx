import type { WorkspaceBot } from '../types/workspace.ts'
import { BotAvatar } from './BotAvatar.tsx'

export interface ChatHeaderProps {
  bot: WorkspaceBot
  leftCollapsed: boolean
  rightCollapsed: boolean
  isMockMode: boolean
  onToggleLeft: () => void
  onToggleRight: () => void
}

export function ChatHeader({
  bot,
  leftCollapsed,
  rightCollapsed,
  isMockMode,
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
        disabled
        title="Bot configuration (Phase 1C)"
        aria-label="Bot options (Phase 1C)"
      >
        ⋯
      </button>
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
