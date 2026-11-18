import { fmtNum, fmtTime } from '../lib/format'
import { money } from '../lib/money'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import { DonutChart } from '../charts/DonutChart'
import { LineChart } from '../charts/LineChart'
import { MiniBar } from '../charts/MiniBar'
import { StatCard } from '../charts/StatCard'
import { IconButton, Button } from '../components/Button'
import { Card } from '../components/Card'
import { Dropdown } from '../components/Form'
import { IconBolt, IconCheck, IconChevronRight, IconDiscord, IconKey, IconRefresh, IconSearch, IconSpark, IconStats, IconTrend } from '../components/Icons'
import { useToast } from '../components/Toast'
import type { ApiKeyView, DiscordGuildRanking, LogItem, Stats } from '../types'
import { GuildIcon, StatusPill } from '../components/Primitives'
import { PageHead } from '../components/PageHead'

const RANGES: { k: string; label: string }[] = [
  { k: '24h', label: '24 小时' },
  { k: '7d', label: '7 天' },
  { k: '30d', label: '30 天' },
]

type IpCaller = Stats['by_ip'][number]['keys'][number]

/** IP 关联的调用方：门户用户显示「用户名 / Key 名」，内网匿名调用没有 Key */
function callerLabel(k: IpCaller): string {
  if (k.key_id == null) return '内网匿名'
  const key = k.key_name || `#${k.key_id}`
  return k.user_id == null ? key : `${k.user_name ?? `用户#${k.user_id}`} / ${key}`
}

const successPct = (success: number, count: number) => (count ? Math.round((success / count) * 100) : 100)

function EmptyData({ text = '暂无数据' }: { text?: string }) {
  return (
    <div className="ah-muted ah-mini" style={{ padding: '34px 0', textAlign: 'center' }}>
      {text}
    </div>
  )
}

/** onSearchUsers：跳到用户页并按服务器 ID 搜索 */
export function StatsPage({ onOpenLogs, onSearchUsers }: { onOpenLogs: () => void; onSearchUsers: (q: string) => void }) {
  const [range, setRange] = useState('24h')
  const [keyId, setKeyId] = useState('')
  const [keys, setKeys] = useState<ApiKeyView[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [logs, setLogs] = useState<LogItem[]>([])
  const [guilds, setGuilds] = useState<DiscordGuildRanking | null>(null)
  const [refresh, setRefresh] = useState(0)
  const toast = useToast()

  const load = useCallback(async (signal: AbortSignal) => {
    try {
      const [s, l] = await Promise.all([
        api.getStats(range, signal, { key_id: keyId ? Number(keyId) : undefined }),
        api.listLogs({ limit: 5 }, signal),
      ])
      if (signal.aborted) return
      setStats(s)
      setLogs(l.items)
    } catch (e: any) {
      if (!signal.aborted) toast('err', e.message)
    }
  }, [range, keyId, toast])

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    return () => controller.abort()
  }, [load, refresh])

  useEffect(() => {
    const controller = new AbortController()
    api.listKeys(controller.signal).then((value) => { if (!controller.signal.aborted) setKeys(value) }).catch(() => {})
    return () => controller.abort()
  }, [])

  // 服务器排名与时间范围、Key 筛选无关，只跟着刷新按钮重新读取
  useEffect(() => {
    const controller = new AbortController()
    api.getDiscordGuildRanking(controller.signal).then(
      (value) => { if (!controller.signal.aborted) setGuilds(value) },
      (e: any) => { if (!controller.signal.aborted) toast('err', e.message) },
    )
    return () => controller.abort()
  }, [refresh, toast])

  const ov = stats?.overview
  const tp = stats?.throughput
  const rate = Math.round((ov?.success_rate ?? 1) * 100)
  const peakLabel = (stats?.bucketMs ?? 0) >= 86_400_000 ? '每天峰值' : '每小时峰值'
  const topGuildUsers = guilds?.items[0]?.user_count || 1

  return (
    <div className="ah-fade-up">
      <PageHead
        title="数据统计"
        sub="请求趋势 · 渠道分布 · 调用明细"
        actions={
          <>
            <div style={{ width: 170 }}>
              <Dropdown
                value={keyId}
                onChange={setKeyId}
                options={[{ value: '', label: '全部 Key' }, ...keys.map((k) => ({ value: String(k.id), label: k.name }))]}
              />
            </div>
            <div className="ah-range">
              {RANGES.map((r) => (
                <button key={r.k} className={range === r.k ? 'is-active' : ''} onClick={() => setRange(r.k)}>
                  {r.label}
                </button>
              ))}
            </div>
            <IconButton title="刷新" onClick={() => setRefresh(value => value + 1)}>
              <IconRefresh size={18} />
            </IconButton>
          </>
        }
      />

      <div className="ah-stats-grid">
        <StatCard icon={<IconBolt size={19} />} label="总请求" value={ov?.total ?? 0} sub={`成功 ${ov?.success ?? 0} · 失败 ${ov?.error ?? 0}`} />
        <StatCard icon={<IconCheck size={19} />} label="成功率" value={`${rate}%`} sub={ov && ov.total ? `${ov.success}/${ov.total}` : '暂无调用'} />
        <StatCard icon={<IconSpark size={19} />} label="总 Token" value={fmtNum(ov?.total_tokens)} sub="prompt + completion" />
        <StatCard icon={<IconKey size={19} />} label="总消耗" value={money(ov?.total_points)} sub="按模型定价折算" />
        <StatCard icon={<IconTrend size={19} />} label="平均延迟" value={`${ov?.avg_latency ?? 0}`} sub="毫秒 / 请求" />
      </div>

      <div className="ah-stats-grid">
        <StatCard icon={<IconBolt size={19} />} label="当前 RPM" value={tp?.current_rpm ?? 0} sub="最近 60 秒请求数" />
        <StatCard icon={<IconSpark size={19} />} label="当前 TPM" value={fmtNum(tp?.current_tpm)} sub="最近 60 秒 Token" />
        <StatCard
          icon={<IconTrend size={19} />}
          label="峰值 RPM"
          value={tp?.peak_rpm ?? 0}
          sub={tp?.peak_rpm_at != null ? `出现在 ${fmtTime(tp.peak_rpm_at)}` : '暂无调用'}
        />
        <StatCard
          icon={<IconTrend size={19} />}
          label="峰值 TPM"
          value={fmtNum(tp?.peak_tpm)}
          sub={tp?.peak_tpm_at != null ? `出现在 ${fmtTime(tp.peak_tpm_at)}` : '暂无调用'}
        />
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

      <div className="ah-charts-row" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <Card className="ah-chart-card">
          <div className="ah-chart-title">
            <IconBolt size={17} /> RPM 趋势
            <span className="sp" />
            <span className="ah-mini ah-muted">{peakLabel}</span>
          </div>
          <LineChart data={stats?.trend.map((t) => t.peak_rpm) ?? []} />
        </Card>
        <Card className="ah-chart-card">
          <div className="ah-chart-title">
            <IconSpark size={17} /> TPM 趋势
            <span className="sp" />
            <span className="ah-mini ah-muted">{peakLabel}</span>
          </div>
          <LineChart data={stats?.trend.map((t) => t.peak_tpm) ?? []} />
        </Card>
      </div>

      <Card className="ah-chart-card" style={{ marginBottom: 'var(--sp-5)' }}>
        <div className="ah-chart-title">Key 分布</div>
        {!stats?.by_key?.length ? (
          <EmptyData />
        ) : (
          <div className="ah-keydist">
            {stats.by_key.map((b) => (
              <div key={b.key_id} className="ah-keydist-row">
                <span className="ah-truncate ah-keydist-name">{b.key_name || '#' + b.key_id}</span>
                <span className="ah-mini ah-muted ah-num">{b.count} 次</span>
                <span className="ah-mini ah-num" style={{ color: 'var(--ok)', fontWeight: 700 }}>
                  {successPct(b.success, b.count)}%
                </span>
                <span className="ah-mini ah-num">{money(b.points)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="ah-chart-card" style={{ marginBottom: 'var(--sp-5)' }}>
        <div className="ah-chart-title">
          IP 分布
          <span className="sp" />
          <span className="ah-mini ah-muted">按请求数 Top 50</span>
        </div>
        {!stats?.by_ip?.length ? (
          <EmptyData />
        ) : (
          <div className="ah-keydist ah-dist-scroll">
            {stats.by_ip.map((b) => (
              <div key={b.ip ?? ''} className="ah-keydist-row ah-ipdist-row">
                <span className="ah-truncate ah-keydist-name ah-mono" title={b.ip ?? undefined}>{b.ip || '未记录'}</span>
                <span className="ah-mini ah-muted ah-num">{b.count} 次</span>
                <span className="ah-mini ah-num" style={{ color: 'var(--ok)', fontWeight: 700 }}>
                  {successPct(b.success, b.count)}%
                </span>
                <span className="ah-mini ah-muted ah-num">{fmtNum(b.tokens)} tok</span>
                <span className="ah-mini ah-num">{money(b.points)}</span>
                <span className="ah-ipdist-callers">
                  {b.keys.map((k) => (
                    <span key={k.key_id ?? 'owner'} className="ah-tag ah-truncate" title={`${callerLabel(k)} · ${k.count} 次`}>
                      {callerLabel(k)}
                    </span>
                  ))}
                  {b.key_count > b.keys.length && <span className="ah-mini ah-faint">+{b.key_count - b.keys.length}</span>}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="ah-chart-card" style={{ marginBottom: 'var(--sp-5)' }}>
        <div className="ah-chart-title">
          UA 分布
          <span className="sp" />
          <span className="ah-mini ah-muted">按请求数 Top 50</span>
        </div>
        {!stats?.by_ua?.length ? (
          <EmptyData />
        ) : (
          <div className="ah-keydist ah-dist-scroll">
            {stats.by_ua.map((b) => (
              <div key={b.ua ?? ''} className="ah-keydist-row ah-uadist-row">
                <span className={`ah-truncate ah-mono ${b.ua ? 'ah-keydist-name' : 'ah-muted'}`} title={b.ua ?? '旧日志未存请求头，或请求未带 User-Agent'}>
                  {b.ua || '未记录'}
                </span>
                <span className="ah-mini ah-muted ah-num">{b.count} 次</span>
                <span className="ah-mini ah-num" style={{ color: 'var(--ok)', fontWeight: 700 }}>
                  {successPct(b.success, b.count)}%
                </span>
                <span className="ah-mini ah-muted ah-num">{fmtNum(b.tokens)} tok</span>
                <span className="ah-mini ah-num">{money(b.points)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="ah-chart-card" style={{ marginBottom: 'var(--sp-5)' }}>
        <div className="ah-chart-title">
          <IconDiscord size={17} /> 服务器排名
          <span className="sp" />
          <span className="ah-mini ah-muted">
            {guilds?.recorded_users ? `${guilds.recorded_users} 名用户 · ${guilds.total_guilds} 个服务器 · ` : ''}按库内人数 Top 50
          </span>
        </div>
        {!guilds?.items.length ? (
          <EmptyData text="暂无数据，用户用 Discord 登录后会记录其所在的服务器" />
        ) : (
          <div className="ah-keydist ah-dist-scroll">
            {guilds.items.map((g, i) => (
              <div key={g.id} className="ah-keydist-row ah-guildrank-row">
                <span className="ah-mini ah-faint ah-num">#{i + 1}</span>
                <span className="ah-guildrank-name">
                  <GuildIcon guild={g} />
                  <span className="ah-truncate ah-keydist-name" title={`${g.name}\n服务器 ID：${g.id}`}>{g.name}</span>
                </span>
                <span className="ah-bar"><i style={{ width: `${(g.user_count / topGuildUsers) * 100}%` }} /></span>
                <span className="ah-mini ah-num" style={{ fontWeight: 700 }}>{g.user_count} 人</span>
                <span className="ah-mini ah-muted ah-num" title="占已记录服务器列表的用户">
                  {Math.round((g.user_count / guilds.recorded_users) * 100)}%
                </span>
                <span className="ah-mini ah-faint ah-num" title="Discord 给出的服务器近似成员数">
                  {g.member_count != null ? `共 ${fmtNum(g.member_count)}` : '—'}
                </span>
                <button type="button" className="ah-guild-search" title="在用户页查看加入了这个服务器的用户" onClick={() => onSearchUsers(g.id)}>
                  <IconSearch size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>

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
              <StatusPill log={l} />
              <span className="ah-mini ah-faint ah-num">{fmtTime(l.created_at)}</span>
            </div>
          ))
        )}
      </Card>
    </div>
  )
}

