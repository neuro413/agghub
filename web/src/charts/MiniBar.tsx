/** 横向排名条：第一名用主序列色，其余用浅色 */
export function MiniBar({ items }: { items: { label: string; value: number }[] }) {
  if (!items.length) {
    return <div className="ah-chart-empty">暂无数据</div>
  }
  const max = Math.max(...items.map((i) => i.value), 1)
  return (
    <ul className="ah-minibar">
      {items.map((it, i) => (
        <li key={i} className="ah-minibar-row">
          <div className="ah-minibar-head">
            <span className="ah-truncate ah-mono" title={it.label}>
              {it.label}
            </span>
            <b className="ah-num">{it.value.toLocaleString('en-US')}</b>
          </div>
          <div className="ah-minibar-track">
            <div className={`ah-minibar-fill${i === 0 ? ' is-top' : ''}`} style={{ width: `${Math.max((it.value / max) * 100, 0.6)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  )
}
