/** 筛选条：全部 13 / 在线 10，选中项为深色底 */
export function Chips<K extends string>({
  value,
  items,
  onChange,
}: {
  value: K
  items: { key: K; label: string; count?: number }[]
  onChange: (k: K) => void
}) {
  return (
    <div className="ah-chips">
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          className={`ah-chip${value === it.key ? ' is-on' : ''}`}
          aria-pressed={value === it.key}
          onClick={() => onChange(it.key)}
        >
          {it.label}
          {it.count != null && <b>{it.count}</b>}
        </button>
      ))}
    </div>
  )
}
