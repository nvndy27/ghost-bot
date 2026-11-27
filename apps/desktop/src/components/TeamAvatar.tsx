import { Users } from 'lucide-react'
import type { TeamAppearance } from '@ghost-bot/shared-types/ipc'
import type { WorkspaceBot } from '../types/workspace.ts'
import { BotAvatar } from './BotAvatar.tsx'

export function TeamAvatar({ appearance, memberIds, bots, size = 32 }: {
  appearance?: TeamAppearance
  memberIds: readonly string[]
  bots: readonly WorkspaceBot[]
  size?: number
}) {
  const members = memberIds.slice(0, 4)
  return (
    <span aria-hidden="true" className="gb-team-avatar" data-avatar-mode={appearance?.mode ?? 'auto'}
      data-avatar-tiles={appearance?.mode && appearance.mode !== 'auto' ? 1 : members.length}
      style={{ width: size, height: size }}>
      {appearance?.mode === 'upload' ? <img src={appearance.dataUrl} alt="" /> :
        appearance?.mode === 'bot' ? <BotAvatar config={appearance.avatar} status="idle" size={size} /> :
          members.length ? <span className="gb-team-avatar-grid" data-count={members.length}>
            {members.map((id) => {
              const bot = bots.find((entry) => entry.id === id)
              return <span key={id} className="gb-team-avatar-tile">
                {bot ? <BotAvatar config={bot.avatar} status="idle" size={members.length === 1 ? size : Math.round(size * 0.53)} /> :
                  <Users size={Math.round(size * 0.42)} />}
              </span>
            })}
          </span> : <Users size={Math.round(size * 0.55)} />}
    </span>
  )
}
