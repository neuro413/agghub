import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { Button } from '../components/Button'
import { Input, MoneyInput } from '../components/Form'
import { IconRefresh, IconSearch } from '../components/Icons'
import { Modal } from '../components/Modal'
import { useToast } from '../components/Toast'
import { channelModelNames } from '../lib/channelModels'
import { PRICE_FIELDS, findRow, openRouterMatcher, openRouterPrices, pickPrices, validPrice } from './modelPricing'
import type { PriceField, PriceRow, Prices } from './modelPricing'

type Status = { kind: 'none' } | { kind: 'wildcard'; pattern: string } | { kind: 'exact' }

interface Candidate {
  model: string
  status: Status
  prices: Prices
  /** 匹配到的 OpenRouter 模型 id */
  source: string | null
}

const EMPTY: Prices = { input: '', output: '', cache_read: '', cache_write: '', per_request: '0' }

const COLUMNS: { field: PriceField; label: string }[] = [
  { field: 'input', label: '输入 / 1M' },
  { field: 'output', label: '输出 / 1M' },
  { field: 'cache_read', label: '缓存读 / 1M' },
  { field: 'cache_write', label: '缓存写 / 1M' },
  { field: 'per_request', label: '按次' },
]

/** 初始价格沿用当前命中的规则，没有命中则留空 */
function candidateOf(rows: PriceRow[], model: string): Candidate {
  const rule = findRow(rows, model)
  const pattern = rule?.pattern.trim()
  const status: Status = !rule ? { kind: 'none' } : pattern === model ? { kind: 'exact' } : { kind: 'wildcard', pattern: pattern! }
  return { model, status, prices: rule ? pickPrices(rule) : EMPTY, source: null }
}

function statusText(s: Status): string {
  return s.kind === 'none' ? '未定价' : s.kind === 'exact' ? '已单独定价' : `命中 ${s.pattern}`
}

/** 列出渠道里的模型（含重映射别名），按当前编辑中的规则标出定价状态，可从 OpenRouter 匹配价格后批量导入 */
export function ModelPriceImportModal({
  rows,
  onImport,
  onClose,
}: {
  rows: PriceRow[]
  onImport: (items: { pattern: string; prices: Prices }[]) => void
  onClose: () => void
}) {
  const toast = useToast()
  const [cands, setCands] = useState<Candidate[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showAll, setShowAll] = useState(false)
  const [query, setQuery] = useState('')
  const [fetching, setFetching] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    api.listChannels(controller.signal).then(
      (channels) => {
        const models = new Set<string>()
        for (const c of channels) channelModelNames(c).forEach((m) => models.add(m))
        setCands([...models].sort().map((m) => candidateOf(rows, m)))
      },
      (e: any) => {
        if (!controller.signal.aborted) toast('err', e.message)
      },
    )
    return () => controller.abort()
  }, [rows, toast])

  const q = query.trim().toLowerCase()
  const pending = cands?.filter((c) => c.status.kind !== 'exact').length ?? 0
  const visible = (cands ?? []).filter((c) => (showAll || c.status.kind !== 'exact') && (!q || c.model.toLowerCase().includes(q)))
  const allChecked = visible.length > 0 && visible.every((c) => selected.has(c.model))

  const toggle = (model: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(model) ? next.delete(model) : next.add(model)
      return next
    })

  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev)
      for (const c of visible) allChecked ? next.delete(c.model) : next.add(c.model)
      return next
    })

  const patchPrice = (model: string, field: PriceField, value: string) =>
    setCands((cs) => cs && cs.map((c) => (c.model === model ? { ...c, prices: { ...c.prices, [field]: value } } : c)))

  const matchOpenRouter = async () => {
    if (!cands) return
    setFetching(true)
    try {
      const match = openRouterMatcher(await api.openRouterPrices())
      const next = cands.map((c) => {
        const price = match(c.model)
        return price ? { ...c, source: price.id, prices: openRouterPrices(price) } : c
      })
      const hits = next.filter((c) => c.source)
      setCands(next)
      // 自动勾选匹配到价格的待定价模型
      setSelected((prev) => new Set([...prev, ...hits.filter((c) => c.status.kind !== 'exact').map((c) => c.model)]))
      if (hits.length) toast('ok', `已匹配 ${hits.length} 个模型的 OpenRouter 价格，请核对后导入`)
      else toast('info', 'OpenRouter 上没有找到匹配的模型')
    } catch (e: any) {
      toast('err', e.message)
    } finally {
      setFetching(false)
    }
  }

  const submit = () => {
    const items = (cands ?? []).filter((c) => selected.has(c.model))
    const bad = items.find((c) => PRICE_FIELDS.some((k) => !validPrice(c.prices[k])))
    if (bad) {
      toast('err', `「${bad.model}」的价格必须是不小于 0 的数字（留空按 0 计）`)
      return
    }
    onImport(items.map((c) => ({ pattern: c.model, prices: c.prices })))
  }

  return (
    <Modal
      title="导入模型定价"
      size="xl"
      onClose={onClose}
      dismissible={false}
      footer={
        <>
          <span className="ah-mini ah-muted">导入后还需要在定价卡片里点「保存定价」才会生效</span>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={!selected.size} onClick={submit}>
            导入选中（{selected.size}）
          </Button>
        </>
      }
    >
      <div className="ah-price-import-bar">
        <div className="ah-search ah-price-import-search">
          <IconSearch size={15} />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索模型" />
        </div>
        <div className="ah-pp-chips">
          <button type="button" className={`ah-pp-chip${!showAll ? ' is-on' : ''}`} onClick={() => setShowAll(false)}>
            待定价（{pending}）
          </button>
          <button type="button" className={`ah-pp-chip${showAll ? ' is-on' : ''}`} onClick={() => setShowAll(true)}>
            全部（{cands?.length ?? 0}）
          </button>
        </div>
        <span style={{ flex: 1 }} />
        <Button variant="soft" size="sm" icon={<IconRefresh size={15} />} loading={fetching} disabled={!cands} onClick={matchOpenRouter}>
          从 OpenRouter 匹配价格
        </Button>
      </div>
      <div className="ah-mini ah-muted" style={{ marginBottom: 10 }}>
        「待定价」是没有命中任何规则、或者只命中通配规则的渠道模型；价格默认沿用当前命中的规则，可以直接修改。OpenRouter 价格为美元，匹配结果请核对后再导入。
      </div>

      {!cands ? (
        <div className="ah-detail-empty">读取渠道模型…</div>
      ) : !visible.length ? (
        <div className="ah-detail-empty">{q ? `没有匹配「${query}」的模型` : showAll ? '渠道里还没有模型' : '渠道里的模型都已单独定价'}</div>
      ) : (
        <div className="ah-price-import-table">
          <div className="ah-price-import-head">
            <input type="checkbox" checked={allChecked} onChange={toggleAll} title="全选当前列表" />
            <span>模型</span>
            {COLUMNS.map((c) => (
              <span key={c.field}>{c.label}</span>
            ))}
          </div>
          {visible.map((c) => (
            <div key={c.model} className={`ah-price-import-row${selected.has(c.model) ? ' is-selected' : ''}`}>
              <input type="checkbox" checked={selected.has(c.model)} onChange={() => toggle(c.model)} />
              <div className="ah-price-import-model" onClick={() => toggle(c.model)}>
                <span className="ah-truncate" title={c.model}>
                  {c.model}
                </span>
                <span className="ah-mini ah-truncate" title={c.source ? `OpenRouter：${c.source}` : undefined}>
                  <span className={c.status.kind === 'none' ? 'is-none' : 'ah-faint'}>{statusText(c.status)}</span>
                  {c.source && <span className="ah-faint"> · OpenRouter：{c.source}</span>}
                </span>
              </div>
              {COLUMNS.map((col) => (
                <MoneyInput
                  key={col.field}
                  aria-label={`${c.model} ${col.label}`}
                  value={c.prices[col.field]}
                  onChange={(e) => patchPrice(c.model, col.field, e.target.value)}
                  placeholder="—"
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}
