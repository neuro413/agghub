import type { ReactNode } from 'react'

export function EmptyState({
  icon,
  title,
  desc,
  action,
}: {
  icon: ReactNode
  title: string
  desc?: string
  action?: ReactNode
}) {
  return (
    <div className="ah-empty ah-fade-up">
      <div className="ah-empty-icon">{icon}</div>
      <h3>{title}</h3>
      {desc && <p className="ah-mini">{desc}</p>}
      {action && <div style={{ marginTop: 18, display: 'flex', justifyContent: 'center' }}>{action}</div>}
    </div>
  )
}
