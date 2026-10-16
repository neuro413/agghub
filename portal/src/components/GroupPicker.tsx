import { useEffect, useRef, useState } from 'react'
import type { PortalGroup } from '../types'
import { IconCheck, IconChevronsUpDown, IconSearch } from './Icons'
import { Badge } from './ui'

/** 分组倍率徽章：低于 1 绿色、高于 1 橙色 */
export function RatioBadge({ ratio }: { ratio: number }) {
  const tone = ratio < 1 ? 'success' : ratio > 1 ? 'warning' : 'neutral'
  return <Badge tone={tone}>倍率 ×{Number(ratio.toFixed(4))}</Badge>
}

/** 令牌分组选择（仿 new-api 的分组下拉）：每项显示名称、倍率和描述，分组多时可搜索 */
export function GroupPicker({ groups, value, onChange, id }: {
  groups: PortalGroup[]
  value: string
  onChange: (name: string) => void
  id?: string
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    // 捕获阶段拦下 Esc，只收起下拉，不关闭外层抽屉
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const current = groups.find(g => g.name === value)
  const keyword = q.trim().toLowerCase()
  const shown = keyword ? groups.filter(g => g.name.toLowerCase().includes(keyword) || g.description.toLowerCase().includes(keyword)) : groups
  const pick = (name: string) => {
    onChange(name)
    setOpen(false)
    setQ('')
  }

  return (
    <div className="pt-group-picker" ref={ref}>
      <button type="button" id={id} className="pt-input pt-group-trigger" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        {current ? (
          <>
            <span className="pt-group-name">{current.name}</span>
            <RatioBadge ratio={current.ratio} />
            {current.description && <span className="pt-group-trigger-desc">{current.description}</span>}
          </>
        ) : (
          <span className="pt-group-placeholder">{value ? `${value}（已不可用，请重新选择）` : '选择分组'}</span>
        )}
        <IconChevronsUpDown size={14} className="pt-group-caret" />
      </button>
      {open && (
        <div className="pt-group-menu">
          {groups.length > 5 && (
            <div className="pt-group-search">
              <IconSearch size={14} />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索分组" autoFocus />
            </div>
          )}
          <div className="pt-group-list" role="listbox">
            {shown.map(g => (
              <button type="button" role="option" aria-selected={g.name === value} key={g.name}
                className={`pt-group-option${g.name === value ? ' is-selected' : ''}`} onClick={() => pick(g.name)}>
                <span className="pt-group-option-main">
                  <span className="pt-group-name">{g.name}</span>
                  <RatioBadge ratio={g.ratio} />
                  {g.name === value && <IconCheck size={14} className="pt-group-check" />}
                </span>
                {g.description && <span className="pt-group-desc">{g.description}</span>}
              </button>
            ))}
            {!shown.length && <div className="pt-group-empty">{groups.length ? '没有匹配的分组' : '暂无可用分组，请联系管理员'}</div>}
          </div>
        </div>
      )}
    </div>
  )
}
