import { avatarPresets } from '@ghost-bot/avatar/presets'
import type { AvatarConfig } from '@ghost-bot/avatar/presets'
import type { AvatarStatus } from '../types/workspace.ts'

export interface BotAvatarProps {
  config: AvatarConfig
  status?: AvatarStatus
  size?: number
  label?: string
}

export function BotAvatar({
  config,
  status = 'idle',
  size = 32,
  label,
}: BotAvatarProps) {
  const preset = avatarPresets.find((p) => p.id === config.shape) ?? avatarPresets[0]
  const eyeStyle =
    status === 'sleeping'
      ? 'sleepy'
      : status === 'completed'
        ? 'happy'
        : config.eyes

  const animClass = config.animation ? `gb-avatar gb-avatar--${status}` : 'gb-avatar'

  return (
    <span
      className={animClass}
      style={{
        width: `${size}px`,
        height: `${size}px`,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        position: 'relative',
      }}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <svg
        viewBox="0 0 80 80"
        width={size}
        height={size}
        style={{ display: 'block', overflow: 'visible' }}
      >
        <g
          className="gb-avatar-body"
          transform={`rotate(${config.rotation} 40 40)`}
        >
          <path d={preset.path} fill={config.color} />
          <g className="gb-avatar-eyes" fill="#ffffff" stroke="#ffffff">
            {eyeStyle === 'classic' && (
              <>
                <ellipse cx="31" cy="36" rx="3.2" ry="5" stroke="none" />
                <ellipse cx="49" cy="36" rx="3.2" ry="5" stroke="none" />
              </>
            )}
            {eyeStyle === 'round' && (
              <>
                <circle cx="31" cy="36" r="4.2" stroke="none" />
                <circle cx="49" cy="36" r="4.2" stroke="none" />
              </>
            )}
            {eyeStyle === 'happy' && (
              <>
                <path
                  d="M27 37 Q31 31 35 37"
                  fill="none"
                  strokeWidth="3"
                  strokeLinecap="round"
                />
                <path
                  d="M45 37 Q49 31 53 37"
                  fill="none"
                  strokeWidth="3"
                  strokeLinecap="round"
                />
              </>
            )}
            {eyeStyle === 'sleepy' && (
              <>
                <path
                  d="M27 36 H35"
                  fill="none"
                  strokeWidth="3"
                  strokeLinecap="round"
                />
                <path
                  d="M45 36 H53"
                  fill="none"
                  strokeWidth="3"
                  strokeLinecap="round"
                />
              </>
            )}
          </g>
        </g>
      </svg>
      {status === 'error' && (
        <span
          className="gb-avatar-error-dot"
          title="Error"
          aria-label="Error status"
        />
      )}
    </span>
  )
}
