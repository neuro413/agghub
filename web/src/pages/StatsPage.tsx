import { fmtNum, fmtTime } from '../lib/format'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import { DonutChart } from '../charts/DonutChart'
import { LineChart } from '../charts/LineChart'
import { MiniBar } from '../charts/MiniBar'
import { StatCard } from '../charts/StatCard'
import { IconButton, Button } from '../components/Button'
import { Card } from '../components/Card'
import { IconBolt, IconCheck, IconChevronRight, IconRefresh, IconSpark, IconStats, IconTrend } from '../components/Icons'
import { useToast } from '../components/Toast'
import type { LogItem, Stats } from '../types'
import { useLatestRequest } from '../lib/useLatestRequest'

const RANGES: { k: string; label: string }[] = [
  { k: '24h', label: '24 小时' },
  { k: '7d', label: '7 天' },
  { k: '30d', label: '30 天' },
]


export function StatsPage({ onOpenLogs }: { onOpenLogs: () => void }) {
  const [range, setRange] = useState('24h')
  const [stats, setStats] = useState<Stats | null>(null)
  const [logs, setLogs] = useState<LogItem[]>([])
  const toast = useToast()

  const requests = useLatestRequest()
  const load = useCallback(async () => {
    const request = requests.begin()
    try {
      const [s, l] = await Promise.all([api.getStats(range, request.signal), api.listLogs({ limit: 5 }, request.signal)])
      if (!request.current()) return
      setStats(s)
      setLogs(l.items)
    } catch (e: any) {
      if (request.current()) toast('err', e.message)
    }
  }, [range, toast, requests])

  useEffect(() => {
    load()
    return () => requests.cancel()
  }, [load, requests])

  const ov = stats?.overview
  const rate = Math.round((ov?.success_rate ?? 1) * 100)

  return (
    <div className="ah-fade-up">
      <div className="ah-page-head">
        <div>
          <div className="ah-page-title">数据统计</div>
          <div className="ah-page-sub">请求趋势 · 渠道分布 · 调用明细</div>
        </div>
        <div className="ah-row">
          <div className="ah-range">
            {RANGES.map((r) => (
              <button key={r.k} className={range === r.k ? 'is-active' : ''} onClick={() => setRange(r.k)}>
                {r.label}
              </button>
            ))}
          </div>
          <IconButton title="刷新" onClick={load}>
            <IconRefresh size={18} />
          </IconButton>
        </div>
      </div>

      <div className="ah-stats-grid">
        <StatCard icon={<IconBolt size={19} />} label="总请求" value={ov?.total ?? 0} sub={`成功 ${ov?.success ?? 0} · 失败 ${ov?.error ?? 0}`} />
        <StatCard icon={<IconCheck size={19} />} label="成功率" value={`${rate}%`} sub={ov && ov.total ? `${ov.success}/${ov.total}` : '暂无调用'} />
        <StatCard icon={<IconSpark size={19} />} label="总 Token" value={fmtNum(ov?.total_tokens)} sub="prompt + completion" />
        <StatCard icon={<IconTrend size={19} />} label="平均延迟" value={`${ov?.avg_latency ?? 0}`} sub="毫秒 / 请求" />
      </div>

      <div className="ah-charts-row">
        <Card className="ah-chart-card">
          <div className="ah-chart-title">
            <IconTrend size={18} /> 请求趋势
            <span className="sp" />
            <span className="ah-mini ah-muted">{RANGES.find((r) => r.k === range)?.label}</span>
          </div>
          <LineChart data={stats?.trend.map((t) => t.requests) ?? []} />
        </Card>
        <Card className="ah-chart-card">
          <div className="ah-chart-title">渠道分布</div>
          <DonutChart segments={(stats?.by_channel ?? []).map((c) => ({ label: c.channel_name || `渠道#${c.channel_id}`, value: c.count }))} />
        </Card>
      </div>

      <div className="ah-charts-row" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <Card className="ah-chart-card">
          <div className="ah-chart-title">模型调用 Top</div>
          <MiniBar items={(stats?.by_model ?? []).slice(0, 8).map((m) => ({ label: m.model || '-', value: m.count }))} />
        </Card>
        <Card className="ah-chart-card">
          <div className="ah-chart-title">
            <IconSpark size={17} /> Token 趋势
          </div>
          <LineChart data={stats?.trend.map((t) => t.tokens) ?? []} />
        </Card>
      </div>

      <Card className="ah-chart-card ah-logs-card">
        <div className="ah-chart-title" style={{ padding: '0 8px', marginBottom: 8 }}>
          最近请求
          <span className="sp" />
          <Button variant="ghost" size="sm" icon={<IconChevronRight size={15} />} onClick={onOpenLogs}>
            查看全部
          </Button>
        </div>
        {logs.length === 0 ? (
          <div className="ah-muted ah-mini" style={{ padding: '34px 0', textAlign: 'center' }}>
            <IconStats size={30} style={{ opacity: 0.4, display: 'block', margin: '0 auto 10px' }} />
            暂无调用记录
          </div>
        ) : (
          logs.map((l) => (
            <div key={l.id} className="ah-log-row" onClick={onOpenLogs}>
              <span className="ah-log-model ah-truncate">{l.model || '-'}</span>
              <span className="ah-mini ah-muted ah-truncate" style={{ maxWidth: 120 }}>
                {l.channel_name || '—'}
              </span>
              <span className="ah-log-spacer" />
              {l.is_stream ? <span className="ah-tag">stream</span> : null}
              <span className="ah-mini ah-muted ah-num">{l.total_tokens || 0} tok</span>
              <span className="ah-mini ah-muted ah-num">{l.latency_ms ?? 0}ms</span>
              <span className={`ah-log-pill ${l.status === 'success' ? 'ok' : 'err'}`}>
                {l.status === 'success' ? l.status_code || 200 : l.status_code || 'ERR'}
              </span>
              <span className="ah-mini ah-faint ah-num">{fmtTime(l.created_at)}</span>
            </div>
          ))
        )}
      </Card>
    </div>
  )
}

