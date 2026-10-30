import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '../api/client'
import { Button, IconButton } from '../components/Button'
import { Input } from '../components/Form'
import { IconCopy, IconEye, IconEyeOff, IconSearch, IconTrash } from '../components/Icons'

import { Modal } from '../components/Modal'
import { useToast } from '../components/Toast'
import { paramsOf, parseConversation, roleClass } from '../lib/requestBody'
import { fmtLabel } from './preprocessShared'
import { fmtBytes, prettyJson } from '../lib/format'
import { money } from '../lib/money'
import { Loading, StatusPill } from '../components/Primitives'
import type { CallerSource, CompressStatus, LogBodyField, LogItem, PartialLogDetail } from '../types'
import { copyText } from '../lib/clipboard'

const SENSITIVE = /authorization|api[-_]?key|x-api-key|cookie|token|secret|password|proxy-authorization/i

/** owner / null 按内网匿名显示 */
function sourceLabel(s: CallerSource | null): string {
  if (s === 'lan_key') return '内网 Key'
  if (s === 'public_key') return '公网 Key'
  if (s === 'user') return '门户用户'
  if (s === 'probe') return '自动测活'
  return '内网匿名'
}

const COMPRESS_STATUS_TEXT: Record<CompressStatus, string> = {
  compressed: '已压缩', fallback_ok: '压缩被拒，明文重发成功', fallback_failed: '压缩被拒，明文重发仍失败', rejected: '压缩被拒（未开回退）',
  off: '渠道关闭压缩', below_min: '低于阈值', channel_unsupported: '记忆中：渠道不支持', runtime_unsupported: '当前 Node 不支持', compress_error: '压缩出错',
}

/** 上游请求体压缩：zstd-2 w23 · 612.3 KB → 118.4 KB（19.3%）· 3.2ms · 已压缩；只有详情接口返回这些字段 */
function compressionText(d: LogItem): string | null {
  const raw = d.upstream_raw_bytes
  if (raw == null) return null
  if (!d.compress_status) return `上游请求体 ${fmtBytes(raw)}（未启用压缩）`
  const sent = d.upstream_sent_bytes ?? raw
  const parts = d.upstream_encoding ? [d.upstream_encoding] : []
  parts.push(sent !== raw && raw > 0 ? `${fmtBytes(raw)} → ${fmtBytes(sent)}（${((sent / raw) * 100).toFixed(1)}%）` : fmtBytes(raw))
  if (d.compress_ms != null) parts.push(`${d.compress_ms}ms`)
  parts.push(COMPRESS_STATUS_TEXT[d.compress_status] ?? d.compress_status)
  return `上游压缩：${parts.join(' · ')}`
}

function maskValue(v: string): string {
  const s = String(v)
  const m = /^(Bearer\s+)?(.*)$/i.exec(s)
  const prefix = m?.[1] || ''
  const body = m?.[2] || s
  if (body.length <= 8) return prefix + '••••'
  return prefix + body.slice(0, 4) + '••••' + body.slice(-4)
}

// 文本高亮（大小写不敏感）
function Highlighted({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>
  const low = text.toLowerCase()
  const ql = q.toLowerCase()
  const out: any[] = []
  let i = 0
  let idx: number
  let key = 0
  while ((idx = low.indexOf(ql, i)) !== -1) {
    if (idx > i) out.push(text.slice(i, idx))
    out.push(<mark key={key++}>{text.slice(idx, idx + ql.length)}</mark>)
    i = idx + ql.length
  }
  out.push(text.slice(i))
  return <>{out}</>
}

type Tab = 'conv' | 'headers' | 'params' | 'response' | 'raw' | 'thinking'

export function LogDetailModal({
  id,
  onClose,
  onDeleted,
}: {
  id: number
  onClose: () => void
  onDeleted: () => void
}) {
  const toast = useToast()
  const [detail, setDetail] = useState<PartialLogDetail | null>(null)
  const [tab, setTab] = useState<Tab>('conv')
  const [showOriginal, setShowOriginal] = useState(false)
  const [showUpstream, setShowUpstream] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [bodyError, setBodyError] = useState('')
  const [reload, setReload] = useState(0)
  const hasField = (field: LogBodyField) => detail?.available_fields?.includes(field) ?? detail?.[field] != null
  const activeField: LogBodyField = !showOriginal && hasField('preprocessed_body') ? 'preprocessed_body' : 'request_body'
  const wanted: LogBodyField = tab === 'headers' ? 'request_headers'
    : tab === 'thinking' ? 'thinking_inject'
    : tab === 'response' ? showUpstream ? 'upstream_response_body' : 'response_body'
    : activeField
  const bodyPending = !!detail && detail[wanted] === undefined && (detail.available_fields === undefined || hasField(wanted))

  useEffect(() => {
    setTab('conv')
    setShowOriginal(false)
    setShowUpstream(false)
  }, [id])

  useEffect(() => {
    const controller = new AbortController()
    setDetail(null)
    setLoadError('')
    setBodyError('')
    api.getLogFields(id, [], controller.signal)
      .then(value => { if (!controller.signal.aborted) setDetail(value) })
      .catch(e => { if (!controller.signal.aborted) setLoadError(e.message) })
    return () => controller.abort()
  }, [id, reload])

  useEffect(() => {
    setBodyError('')
    if (!bodyPending || detail?.id !== id) return
    const controller = new AbortController()
    api.getLogFields(id, [wanted], controller.signal)
      .then(value => {
        if (!controller.signal.aborted) setDetail(current => current?.id === id ? { ...current, ...value } : current)
      })
      .catch(e => { if (!controller.signal.aborted) setBodyError(e.message) })
    return () => controller.abort()
  }, [id, detail?.id, wanted, bodyPending])

  const copy = async (text: string, label = '已复制') => {
    if (await copyText(text)) toast('ok', label)
    else toast('err', '复制失败，请选择显示的内容手动复制')
  }

  const del = async () => {
    if (!window.confirm('确认删除这条日志？')) return
    try {
      await api.deleteLog(id)
      toast('ok', '已删除')
      onDeleted()
    } catch (e: any) {
      toast('err', e.message)
    }
  }

  const activeBody = detail?.[activeField] ?? null
  const retry = <Button variant="soft" size="sm" onClick={() => setReload(value => value + 1)}>重试加载</Button>

  const TABS: { k: Tab; label: string }[] = [
    { k: 'conv', label: '对话' },
    { k: 'headers', label: '请求头' },
    { k: 'params', label: '参数' },
    { k: 'response', label: '响应' },
    { k: 'raw', label: '原始' },
  ]

  return (
    <Modal
      title="请求详情"
      size="xl"
      onClose={onClose}
      footer={
        <>
          <Button variant="danger" size="sm" icon={<IconTrash size={16} />} onClick={del}>
            删除
          </Button>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
        </>
      }
    >
      {!detail ? (
        loadError ? <div role="alert">{loadError} {retry}</div> : <Loading />
      ) : (
        <>
          <LogMeta detail={detail} />
          {detail.request_id && <div className="ah-mini ah-muted">请求 ID：{detail.request_id} · 总耗时 {detail.latency_ms ?? 0}ms{detail.first_token_ms != null && ` · 首字 ${detail.first_token_ms}ms`} · 最后尝试 {detail.attempt_latency_ms ?? '—'}ms</div>}
          {!!(detail.response_body_truncated || detail.upstream_response_body_truncated) && <div role="note" className="ah-detail-empty">日志正文已截断，仅保存前缀；复制得到的也只有已保存内容。实际业务输出不受日志上限影响。</div>}
          {detail.preprocessed_body?.includes('"contents"') && !showOriginal && <div className="ah-mini ah-muted">当前为 Gemini 上游请求体，请在「原始」标签查看 contents；切换原始请求可查看客户端对话。</div>}
          {(hasField('preprocessed_body') || !!detail.client_error) && (
            <div className="ah-pp-viewbar">
              <span className={`ah-pp-viewflag${showOriginal ? '' : ' is-pp'}`}>
                {showOriginal ? '当前：原始请求' : '当前：后处理改写后'}
              </span>
              <span style={{ flex: 1 }} />
              <Button variant="soft" size="sm" onClick={() => {
                setShowOriginal((v) => !v)
                // 只有报错被脱敏改写时，差异只体现在响应页的错误信息上
                if (!hasField('preprocessed_body')) setTab('response')
              }}>
                {showOriginal ? '显示改写后请求' : '显示原始请求'}
              </Button>
            </div>
          )}
          <div className="ah-detail-tabs">
            {TABS.map((t) => (
              <button key={t.k} className={`ah-detail-tab${tab === t.k ? ' is-active' : ''}`} onClick={() => setTab(t.k)}>
                {t.label}
              </button>
            ))}
            {hasField('thinking_inject') && (
              <button className={`ah-detail-tab${tab === 'thinking' ? ' is-active' : ''}`} onClick={() => setTab('thinking')}>
                思考块
              </button>
            )}
          </div>
          {tab === 'response' ? <ResponseView detail={detail} error={!showOriginal && detail.client_error ? detail.client_error : detail.error_message}
            showUpstream={showUpstream} onToggle={() => setShowUpstream((v) => !v)} onCopy={copy}
            bodyStatus={bodyError ? <div role="alert">{bodyError} {retry}</div> : bodyPending ? <Loading /> : undefined} />
            : bodyError ? <div role="alert">{bodyError} {retry}</div> : bodyPending ? <Loading /> : <>
              {tab === 'conv' && <ConvView body={activeBody} />}
              {tab === 'headers' && <HeadersView detail={detail} onCopy={copy} />}
              {tab === 'params' && <JsonView text={JSON.stringify(paramsOf(activeBody) ?? {}, null, 2)} onCopy={copy} empty="（无额外参数）" />}
              {tab === 'raw' && <JsonView text={prettyJson(activeBody)} onCopy={copy} empty="（未存储请求正文）" />}
              {tab === 'thinking' && <ThinkingInjectView detail={detail} />}
            </>}
        </>
      )}
    </Modal>
  )
}

function LogMeta({ detail }: { detail: LogItem }) {
  const d = new Date(detail.created_at)
  const time = d.toLocaleString('zh-CN', { hour12: false })
  const compression = compressionText(detail)
  return (
    <div className="ah-detail-meta">
      <StatusPill log={detail} />
      <span className="ah-detail-meta-model">{detail.model || '-'}</span>
      {detail.upstream_model && detail.upstream_model !== detail.model && (
        <span className="ah-mini ah-faint">→ {detail.upstream_model}</span>
      )}
      <span className={`ah-fmt-badge ${detail.entry_format}`}>{fmtLabel(detail.entry_format)}</span>
      {detail.is_stream ? <span className="ah-tag">stream</span> : null}
      <span className="sp" style={{ flex: 1 }} />
      <span className="ah-mini ah-muted">{detail.channel_name || '—'}</span>
      {detail.channel_key && <span className="ah-mini ah-muted ah-num" title="多 key 渠道本次使用的上游 key">上游 key：{detail.channel_key}</span>}
      <span className="ah-mini ah-muted">来源：{sourceLabel(detail.source)}</span>
      {detail.user_id != null && <span className="ah-mini ah-muted ah-truncate">用户：{detail.user_name ?? `#${detail.user_id}（已删除）`}</span>}
      {detail.user_discord_name && <span className="ah-mini ah-muted ah-truncate">Discord：{detail.user_discord_name}</span>}
      {detail.key_name && <span className="ah-mini ah-muted ah-truncate">Key：{detail.key_name}</span>}
      {detail.group_name && <span className="ah-mini ah-muted ah-truncate">分组：{detail.group_name}</span>}
      {detail.client_ip && <span className="ah-mini ah-muted ah-num">IP：{detail.client_ip}</span>}
      {detail.quota_points != null && <span className="ah-mini ah-muted ah-num">{money(detail.quota_points)}</span>}
      <span className="ah-mini ah-muted ah-num" title="输入 + 输出（缓存读取 + 缓存写入）；输入已含缓存读写部分">
        {detail.prompt_tokens || 0}+{detail.completion_tokens || 0}（{detail.cache_read_tokens || 0}+{detail.cache_write_tokens || 0}）token
      </span>
      <span className="ah-mini ah-muted ah-num">{detail.latency_ms ?? 0}ms</span>
      {detail.first_token_ms != null && <span className="ah-mini ah-muted ah-num" title="首字延迟：从网关收到请求到开始向客户端输出首个内容（含思考）">首字 {detail.first_token_ms}ms</span>}
      <span className="ah-mini ah-faint ah-num">{time}</span>
      {compression && <span className="ah-mini ah-muted ah-num" style={{ flexBasis: '100%' }}>{compression}</span>}
      {detail.compress_note && (
        <span className="ah-mini ah-faint ah-truncate" style={{ flexBasis: '100%' }} title={detail.compress_note}>
          压缩备注：{detail.compress_note}
        </span>
      )}
    </div>
  )
}

// ── 对话块可视化（折叠 + 搜索） ──────────────────────────
function ConvView({ body }: { body: string | null }) {
  const blocks = useMemo(() => parseConversation(body), [body])
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())
  const [q, setQ] = useState('')
  const [cur, setCur] = useState(0)
  const rowRefs = useRef<(HTMLDivElement | null)[]>([])

  const matches = useMemo(() => {
    if (!q.trim()) return [] as number[]
    const ql = q.toLowerCase()
    return blocks.map((b, i) => (b.text.toLowerCase().includes(ql) ? i : -1)).filter((i) => i >= 0)
  }, [q, blocks])

  useEffect(() => {
    if (!matches.length) return
    setExpanded((prev) => {
      const next = new Set(prev)
      matches.forEach((i) => next.add(i))
      return next
    })
    setCur(0)
  }, [matches])

  const jump = (k: number) => {
    if (!matches.length) return
    const nk = ((k % matches.length) + matches.length) % matches.length
    setCur(nk)
    const el = rowRefs.current[matches[nk]]
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  const toggle = (i: number) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(i) ? next.delete(i) : next.add(i)
      return next
    })

  const allExpanded = expanded.size === blocks.length && blocks.length > 0

  if (!body) return <div className="ah-detail-empty">（未存储请求正文，无法解析对话）</div>
  if (!blocks.length) return <div className="ah-detail-empty">（无对话内容）</div>

  const matchSet = new Set(matches)

  return (
    <div className="ah-conv">
      <div className="ah-conv-bar">
        <div className="ah-log-search ah-conv-search">
          <IconSearch size={15} className="ah-log-search-icon" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="在对话内搜索…"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                jump(cur + (e.shiftKey ? -1 : 1))
              } else if (e.key === 'Escape') {
                setQ('')
              }
            }}
          />
        </div>
        {q && (
          <div className="ah-conv-nav">
            <span className="ah-mini ah-muted ah-num">{matches.length ? `${cur + 1}/${matches.length}` : '无匹配'}</span>
            <IconButton title="上一个" onClick={() => jump(cur - 1)}>
              ▲
            </IconButton>
            <IconButton title="下一个" onClick={() => jump(cur + 1)}>
              ▼
            </IconButton>
          </div>
        )}
        <span style={{ flex: 1 }} />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded(allExpanded ? new Set() : new Set(blocks.map((_, i) => i)))}
        >
          {allExpanded ? '全部折叠' : '全部展开'}
        </Button>
      </div>

      <div className="ah-conv-list">
        {blocks.map((b, i) => {
          const open = expanded.has(i)
          const isCur = matches[cur] === i
          return (
            <div
              key={i}
              ref={(el) => {
                rowRefs.current[i] = el
              }}
              className={`ah-blk role-${roleClass(b.role)}${matchSet.has(i) ? ' hit' : ''}${isCur ? ' cur' : ''}`}
            >
              <div className="ah-blk-head" onClick={() => toggle(i)}>
                <span className="ah-blk-role">{b.role.toUpperCase()}</span>
                {!open && <span className="ah-blk-preview">{b.text.replace(/\s+/g, ' ').trim() || '(空)'}</span>}
                <span className="ah-blk-chars ah-mini ah-num">{b.chars.toLocaleString()} 字</span>
              </div>
              {open && (
                <div className="ah-blk-body">
                  <Highlighted text={b.text} q={q} />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── 请求头（UA 突出 + 表格 + 敏感字段脱敏） ────────────────
function HeadersView({ detail, onCopy }: { detail: PartialLogDetail; onCopy: (t: string, l?: string) => void }) {
  const [showFull, setShowFull] = useState(false)
  const headers = useMemo<Record<string, string>>(() => {
    if (!detail.request_headers) return {}
    try {
      const h = JSON.parse(detail.request_headers)
      return h && typeof h === 'object' ? h : {}
    } catch {
      return {}
    }
  }, [detail.request_headers])

  const keys = Object.keys(headers)
  if (!detail.request_headers || !keys.length) return <div className="ah-detail-empty">（未存储请求头）</div>

  const ua = headers['user-agent'] || headers['User-Agent'] || '(无)'
  const hasSensitive = keys.some((k) => SENSITIVE.test(k))

  return (
    <div className="ah-headers">
      <div className="ah-detail-sec">
        <span className="ah-detail-sec-label">User-Agent</span>
      </div>
      <div className="ah-ua">{ua}</div>

      <div className="ah-detail-sec">
        <span className="ah-detail-sec-label">请求头（{keys.length} 项）</span>
        <span style={{ flex: 1 }} />
        {hasSensitive && (
          <Button
            variant="ghost"
            size="sm"
            icon={showFull ? <IconEyeOff size={15} /> : <IconEye size={15} />}
            onClick={() => setShowFull((v) => !v)}
          >
            {showFull ? '隐藏凭证' : '显示完整'}
          </Button>
        )}
      </div>
      <table className="ah-htable">
        <tbody>
          {keys.map((k) => {
            const sensitive = SENSITIVE.test(k)
            const raw = String(headers[k])
            const shown = sensitive && !showFull ? maskValue(raw) : raw
            return (
              <tr key={k}>
                <td className="k">{k}</td>
                <td className={sensitive ? 'sensitive' : ''}>
                  {shown}
                  {sensitive && (
                    <button className="ah-copy-inline" title="复制原值" onClick={() => onCopy(raw, '已复制原值')}>
                      <IconCopy size={13} />
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── 响应（返回客户端的响应 ⇄ 上游原始回复） ──────────────
function ResponseView({
  detail,
  error,
  showUpstream,
  onToggle,
  onCopy,
  bodyStatus,
}: {
  detail: PartialLogDetail
  /** 网关响应上方显示的错误信息：改写后或上游原文 */
  error: string | null
  showUpstream: boolean
  onToggle: () => void
  onCopy: (t: string, l?: string) => void
  bodyStatus?: ReactNode
}) {
  const hasUpstream = detail.available_fields?.includes('upstream_response_body') ?? !!detail.upstream_response_body
  const upstream = hasUpstream && showUpstream
  // 上游原始回复：非流式 JSON 做格式化；流式 SSE 帧 / 非 JSON 错误体原样展示
  const text = prettyJson((upstream ? detail.upstream_response_body : detail.response_body) ?? null)
  const empty = upstream
    ? '（未存储上游原始回复）'
    : hasUpstream
      ? '（网关未向客户端返回正文，可切换查看上游原始回复）'
      : '（未存储响应正文）'
  return (
    <>
      <div className="ah-pp-viewbar" style={{ marginTop: 0 }}>
        <span className={`ah-pp-viewflag${upstream ? ' is-pp' : ''}`}>
          {upstream ? `当前：上游原始回复${detail.is_stream ? '（SSE 原文）' : ''}` : '当前：返回客户端的响应'}
        </span>
        <span style={{ flex: 1 }} />
        <Button variant="soft" size="sm" onClick={onToggle} disabled={!hasUpstream} title={hasUpstream ? undefined : '这条日志没有存储上游原始回复'}>
          {upstream ? '显示网关响应' : '显示上游原始回复'}
        </Button>
      </div>
      {bodyStatus ?? <JsonView text={text} onCopy={onCopy} empty={empty} error={upstream ? null : error} />}
    </>
  )
}

// ── 通用 JSON / 文本查看 ──────────────────────────────────
function JsonView({
  text,
  onCopy,
  empty,
  error,
}: {
  text: string
  onCopy: (t: string, l?: string) => void
  empty: string
  error?: string | null
}) {
  return (
    <div className="ah-jsonview">
      {error && <div className="ah-code ah-code-err">{error}</div>}
      {text ? (
        <>
          <div className="ah-jsonview-bar">
            <span className="ah-mini ah-faint ah-num">{text.length.toLocaleString()} 字符</span>
            <span style={{ flex: 1 }} />
            <Button variant="ghost" size="sm" icon={<IconCopy size={15} />} onClick={() => onCopy(text)}>
              复制
            </Button>
          </div>
          <pre className="ah-code ah-code-block">{text}</pre>
        </>
      ) : (
        !error && <div className="ah-detail-empty">{empty}</div>
      )}
    </div>
  )
}

function ThinkingInjectView({ detail }: { detail: PartialLogDetail }) {
  const entries = useMemo(() => {
    if (!detail.thinking_inject) return []
    try {
      const arr = JSON.parse(detail.thinking_inject)
      return Array.isArray(arr) ? (arr as { messageIndex: number; thinking: string }[]) : []
    } catch {
      return []
    }
  }, [detail.thinking_inject])

  if (!entries.length) return <div className="ah-detail-empty">（本次请求未注入历史思维链）</div>

  return (
    <div className="ah-conv-list">
      {entries.map((e, i) => (
        <div key={i} className="ah-blk role-assistant">
          <div className="ah-blk-head">
            <span className="ah-blk-role">注入到第 {e.messageIndex + 1} 条 ASSISTANT</span>
            <span className="ah-blk-chars ah-mini ah-num">{e.thinking.length.toLocaleString()} 字</span>
          </div>
          <div className="ah-blk-body" style={{ whiteSpace: 'pre-wrap' }}>{e.thinking}</div>
        </div>
      ))}
    </div>
  )
}
