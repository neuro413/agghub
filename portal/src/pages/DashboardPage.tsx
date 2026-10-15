import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '../api'
import { navigate } from '../router'
import { useSession, useUser } from '../session'
import { localDay, num, perMillion, usd } from '../lib/format'
import type { ModelPrice, UsageDay } from '../types'
import { PageLayout } from '../components/Layout'
import { Button, Card, CardHeader, CopyButton, Empty, IconBadge, Skeleton } from '../components/ui'
import { IconActivity, IconChartColumn, IconChevronRight, IconGlobe, IconSparkles, IconWallet, IconZap } from '../components/Icons'
import { CheckinCard } from './CheckinCard'

/** 最近 days 天（含今天），没有用量的日期补 0 */
function lastDays(rows: UsageDay[], days: number): UsageDay[] {
  const byDay = new Map(rows.map(r => [r.day, r]))
  return Array.from({ length: days }, (_, i) => {
    const day = localDay(Date.now() - (days - 1 - i) * 86_400_000)
    return byDay.get(day) ?? { day, requests: 0, points: 0, prompt_tokens: 0, completion_tokens: 0 }
  })
}

function MiniBars({ values, tone }: { values: number[]; tone: string }) {
  const max = Math.max(...values, 0)
  return (
    <div className={`pt-mini-bars tone-${tone}`}>
      {values.map((v, i) => (
        <span key={i} style={{ height: `${max ? Math.max(8, (v / max) * 100) : 8}%`, opacity: v ? 1 : 0.35 }} />
      ))}
    </div>
  )
}

function Sparkline({ values, tone }: { values: number[]; tone: string }) {
  const max = Math.max(...values, 0)
  const points = values.map((v, i) => [(i / Math.max(1, values.length - 1)) * 160, 32 - (max ? (v / max) * 28 : 0)])
  const line = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const id = `spark-${tone}`
  return (
    <div className={`pt-sparkline tone-${tone}`}>
      <svg viewBox="0 0 160 36" preserveAspectRatio="none">
        <defs>
          <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.24" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`${line} L160,36 L0,36 Z`} fill={`url(#${id})`} />
        <path d={line} fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  )
}

function StatItem({ icon, tone, label, value, desc, chart }: { icon: ReactNode; tone: string; label: string; value: string; desc: string; chart: ReactNode }) {
  return (
    <div className="pt-stat">
      <div className="pt-stat-label"><IconBadge tone={tone}>{icon}</IconBadge>{label}</div>
      <div className="pt-stat-value mono">{value}</div>
      <div className="pt-stat-desc">{desc}</div>
      {chart}
    </div>
  )
}

function SummaryCard({ usage }: { usage: UsageDay[] | null }) {
  const user = useUser()
  const { status } = useSession()
  const days = lastDays(usage ?? [], 7)
  const weekPoints = days.reduce((s, d) => s + d.points, 0)
  const weekRequests = days.reduce((s, d) => s + d.requests, 0)
  const health = user.quota <= 0 ? { cls: 'is-critical', text: '余额不足' }
    : user.quota < status.points_per_usd * 0.1 ? { cls: 'is-caution', text: '余额偏低' }
    : { cls: 'is-healthy', text: '状态良好' }
  return (
    <section className="pt-summary">
      <div className="pt-summary-main">
        <div>
          <h3 className="pt-summary-title">账户概览</h3>
          <p className="pt-summary-desc">欢迎回来，{user.username}。以下为最近 7 天的用量。</p>
        </div>
        <div className="pt-stat-grid">
          <StatItem icon={<IconZap size={14} />} tone="chart-1" label="今日消耗" value={usd(user.today_points)}
            desc={`今日 ${num(user.today_requests)} 次请求`} chart={<MiniBars values={days.map(d => d.points)} tone="chart-1" />} />
          <StatItem icon={<IconChartColumn size={14} />} tone="chart-2" label="历史消耗" value={usd(user.used_quota)}
            desc={`近 7 天 ${usd(weekPoints)}`} chart={<Sparkline values={days.map(d => d.points)} tone="chart-2" />} />
          <StatItem icon={<IconActivity size={14} />} tone="chart-3" label="请求次数" value={num(user.request_count)}
            desc={`近 7 天 ${num(weekRequests)} 次`} chart={<MiniBars values={days.map(d => d.requests)} tone="chart-3" />} />
        </div>
      </div>
      <div className="pt-summary-side">
        <div className="pt-balance-head">
          <span className="pt-stat-label"><IconBadge tone="success"><IconWallet size={14} /></IconBadge>剩余额度</span>
          <span className={`pt-health ${health.cls}`}><span className="pt-dot" />{health.text}</span>
        </div>
        <div className="pt-balance mono">{usd(user.quota)}</div>
        <div className="pt-balance-note">
          {status.checkin_enabled
            ? <><IconSparkles size={14} />每日签到可领 {usd(status.checkin_min_points)} ~ {usd(status.checkin_max_points)}</>
            : <>额度由管理员发放，用完后请联系管理员</>}
        </div>
        <Button variant="outline" block className="pt-balance-btn" onClick={() => navigate('/console/keys')}>
          管理令牌<IconChevronRight />
        </Button>
      </div>
    </section>
  )
}

function AccessCard({ models }: { models: ModelPrice[] | null }) {
  const { status } = useSession()
  const base = status.base_url.replace(/\/+$/, '')
  const endpoints = [
    { label: 'OpenAI 兼容', value: `${base}/v1`, hint: 'Chat Completions / Responses' },
    { label: 'Anthropic', value: base, hint: 'Messages' },
  ]
  return (
    <Card>
      <CardHeader icon={<IconBadge tone="info" size="md"><IconGlobe /></IconBadge>} title="接入信息" desc="在客户端里填写 Base URL 和令牌即可调用" />
      <div className="pt-card-content pt-access">
        {endpoints.map(e => (
          <div key={e.label} className="pt-endpoint">
            <div className="pt-endpoint-label">{e.label}<span className="muted"> · {e.hint}</span></div>
            <div className="pt-endpoint-row">
              <code className="pt-endpoint-url mono">{e.value}</code>
              <CopyButton text={e.value} title="复制地址" />
            </div>
          </div>
        ))}
        <div className="pt-model-head">
          <span>可用模型</span>
          <span className="muted">价格为每百万 Token</span>
        </div>
        {models == null ? (
          <Skeleton height={120} />
        ) : models.length === 0 ? (
          <Empty title="暂无可用模型" desc="管理员还没有开放模型，请稍后再来看看" />
        ) : (
          <div className="pt-table-wrap pt-model-table">
            <table className="pt-table">
              <thead>
                <tr><th>模型</th><th className="num">输入</th><th className="num">输出</th><th className="num">缓存读取</th><th className="num">按次</th></tr>
              </thead>
              <tbody>
                {models.map(m => (
                  <tr key={m.model}>
                    <td><span className="pt-model-name mono">{m.model}</span></td>
                    <td className="num mono">{perMillion(m.input)}</td>
                    <td className="num mono">{perMillion(m.output)}</td>
                    <td className="num mono">{perMillion(m.cache_read)}</td>
                    <td className="num mono">{m.per_request ? usd(m.per_request) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  )
}

export function DashboardPage() {
  const { status, refreshUser } = useSession()
  const [usage, setUsage] = useState<UsageDay[] | null>(null)
  const [models, setModels] = useState<ModelPrice[] | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void refreshUser()
    api.usage(7, controller.signal).then(setUsage, () => setUsage([]))
    api.models(controller.signal).then(setModels, () => setModels([]))
    return () => controller.abort()
  }, [refreshUser])

  return (
    <PageLayout title="概览" desc="账户余额、用量与接入信息">
      <SummaryCard usage={usage} />
      <div className={`pt-dash-grid${status.checkin_enabled ? '' : ' is-single'}`}>
        <AccessCard models={models} />
        {status.checkin_enabled && <CheckinCard />}
      </div>
    </PageLayout>
  )
}
