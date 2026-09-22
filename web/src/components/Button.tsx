import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from 'react'

type Variant = 'primary' | 'ghost' | 'soft' | 'danger' | 'default'

interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: 'sm' | 'md'
  block?: boolean
  loading?: boolean
  icon?: ReactNode
}

export function Button({
  variant = 'default',
  size = 'md',
  block,
  loading,
  icon,
  children,
  className = '',
  disabled,
  ...rest
}: BtnProps) {
  const cls = [
    'ah-btn',
    variant !== 'default' && `is-${variant}`,
    size === 'sm' && 'is-sm',
    block && 'is-block',
    className,
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <button className={cls} disabled={disabled || loading} {...rest}>
      {loading ? <span className="ah-spin" /> : icon}
      {children}
    </button>
  )
}

export function IconButton({
  children,
  danger,
  title,
  onClick,
}: {
  children: ReactNode
  danger?: boolean
  title?: string
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void
}) {
  return (
    <button type="button" className={`ah-iconbtn${danger ? ' is-danger' : ''}`} title={title} onClick={onClick}>
      {children}
    </button>
  )
}
