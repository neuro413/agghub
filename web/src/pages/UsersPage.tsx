import { Fragment, useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import { Button, IconButton } from '../components/Button'
import { Card } from '../components/Card'
import { Input } from '../components/Form'
import { IconChevron, IconChevronLeft, IconChevronRight, IconCopy, IconDiscord, IconRefresh, IconSearch, IconTrash, IconUsers } from '../components/Icons'
import { Modal } from '../components/Modal'
import { GuildIcon, Loading } from '../components/Primitives'
import { useToast } from '../components/Toast'
import { Toggle } from '../components/Toggle'
import { copyText } from '../lib/clipboard'
import { fmtNum, fmtTime } from '../lib/format'
import { currencySymbol, money, toPoints } from '../lib/money'
import type { ApiKeyView, ChannelGroupView, DiscordGuild, UserListResult, UserView } from '../types'
import { MultiChips } from './preprocessShared'
import { PageHead } from '../components/PageHead'

const PAGE_SIZE = 20

function maskKey(key: string): string {
  return key.length <= 14 ? key : `${key.slice(0, 11)}…${key.slice(-4)}`
}

/** 分配 / 移除用户的专属分组；公开分组所有用户默认可用，不在这里勾选 */
function UserGroupsModal({ user, groups, onClose, onSaved }: { user: UserView; groups: ChannelGroupView[]; onClose: () => void; onSaved: (u: UserView) => void }) {
  const toast = useToast()
  const [selected, setSelected] = useState(user.groups)
  const [saving, setSaving] = useState(false)
  const publicGroups = groups.filter(g => g.is_public)
  const options = groups.filter(g => !g.is_public).map(g => ({ value: g.name, label: g.ratio === 1 ? g.name : `${g.name} ×${g.ratio}` }))
  const save = async () => {
    setSaving(true)
    try {
      onSaved(await api.setUserGroups(user.id, selected))
      toast('ok', '分组已更新')
      onClose()
    } catch (e: any) {
      toast('err', e.message)
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      title={`「${user.username}」的分组`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" loading={saving} onClick={save}>保存</Button>
        </>
      }
    >
      <div className="ah-field">
        <label className="ah-flabel">专属分组</label>
        <MultiChips options={options} selected={selected} onChange={setSelected} empty="没有需要分配的分组（非公开分组在「分组」页创建）" />
        <div className="ah-hint">勾选即分配，取消勾选即移除；移除后该用户使用这个分组的 Key 将无法调用，直到改选其他分组</div>
      </div>
      <div className="ah-field">
        <label className="ah-flabel">公开分组</label>
        <div className="ah-pp-chips">
          {publicGroups.map(g => <span key={g.name} className="ah-tag ah-tag-pub">{g.name}</span>)}
          {!publicGroups.length && <span className="ah-mini ah-faint">无</span>}
        </div>
        <div className="ah-hint">所有用户默认可用，无须分配</div>
      </div>
    </Modal>
  )
}

/** 展开行：该用户自建的 Key，可停用或删除；usable 为该用户当前可用的分组 */
function UserKeys({ userId, usable, onChanged }: { userId: number; usable: string[]; onChanged: () => void }) {
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
            <span className="ah-truncate ah-strong">{k.name}</span>
            {k.groups[0] && usable.includes(k.groups[0])
              ? <span className="ah-tag">{k.groups[0]}</span>
              : <span className="ah-tag ah-tag-warn" title="分组已删除或不再对该用户可用，这个 Key 无法调用">{k.groups[0] ? `${k.groups[0]}（不可用）` : '无分组'}</span>}
            <code className="ah-key-secret-val">{maskKey(k.key)}</code>
            <IconButton title="复制完整 Key" onClick={() => copy(k)}><IconCopy size={15} /></IconButton>
            <span className="ah-mini ah-muted ah-num">已用 {money(k.quota_used)}</span>
            <span className="ah-mini ah-faint">{k.last_used_at ? `最近 ${fmtTime(k.last_used_at)}` : '从未使用'}</span>
            {expired && <span className="ah-tag ah-tag-warn">已过期</span>}
            <span className="sp" />
            <Toggle checked={k.enabled} onChange={() => toggle(k)} />
            <IconButton title="删除" danger onClick={() => del(k)}><IconTrash size={15} /></IconButton>
          </div>
        )
      })}
    </div>
  )
}

/** 展开行：用户最近一次 Discord 登录时所在的服务器；onSearch 搜索同在某个服务器的用户 */
function UserGuilds({ userId, recordedAt, onSearch }: { userId: number; recordedAt: number | null; onSearch: (guildId: string) => void }) {
  const toast = useToast()
  const [guilds, setGuilds] = useState<DiscordGuild[] | null>(null)
  useEffect(() => {
    if (recordedAt == null) return
    const controller = new AbortController()
    api.listUserDiscordGuilds(userId, controller.signal).then(
      setGuilds,
      (e: any) => { if (!controller.signal.aborted) toast('err', e.message) },
    )
    return () => controller.abort()
  }, [userId, recordedAt, toast])

  if (recordedAt == null) return <div className="ah-user-guilds ah-mini ah-muted">还没有记录 Discord 服务器，该用户下次用 Discord 登录时记录</div>
  if (!guilds) return <div className="ah-user-guilds ah-mini ah-muted">读取中…</div>
  return (
    <div className="ah-user-guilds">
      <div className="ah-user-guilds-head ah-mini ah-muted">
        <IconDiscord size={13} />
        <span>所在服务器 {guilds.length} 个 · 记录于 {fmtTime(recordedAt)}</span>
      </div>
      {!guilds.length ? (
        <div className="ah-mini ah-faint">没有加入任何服务器</div>
      ) : (
        <div className="ah-guild-list">
          {guilds.map(g => (
            <div key={g.id} className="ah-guild">
              <GuildIcon guild={g} />
              <span className="ah-truncate" title={`${g.name}\n服务器 ID：${g.id}`}>{g.name}</span>
              {g.owner && <span className="ah-tag">服主</span>}
              <span className="sp" />
              {g.member_count != null && <span className="ah-mini ah-faint ah-num">{fmtNum(g.member_count)} 人</span>}
              <button type="button" className="ah-guild-search" title="搜索同在这个服务器的用户" onClick={() => onSearch(g.id)}>
                <IconSearch size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** initialQuery：从其他页面跳过来时预填的搜索词 */
export function UsersPage({ initialQuery = '' }: { initialQuery?: string }) {
  const toast = useToast()
  const [qInput, setQInput] = useState(initialQuery)
  const [q, setQ] = useState(initialQuery)
  const [page, setPage] = useState(1)
  const [data, setData] = useState<UserListResult | null>(null)
  const [openId, setOpenId] = useState<number | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [groups, setGroups] = useState<ChannelGroupView[]>([])
  const [groupUser, setGroupUser] = useState<UserView | null>(null)

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

  useEffect(() => {
    const controller = new AbortController()
    api.listGroups(controller.signal).then(setGroups, () => {})
    return () => controller.abort()
  }, [refresh])

  const usableOf = (u: UserView) => groups.filter(g => g.is_public || u.groups.includes(g.name)).map(g => g.name)

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
    const raw = window.prompt(`给「${u.username}」增加多少余额？（单位 ${currencySymbol()}，负数为扣减）`)
    if (raw == null) return
    const delta = toPoints(Number(raw.trim()))
    if (!raw.trim() || !Number.isSafeInteger(delta) || delta === 0) return toast('err', '请输入非零金额')
    try {
      patch(await api.adjustUserQuota(u.id, delta))
      toast('ok', '余额已更新')
    } catch (e: any) {
      toast('err', e.message)
    }
  }

  const resetPassword = async (u: UserView) => {
    const password = window.prompt(u.has_password
      ? `为「${u.username}」设置新密码（8～128 个字符），该用户的所有登录会失效`
      : `「${u.username}」目前只能用 Discord 登录，设置密码（8～128 个字符）后也能用用户名和密码登录；该用户的所有登录会失效`)
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
      <PageHead
        title="用户"
        sub="公网门户注册的用户 · 余额 · 停用 · 自建 Key"
        actions={
          <>
            <div className="ah-search">
              <IconSearch size={15} />
              <Input value={qInput} onChange={e => setQInput(e.target.value)} placeholder="搜索用户名 / Discord / 服务器" />
            </div>
            <IconButton title="刷新" onClick={reload}><IconRefresh size={16} /></IconButton>
          </>
        }
      />

      <Card className="ah-logs-table-card ah-users-table">
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
            <IconUsers size={30} className="ah-logt-empty-icon" />
            {q ? '没有匹配的用户' : '还没有用户注册'}
          </div>
        ) : (
          data.items.map(u => (
            <Fragment key={u.id}>
              <div className={`ah-logt-row ah-user-row${openId === u.id ? ' is-open' : ''}`} onClick={() => setOpenId(id => (id === u.id ? null : u.id))}>
                <span className="u-name">
                  <IconChevron size={14} className={`ah-user-chev${openId === u.id ? ' is-open' : ''}`} />
                  <span className="ah-truncate ah-strong">{u.username}</span>
                  {u.discord_id && (
                    <span className="ah-tag ah-tag-discord" title={`Discord ID：${u.discord_id}${u.has_password ? '' : '（仅 Discord 登录）'}`}>
                      <IconDiscord size={12} />{u.discord_username ?? 'Discord'}
                    </span>
                  )}
                  {u.status !== 1 && <span className="ah-tag ah-tag-warn">已停用</span>}
                  {u.groups.map(g => <span key={g} className="ah-tag" title="专属分组">{g}</span>)}
                </span>
                <span className={`u-num ah-num${u.quota <= 0 ? ' is-neg' : ''}`}>{money(u.quota)}</span>
                <span className="u-num ah-num ah-muted">{money(u.used_quota)}</span>
                <span className="u-num u-sm ah-num ah-muted">{fmtNum(u.request_count)}</span>
                <span className="u-num u-sm ah-num ah-muted">{u.key_count}</span>
                <span className="u-time ah-mini ah-faint ah-num" title={u.register_ip ? `IP：${u.register_ip}` : undefined}>{fmtTime(u.created_at)}</span>
                <span className="u-time ah-mini ah-faint ah-num" title={u.last_login_ip ? `IP：${u.last_login_ip}` : undefined}>{u.last_login_at ? fmtTime(u.last_login_at) : '—'}</span>
                <span className="u-act" onClick={e => e.stopPropagation()}>
                  <Toggle checked={u.status === 1} onChange={() => toggleStatus(u)} />
                  <button type="button" className="ah-btn is-ghost is-sm" onClick={() => setGroupUser(u)}>分组</button>
                  <button type="button" className="ah-btn is-ghost is-sm" onClick={() => adjust(u)}>调余额</button>
                  <button type="button" className="ah-btn is-ghost is-sm" onClick={() => resetPassword(u)}>{u.has_password ? '重置密码' : '设置密码'}</button>
                  <IconButton title="删除" danger onClick={() => del(u)}><IconTrash size={16} /></IconButton>
                </span>
              </div>
              {openId === u.id && (
                <>
                  <UserKeys userId={u.id} usable={usableOf(u)} onChanged={reload} />
                  {u.discord_id && <UserGuilds userId={u.id} recordedAt={u.discord_guilds_at} onSearch={setQInput} />}
                </>
              )}
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
      <div className="ah-page-foot">余额可能因最后一次请求透支为负。用户可用的分组 = 公开分组 + 专属分组。</div>
      {groupUser && <UserGroupsModal user={groupUser} groups={groups} onClose={() => setGroupUser(null)} onSaved={patch} />}
    </div>
  )
}
