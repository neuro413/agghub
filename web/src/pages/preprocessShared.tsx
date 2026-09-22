import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { Modal } from '../components/Modal'
import { useToast } from '../components/Toast'
import type { LogItem } from '../types'

// 预处理页各规则编辑器共用的小件：选项类型 / 入口格式选项 / 多选 chips / 历史请求选择弹窗

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
  if (!options.length) return <span className="ah-mini ah-faint">{empty || '无可选项'}</span>
  const toggle = (v: string) => onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v])
  return (
    <div className="ah-pp-chips">
      {options.map((o) => (
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
