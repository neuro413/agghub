import { Fragment, useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import { IconButton } from '../components/Button'
import { Card } from '../components/Card'
import { Input } from '../components/Form'
import { IconChevron, IconChevronLeft, IconChevronRight, IconCopy, IconRefresh, IconSearch, IconTrash, IconUsers } from '../components/Icons'
import { Loading } from '../components/Primitives'
import { useToast } from '../components/Toast'
import { Toggle } from '../components/Toggle'
import { copyText } from '../lib/clipboard'
import { fmtNum, fmtTime } from '../lib/format'
import type { ApiKeyView, UserListResult, UserView } from '../types'

const PAGE_SIZE = 20

/** 点数 → $，按门户的换算比例 */
function usd(points: number, perUsd: number): string {
  const v = points / perUsd
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(Math.abs(v) >= 1 ? 2 : 4)}`
}

function maskKey(key: string): string {
  return key.length <= 14 ? key : `${key.slice(0, 11)}…${key.slice(-4)}`
}

/** 展开行：该用户自建的 Key，可停用或删除 */
function UserKeys({ userId, onChanged }: { userId: number; onChanged: () => void }) {
  const toast = useToast()
  const [keys, setKeys] = useState<ApiKeyView[] | null>(null)
  const load = useCallback(async () => {
    try {
      setKeys(await api.listUserKeys(userId))
    } catch (e: any) {
      toast('err', e.message)
    }
  }, [userId, toast])
  useEffect(() => { load() }, [load])

  const toggle = async (k: ApiKeyView) => {
    try {
      await api.updateKey(k.id, { enabled: !k.enabled })
      load()
    } catch (e: any) {
      toast('err', e.message)
    }
  }
  const del = async (k: ApiKeyView) => {
    if (!window.confirm(`确认删除该用户的 Key「${k.name}」？`)) return
    try {
      await api.deleteKey(k.id)
      toast('ok', 'Key 已删除')
      load()
      onChanged()
    } catch (e: any) {
      toast('err', e.message)
    }
  }
  const copy = async (k: ApiKeyView) => {
    if (await copyText(k.key)) toast('ok', 'Key 已复制')
    else toast('err', '复制失败，请手动复制')
  }

  if (!keys) return <div className="ah-user-keys ah-mini ah-muted">读取中…</div>
  if (!keys.length) return <div className="ah-user-keys ah-mini ah-muted">该用户还没有创建 Key</div>
  return (
    <div className="ah-user-keys">
      {keys.map(k => {
        const expired = k.expires_at != null && k.expires_at <= Date.now()
        return (
          <div key={k.id} className="ah-user-key">
            <span className="ah-truncate" style={{ fontWeight: 700 }}>{k.name}</span>
            <code className="ah-key-secret-val">{maskKey(k.key)}</code>
            <IconButton title="复制完整 Key" onClick={() => copy(k)}><IconCopy size={15} /></IconButton>
            <span className="ah-mini ah-muted ah-num">已用 {fmtNum(k.quota_used)} 点</span>
            <span className="ah-mini ah-faint">{k.last_used_at ? `最近 ${fmtTime(k.last_used_at)}` : '从未使用'}</span>
            {expired && <span className="ah-tag ah-tag-warn">已过期</span>}
            <span className="sp" style={{ flex: 1 }} />
            <Toggle checked={k.enabled} onChange={() => toggle(k)} />
            <IconButton title="删除" danger onClick={() => del(k)}><IconTrash size={15} /></IconButton>
          </div>
        )
      })}
    </div>
  )
}

export function UsersPage() {
  const toast = useToast()
  const [qInput, setQInput] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<UserListResult | null>(null)
  const [perUsd, setPerUsd] = useState(500000)
  const [openId, setOpenId] = useState<number | null>(null)
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    api.getSettings().then(s => setPerUsd(s.portal_points_per_usd), () => {})
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => { setQ(qInput.trim()); setPage(1) }, 300)
    return () => window.clearTimeout(timer)
  }, [qInput])

  useEffect(() => {
    const controller = new AbortController()
    api.listUsers({ q, page, size: PAGE_SIZE }, controller.signal).then(
      result => setData(result),
      (e: any) => { if (!controller.signal.aborted) toast('err', e.message) },
    )
    return () => controller.abort()
  }, [q, page, refresh, toast])

  const reload = () => setRefresh(v => v + 1)
  const patch = (user: UserView) => setData(d => d && { ...d, items: d.items.map(u => (u.id === user.id ? user : u)) })

  const toggleStatus = async (u: UserView) => {
    try {
      patch(await api.setUserStatus(u.id, u.status === 1 ? 2 : 1))
    } catch (e: any) {
      toast('err', e.message)
    }
  }

  const adjust = async (u: UserView) => {
    const raw = window.prompt(`给「${u.username}」增加多少点余额？（负数为扣减；每 $1 = ${fmtNum(perUsd)} 点）`)
    if (raw == null) return
    const delta = Number(raw.trim())
    if (!raw.trim() || !Number.isSafeInteger(delta) || delta === 0) return toast('err', '请输入非零整数')
    try {
      patch(await api.adjustUserQuota(u.id, delta))
      toast('ok', '余额已更新')
    } catch (e: any) {
      toast('err', e.message)
    }
  }

  const resetPassword = async (u: UserView) => {
    const password = window.prompt(`为「${u.username}」设置新密码（8～128 个字符），该用户的所有登录会失效`)
    if (password == null) return
    try {
      await api.resetUserPassword(u.id, password)
      toast('ok', '密码已重置')
    } catch (e: any) {
      toast('err', e.message)
    }
  }

  const del = async (u: UserView) => {
    if (!window.confirm(`确认删除用户「${u.username}」？其 Key、签到记录会一并删除，调用日志保留。`)) return
    try {
      await api.deleteUser(u.id)
      toast('ok', '用户已删除')
      reload()
    } catch (e: any) {
      toast('err', e.message)
    }
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1

  return (
    <div className="ah-fade-up">
      <div className="ah-page-head">
        <div>
          <div className="ah-page-title">用户</div>
          <div className="ah-page-sub">公网门户注册的用户 · 余额 · 停用 · 自建 Key</div>
        </div>
        <div className="ah-row">
          <div className="ah-user-search">
            <IconSearch size={16} />
            <Input value={qInput} onChange={e => setQInput(e.target.value)} placeholder="搜索用户名" />
          </div>
          <IconButton title="刷新" onClick={reload}><IconRefresh size={18} /></IconButton>
        </div>
      </div>

      <Card className="ah-logs-table-card">
        <div className="ah-logt-head">
          <span className="u-name">用户名</span>
          <span className="u-num">余额</span>
          <span className="u-num">已用</span>
          <span className="u-num u-sm">请求</span>
          <span className="u-num u-sm">Key</span>
          <span className="u-time">注册</span>
          <span className="u-time">最近登录</span>
          <span className="u-act" />
        </div>
        {!data ? (
          <Loading />
        ) : data.items.length === 0 ? (
          <div className="ah-logt-empty">
            <IconUsers size={30} style={{ opacity: 0.4, display: 'block', margin: '0 auto 10px' }} />
            {q ? '没有匹配的用户' : '还没有用户注册'}
          </div>
        ) : (
          data.items.map(u => (
            <Fragment key={u.id}>
              <div className="ah-logt-row ah-user-row" onClick={() => setOpenId(id => (id === u.id ? null : u.id))}>
                <span className="u-name">
                  <IconChevron size={14} className={`ah-user-chev${openId === u.id ? ' is-open' : ''}`} />
                  <span className="ah-truncate" style={{ fontWeight: 700 }}>{u.username}</span>
                  {u.status !== 1 && <span className="ah-tag ah-tag-warn">已停用</span>}
                </span>
                <span className={`u-num ah-num${u.quota <= 0 ? ' is-neg' : ''}`} title={usd(u.quota, perUsd)}>{fmtNum(u.quota)}</span>
                <span className="u-num ah-num ah-muted" title={usd(u.used_quota, perUsd)}>{fmtNum(u.used_quota)}</span>
                <span className="u-num u-sm ah-num ah-muted">{fmtNum(u.request_count)}</span>
                <span className="u-num u-sm ah-num ah-muted">{u.key_count}</span>
                <span className="u-time ah-mini ah-faint ah-num" title={u.register_ip ? `IP：${u.register_ip}` : undefined}>{fmtTime(u.created_at)}</span>
                <span className="u-time ah-mini ah-faint ah-num" title={u.last_login_ip ? `IP：${u.last_login_ip}` : undefined}>{u.last_login_at ? fmtTime(u.last_login_at) : '—'}</span>
                <span className="u-act" onClick={e => e.stopPropagation()}>
                  <Toggle checked={u.status === 1} onChange={() => toggleStatus(u)} />
                  <button type="button" className="ah-btn is-ghost is-sm" onClick={() => adjust(u)}>调余额</button>
                  <button type="button" className="ah-btn is-ghost is-sm" onClick={() => resetPassword(u)}>重置密码</button>
                  <IconButton title="删除" danger onClick={() => del(u)}><IconTrash size={16} /></IconButton>
                </span>
              </div>
              {openId === u.id && <UserKeys userId={u.id} onChanged={reload} />}
            </Fragment>
          ))
        )}
        {data && data.total > PAGE_SIZE && (
          <div className="ah-logt-pager">
            <IconButton title="上一页" onClick={() => setPage(p => Math.max(1, p - 1))}><IconChevronLeft size={18} /></IconButton>
            <span className="ah-mini ah-muted ah-num">{page} / {pages}</span>
            <IconButton title="下一页" onClick={() => setPage(p => Math.min(pages, p + 1))}><IconChevronRight size={18} /></IconButton>
          </div>
        )}
      </Card>
      <div className="ah-mini ah-faint" style={{ marginTop: 10 }}>余额与已用均为点数，悬停可看折合金额；余额可能因最后一次请求透支为负。</div>
    </div>
  )
}
