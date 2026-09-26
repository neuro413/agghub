import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api/client'
import { Button, IconButton } from '../components/Button'
import { Input } from '../components/Form'
import { IconCopy, IconEye, IconEyeOff, IconSearch, IconTrash } from '../components/Icons'

import { Modal } from '../components/Modal'
import { useToast } from '../components/Toast'
import { paramsOf, parseConversation, roleClass } from '../lib/requestBody'
import { fmtLabel } from './preprocessShared'
import type { LogDetail } from '../types'
import { copyText } from '../lib/clipboard'

const SENSITIVE = /authorization|api[-_]?key|x-api-key|cookie|token|secret|password|proxy-authorization/i

function maskValue(v: string): string {
  const s = String(v)
  const m = /^(Bearer\s+)?(.*)$/i.exec(s)
  const prefix = m?.[1] || ''
  const body = m?.[2] || s
  if (body.length <= 8) return prefix + '••••'
  return prefix + body.slice(0, 4) + '••••' + body.slice(-4)
}

function pretty(s: string | null): string {
  if (!s) return ''
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
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
  const [detail, setDetail] = useState<LogDetail | null>(null)
  const [tab, setTab] = useState<Tab>('conv')
  const [showOriginal, setShowOriginal] = useState(false)
  const [showUpstream, setShowUpstream] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setDetail(null)
    api.getLog(id, controller.signal).then(value => { if (!controller.signal.aborted) setDetail(value) }).catch(e => { if (!controller.signal.aborted) toast('err', e.message) })
    return () => controller.abort()
  }, [id, toast])

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

  const activeBody =
    detail && detail.preprocessed_body && !showOriginal ? detail.preprocessed_body : (detail?.request_body ?? null)

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
        <div className="ah-logt-empty">
          <span className="ah-spin ah-spin-orange" /> 加载中…
        </div>
      ) : (
        <>
          <LogMeta detail={detail} />
          {detail.request_id && <div className="ah-mini ah-muted">请求 ID：{detail.request_id} · 总耗时 {detail.latency_ms ?? 0}ms · 最后尝试 {detail.attempt_latency_ms ?? '—'}ms</div>}
          {!!(detail.response_body_truncated || detail.upstream_response_body_truncated) && <div role="note" className="ah-detail-empty">日志正文已截断，仅保存前缀；复制得到的也只有已保存内容。实际业务输出不受日志上限影响。</div>}
          {detail.preprocessed_body?.includes('"contents"') && !showOriginal && <div className="ah-mini ah-muted">当前为 Gemini 上游请求体，请在「原始」标签查看 contents；切换原始请求可查看客户端对话。</div>}
          {detail.preprocessed_body && (
            <div className="ah-pp-viewbar">
              <span className={`ah-pp-viewflag${showOriginal ? '' : ' is-pp'}`}>
                {showOriginal ? '当前：原始请求' : '当前：后处理改写后'}
              </span>
              <span style={{ flex: 1 }} />
              <Button variant="soft" size="sm" onClick={() => setShowOriginal((v) => !v)}>
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
            {detail.thinking_inject && (
              <button className={`ah-detail-tab${tab === 'thinking' ? ' is-active' : ''}`} onClick={() => setTab('thinking')}>
                思考块
              </button>
            )}
          </div>
          {tab === 'conv' && <ConvView body={activeBody} />}
          {tab === 'headers' && <HeadersView detail={detail} onCopy={copy} />}
          {tab === 'params' && <JsonView text={JSON.stringify(paramsOf(activeBody) ?? {}, null, 2)} onCopy={copy} empty="（无额外参数）" />}
          {tab === 'response' && <ResponseView detail={detail} showUpstream={showUpstream} onToggle={() => setShowUpstream((v) => !v)} onCopy={copy} />}
          {tab === 'raw' && <JsonView text={pretty(activeBody)} onCopy={copy} empty="（未存储请求正文）" />}
          {tab === 'thinking' && detail && <ThinkingInjectView detail={detail} />}
        </>
      )}
    </Modal>
  )
}

function LogMeta({ detail }: { detail: LogDetail }) {
  const d = new Date(detail.created_at)
  const time = d.toLocaleString('zh-CN', { hour12: false })
  return (
    <div className="ah-detail-meta">
      <span className={`ah-log-pill ${detail.status === 'success' ? 'ok' : 'err'}`}>
        {detail.status === 'success' ? detail.status_code || 200 : detail.status_code || 'ERR'}
      </span>
      <span className="ah-detail-meta-model">{detail.model || '-'}</span>
      {detail.upstream_model && detail.upstream_model !== detail.model && (
        <span className="ah-mini ah-faint">→ {detail.upstream_model}</span>
      )}
      <span className={`ah-fmt-badge ${detail.entry_format}`}>{fmtLabel(detail.entry_format)}</span>
      {detail.is_stream ? <span className="ah-tag">stream</span> : null}
      <span className="sp" style={{ flex: 1 }} />
      <span className="ah-mini ah-muted">{detail.channel_name || '—'}</span>
      <span className="ah-mini ah-muted ah-num" title="输入 + 输出（缓存读取 + 缓存写入）；输入已含缓存读写部分">
        {detail.prompt_tokens || 0}+{detail.completion_tokens || 0}（{detail.cache_read_tokens || 0}+{detail.cache_write_tokens || 0}）token
      </span>
      <span className="ah-mini ah-muted ah-num">{detail.latency_ms ?? 0}ms</span>
      <span className="ah-mini ah-faint ah-num">{time}</span>
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
function HeadersView({ detail, onCopy }: { detail: LogDetail; onCopy: (t: string, l?: string) => void }) {
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
  showUpstream,
  onToggle,
  onCopy,
}: {
  detail: LogDetail
  showUpstream: boolean
  onToggle: () => void
  onCopy: (t: string, l?: string) => void
}) {
  const hasUpstream = typeof detail.upstream_response_body === 'string' && detail.upstream_response_body.length > 0
  const upstream = hasUpstream && showUpstream
  // 上游原始回复：非流式 JSON 做格式化；流式 SSE 帧 / 非 JSON 错误体原样展示
  const text = upstream ? pretty(detail.upstream_response_body ?? null) : pretty(detail.response_body)
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
      <JsonView text={text} onCopy={onCopy} empty={empty} error={upstream ? null : detail.error_message} />
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

function ThinkingInjectView({ detail }: { detail: LogDetail }) {
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
