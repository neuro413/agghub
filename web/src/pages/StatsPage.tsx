import { fmtDuration, fmtNum, fmtTime, rateTone, successRate } from '../lib/format'
import { money } from '../lib/money'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api } from '../api/client'
import { DonutChart } from '../charts/DonutChart'
import { LineChart, type LineSeries } from '../charts/LineChart'
import { MiniBar } from '../charts/MiniBar'
import { Sparkline } from '../charts/Sparkline'
import { IconButton, Button } from '../components/Button'
import { Dropdown } from '../components/Form'
import { IconChevronRight, IconRefresh, IconSearch } from '../components/Icons'
import { PageHead } from '../components/PageHead'
import { useToast } from '../components/Toast'
import type { ApiKeyView, DiscordGuildRanking, LogItem, Stats, StatsOverview } from '../types'
import { GuildIcon, StatusPill } from '../components/Primitives'

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

/** 成功率文字：按三档着色，没有请求时显示 — */
function Rate({ success, count }: { success: number; count: number }) {
  const rate = successRate(success, count)
  if (rate == null) return <span className="ah-muted">—</span>
  return <span className={`ah-num ah-strong ah-c-${rateTone(rate)}`}>{rate}%</span>
}

/** fmtNum / fmtDuration 的结果拆成数字和单位，单位用小字 */
function splitUnit(text: string): [string, string] {
  const m = /^(-?[\d.,]+)([a-zA-Z%]*)$/.exec(text)
  return m ? [m[1], m[2]] : [text, '']
}

/** 趋势横轴标签：按小时显示 HH:00，按天显示 MM/DD */
function bucketLabel(ts: number, bucketMs: number): string {
  const d = new Date(ts)
  const p = (x: number) => String(x).padStart(2, '0')
  return bucketMs >= 86_400_000 ? `${p(d.getMonth() + 1)}/${p(d.getDate())}` : `${p(d.getHours())}:00`
}

/** 环比涨跌；上一区间为 0 时不显示 */
function Delta({ cur, prev, goodWhenUp = true, kind = 'pct' }: { cur: number; prev: number | undefined; goodWhenUp?: boolean; kind?: 'pct' | 'pt' }) {
  if (prev == null || (kind === 'pct' && !prev)) return null
  const diff = kind === 'pct' ? ((cur - prev) / prev) * 100 : cur - prev
  if (!Number.isFinite(diff)) return null
  const flat = Math.abs(diff) < 0.05
  const cls = flat ? 'flat' : diff > 0 === goodWhenUp ? 'up' : 'down'
  const text = `${diff > 0 ? '+' : diff < 0 ? '−' : ''}${Math.abs(diff).toFixed(1)}${kind === 'pct' ? '%' : ' 个百分点'}`
  return <span className={`ah-delta ${cls}`}>{text}</span>
}

function Kpi({ label, value, sub, delta, spark }: { label: string; value: string; sub: ReactNode; delta?: ReactNode; spark?: number[] }) {
  const [num, unit] = splitUnit(value)
  return (
    <div className="ah-kpi">
      <div className="ah-kpi-label">{label}</div>
      <div className="ah-kpi-val ah-num">
        {num}
        {unit && <small>{unit}</small>}
      </div>
      <div className="ah-kpi-sub">
        {delta}
        <span className="ah-truncate">{sub}</span>
      </div>
      {spark && spark.length > 1 && <Sparkline values={spark} />}
    </div>
  )
}

function Panel({ title, hint, children, className = '' }: { title: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`ah-panel ${className}`.trim()}>
      <div className="ah-panel-head">
        <h2>{title}</h2>
        {hint != null && <span className="ah-panel-hint">{hint}</span>}
      </div>
      {children}
    </section>
  )
}

function EmptyData({ text = '暂无数据' }: { text?: string }) {
  return <div className="ah-chart-empty">{text}</div>
}

const pct = (part: number, total: number | undefined) => (total ? Math.round((part / total) * 1000) / 10 : 0)

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
  const prev: StatsOverview | undefined = stats?.overview_prev
  const tp = stats?.throughput
  const trend = stats?.trend ?? []
  const bucketMs = stats?.bucketMs ?? 3_600_000
  const labels = trend.map((t) => bucketLabel(t.bucket, bucketMs))
  const hasErrors = trend.some((t) => t.errors != null)
  const rate = Math.round((ov?.success_rate ?? 1) * 1000) / 10
  const peakLabel = bucketMs >= 86_400_000 ? '每天峰值' : '每小时峰值'
  const topGuildUsers = guilds?.items[0]?.user_count || 1
  const rangeLabel = RANGES.find((r) => r.k === range)?.label

  const reqSeries: LineSeries[] = hasErrors
    ? [
        { name: '成功', values: trend.map((t) => t.requests - (t.errors ?? 0)), color: 'var(--chart-1)', area: 0.16 },
        { name: '失败', values: trend.map((t) => t.errors ?? 0), color: 'var(--err)' },
      ]
    : [{ name: '请求', values: trend.map((t) => t.requests), color: 'var(--chart-1)', area: 0.16 }]

  return (
    <div className="ah-fade-up">
      <PageHead
        title="数据统计"
        sub="请求趋势 · 渠道分布 · 调用明细"
        actions={
          <>
            <div className="ah-stats-key">
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
              <IconRefresh size={16} />
            </IconButton>
          </>
        }
      />

      <div className="ah-kpis">
        <Kpi
          label="总请求"
          value={(ov?.total ?? 0).toLocaleString('en-US')}
          sub={`成功 ${ov?.success ?? 0} · 失败 ${ov?.error ?? 0}`}
          delta={ov && <Delta cur={ov.total} prev={prev?.total} />}
          spark={trend.map((t) => t.requests)}
        />
        <Kpi
          label="成功率"
          value={ov && ov.total ? `${rate}%` : '—'}
          sub={ov && ov.total ? `${ov.success}/${ov.total}` : '暂无调用'}
          delta={ov && prev && prev.total ? <Delta cur={ov.success_rate * 100} prev={prev.success_rate * 100} kind="pt" /> : null}
          spark={hasErrors ? trend.map((t) => (t.requests ? ((t.requests - (t.errors ?? 0)) / t.requests) * 100 : 100)) : undefined}
        />
        <Kpi
          label="总 Token"
          value={fmtNum(ov?.total_tokens)}
          sub="prompt + completion"
          delta={ov && <Delta cur={ov.total_tokens} prev={prev?.total_tokens} />}
          spark={trend.map((t) => t.tokens)}
        />
        <Kpi
          label="总消耗"
          value={money(ov?.total_points)}
          sub="按模型定价折算"
          delta={ov && <Delta cur={ov.total_points ?? 0} prev={prev?.total_points} />}
          spark={trend.map((t) => t.points)}
        />
        <Kpi
          label="平均延迟"
          value={ov?.avg_latency ? fmtDuration(ov.avg_latency) : '—'}
          sub="平均每次请求"
          delta={ov && ov.avg_latency ? <Delta cur={ov.avg_latency} prev={prev?.avg_latency} goodWhenUp={false} /> : null}
        />
      </div>

      <div className="ah-live">
        <div>
          <label>当前 RPM</label>
          <b className="ah-num">{tp?.current_rpm ?? 0}</b>
          <span>最近 60 秒请求数</span>
        </div>
        <div>
          <label>当前 TPM</label>
          <b className="ah-num">{fmtNum(tp?.current_tpm)}</b>
          <span>最近 60 秒 Token</span>
        </div>
        <div>
          <label>峰值 RPM</label>
          <b className="ah-num">{tp?.peak_rpm ?? 0}</b>
          <span>{tp?.peak_rpm_at != null ? `出现在 ${fmtTime(tp.peak_rpm_at)}` : '暂无调用'}</span>
        </div>
        <div>
          <label>峰值 TPM</label>
          <b className="ah-num">{fmtNum(tp?.peak_tpm)}</b>
          <span>{tp?.peak_tpm_at != null ? `出现在 ${fmtTime(tp.peak_tpm_at)}` : '暂无调用'}</span>
        </div>
      </div>

      <div className="ah-stats-row is-21">
        <Panel
          title="请求趋势"
          hint={
            hasErrors ? (
              <span className="ah-legend">
                <span><i style={{ background: 'var(--chart-1)' }} />成功</span>
                <span><i style={{ background: 'var(--err)' }} />失败</span>
              </span>
            ) : (
              rangeLabel
            )
          }
        >
          <div className="ah-panel-chart">
            <LineChart series={reqSeries} labels={labels} height={330} format={fmtNum} />
          </div>
        </Panel>
        <Panel title="渠道分布" hint="按请求数">
          <DonutChart segments={(stats?.by_channel ?? []).map((c) => ({ label: c.channel_name || `渠道#${c.channel_id}`, value: c.count }))} />
        </Panel>
      </div>

      <div className="ah-stats-row">
        <Panel title="模型调用 Top" hint={stats?.by_model?.length ? `共 ${stats.by_model.length} 个模型` : undefined}>
          <div className="ah-panel-body">
            <MiniBar items={(stats?.by_model ?? []).slice(0, 8).map((m) => ({ label: m.model || '-', value: m.count }))} />
          </div>
        </Panel>
        <Panel title="Token 趋势" hint={rangeLabel}>
          <div className="ah-panel-chart">
            <LineChart series={[{ name: 'Token', values: trend.map((t) => t.tokens), color: 'var(--chart-3)', area: 0.12 }]} labels={labels} height={228} format={fmtNum} />
          </div>
        </Panel>
      </div>

      <div className="ah-stats-row">
        <Panel title="RPM 趋势" hint={peakLabel}>
          <div className="ah-panel-chart">
            <LineChart series={[{ name: '峰值 RPM', values: trend.map((t) => t.peak_rpm), color: 'var(--chart-1)', area: 0.16 }]} labels={labels} height={200} format={fmtNum} />
          </div>
        </Panel>
        <Panel title="TPM 趋势" hint={peakLabel}>
          <div className="ah-panel-chart">
            <LineChart series={[{ name: '峰值 TPM', values: trend.map((t) => t.peak_tpm), color: 'var(--chart-3)', area: 0.12 }]} labels={labels} height={200} format={fmtNum} />
          </div>
        </Panel>
      </div>

      <Panel title="Key 分布" className="ah-dist-panel">
        {!stats?.by_key?.length ? (
          <EmptyData />
        ) : (
          <div className="ah-dist">
            <div className="ah-dist-head ah-keydist-row">
              <span>Key</span>
              <span className="r">请求</span>
              <span className="r">成功率</span>
              <span className="r">消耗</span>
            </div>
            {stats.by_key.map((b) => (
              <div key={b.key_id} className="ah-dist-row ah-keydist-row">
                <span className="ah-truncate ah-keydist-name">{b.key_name || '#' + b.key_id}</span>
                <span className="r ah-num">{b.count.toLocaleString('en-US')}</span>
                <span className="r">
                  <Rate success={b.success} count={b.count} />
                </span>
                <span className="r ah-num">{money(b.points)}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="IP 分布" hint="按请求数 Top 50" className="ah-dist-panel">
        {!stats?.by_ip?.length ? (
          <EmptyData />
        ) : (
          <div className="ah-dist ah-dist-scroll">
            <div className="ah-dist-head ah-ipdist-row">
              <span>IP</span>
              <span className="r">请求</span>
              <span className="r">成功率</span>
              <span className="r">Token</span>
              <span className="r">消耗</span>
              <span>调用方</span>
            </div>
            {stats.by_ip.map((b) => (
              <div key={b.ip ?? ''} className="ah-dist-row ah-ipdist-row">
                <span className="ah-truncate ah-keydist-name ah-mono" title={b.ip ?? undefined}>{b.ip || '未记录'}</span>
                <span className="r ah-num">{b.count.toLocaleString('en-US')}</span>
                <span className="r">
                  <Rate success={b.success} count={b.count} />
                </span>
                <span className="r ah-num ah-muted">{fmtNum(b.tokens)}</span>
                <span className="r ah-num">{money(b.points)}</span>
                <span className="ah-ipdist-callers">
                  {b.keys.map((k) => (
                    <span key={k.key_id ?? 'owner'} className="ah-tag ah-truncate" title={`${callerLabel(k)} · ${k.count} 次`}>
                      {callerLabel(k)}
                    </span>
                  ))}
                  {b.key_count > b.keys.length && <span className="ah-mini ah-muted">+{b.key_count - b.keys.length}</span>}
                </span>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="UA 分布" hint="按请求数 Top 50" className="ah-dist-panel">
        {!stats?.by_ua?.length ? (
          <EmptyData />
        ) : (
          <div className="ah-dist ah-dist-scroll">
            <div className="ah-dist-head ah-uadist-row">
              <span>User-Agent</span>
              <span className="r">请求</span>
              <span className="r">成功率</span>
              <span className="r">Token</span>
              <span className="r">消耗</span>
            </div>
            {stats.by_ua.map((b) => (
              <div key={b.ua ?? ''} className="ah-dist-row ah-uadist-row">
                <span className={`ah-truncate ah-mono ${b.ua ? 'ah-keydist-name' : 'ah-muted'}`} title={b.ua ?? '旧日志未存请求头，或请求未带 User-Agent'}>
                  {b.ua || '未记录'}
                </span>
                <span className="r ah-num">{b.count.toLocaleString('en-US')}</span>
                <span className="r">
                  <Rate success={b.success} count={b.count} />
                </span>
                <span className="r ah-num ah-muted">{fmtNum(b.tokens)}</span>
                <span className="r ah-num">{money(b.points)}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel
        title="服务器排名"
        hint={`${guilds?.recorded_users ? `${guilds.recorded_users} 名用户 · ${guilds.total_guilds} 个服务器 · ` : ''}按库内人数 Top 50`}
        className="ah-dist-panel"
      >
        {!guilds?.items.length ? (
          <EmptyData text="暂无数据，用户用 Discord 登录后会记录其所在的服务器" />
        ) : (
          <div className="ah-dist ah-dist-scroll">
            <div className="ah-dist-head ah-guildrank-row">
              <span>#</span>
              <span>服务器</span>
              <span />
              <span className="r">人数</span>
              <span className="r">占比</span>
              <span className="r">成员数</span>
              <span />
            </div>
            {guilds.items.map((g, i) => (
              <div key={g.id} className="ah-dist-row ah-guildrank-row">
                <span className="ah-muted ah-num">{i + 1}</span>
                <span className="ah-guildrank-name">
                  <GuildIcon guild={g} />
                  <span className="ah-truncate ah-keydist-name" title={`${g.name}\n服务器 ID：${g.id}`}>{g.name}</span>
                </span>
                <span className="ah-rankbar">
                  <i className={i === 0 ? 'is-top' : undefined} style={{ width: `${(g.user_count / topGuildUsers) * 100}%` }} />
                </span>
                <span className="r ah-num ah-strong">{g.user_count} 人</span>
                <span className="r ah-num ah-muted" title="占已记录服务器列表的用户">
                  {pct(g.user_count, guilds.recorded_users)}%
                </span>
                <span className="r ah-num ah-muted" title="Discord 给出的服务器近似成员数">
                  {g.member_count != null ? fmtNum(g.member_count) : '—'}
                </span>
                <button type="button" className="ah-guild-search" title="在用户页查看加入了这个服务器的用户" onClick={() => onSearchUsers(g.id)}>
                  <IconSearch size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel
        title="最近请求"
        hint={
          <Button variant="ghost" size="sm" icon={<IconChevronRight size={14} />} onClick={onOpenLogs}>
            查看全部
          </Button>
        }
        className="ah-recent"
      >
        {logs.length === 0 ? (
          <EmptyData text="暂无调用记录" />
        ) : (
          <div className="ah-table-wrap">
            <table className="ah-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>模型</th>
                  <th>渠道</th>
                  <th />
                  <th className="r">Token</th>
                  <th className="r">耗时</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id} className="is-click" onClick={onOpenLogs}>
                    <td className="dim ah-num">{fmtTime(l.created_at, true)}</td>
                    <td>
                      <span className="ah-recent-model ah-truncate">{l.model || '-'}</span>
                    </td>
                    <td>
                      <span className="ah-recent-chan ah-truncate">{l.channel_name || '—'}</span>
                    </td>
                    <td>{l.is_stream ? <span className="ah-tag">stream</span> : null}</td>
                    <td className="r ah-num">{fmtNum(l.total_tokens)}</td>
                    <td className="r ah-num">{fmtDuration(l.latency_ms ?? 0)}</td>
                    <td>
                      <StatusPill log={l} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  )
}
