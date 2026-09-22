import type { ReactNode } from 'react'

export function StatCard({
  label,
  value,
  sub,
  icon,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  icon: ReactNode
}) {
  return (
    <div className="ah-stat ah-fade-up">
      <div className="ah-stat-icon">{icon}</div>
      <div className="ah-stat-label">{label}</div>
      <div className="ah-stat-val ah-num">{value}</div>
      {sub != null && <div className="ah-stat-sub">{sub}</div>}
    </div>
  )
}
