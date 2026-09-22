export function MiniBar({ items }: { items: { label: string; value: number }[] }) {
  if (!items.length) {
    return (
      <div className="ah-muted ah-mini" style={{ padding: '34px 0', textAlign: 'center' }}>
        暂无数据
      </div>
    )
  }
  const max = Math.max(...items.map((i) => i.value), 1)
  return (
    <div className="ah-minibar">
      {items.map((it, i) => (
        <div key={i} className="ah-minibar-row">
          <div className="ah-minibar-head">
            <span className="ah-truncate ah-mono">{it.label}</span>
            <b className="ah-num">{it.value}</b>
          </div>
          <div className="ah-minibar-track">
            <div className="ah-minibar-fill" style={{ width: `${(it.value / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}
