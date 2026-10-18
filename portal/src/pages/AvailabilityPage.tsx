import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { api } from '../api'
import { num } from '../lib/format'
import type { AvailabilityCell, AvailabilityData, AvailabilityModel } from '../types'
import { PageLayout } from '../components/Layout'
import { useToast } from '../components/Toast'
import { Badge, Button, Card, Empty, Input, Skeleton } from '../components/ui'
import { IconActivity, IconCircleCheck, IconCircleDashed, IconCircleX, IconRefresh, IconSearch, IconTriangleAlert } from '../components/Icons'
import type { IconProps } from '../components/Icons'

// 可用性：最近 2 小时每 10 分钟一格，按错误率给每格定健康度；10 分钟内没人调用的模型由服务端自动测活

type Level = 'good' | 'warn' | 'bad' | 'none'

const LEVELS: Record<Level, { label: string; desc: string; Icon: (props: IconProps) => JSX.Element }> = {
  good: { label: '正常', desc: '错误率 ≤ 10%', Icon: IconCircleCheck },
  warn: { label: '波动', desc: '错误率 10% ~ 50%', Icon: IconTriangleAlert },
  bad: { label: '故障', desc: '错误率 > 50%', Icon: IconCircleX },
  none: { label: '无数据', desc: '最近没有请求结果', Icon: IconCircleDashed },
}
const LEVEL_ORDER: Level[] = ['good', 'warn', 'bad', 'none']
const REFRESH_MS = 60_000

function levelOf(cell: Pick<AvailabilityCell, 'total' | 'errors'>): Level {
  if (!cell.total) return 'none'
  const rate = cell.errors / cell.total
  return rate <= 0.1 ? 'good' : rate <= 0.5 ? 'warn' : 'bad'
}

const rateText = (errors: number, total: number) => `${Number(((errors / total) * 100).toFixed(1))}%`

const pad = (x: number) => String(x).padStart(2, '0')
const hm = (ts: number) => `${pad(new Date(ts).getHours())}:${pad(new Date(ts).getMinutes())}`
const hms = (ts: number) => `${hm(ts)}:${pad(new Date(ts).getSeconds())}`

interface Row extends AvailabilityModel {
  total: number
  errors: number
  /** 当前健康度：最近一个有结果的格子 */
  level: Level
}

function summarize(m: AvailabilityModel): Row {
  const total = m.cells.reduce((s, c) => s + c.total, 0)
  const errors = m.cells.reduce((s, c) => s + c.errors, 0)
  const latest = [...m.cells].reverse().find(c => c.total)
  return { ...m, total, errors, level: latest ? levelOf(latest) : 'none' }
}

/** 第 index 格的时间范围；最后一格还没结束 */
function cellRange(data: AvailabilityData, index: number, count: number): string {
  const from = data.start + index * data.cell_ms
  return index === count - 1 ? `${hm(from)} – 现在` : `${hm(from)} – ${hm(from + data.cell_ms)}`
}

function cellLabel(data: AvailabilityData, cells: AvailabilityCell[], index: number): string {
  const cell = cells[index]
  const range = cellRange(data, index, cells.length)
  if (!cell.total) return `${range}：无数据`
  return `${range}：${LEVELS[levelOf(cell)].label}，错误率 ${rateText(cell.errors, cell.total)}，请求 ${cell.total} 次，失败 ${cell.errors} 次`
}

function Status({ level }: { level: Level }) {
  const { label, Icon } = LEVELS[level]
  return <span className={`pt-av-status is-${level}`}><Icon size={14} />{label}</span>
}

interface Tip {
  row: Row
  index: number
  /** 格子中心的横坐标与上下边（视口坐标） */
  x: number
  top: number
  bottom: number
}

/** 悬浮提示：默认在格子上方，贴边时向内收，上方放不下时翻到下方 */
function CellTip({ data, tip }: { data: AvailabilityData; tip: Tip }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { offsetWidth: w, offsetHeight: h } = el
    const left = Math.min(Math.max(tip.x - w / 2, 8), window.innerWidth - w - 8)
    setPos({ left, top: tip.top - h - 8 >= 8 ? tip.top - h - 8 : tip.bottom + 8 })
  }, [tip])
  const cell = tip.row.cells[tip.index]
  const level = levelOf(cell)
  return (
    <div ref={ref} className="pt-av-tip" role="tooltip" style={pos ?? { left: -9999, top: 0 }}>
      <div className="pt-av-tip-head">
        <span className="pt-av-tip-model">{tip.row.model}</span>
        <span className="pt-av-tip-time">{cellRange(data, tip.index, tip.row.cells.length)}</span>
      </div>
      {cell.total ? (
        <>
          <div className="pt-av-tip-value"><strong>{rateText(cell.errors, cell.total)}</strong><span>错误率</span></div>
          <div className="pt-av-tip-meta">请求 {num(cell.total)} 次 · 失败 {num(cell.errors)} 次{cell.probes > 0 && <> · 含自动测活 {cell.probes} 次</>}</div>
        </>
      ) : (
        <div className="pt-av-tip-meta">这段时间没有请求结果</div>
      )}
      <Status level={level} />
    </div>
  )
}

function Strip({ data, row, tip, onTip }: { data: AvailabilityData; row: Row; tip: Tip | null; onTip: (tip: Tip | null) => void }) {
  const refs = useRef<(HTMLSpanElement | null)[]>([])
  const active = tip?.row.model === row.model ? tip.index : -1
  const show = (index: number) => {
    const rect = refs.current[index]?.getBoundingClientRect()
    if (rect) onTip({ row, index, x: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom })
  }
  // 整条只占一个 Tab 位，左右方向键在格子间移动
  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
    if (!step) return
    e.preventDefault()
    show(Math.min(Math.max((active < 0 ? row.cells.length - 1 : active) + step, 0), row.cells.length - 1))
  }
  return (
    <div
      className="pt-av-strip"
      tabIndex={0}
      role="group"
      aria-label={`${row.model} 最近 2 小时，方向键逐格查看`}
      // 鼠标点击也会聚焦，只有键盘聚焦才跳到最新一格
      onFocus={e => { if (e.currentTarget.matches(':focus-visible')) show(row.cells.length - 1) }}
      onBlur={() => onTip(null)}
      onKeyDown={onKeyDown}
      onPointerLeave={() => onTip(null)}
    >
      {row.cells.map((cell, index) => (
        <span
          key={index}
          ref={el => { refs.current[index] = el }}
          className={`pt-av-cell is-${levelOf(cell)}${index === active ? ' is-active' : ''}`}
          role="img"
          aria-label={cellLabel(data, row.cells, index)}
          onPointerEnter={() => show(index)}
        />
      ))}
    </div>
  )
}

function ModelRow({ data, row, showGroups, tip, onTip }: { data: AvailabilityData; row: Row; showGroups: boolean; tip: Tip | null; onTip: (tip: Tip | null) => void }) {
  return (
    <div className="pt-av-row">
      <div className="pt-av-model">
        <span className="pt-av-name" title={row.model}>{row.model}</span>
        {showGroups && <span className="pt-badge-row">{row.groups.map(g => <Badge key={g} tone="outline">{g}</Badge>)}</span>}
      </div>
      <div className="pt-av-current"><Status level={row.level} /></div>
      <Strip data={data} row={row} tip={tip} onTip={onTip} />
      <div className="pt-av-rate">
        <span className="pt-av-rate-label">2 小时错误率</span>
        <span className="pt-av-rate-value">{row.total ? rateText(row.errors, row.total) : '—'}</span>
        <span className="pt-av-rate-desc">{row.total ? `${num(row.total)} 次请求` : '暂无请求'}</span>
      </div>
    </div>
  )
}

export function AvailabilityPage() {
  const toast = useToast()
  const [data, setData] = useState<AvailabilityData | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [updatedAt, setUpdatedAt] = useState(0)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Level | ''>('')
  const [tip, setTip] = useState<Tip | null>(null)
  const controller = useRef<AbortController>()

  const load = useCallback(async (manual = false) => {
    controller.current?.abort()
    const ac = new AbortController()
    controller.current = ac
    setLoading(true)
    try {
      const next = await api.availability(ac.signal)
      setData(next)
      setError('')
      setUpdatedAt(Date.now())
    } catch (e) {
      if (ac.signal.aborted) return
      setError((e as Error).message)
      if (manual) toast('error', (e as Error).message)
    } finally {
      if (!ac.signal.aborted) setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => { if (!document.hidden) void load() }, REFRESH_MS)
    return () => {
      window.clearInterval(timer)
      controller.current?.abort()
    }
  }, [load])

  // 滚动或刷新后格子位置会变，直接收起提示
  useEffect(() => {
    const hide = () => setTip(null)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => {
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
    }
  }, [])
  useEffect(() => setTip(null), [data])

  const rows = useMemo(() => (data?.models ?? []).map(summarize), [data])
  const counts = useMemo(() => {
    const out: Record<Level, number> = { good: 0, warn: 0, bad: 0, none: 0 }
    for (const row of rows) out[row.level]++
    return out
  }, [rows])
  const showGroups = useMemo(() => new Set(rows.flatMap(r => r.groups)).size > 1, [rows])
  const keyword = q.trim().toLowerCase()
  const visible = rows.filter(r => (!filter || r.level === filter) && (!keyword || r.model.toLowerCase().includes(keyword)))

  const actions = (
    <>
      {updatedAt > 0 && <span className="pt-av-updated">更新于 {hms(updatedAt)}</span>}
      <div className="pt-input-wrap has-lead pt-filter-search">
        <span className="pt-input-lead"><IconSearch size={14} /></span>
        <Input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索模型" />
      </div>
      <Button variant="outline" size="icon" onClick={() => load(true)} disabled={loading} title="刷新" aria-label="刷新">
        <IconRefresh size={14} className={loading ? 'pt-spinner' : undefined} />
      </Button>
    </>
  )

  let content
  if (!data) {
    content = error ? (
      <Card><Empty icon={<IconActivity size={20} />} title="加载失败" desc={error} action={<Button variant="outline" size="sm" onClick={() => load(true)}>重试</Button>} /></Card>
    ) : (
      <Card><div className="pt-card-content" style={{ display: 'grid', gap: 14 }}>{[0, 1, 2, 3, 4].map(i => <Skeleton key={i} height={28} />)}</div></Card>
    )
  } else if (!rows.length) {
    content = <Card><Empty icon={<IconActivity size={20} />} title="暂无可用模型" desc="你的分组里还没有开放模型，请联系管理员" /></Card>
  } else {
    const firstCell = data.start
    const mid = data.start + (data.models[0].cells.length / 2) * data.cell_ms
    content = (
      <Card className={`pt-av-card${loading ? ' is-refreshing' : ''}`}>
        <div className="pt-av-list">
          <div className="pt-av-row pt-av-head" aria-hidden="true">
            <span className="pt-av-model">模型</span>
            <span className="pt-av-current">当前</span>
            <span className="pt-av-axis"><span>{hm(firstCell)}</span><span>{hm(mid)}</span><span>现在</span></span>
            <span className="pt-av-rate">2 小时错误率</span>
          </div>
          {visible.map(row => <ModelRow key={row.model} data={data} row={row} showGroups={showGroups} tip={tip} onTip={setTip} />)}
          {!visible.length && (
            <Empty icon={<IconSearch size={20} />} title="没有匹配的模型" desc="换个关键词或状态试试"
              action={<Button variant="outline" size="sm" onClick={() => { setQ(''); setFilter('') }}>清除筛选</Button>} />
          )}
        </div>
      </Card>
    )
  }

  return (
    <PageLayout title="可用性" desc="最近 2 小时各模型的健康度与错误率，每格 10 分钟" actions={actions}>
      <div className="pt-av-stats">
        {LEVEL_ORDER.map(level => (
          <button
            key={level}
            type="button"
            className={`pt-av-stat${filter === level ? ' is-active' : ''}`}
            aria-pressed={filter === level}
            onClick={() => setFilter(f => (f === level ? '' : level))}
          >
            <Status level={level} />
            <span className="pt-av-stat-value">{data ? counts[level] : '—'}</span>
            <span className="pt-av-stat-desc">{LEVELS[level].desc}</span>
          </button>
        ))}
      </div>
      {content}
      <p className="pt-av-note">
        {'健康度按每格错误率判定，「当前」取最近一个有结果的格子。客户端主动断开、请求参数错误、余额或限流拒绝等调用方自身原因的失败不计入。'
          + '某个模型 10 分钟内没有人调用时，系统会自动发一次很小的请求测活，结果同样计入。'}
      </p>
      {tip && data && <CellTip data={data} tip={tip} />}
    </PageLayout>
  )
}
