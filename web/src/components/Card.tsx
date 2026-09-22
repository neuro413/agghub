import type { HTMLAttributes } from 'react'

export function Card({ hover, className = '', ...rest }: HTMLAttributes<HTMLDivElement> & { hover?: boolean }) {
  return <div className={`ah-card${hover ? ' is-hover' : ''} ${className}`.trim()} {...rest} />
}
