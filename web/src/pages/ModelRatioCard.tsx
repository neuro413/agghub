import { useEffect, useMemo, useState } from 'react'
import { api } from '../api/client'
import { Button, IconButton } from '../components/Button'
import { Card } from '../components/Card'
import { Input, MoneyInput } from '../components/Form'
import { IconPlus, IconTrash } from '../components/Icons'
import { useToast } from '../components/Toast'
import { newId } from '../lib/id'
import { money } from '../lib/money'
import type { ModelRatio } from '../types'
import { ModelPriceImportModal } from './ModelPriceImportModal'
import { PRICE_FIELDS, fromRatio, toRatio, validPrice } from './modelPricing'
import type { PriceField, PriceRow, Prices } from './modelPricing'

const DESC =
  '按「金额 / 1M Token」填写价格，按次价格只在产生输出时计入。按客户端请求的模型名匹配：精确名优先，其次是非通配部分最长的 * 通配符，再按列表顺序。没有命中的模型不允许 Key 调用，建议保留一条 * 作为兜底。'

function newRow(): PriceRow {
  return { id: newId(), pattern: '', input: '', output: '', cache_read: '', cache_write: '', per_request: '0' }
}

const COLUMNS: { field: PriceField; label: string; unit: string }[] = [
  { field: 'input', label: '输入', unit: '/ 1M' },
  { field: 'output', label: '输出', unit: '/ 1M' },
  { field: 'cache_read', label: '缓存读', unit: '/ 1M' },
  { field: 'cache_write', label: '缓存写', unit: '/ 1M' },
  { field: 'per_request', label: '按次', unit: '/ 次' },
]

export function ModelRatioCard({ ratios, onSaved }: { ratios: ModelRatio[]; onSaved: () => void }) {
  const toast = useToast()
  const saved = useMemo(() => ratios.map(fromRatio), [ratios])
  const [rows, setRows] = useState<PriceRow[]>(saved)
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)

  // props 变化时同步本地副本（保存后刷新、切换页面回到最新）
  useEffect(() => {
    setRows(saved)
  }, [saved])

  const dirty = JSON.stringify(rows) !== JSON.stringify(saved)

  const patch = (id: string, p: Partial<PriceRow>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)))

  /** 已有同名规则时更新价格，否则插到第一条 * 兜底规则之前 */
  const applyImport = (items: { pattern: string; prices: Prices }[]) => {
    setRows((rs) => {
      const next = [...rs]
      for (const item of items) {
        const i = next.findIndex((r) => r.pattern.trim() === item.pattern)
        if (i >= 0) {
          next[i] = { ...next[i], ...item.prices }
          continue
        }
        const fallback = next.findIndex((r) => r.pattern.trim() === '*')
        next.splice(fallback >= 0 ? fallback : next.length, 0, { id: newId(), pattern: item.pattern, ...item.prices })
      }
      return next
    })
    setImporting(false)
    toast('ok', `已导入 ${items.length} 条，确认无误后点「保存定价」`)
  }

  const save = async () => {
    const seen = new Set<string>()
    for (const r of rows) {
      const p = r.pattern.trim()
      if (!p) {
        toast('err', '模型模式不能为空')
        return
      }
      if (seen.has(p)) {
        toast('err', `模型模式重复：${p}`)
        return
      }
      seen.add(p)
      if (PRICE_FIELDS.some((k) => !validPrice(r[k]))) {
        toast('err', `「${p}」的价格必须是不小于 0 的数字（留空按 0 计）`)
        return
      }
    }
    setSaving(true)
    try {
      await api.updateSettings({ model_ratios: rows.map(toRatio) })
      toast('ok', '定价已保存')
      onSaved()
    } catch (e: any) {
      toast('err', e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="ah-set-card ah-ratio-card">
      <div className="ah-ratio-top">
        <div>
          <div className="ah-set-title">模型定价</div>
          <div className="ah-set-desc">{DESC}</div>
        </div>
        <Button variant="soft" size="sm" onClick={() => setImporting(true)}>
          导入模型定价
        </Button>
      </div>

      <div className="ah-ratio-table">
        <div className="ah-ratio-head">
          <span>模型模式</span>
          {COLUMNS.map((c) => (
            <span key={c.field}>
              {c.label}
              <em>{c.unit}</em>
            </span>
          ))}
          <span />
        </div>
        {rows.map((r) => {
          const pattern = r.pattern.trim()
          return (
            <div className="ah-ratio-row" key={r.id}>
              <div className="ah-ratio-pattern">
                <Input value={r.pattern} onChange={(e) => patch(r.id, { pattern: e.target.value })} placeholder="如 claude-opus-* 或 *" />
                {pattern === '*' ? (
                  <span className="ah-tag">兜底</span>
                ) : pattern.includes('*') ? (
                  <span className="ah-tag">通配</span>
                ) : null}
              </div>
              {COLUMNS.map((c) => (
                <MoneyInput
                  key={c.field}
                  aria-label={`${c.label}价格`}
                  value={r[c.field]}
                  onChange={(e) => patch(r.id, { [c.field]: e.target.value })}
                  placeholder="0"
                />
              ))}
              <IconButton title="删除此行" danger onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))}>
                <IconTrash size={16} />
              </IconButton>
            </div>
          )
        })}
        {!rows.length && <div className="ah-detail-empty">还没有定价规则，点「添加规则」或「导入模型定价」开始；建议保留一条 * 作为兜底。</div>}
      </div>

      <div className="ah-ratio-actions">
        <Button variant="soft" size="sm" icon={<IconPlus size={15} />} onClick={() => setRows((rs) => [...rs, newRow()])}>
          添加规则
        </Button>
        <span style={{ flex: 1 }} />
        {dirty && <span className="ah-ratio-dirty">有未保存的修改</span>}
        <Button variant="primary" loading={saving} onClick={save}>
          保存定价
        </Button>
      </div>

      <TrialPanel />

      {importing && <ModelPriceImportModal rows={rows} onImport={applyImport} onClose={() => setImporting(false)} />}
    </Card>
  )
}

function TrialPanel() {
  const toast = useToast()
  const [model, setModel] = useState('')
  // 用字符串保存，留空时能显示占位说明；提交时按非负整数解析
  const [prompt, setPrompt] = useState('')
  const [cacheRead, setCacheRead] = useState('')
  const [cacheWrite, setCacheWrite] = useState('')
  const [completion, setCompletion] = useState('')
  const toTokens = (v: string) => Math.max(0, Math.floor(Number(v) || 0))
  const [previewing, setPreviewing] = useState(false)
  const [result, setResult] = useState<{ pattern: string | null; points: number | null } | null>(null)

  const run = async () => {
    if (!model.trim()) {
      toast('err', '请填写要试算的模型名')
      return
    }
    setPreviewing(true)
    try {
      const r = await api.billingPreview({
        model: model.trim(),
        prompt_tokens: toTokens(prompt),
        completion_tokens: toTokens(completion),
        cache_read_tokens: toTokens(cacheRead),
        cache_write_tokens: toTokens(cacheWrite),
      })
      setResult({ pattern: r.ratio?.pattern ?? null, points: r.points })
    } catch (e: any) {
      toast('err', e.message)
    } finally {
      setPreviewing(false)
    }
  }

  return (
    <div className="ah-ratio-trial">
      <div className="ah-set-row-label">费用试算</div>
      <div className="ah-set-row-desc">试算使用已保存的定价，改完请先点「保存定价」再试算。</div>
      <div className="ah-ratio-trial-grid">
        <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="模型名，如 claude-opus-4-1" />
        <Input type="number" min={0} step={1} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="输入 Token（含缓存）" title="输入 Token（含缓存读写）" />
        <Input type="number" min={0} step={1} value={cacheRead} onChange={(e) => setCacheRead(e.target.value)} placeholder="其中缓存读" title="其中缓存读取" />
        <Input type="number" min={0} step={1} value={cacheWrite} onChange={(e) => setCacheWrite(e.target.value)} placeholder="其中缓存写" title="其中缓存写入" />
        <Input type="number" min={0} step={1} value={completion} onChange={(e) => setCompletion(e.target.value)} placeholder="输出 Token" title="输出 Token" />
        <Button variant="soft" size="sm" loading={previewing} onClick={run}>
          试算
        </Button>
      </div>
      {result && (
        <div className={`ah-ratio-trial-out${result.points == null ? ' is-empty' : ''}`}>
          {result.points == null ? '没有命中任何定价，Key 无法调用该模型' : `命中「${result.pattern}」：${money(result.points)}`}
        </div>
      )}
    </div>
  )
}
