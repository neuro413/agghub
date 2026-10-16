import { useEffect, useMemo, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { api } from '../api'
import { money, tokenPrice } from '../lib/format'
import { OTHER_VENDOR, vendorOf, vendorTone } from '../lib/vendor'
import type { ModelPrice, PortalGroup, PricingData } from '../types'
import { PageLayout } from '../components/Layout'
import { Sheet } from '../components/Overlay'
import { Pagination } from '../components/Pagination'
import { useToast } from '../components/Toast'
import { Badge, Button, Card, CopyButton, Empty, Input, Skeleton } from '../components/ui'
import { IconBox, IconChevronDown, IconChevronRight, IconFilter, IconLayoutGrid, IconList, IconRotateCcw, IconSearch } from '../components/Icons'

// 模型列表（仿 new-api 模型广场）：左侧按分组 / 供应商 / 计费类型筛选，卡片或表格展示，点开看各分组价格

type Unit = 'M' | 'K'
type View = 'card' | 'table'
type Billing = 'token' | 'request' | 'free'
type Sort = 'name' | 'input-asc' | 'input-desc' | 'output-asc' | 'output-desc'

interface Filters {
  group: string
  vendor: string
  billing: Billing | ''
}

const NO_FILTERS: Filters = { group: '', vendor: '', billing: '' }
const UNITS: Record<Unit, { tokens: number; label: string }> = { M: { tokens: 1_000_000, label: '1M' }, K: { tokens: 1000, label: '1K' } }
const PAGE_SIZES: Record<View, number[]> = { card: [12, 24, 48, 96], table: [10, 20, 50, 100] }
const VIEW_KEY = 'agh_portal_models_view'
const UNIT_KEY = 'agh_portal_models_unit'

const TOKEN_FIELDS = [
  ['input', '输入'],
  ['output', '输出'],
  ['cache_read', '缓存读取'],
  ['cache_write', '缓存写入'],
] as const

const BILLING_LABEL: Record<Billing, string> = { token: '按量计费', request: '按次计费', free: '免费' }
const SORTS: [Sort, string][] = [
  ['name', '按名称'],
  ['input-asc', '输入价从低到高'],
  ['input-desc', '输入价从高到低'],
  ['output-asc', '输出价从低到高'],
  ['output-desc', '输出价从高到低'],
]

/** 同时设了 Token 价格和按次价格的模型两类都算 */
function billingOf(m: ModelPrice): Billing[] {
  const kinds: Billing[] = []
  if (m.input || m.output || m.cache_read || m.cache_write) kinds.push('token')
  if (m.per_request) kinds.push('request')
  return kinds.length ? kinds : ['free']
}

const ratioText = (ratio: number) => `×${Number(ratio.toFixed(4))}`

/** 展示价格用的倍率：选了分组用该分组的，否则取模型可用分组里最低的 */
function displayRatio(m: ModelPrice, group: string, ratios: Map<string, number>): number {
  if (group) return ratios.get(group) ?? 1
  const list = m.groups.map(g => ratios.get(g)).filter((r): r is number => r != null)
  return list.length ? Math.min(...list) : 1
}

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const value = localStorage.getItem(key) as T | null
  return value && allowed.includes(value) ? value : fallback
}

function VendorAvatar({ model, vendor, small }: { model: string; vendor: string; small?: boolean }) {
  const letter = (vendor === OTHER_VENDOR ? model.split('/').pop() || model : vendor).slice(0, 1).toUpperCase()
  return <span className={`pt-vendor-avatar tone-${vendorTone(vendor)}${small ? ' is-sm' : ''}`} aria-hidden="true">{letter}</span>
}

function PriceItem({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="pt-price-item">
      <span className="pt-price-label">{label}</span>
      <span className="pt-price-value mono">
        {value}
        {unit && value !== '免费' && <span className="pt-price-unit"> / {unit}</span>}
      </span>
    </div>
  )
}

function PriceGrid({ m, ratio, unit }: { m: ModelPrice; ratio: number; unit: Unit }) {
  const kinds = billingOf(m)
  const { tokens, label } = UNITS[unit]
  return (
    <div className="pt-price-grid">
      {kinds.includes('token') && TOKEN_FIELDS.map(([field, name]) => (
        <PriceItem key={field} label={name} value={tokenPrice(m[field] * ratio, tokens)} unit={label} />
      ))}
      {kinds.includes('request') && <PriceItem label="按次" value={money(m.per_request * ratio)} unit="次" />}
      {kinds.includes('free') && <PriceItem label="价格" value="免费" />}
    </div>
  )
}

interface FilterOption {
  value: string
  label: string
  suffix?: ReactNode
  title?: string
}

function FilterSection({ title, options, value, onChange }: { title: string; options: FilterOption[]; value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="pt-filter-section">
      <button type="button" className="pt-filter-title" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        {title}
        <IconChevronDown size={14} className={open ? 'is-open' : undefined} />
      </button>
      {open && (
        <div className="pt-filter-chips">
          {options.map(o => (
            <button type="button" key={o.value} title={o.title} aria-pressed={o.value === value}
              className={`pt-filter-chip${o.value === value ? ' is-active' : ''}`} onClick={() => onChange(o.value)}>
              <span className="label">{o.label}</span>
              {o.suffix != null && <span className="suffix">{o.suffix}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function FilterPanel({ data, vendors, billings, filters, onChange, compact }: {
  data: PricingData
  vendors: [string, number][]
  billings: [Billing, number][]
  filters: Filters
  onChange: (filters: Filters) => void
  /** 放在抽屉里时不显示标题行，重置按钮由抽屉提供 */
  compact?: boolean
}) {
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch })
  const active = !!(filters.group || filters.vendor || filters.billing)
  return (
    <div className={`pt-filter${compact ? ' is-compact' : ''}`}>
      {!compact && (
        <div className="pt-filter-head">
          <span>筛选</span>
          <Button variant="ghost" size="sm" disabled={!active} onClick={() => onChange(NO_FILTERS)}><IconRotateCcw size={14} />重置</Button>
        </div>
      )}
      <FilterSection title="分组" value={filters.group} onChange={group => set({ group })}
        options={[
          { value: '', label: '全部分组' },
          ...data.groups.map(g => ({ value: g.name, label: g.name, suffix: ratioText(g.ratio), title: g.description || undefined })),
        ]} />
      <FilterSection title="供应商" value={filters.vendor} onChange={vendor => set({ vendor })}
        options={[{ value: '', label: '全部', suffix: data.models.length }, ...vendors.map(([name, count]) => ({ value: name, label: name, suffix: count }))]} />
      <FilterSection title="计费类型" value={filters.billing} onChange={billing => set({ billing: billing as Billing | '' })}
        options={[{ value: '', label: '全部' }, ...billings.map(([kind, count]) => ({ value: kind, label: BILLING_LABEL[kind], suffix: count }))]} />
    </div>
  )
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, ReactNode, string][]; onChange: (value: T) => void }) {
  return (
    <div className="pt-segmented" role="group" aria-label={label}>
      {options.map(([v, content, title]) => (
        <button key={v} type="button" title={title} aria-pressed={v === value} className={v === value ? 'is-active' : undefined} onClick={() => onChange(v)}>
          {content}
        </button>
      ))}
    </div>
  )
}

function ModelCard({ m, ratio, unit, onOpen }: { m: ModelPrice; ratio: number; unit: Unit; onOpen: () => void }) {
  const vendor = vendorOf(m.model)
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
    e.preventDefault()
    onOpen()
  }
  return (
    <Card hover className="pt-model-card" role="button" tabIndex={0} onClick={onOpen} onKeyDown={onKey}>
      <div className="pt-model-card-head">
        <VendorAvatar model={m.model} vendor={vendor} />
        <div className="pt-model-card-title">
          <div className="pt-model-card-name mono" title={m.model}>{m.model}</div>
          <div className="pt-model-card-vendor">{vendor}</div>
        </div>
        <span onClick={e => e.stopPropagation()}><CopyButton text={m.model} title="复制模型名" /></span>
      </div>
      <PriceGrid m={m} ratio={ratio} unit={unit} />
      <div className="pt-model-card-foot">
        <span className="muted">分组</span>
        <span className="pt-model-card-groups">{m.groups[0]}</span>
        {m.groups.length > 1 && <span className="muted" title={m.groups.join('、')}>+{m.groups.length - 1}</span>}
        <span className="spacer" />
        <span className="pt-model-card-more">详情<IconChevronRight size={14} /></span>
      </div>
    </Card>
  )
}

function ModelTable({ rows, group, ratios, unit, onOpen }: { rows: ModelPrice[]; group: string; ratios: Map<string, number>; unit: Unit; onOpen: (m: ModelPrice) => void }) {
  const { tokens, label } = UNITS[unit]
  return (
    <div className="pt-table-wrap">
      <table className="pt-table pt-models-table">
        <thead>
          <tr>
            <th>模型</th>
            <th>供应商</th>
            {TOKEN_FIELDS.map(([field, name]) => <th key={field} className="num">{name}<span className="muted"> /{label}</span></th>)}
            <th className="num">按次</th>
            <th>可用分组</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m, i) => {
            const vendor = vendorOf(m.model)
            const ratio = displayRatio(m, group, ratios)
            const token = billingOf(m).includes('token')
            return (
              <tr key={m.model} className="is-clickable" onClick={() => onOpen(m)} style={{ animationDelay: `${Math.min(i, 10) * 25}ms` }}>
                <td>
                  <div className="pt-model-cell">
                    <VendorAvatar model={m.model} vendor={vendor} small />
                    <span className="pt-model-name mono">{m.model}</span>
                  </div>
                </td>
                <td className="muted">{vendor}</td>
                {TOKEN_FIELDS.map(([field]) => <td key={field} className="num mono">{token ? tokenPrice(m[field] * ratio, tokens) : '-'}</td>)}
                <td className="num mono">{m.per_request ? money(m.per_request * ratio) : '-'}</td>
                <td><div className="pt-badge-row">{m.groups.map(g => <Badge key={g} tone="outline">{g}</Badge>)}</div></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function ModelSheet({ m, groups, unit, onClose }: { m: ModelPrice; groups: PortalGroup[]; unit: Unit; onClose: () => void }) {
  const vendor = vendorOf(m.model)
  const kinds = billingOf(m)
  const token = kinds.includes('token')
  const request = kinds.includes('request')
  const { tokens, label } = UNITS[unit]
  const usable = groups.filter(g => m.groups.includes(g.name))
  return (
    <Sheet
      title={
        <span className="pt-sheet-model">
          <VendorAvatar model={m.model} vendor={vendor} />
          <span className="mono">{m.model}</span>
          <CopyButton text={m.model} title="复制模型名" />
        </span>
      }
      desc={`${vendor} · ${kinds.map(k => BILLING_LABEL[k]).join(' + ')}`}
      onClose={onClose}
    >
      <section className="pt-sheet-section">
        <div>
          <div className="pt-section-title">基础价格</div>
          <div className="pt-section-desc">未乘分组倍率{token && `，Token 价格为每 ${label} Token`}</div>
        </div>
        <div className="pt-price-panel"><PriceGrid m={m} ratio={1} unit={unit} /></div>
      </section>
      <section className="pt-sheet-section">
        <div>
          <div className="pt-section-title">分组价格</div>
          <div className="pt-section-desc">令牌按所属分组的倍率扣费：实际价格 = 基础价格 × 分组倍率</div>
        </div>
        <div className="pt-table-wrap">
          <table className="pt-table pt-group-price-table">
            <thead>
              <tr>
                <th>分组</th>
                <th className="num">倍率</th>
                {token && TOKEN_FIELDS.map(([field, name]) => <th key={field} className="num">{name}</th>)}
                {request && <th className="num">按次</th>}
              </tr>
            </thead>
            <tbody>
              {usable.map(g => (
                <tr key={g.name}>
                  <td>
                    <div className="pt-cell-stack">
                      <span className="pt-group-name">{g.name}</span>
                      {g.description && <span className="pt-cell-sub">{g.description}</span>}
                    </div>
                  </td>
                  <td className="num mono">{ratioText(g.ratio)}</td>
                  {token && TOKEN_FIELDS.map(([field]) => <td key={field} className="num mono">{tokenPrice(m[field] * g.ratio, tokens)}</td>)}
                  {request && <td className="num mono">{money(m.per_request * g.ratio)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="pt-sheet-section">
        <div className="pt-section-title">计费说明</div>
        <ul className="pt-sheet-notes">
          {token && <li>输入中命中缓存读取、缓存写入的 Token 按各自单价计费，其余按输入单价计费。</li>}
          {request && <li>按次价格在请求产生输出时收取{token && '，与 Token 费用叠加'}。</li>}
          {kinds.includes('free') && <li>该模型免费，调用不扣余额。</li>}
          <li>同一模型在不同分组的可用渠道可能不同，创建令牌时请选择需要的分组。</li>
        </ul>
      </section>
    </Sheet>
  )
}

export function ModelsPage() {
  const toast = useToast()
  const [data, setData] = useState<PricingData | null>(null)
  const [q, setQ] = useState('')
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [sort, setSort] = useState<Sort>('name')
  const [unit, setUnitState] = useState<Unit>(() => readPref(UNIT_KEY, ['M', 'K'], 'M'))
  const [view, setViewState] = useState<View>(() => readPref(VIEW_KEY, ['card', 'table'], 'card'))
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(() => PAGE_SIZES[view][1])
  const [detail, setDetail] = useState<ModelPrice | null>(null)
  const [filterOpen, setFilterOpen] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    api.pricing(controller.signal).then(setData, e => {
      if (controller.signal.aborted) return
      toast('error', (e as Error).message)
      setData({ groups: [], models: [] })
    })
    return () => controller.abort()
  }, [toast])

  const ratios = useMemo(() => new Map((data?.groups ?? []).map(g => [g.name, g.ratio])), [data])

  const vendors = useMemo(() => {
    const counts = new Map<string, number>()
    for (const m of data?.models ?? []) {
      const vendor = vendorOf(m.model)
      counts.set(vendor, (counts.get(vendor) ?? 0) + 1)
    }
    // 数量多的在前，「其他」固定最后
    return [...counts].sort((a, b) => (a[0] === OTHER_VENDOR ? 1 : b[0] === OTHER_VENDOR ? -1 : b[1] - a[1] || a[0].localeCompare(b[0])))
  }, [data])

  const billings = useMemo(() => {
    const counts = new Map<Billing, number>()
    for (const m of data?.models ?? []) for (const kind of billingOf(m)) counts.set(kind, (counts.get(kind) ?? 0) + 1)
    return (['token', 'request', 'free'] as Billing[]).filter(k => counts.has(k)).map(k => [k, counts.get(k)!] as [Billing, number])
  }, [data])

  const keyword = q.trim().toLowerCase()
  const rows = useMemo(() => {
    if (!data) return []
    const list = data.models.filter(m =>
      (!keyword || m.model.toLowerCase().includes(keyword))
      && (!filters.group || m.groups.includes(filters.group))
      && (!filters.vendor || vendorOf(m.model) === filters.vendor)
      && (!filters.billing || billingOf(m).includes(filters.billing)))
    if (sort === 'name') return list
    const [field, dir] = sort.split('-') as ['input' | 'output', 'asc' | 'desc']
    const price = (m: ModelPrice) => m[field] * displayRatio(m, filters.group, ratios)
    return [...list].sort((a, b) => (dir === 'asc' ? price(a) - price(b) : price(b) - price(a)))
  }, [data, keyword, filters, sort, ratios])

  useEffect(() => setPage(1), [keyword, filters, sort])

  const setView = (next: View) => {
    setViewState(next)
    setSize(PAGE_SIZES[next][1])
    setPage(1)
    localStorage.setItem(VIEW_KEY, next)
  }
  const setUnit = (next: Unit) => {
    setUnitState(next)
    localStorage.setItem(UNIT_KEY, next)
  }
  const clearAll = () => {
    setFilters(NO_FILTERS)
    setQ('')
  }

  const activeCount = [filters.group, filters.vendor, filters.billing].filter(Boolean).length
  const current = Math.min(page, Math.max(1, Math.ceil(rows.length / size)))
  const pageRows = rows.slice((current - 1) * size, current * size)

  let content: ReactNode
  if (!data) {
    content = <div className="pt-model-grid">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} height={210} style={{ borderRadius: 22 }} />)}</div>
  } else if (!data.models.length) {
    content = (
      <div className="pt-table-wrap">
        <Empty icon={<IconBox size={20} />} title="暂无可用模型" desc={data.groups.length ? '管理员还没有开放模型，请稍后再来看看' : '还没有可用的分组，请联系管理员'} />
      </div>
    )
  } else if (!rows.length) {
    content = (
      <div className="pt-table-wrap">
        <Empty icon={<IconSearch size={20} />} title="没有匹配的模型" desc="换个关键词或筛选条件试试" action={<Button variant="outline" size="sm" onClick={clearAll}>清除筛选</Button>} />
      </div>
    )
  } else if (view === 'card') {
    content = (
      <div className="pt-model-grid">
        {pageRows.map(m => <ModelCard key={m.model} m={m} ratio={displayRatio(m, filters.group, ratios)} unit={unit} onOpen={() => setDetail(m)} />)}
      </div>
    )
  } else {
    content = <ModelTable rows={pageRows} group={filters.group} ratios={ratios} unit={unit} onOpen={setDetail} />
  }

  const actions = (
    <div className="pt-input-wrap has-lead pt-filter-search">
      <span className="pt-input-lead"><IconSearch size={14} /></span>
      <Input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索模型" />
    </div>
  )
  const footer = rows.length > 0
    ? <Pagination page={current} size={size} total={rows.length} sizes={PAGE_SIZES[view]} onPage={setPage} onSize={n => { setSize(n); setPage(1) }} />
    : undefined

  return (
    <PageLayout title="模型列表" desc="可用的模型、分组与价格" actions={actions} footer={footer}>
      <div className="pt-models">
        {data && (
          <aside className="pt-models-side">
            <FilterPanel data={data} vendors={vendors} billings={billings} filters={filters} onChange={setFilters} />
          </aside>
        )}
        <div className="pt-models-main">
          <div className="pt-models-toolbar">
            <Button variant="outline" size="sm" className="pt-models-filter-btn" onClick={() => setFilterOpen(true)} disabled={!data}>
              <IconFilter size={14} />筛选{activeCount > 0 && <Badge>{activeCount}</Badge>}
            </Button>
            <span className="pt-models-count">
              共 <span className="mono">{rows.length}</span> 个模型
              {!filters.group && (data?.groups.length ?? 0) > 1 && <span className="muted"> · 价格按可用分组中的最低倍率显示</span>}
            </span>
            <span className="spacer" />
            <select className="pt-input pt-models-sort" value={sort} onChange={e => setSort(e.target.value as Sort)} aria-label="排序">
              {SORTS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </select>
            <Segmented label="价格单位" value={unit} onChange={setUnit} options={[['M', '/1M', '每百万 Token'], ['K', '/1K', '每千 Token']]} />
            <Segmented label="视图" value={view} onChange={setView}
              options={[['card', <IconLayoutGrid key="card" size={14} />, '卡片视图'], ['table', <IconList key="table" size={14} />, '表格视图']]} />
          </div>
          {content}
        </div>
      </div>

      {detail && data && <ModelSheet m={detail} groups={data.groups} unit={unit} onClose={() => setDetail(null)} />}
      {filterOpen && data && (
        <Sheet
          title="筛选"
          desc={`共 ${rows.length} 个模型`}
          onClose={() => setFilterOpen(false)}
          footer={
            <>
              <Button variant="outline" disabled={!activeCount} onClick={() => setFilters(NO_FILTERS)}><IconRotateCcw size={14} />重置</Button>
              <Button onClick={() => setFilterOpen(false)}>查看结果</Button>
            </>
          }
        >
          <FilterPanel data={data} vendors={vendors} billings={billings} filters={filters} onChange={setFilters} compact />
        </Sheet>
      )}
    </PageLayout>
  )
}
