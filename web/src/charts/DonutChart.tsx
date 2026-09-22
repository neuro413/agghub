const PALETTE = ['#ff7a33', '#ffb24d', '#ff9a6b', '#f2a40c', '#5b9bd9', '#3fb984', '#c77dff', '#ff6b9d']

export function DonutChart({ segments }: { segments: { label: string; value: number }[] }) {
  const total = segments.reduce((s, x) => s + x.value, 0)
  const r = 54
  const cx = 70
  const cy = 70
  const sw = 20
  const C = 2 * Math.PI * r
  let acc = 0

  return (
    <div className="ah-donut-wrap">
      <svg viewBox="0 0 140 140" width="140" height="140" style={{ flex: 'none' }}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--orange-50)" strokeWidth={sw} />
        {total > 0 &&
          segments.map((s, i) => {
            const frac = s.value / total
            const len = frac * C
            const el = (
              <circle
                key={i}
                cx={cx}
                cy={cy}
                r={r}
                fill="none"
                stroke={PALETTE[i % PALETTE.length]}
                strokeWidth={sw}
                strokeDasharray={`${len} ${C - len}`}
                strokeDashoffset={-acc * C}
                strokeLinecap="round"
                transform={`rotate(-90 ${cx} ${cy})`}
              />
            )
            acc += frac
            return el
          })}
        <text x={cx} y={cy - 3} textAnchor="middle" fontSize="23" fontWeight="800" fill="var(--ink)">
          {total}
        </text>
        <text x={cx} y={cy + 15} textAnchor="middle" fontSize="11" fill="var(--ink-faint)">
          总请求
        </text>
      </svg>
      <div className="ah-donut-legend">
        {segments.length === 0 && <span className="ah-muted ah-mini">暂无数据</span>}
        {segments.map((s, i) => (
          <div key={i} className="ah-legend-item">
            <span className="ah-legend-dot" style={{ background: PALETTE[i % PALETTE.length] }} />
            <span className="ah-truncate">{s.label}</span>
            <span className="ah-legend-val ah-num">{s.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
