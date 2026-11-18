const COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)']
const OTHER = 'var(--chart-6)'
const TOP = 5

/** 环形图：按数量降序取前 5，其余合并为「其他」 */
export function DonutChart({ segments, unit = '总请求' }: { segments: { label: string; value: number }[]; unit?: string }) {
  const sorted = [...segments].filter((s) => s.value > 0).sort((a, b) => b.value - a.value)
  const parts = sorted.slice(0, TOP).map((s, i) => ({ ...s, color: COLORS[i] }))
  const rest = sorted.slice(TOP).reduce((sum, s) => sum + s.value, 0)
  if (rest > 0) parts.push({ label: '其他', value: rest, color: OTHER })
  const total = parts.reduce((s, x) => s + x.value, 0)

  const size = 148
  const thick = 18
  const gap = parts.length > 1 ? 3 : 0
  const r = (size - thick) / 2
  const C = 2 * Math.PI * r
  let off = 0

  return (
    <div className="ah-donut-wrap">
      <div className="ah-donut">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" className="ah-donut-track" strokeWidth={thick} />
          {total > 0 &&
            parts.map((p, i) => {
              const full = (p.value / total) * C
              const len = Math.max(full - gap, 0.6)
              const el = (
                <circle
                  key={i}
                  cx={size / 2}
                  cy={size / 2}
                  r={r}
                  fill="none"
                  style={{ stroke: p.color }}
                  strokeWidth={thick}
                  strokeDasharray={`${len} ${C - len}`}
                  strokeDashoffset={-off}
                />
              )
              off += full
              return el
            })}
        </svg>
        <div className="ah-donut-center">
          <b className="ah-num">{total.toLocaleString('en-US')}</b>
          <small>{unit}</small>
        </div>
      </div>
      <ul className="ah-donut-legend">
        {parts.length === 0 && <li className="ah-muted ah-mini">暂无数据</li>}
        {parts.map((p, i) => (
          <li key={i}>
            <i style={{ background: p.color }} />
            <span className="ah-truncate" title={p.label}>
              {p.label}
            </span>
            <b className="ah-num">{p.value.toLocaleString('en-US')}</b>
            <em className="ah-num">{((p.value / total) * 100).toFixed(1)}%</em>
          </li>
        ))}
      </ul>
    </div>
  )
}
