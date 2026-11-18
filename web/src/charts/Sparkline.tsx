/** 迷你折线：按最小值到最大值归一化，尺寸由外层 CSS 决定，线宽不随拉伸变形 */
export function Sparkline({ values, className = 'ah-spark' }: { values: number[]; className?: string }) {
  if (values.length < 2) return null
  const w = 100
  const h = 28
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = hi - lo || 1
  const d = values
    .map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * w).toFixed(1)},${(h - 3 - ((v - lo) / span) * (h - 6)).toFixed(1)}`)
    .join('')
  return (
    <svg className={className} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={d} fill="none" style={{ stroke: 'currentColor' }} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}
