import { clampOffset, fmtNum, fmtTime } from '../lib/format'
import { money } from '../lib/money'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import { Button, IconButton } from '../components/Button'
import { Card } from '../components/Card'
import { Dropdown, Input } from '../components/Form'
import {
  IconChevronLeft,
  IconChevronRight,
  IconEye,
  IconLogs,
  IconRefresh,
  IconSearch,
  IconTrash,
} from '../components/Icons'
import { useToast } from '../components/Toast'
import type { LogFacets, LogItem } from '../types'
import { LogDetailModal } from './LogDetailModal'
import { fmtShort } from './preprocessShared'
import { Loading, StatusPill } from '../components/Primitives'
import { PageHead } from '../components/PageHead'

const PAGE_SIZE = 50


interface Filters {
  q: string
  status: string
  entry_format: string
  is_stream: string
  channel_id: string
  model: string
  source: string
  key_id: string
}

const EMPTY: Filters = { q: '', status: '', entry_format: '', is_stream: '', channel_id: '', model: '', source: '', key_id: '' }

/** 门户用户名；Discord 用户名与之不同时附在括号里（Discord 建号的用户名由 Discord 名把 . 换成 _ 得来，相同时不重复显示） */
function userLabel(l: LogItem): string {
  const name = l.user_name ?? '#' + l.user_id
  const dc = l.user_discord_name
  return dc && dc.replace(/\./g, '_').toLowerCase() !== name.toLowerCase() ? `${name}（${dc}）` : name
}

/** Key 标签：公网 / 内网前缀 + Key 名称快照；门户用户显示「用户名 / Key 名」 */
function keyLabel(l: LogItem): string {
  if (l.source === 'user') return `${userLabel(l)} / ${l.key_name || '#' + l.key_id}`
  const prefix = l.source === 'public_key' ? '公网 ' : l.source === 'lan_key' ? '内网 ' : ''
  return prefix + (l.key_name || '#' + l.key_id)
}

export function LogsPage() {
  const [filters, setFilters] = useState<Filters>(EMPTY)
  const [qInput, setQInput] = useState('')
  const [offset, setOffset] = useState(0)
  const [items, setItems] = useState<LogItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  const [facets, setFacets] = useState<LogFacets>({ models: [], channels: [], keys: [] })
  const [openId, setOpenId] = useState<number | null>(null)
  const toast = useToast()

  // 关键词防抖
  useEffect(() => {
    if (qInput === filters.q) return
    const timer = window.setTimeout(() => {
      setFilters((f) => ({ ...f, q: qInput }))
      setOffset(0)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [qInput, filters.q])

  // 筛选 / 翻页 / 刷新都会重跑 effect，清理时中止旧请求，旧响应不会覆盖新结果
  const [loadError, setLoadError] = useState('')
  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true)
    setLoadError('')
    try {
      const r = await api.listLogs({
        limit: PAGE_SIZE,
        offset,
        status: filters.status || undefined,
        entry_format: filters.entry_format || undefined,
        is_stream: filters.is_stream || undefined,
        channel_id: filters.channel_id ? Number(filters.channel_id) : undefined,
        model: filters.model || undefined,
        q: filters.q || undefined,
        source: filters.source || undefined,
        key_id: filters.key_id ? Number(filters.key_id) : undefined,
      }, signal)
      if (signal.aborted) return
      setTotal(r.total)
      const valid = clampOffset(offset, r.total, PAGE_SIZE)
      if (valid !== offset) { setOffset(valid); return }
      setItems(r.items)
    } catch (e: any) {
      if (!signal.aborted) { setLoadError(e.message); toast('err', e.message) }
    } finally {
      if (!signal.aborted) setLoading(false)
    }
  }, [offset, filters, toast])

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    return () => controller.abort()
  }, [load, refresh])

  useEffect(() => {
    api.getLogFacets().then(setFacets).catch(() => {})
  }, [])

  const setF = <K extends keyof Filters>(k: K, v: Filters[K]) => {
    setFilters((f) => ({ ...f, [k]: v }))
    setOffset(0)
  }

  const reset = () => {
    setFilters(EMPTY)
    setQInput('')
    setOffset(0)
  }

  const del = async (id: number) => {
    if (!window.confirm('确认删除这条日志？')) return
    try {
      await api.deleteLog(id)
      toast('ok', '已删除')
      setOpenId(current => current === id ? null : current)
      setRefresh(value => value + 1)
    } catch (err: any) {
      toast('err', err.message)
    }
  }

  const clearAll = async () => {
    if (!window.confirm('确认清空全部请求日志？此操作不可撤销。')) return
    try {
      await api.clearLogs()
      toast('ok', '日志已清空')
      setOpenId(null)
      setOffset(0)
      setRefresh(value => value + 1)
      api.getLogFacets().then(setFacets).catch(() => {})
    } catch (e: any) {
      toast('err', e.message)
    }
  }

  const hasFilter = filters.q || filters.status || filters.entry_format || filters.is_stream || filters.channel_id || filters.model || filters.source || filters.key_id
  const page = Math.floor(offset / PAGE_SIZE) + 1
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="ah-fade-up">
      <PageHead
        title="请求日志"
        sub={<>共 {total} 条记录 · 可视化对话 / 请求头 / 原始报文</>}
        actions={
          <>
            <IconButton title="刷新" onClick={() => setRefresh(value => value + 1)}>
              <IconRefresh size={18} />
            </IconButton>
            <Button variant="danger" size="sm" icon={<IconTrash size={16} />} onClick={clearAll}>
              清空
            </Button>
          </>
        }
      />

      {/* 筛选栏 */}
      <Card className="ah-log-filters">
        <div className="ah-log-search">
          <IconSearch size={17} className="ah-log-search-icon" />
          <Input
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            placeholder="搜索模型 / 渠道 / 用户 / IP…"
            title="可搜索：模型、渠道、上游模型、错误信息、Key 名、门户用户名、Discord 用户名 / ID、客户端 IP、代理节点、请求 ID"
          />
        </div>
        <Dropdown
          value={filters.status}
          onChange={(v) => setF('status', v)}
          options={[
            { value: '', label: '全部状态' },
            { value: 'success', label: '成功' },
            { value: 'error', label: '失败' },
          ]}
        />
        <Dropdown
          value={filters.entry_format}
          onChange={(v) => setF('entry_format', v)}
          options={[
            { value: '', label: '全部格式' },
            { value: 'openai', label: 'OpenAI' },
            { value: 'anthropic', label: 'Anthropic' },
            { value: 'responses', label: 'Responses' },
          ]}
        />
        <Dropdown
          value={filters.is_stream}
          onChange={(v) => setF('is_stream', v)}
          options={[
            { value: '', label: '流式 / 非流式' },
            { value: '1', label: '仅流式' },
            { value: '0', label: '仅非流式' },
          ]}
        />
        <Dropdown
          value={filters.channel_id}
          onChange={(v) => setF('channel_id', v)}
          options={[
            { value: '', label: '全部渠道' },
            ...facets.channels.map((c) => ({ value: String(c.channel_id), label: `${c.channel_name || '渠道#' + c.channel_id} (${c.n})` })),
          ]}
        />
        <Dropdown
          value={filters.model}
          onChange={(v) => setF('model', v)}
          options={[
            { value: '', label: '全部模型' },
            ...facets.models.map((m) => ({ value: m.model, label: `${m.model} (${m.n})` })),
          ]}
        />
        <Dropdown
          value={filters.source}
          onChange={(v) => setF('source', v)}
          options={[
            { value: '', label: '全部来源' },
            { value: 'owner', label: '内网匿名' },
            { value: 'lan_key', label: '内网 Key' },
            { value: 'public_key', label: '公网 Key' },
            { value: 'user', label: '门户用户' },
            { value: 'probe', label: '自动测活' },
          ]}
        />
        <Dropdown
          value={filters.key_id}
          onChange={(v) => setF('key_id', v)}
          options={[
            { value: '', label: '全部 Key' },
            ...facets.keys.map((k) => ({ value: String(k.key_id), label: `${k.key_name || '#' + k.key_id} (${k.n})` })),
          ]}
        />
        {hasFilter && (
          <Button variant="ghost" size="sm" onClick={reset}>
            重置
          </Button>
        )}
      </Card>

      {/* 列表 */}
      <Card className="ah-logs-table-card">
        <div className="ah-logt-head">
          <span className="c-time">时间</span>
          <span className="c-status">状态</span>
          <span className="c-model">模型 / 渠道</span>
          <span className="c-tok">Token</span>
          <span className="c-lat">延迟</span>
          <span className="c-act" />
        </div>

        {loading ? (
          <Loading />
        ) : loadError ? <div className="ah-logt-empty" role="alert">加载失败：{loadError}</div> : items.length === 0 ? (
          <div className="ah-logt-empty">
            <IconLogs size={30} style={{ opacity: 0.4, display: 'block', margin: '0 auto 10px' }} />
            {hasFilter ? '没有符合条件的日志' : '暂无请求日志'}
          </div>
        ) : (
          items.map((l) => (
            <div key={l.id} className="ah-logt-row" onClick={() => setOpenId(l.id)}>
              <span className="c-time ah-mini ah-faint ah-num">{fmtTime(l.created_at, true)}</span>
              <span className="c-status">
                <StatusPill log={l} />
              </span>
              <span className="c-model">
                <span className="ah-logt-model ah-truncate">
                  <span className={`ah-fmt-badge ${l.entry_format}`}>{fmtShort(l.entry_format)}</span>
                  {l.model || '-'}
                  {l.is_stream ? <span className="ah-tag" style={{ marginLeft: 6 }}>stream</span> : null}
                  {l.preprocessed || l.client_error ? <span className="ah-tag ah-tag-pp" style={{ marginLeft: 6 }}>已改写</span> : null}
                  {l.pseudo_thinking ? <span className="ah-tag ah-tag-think" style={{ marginLeft: 6 }}>伪思考</span> : null}
                  {l.retry_count ? <span className="ah-tag ah-tag-warn" style={{ marginLeft: 6 }}>×{l.retry_count}</span> : null}
                </span>
                <span className="ah-mini ah-muted ah-truncate">
                  {l.channel_name || '—'}
                  {l.source === 'probe' && <span className="ah-tag" style={{ marginLeft: 6 }}>测活</span>}
                  {l.key_id != null && (
                    <span className={`ah-tag${l.source === 'public_key' || l.source === 'user' ? ' ah-tag-pub' : ''}`} style={{ marginLeft: 6 }}>
                      {keyLabel(l)}
                    </span>
                  )}
                  {l.group_name && (
                    <span className="ah-tag" style={{ marginLeft: 6 }} title="计费分组">
                      {l.group_name}
                    </span>
                  )}
                  {l.proxy_node && (
                    <span className="ah-mini ah-faint" style={{ marginLeft: 6 }} title="代理池节点">
                      🌐 {l.proxy_node}
                    </span>
                  )}
                  {l.quota_points != null && (
                    <span className="ah-mini ah-faint ah-num" style={{ marginLeft: 6 }}>
                      {money(l.quota_points)}
                    </span>
                  )}
                </span>
              </span>
              <span className="c-tok ah-mini ah-muted ah-num">{fmtNum(l.total_tokens)}</span>
              <span className="c-lat ah-mini ah-muted ah-num">
                <span>{l.latency_ms ?? 0}ms</span>
                {l.first_token_ms != null && <span className="ah-faint" title="首字延迟">首字 {l.first_token_ms}ms</span>}
              </span>
              <span className="c-act">
                <IconButton title="查看详情" onClick={() => setOpenId(l.id)}>
                  <IconEye size={16} />
                </IconButton>
                <IconButton title="删除" danger onClick={(e) => { e.stopPropagation(); del(l.id) }}>
                  <IconTrash size={16} />
                </IconButton>
              </span>
            </div>
          ))
        )}

        {/* 分页 */}
        {(total > PAGE_SIZE || offset > 0) && (
          <div className="ah-logt-pager">
            <IconButton title="上一页" onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}>
              <IconChevronLeft size={18} />
            </IconButton>
            <span className="ah-mini ah-muted ah-num">
              {page} / {pages}
            </span>
            <IconButton title="下一页" onClick={() => setOffset((o) => (o + PAGE_SIZE < total ? o + PAGE_SIZE : o))}>
              <IconChevronRight size={18} />
            </IconButton>
          </div>
        )}
      </Card>

      {openId != null && <LogDetailModal id={openId} onClose={() => setOpenId(null)} onDeleted={() => { setOpenId(null); setRefresh(value => value + 1) }} />}
    </div>
  )
}
