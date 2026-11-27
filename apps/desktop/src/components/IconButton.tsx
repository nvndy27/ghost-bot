import type { ButtonHTMLAttributes, ReactNode } from 'react'

export const ICON_SIZE = {
  xs: 14,
  sm: 16,
  md: 18,
  lg: 20,
} as const

export const ICON_STROKE = 1.9

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  label: string
  children: ReactNode
  size?: 'sm' | 'md'
  active?: boolean
  pressed?: boolean
  variant?: 'ghost' | 'outline'
}

/**
 * Standardized 32-36px interactive icon button with accessible labeling,
 * focus ring, hover/active states, and optical centering.
 */
export function IconButton({
  label,
  title,
  children,
  size = 'sm',
  active = false,
  pressed,
  variant = 'ghost',
  className,
  type = 'button',
  ...rest
}: IconButtonProps) {
  const classes = [
    'gb-icon-btn',
    size === 'md' ? 'gb-icon-btn--md' : '',
    variant === 'outline' ? 'gb-icon-btn--outline' : '',
    active ? 'active' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      type={type}
      className={classes}
      aria-label={label}
      title={title ?? label}
      aria-pressed={pressed}
      {...rest}
    >
      {children}
    </button>
  )
}
