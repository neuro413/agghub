import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api/client'
import { Button, IconButton } from '../components/Button'
import { Card } from '../components/Card'
import { Chips } from '../components/Chips'
import { EmptyState } from '../components/EmptyState'
import { Input } from '../components/Form'
import { IconChannels, IconEdit, IconList, IconPlus, IconSearch, IconTrash } from '../components/Icons'
import { Meter } from '../components/Meter'
import { PageHead } from '../components/PageHead'
import { Badge, RatePill, StatusDot, statusText } from '../components/Primitives'
import { Toggle } from '../components/Toggle'
import { useToast } from '../components/Toast'
import { fmtDuration, rateTone, successRate } from '../lib/format'
import type { Channel, ChannelGroupView } from '../types'
import { ChannelModal } from './ChannelModal'

type Filter = 'all' | 'on' | 'banned' | 'off'
type View = 'cards' | 'table'
const VIEW_KEY = 'agghub_admin_channel_view'
const FILTER_STATUS: Record<Exclude<Filter, 'all'>, number> = { on: 1, banned: 2, off: 0 }

/** 前端过滤：匹配名称、地址、模型 */
function matches(c: Channel, q: string): boolean {
  if (!q) return true
  const s = q.toLowerCase()
  return c.name.toLowerCase().includes(s) || (c.base_url || '').toLowerCase().includes(s) || c.models.some((m) => m.toLowerCase().includes(s))
}

export function ChannelsPage() {
  const [channels, setChannels] = useState<Channel[]>([])
  const [groups, setGroups] = useState<ChannelGroupView[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Channel | 'new' | null>(null)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [view, setView] = useState<View>(() => (localStorage.getItem(VIEW_KEY) === 'table' ? 'table' : 'cards'))
  const toast = useToast()

  const load = useCallback(async () => {
    try {
      const [list, groupList] = await Promise.all([api.listChannels(), api.listGroups()])
      setChannels(list)
      setGroups(groupList)
    } catch (e: any) {
      toast('err', e.message)
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    load()
  }, [load])

  const toggleStatus = async (c: Channel) => {
    const next = c.status === 1 ? 0 : 1
    try {
      await api.updateChannel(c.id, { status: next })
      load()
    } catch (e: any) {
      toast('err', e.message)
    }
  }

  const del = async (c: Channel) => {
    if (!window.confirm(`确认删除渠道「${c.name}」？此操作不可撤销。`)) return
    try {
      await api.deleteChannel(c.id)
      toast('ok', '渠道已删除')
      load()
    } catch (e: any) {
      toast('err', e.message)
    }
  }

  const switchView = (v: View) => {
    setView(v)
    localStorage.setItem(VIEW_KEY, v)
  }

  const count = (s: number) => channels.filter((c) => c.status === s).length
  const enabledCount = count(1)
  const groupsOf = (c: Channel) => groups.filter((g) => g.channel_ids.includes(c.id)).map((g) => g.name)
  const shown = useMemo(
    () => channels.filter((c) => (filter === 'all' || c.status === FILTER_STATUS[filter]) && matches(c, q.trim())),
    [channels, filter, q],
  )

  return (
    <div className="ah-fade-up">
      <PageHead
        title="渠道管理"
        sub={<>聚合 {channels.length} 个上游渠道 · {enabledCount} 个在线</>}
        actions={
          <Button variant="primary" icon={<IconPlus size={16} />} onClick={() => setEditing('new')}>
            新增渠道
          </Button>
        }
      />

      {!loading && channels.length > 0 && (
        <div className="ah-chan-toolbar">
          <label className="ah-search">
            <IconSearch size={15} />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索渠道、地址、模型" />
          </label>
          <Chips
            value={filter}
            onChange={setFilter}
            items={[
              { key: 'all', label: '全部', count: channels.length },
              { key: 'on', label: '在线', count: enabledCount },
              { key: 'banned', label: '已熔断', count: count(2) },
              { key: 'off', label: '已停用', count: count(0) },
            ]}
          />
          <span className="sp" />
          <div className="ah-range" role="group" aria-label="视图">
            <button type="button" className={view === 'cards' ? 'is-active' : ''} aria-pressed={view === 'cards'} onClick={() => switchView('cards')}>
              <IconChannels size={15} />
              卡片
            </button>
            <button type="button" className={view === 'table' ? 'is-active' : ''} aria-pressed={view === 'table'} onClick={() => switchView('table')}>
              <IconList size={15} />
              表格
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="ah-chan-grid">
          {[0, 1, 2].map((i) => (
            <div key={i} className="ah-skel" />
          ))}
        </div>
      ) : channels.length === 0 ? (
        <Card>
          <EmptyState
            icon={<IconChannels size={24} />}
            title="还没有渠道"
            desc="添加第一个上游渠道，开始聚合你的模型吧～"
            action={
              <Button variant="primary" icon={<IconPlus size={16} />} onClick={() => setEditing('new')}>
                新增渠道
              </Button>
            }
          />
        </Card>
      ) : shown.length === 0 ? (
        <Card>
          <EmptyState icon={<IconSearch size={24} />} title="没有匹配的渠道" desc="换个关键词或筛选条件试试" />
        </Card>
      ) : view === 'cards' ? (
        <div className="ah-chan-grid">
          {shown.map((c) => (
            <ChannelCard
              key={c.id}
              c={c}
              groups={groupsOf(c)}
              onToggle={() => toggleStatus(c)}
              onEdit={() => setEditing(c)}
              onDelete={() => del(c)}
            />
          ))}
        </div>
      ) : (
        <ChannelTable channels={shown} groupsOf={groupsOf} onToggle={toggleStatus} onEdit={setEditing} onDelete={del} />
      )}

      {editing && (
        <ChannelModal
          channel={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onChanged={load}
          onSaved={() => {
            setEditing(null)
            setLoading(true)
            load()
          }}
        />
      )}
    </div>
  )
}

/** 压缩「不支持」记忆的到期说明 */
function untilText(until: number | null): string {
  if (until === null) return '直到重启'
  return `${new Date(until).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 到期`
}

/** 配置项说明：优先级、权重、多 key、压缩回退、代理池，用 · 分隔 */
function ChannelMeta({ c }: { c: Channel }) {
  const parts = [
    <span key="p">优先级 {c.priority}</span>,
    <span key="w">权重 {c.weight}</span>,
  ]
  if (c.key_total != null) {
    parts.push(
      <span
        key="k"
        className={c.key_available === 0 ? 'ah-c-warn' : undefined}
        title={c.key_mode === 'race' ? `多 key 并发 · 每次 ${c.key_concurrency} 个 key` : '多 key 轮询'}
      >
        {c.key_mode === 'race' ? '并发 key' : '轮询 key'} {c.key_available}/{c.key_total}
      </span>,
    )
  }
  if (c.compression_unsupported?.length) {
    parts.push(
      <span key="z" className="ah-c-warn" title={c.compression_unsupported.map((u) => `${u.algorithm} 不支持，${untilText(u.until)}`).join('\n')}>
        压缩回退 {c.compression_unsupported.map((u) => u.algorithm).join(' / ')}
      </span>,
    )
  }
  if (c.proxy_pool) {
    parts.push(
      <span
        key="x"
        title={
          c.proxy_pool_include || c.proxy_pool_exclude
            ? [c.proxy_pool_include && `包含：${c.proxy_pool_include}`, c.proxy_pool_exclude && `排除：${c.proxy_pool_exclude}`].filter(Boolean).join('\n')
            : '使用代理池全部节点'
        }
      >
        代理池 {c.proxy_pool_include || c.proxy_pool_exclude ? '按关键词' : '全部'}
      </span>,
    )
  }
  return (
    <div className="ah-chan-meta">
      {parts.flatMap((p, i) => (i ? [<span key={'s' + i} className="sep">·</span>, p] : [p]))}
    </div>
  )
}

/** 熔断剩余时间 */
function BanCountdown({ c }: { c: Channel }) {
  if (c.status !== 2 || c.ban_until == null) return null
  return <span className="ah-c-warn ah-num">{Math.max(1, Math.ceil((c.ban_until - Date.now()) / 60000))} 分钟后自动恢复</span>
}

function ChannelCard({
  c,
  groups,
  onToggle,
  onEdit,
  onDelete,
}: {
  c: Channel
  /** 勾选了本渠道的分组 */
  groups: string[]
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const req = c.today_requests || 0
  const rate = successRate(c.today_success, req)
  const hasLatency = c.today_avg_latency !== undefined

  return (
    <Card hover className={`ah-chan${c.status === 0 ? ' is-off' : ''}`}>
      <div className="ah-chan-top">
        <StatusDot status={c.status} />
        <h3 className="ah-chan-name" title={c.name}>
          {c.name}
        </h3>
        <Badge type={c.type} />
      </div>
      <div className="ah-chan-sub" title={c.base_url || undefined}>
        {c.base_url || '官方默认地址'} · {c.models.length} 个模型
      </div>

      <div className={`ah-chan-nums${hasLatency ? '' : ' is-2'}`}>
        <div>
          <label>成功率</label>
          <b>{rate == null ? '—' : `${rate}%`}</b>
          {rate != null && <Meter value={rate} tone={rateTone(rate)} />}
        </div>
        <div>
          <label>今日请求</label>
          <b>{req.toLocaleString('en-US')}</b>
        </div>
        {hasLatency && (
          <div>
            <label>平均延迟</label>
            <b>{c.today_avg_latency == null ? '—' : fmtDuration(c.today_avg_latency)}</b>
          </div>
        )}
      </div>

      <ChannelMeta c={c} />

      <div className="ah-chan-foot">
        {groups.length > 0 && (
          <span className="ah-chan-groups" title="勾选了本渠道的分组，在「分组」页修改">
            {groups.map((g) => (
              <span key={g} className="ah-tag">
                {g}
              </span>
            ))}
          </span>
        )}
        <span>{statusText(c.status)}</span>
        <BanCountdown c={c} />
        <span className="sp" />
        <IconButton title="编辑" onClick={onEdit}>
          <IconEdit size={15} />
        </IconButton>
        <IconButton title="删除" danger onClick={onDelete}>
          <IconTrash size={15} />
        </IconButton>
        <Toggle checked={c.status === 1} onChange={onToggle} label={c.status === 1 ? '停用渠道' : '启用渠道'} />
      </div>
    </Card>
  )
}

function ChannelTable({
  channels,
  groupsOf,
  onToggle,
  onEdit,
  onDelete,
}: {
  channels: Channel[]
  groupsOf: (c: Channel) => string[]
  onToggle: (c: Channel) => void
  onEdit: (c: Channel) => void
  onDelete: (c: Channel) => void
}) {
  return (
    <Card className="ah-table-card">
      <div className="ah-table-wrap">
        <table className="ah-table ah-chan-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>类型</th>
              <th>地址</th>
              <th className="r">模型</th>
              <th className="r">优先级 / 权重</th>
              <th>分组</th>
              <th className="r">今日请求</th>
              <th className="r">成功率</th>
              <th>启用</th>
              <th className="r">操作</th>
            </tr>
          </thead>
          <tbody>
            {channels.map((c) => (
              <tr key={c.id} className={c.status === 0 ? 'is-off' : undefined}>
                <td>
                  <span className="ah-chan-tname">
                    <StatusDot status={c.status} />
                    <span className="ah-truncate" title={c.name}>
                      {c.name}
                    </span>
                  </span>
                </td>
                <td>
                  <Badge type={c.type} />
                </td>
                <td className="dim">
                  <span className="ah-chan-url ah-truncate" title={c.base_url || undefined}>
                    {c.base_url || '官方默认地址'}
                  </span>
                </td>
                <td className="r ah-num">{c.models.length}</td>
                <td className="r ah-num">
                  {c.priority} / {c.weight}
                </td>
                <td>
                  <span className="ah-chan-groups">
                    {groupsOf(c).map((g) => (
                      <span key={g} className="ah-tag">
                        {g}
                      </span>
                    ))}
                  </span>
                </td>
                <td className="r ah-num">{(c.today_requests || 0).toLocaleString('en-US')}</td>
                <td className="r">
                  <RatePill rate={successRate(c.today_success, c.today_requests)} />
                </td>
                <td>
                  <Toggle checked={c.status === 1} onChange={() => onToggle(c)} label={c.status === 1 ? '停用渠道' : '启用渠道'} />
                </td>
                <td className="r">
                  <span className="ah-chan-tact">
                    <IconButton title="编辑" onClick={() => onEdit(c)}>
                      <IconEdit size={15} />
                    </IconButton>
                    <IconButton title="删除" danger onClick={() => onDelete(c)}>
                      <IconTrash size={15} />
                    </IconButton>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
