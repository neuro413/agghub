import { useEffect, useRef, useState } from 'react'
import type { ComponentType, Dispatch, DragEvent, ReactNode, SetStateAction } from 'react'
import { api } from '../api/client'
import { Button } from '../components/Button'
import { Field } from '../components/Form'
import { IconPlus } from '../components/Icons'
import { Modal } from '../components/Modal'
import { useToast } from '../components/Toast'
import type { EntryFormat, LogItem } from '../types'

// 预处理页各规则编辑器共用的小件：选项类型 / 入口格式选项 / 多选 chips / 限定范围 / 规则列表 / 历史请求选择弹窗

export type Opt = { value: string; label: string }

export const FORMAT_OPTIONS: Opt[] = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'responses', label: 'Responses' },
]

/** 入口格式显示名 */
export function fmtLabel(f: string): string {
  if (f === 'anthropic') return 'Anthropic'
  if (f === 'responses') return 'Responses'
  return 'OpenAI'
}

/** 入口格式单字母缩写（紧凑列表用）*/
export function fmtShort(f: string): string {
  if (f === 'anthropic') return 'A'
  if (f === 'responses') return 'R'
  return 'O'
}

export function regexValid(pattern: string | undefined, flags: string | undefined): boolean {
  if (!pattern) return true
  try {
    new RegExp(pattern, flags || 'g')
    return true
  } catch {
    return false
  }
}

export function MultiChips({
  options,
  selected,
  onChange,
  empty,
}: {
  options: Opt[]
  selected: string[]
  onChange: (v: string[]) => void
  empty?: string
}) {
  const visible = [...options, ...selected.filter(value => !options.some(option => option.value === value)).map(value => ({ value, label: `${value}（已失效，可移除）` }))]
  if (!visible.length) return <span className="ah-mini ah-faint">{empty || '无可选项'}</span>
  const toggle = (v: string) => onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v])
  return (
    <div className="ah-pp-chips">
      {visible.map((o) => (
        <button
          type="button"
          key={o.value}
          className={`ah-pp-chip${selected.includes(o.value) ? ' is-on' : ''}`}
          onClick={() => toggle(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

type Scope = { formats?: EntryFormat[]; channelIds?: number[]; models?: string[] }

/** 三类规则共用的限定范围：入口格式 / 渠道 / 模型，不选即不限定 */
export function ScopeFields({ rule, onChange, channelOptions, modelOptions }: {
  rule: Scope
  onChange: (patch: Scope) => void
  channelOptions: Opt[]
  modelOptions: Opt[]
}) {
  return (
    <>
      <Field label="入口格式（不选 = 全部）">
        <MultiChips
          options={FORMAT_OPTIONS}
          selected={rule.formats ?? []}
          onChange={(v) => onChange({ formats: v.length ? (v as EntryFormat[]) : undefined })}
        />
      </Field>
      <Field label="限定渠道（不选 = 全部）">
        <MultiChips
          options={channelOptions}
          selected={(rule.channelIds ?? []).map(String)}
          onChange={(v) => onChange({ channelIds: v.length ? v.map(Number) : undefined })}
          empty="暂无渠道"
        />
      </Field>
      <Field label="限定模型（不选 = 全部）">
        <MultiChips
          options={modelOptions}
          selected={rule.models ?? []}
          onChange={(v) => onChange({ models: v.length ? v : undefined })}
          empty="暂无模型（渠道未配置 models）"
        />
      </Field>
    </>
  )
}

export type DragProps = { draggable: true; onDragStart: () => void; onDragOver: (e: DragEvent) => void; onDrop: (e: DragEvent) => void }

/** 规则行的公共 props；drag 只在可排序列表里提供，直接展开到行根元素上 */
export type RuleRowProps<T> = {
  rule: T
  channelOptions: Opt[]
  modelOptions: Opt[]
  expanded: boolean
  onToggleExpand: () => void
  onChange: (r: T) => void
  onDelete: () => void
  drag?: DragProps
}

/** 规则列表：新增按钮 + 空状态 + 行列表，负责增删改、展开和拖拽排序 */
export function RuleList<T extends { id: string }>({
  rules,
  onChange,
  create,
  expanded,
  setExpanded,
  channelOptions,
  modelOptions,
  Row,
  sortable,
  toolbar,
}: {
  rules: T[]
  onChange: (next: T[]) => void
  create: () => T
  expanded: Set<string>
  setExpanded: Dispatch<SetStateAction<Set<string>>>
  channelOptions: Opt[]
  modelOptions: Opt[]
  Row: ComponentType<RuleRowProps<T>>
  sortable?: boolean
  toolbar?: ReactNode
}) {
  const dragIndex = useRef<number | null>(null)
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const n = new Set(prev)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  const add = () => {
    const r = create()
    onChange([...rules, r])
    setExpanded((prev) => new Set(prev).add(r.id))
  }
  const drag = (i: number): DragProps => ({
    draggable: true,
    onDragStart: () => {
      dragIndex.current = i
    },
    onDragOver: (e) => e.preventDefault(),
    onDrop: (e) => {
      e.preventDefault()
      const from = dragIndex.current
      dragIndex.current = null
      if (from == null || from === i) return
      const next = rules.slice()
      next.splice(i, 0, next.splice(from, 1)[0])
      onChange(next)
    },
  })

  return (
    <div className="ah-pp">
      <div className="ah-pp-toolbar">
        <Button variant="primary" size="sm" icon={<IconPlus size={16} />} onClick={add}>
          新增规则
        </Button>
        {toolbar}
      </div>
      {!rules.length ? (
        <div className="ah-detail-empty">还没有规则，点「新增规则」开始</div>
      ) : (
        <div className="ah-pp-list">
          {rules.map((r, i) => (
            <Row
              key={r.id}
              rule={r}
              channelOptions={channelOptions}
              modelOptions={modelOptions}
              expanded={expanded.has(r.id)}
              onToggleExpand={() => toggle(r.id)}
              onChange={(next) => onChange(rules.map((x) => (x.id === next.id ? next : x)))}
              onDelete={() => onChange(rules.filter((x) => x.id !== r.id))}
              drag={sortable ? drag(i) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function LogPickerModal({ onPick, onClose }: { onPick: (id: number) => void; onClose: () => void }) {
  const toast = useToast()
  const [items, setItems] = useState<LogItem[] | null>(null)
  useEffect(() => {
    api
      .listLogs({ limit: 40 })
      .then((r) => setItems(r.items))
      .catch((e) => toast('err', e.message))
  }, [toast])
  return (
    <Modal title="选择历史请求" size="lg" onClose={onClose}>
      {!items ? (
        <div className="ah-logt-empty">
          <span className="ah-spin ah-spin-orange" /> 加载中…
        </div>
      ) : !items.length ? (
        <div className="ah-detail-empty">暂无请求日志</div>
      ) : (
        <div className="ah-pp-picker">
          {items.map((l) => (
            <button type="button" key={l.id} className="ah-pp-picker-row" onClick={() => onPick(l.id)}>
              <span className={`ah-log-pill ${l.status === 'success' ? 'ok' : 'err'}`}>
                {l.status === 'success' ? l.status_code || 200 : 'ERR'}
              </span>
              <span className={`ah-fmt-badge ${l.entry_format}`}>{fmtLabel(l.entry_format)}</span>
              <span className="ah-pp-picker-model ah-truncate">{l.model || '-'}</span>
              <span className="ah-mini ah-muted ah-truncate">{l.channel_name || '—'}</span>
              <span className="ah-mini ah-faint ah-num">{new Date(l.created_at).toLocaleString('zh-CN', { hour12: false })}</span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  )
}
