import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import { Button, IconButton } from '../components/Button'
import { Card } from '../components/Card'
import { EmptyState } from '../components/EmptyState'
import { IconEdit, IconLayers, IconPlus, IconRefresh, IconTrash } from '../components/Icons'
import { useToast } from '../components/Toast'
import type { Channel, ChannelGroupView } from '../types'
import { GroupModal } from './GroupModal'

export function GroupsPage() {
  const toast = useToast()
  const [groups, setGroups] = useState<ChannelGroupView[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<ChannelGroupView | 'new' | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [g, c] = await Promise.all([api.listGroups(signal), api.listChannels(signal)])
      if (signal?.aborted) return
      setGroups(g)
      setChannels(c)
    } catch (e: any) {
      if (!signal?.aborted) toast('err', e.message)
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    return () => controller.abort()
  }, [load])

  const refresh = useCallback(() => load(), [load])

  const del = async (g: ChannelGroupView) => {
    const refs = g.key_count || g.user_count ? `\n${g.key_count} 个 Key、${g.user_count} 个用户引用了它，删除后会一并移除；失去分组的 Key 将无法调用。` : ''
    if (!window.confirm(`确认删除分组「${g.name}」？${refs}`)) return
    try {
      await api.deleteGroup(g.name)
      toast('ok', '分组已删除')
      refresh()
    } catch (e: any) {
      toast('err', e.message)
    }
  }

  return (
    <div className="ah-fade-up">
      <div className="ah-page-head">
        <div>
          <div className="ah-page-title">分组</div>
          <div className="ah-page-sub">按分组开放渠道与模型 · 分组倍率 · 公开或分配给门户用户</div>
        </div>
        <div className="ah-row">
          <IconButton title="刷新" onClick={refresh}>
            <IconRefresh size={18} />
          </IconButton>
          <Button variant="primary" icon={<IconPlus size={18} />} onClick={() => setEditing('new')}>
            新建分组
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="ah-chan-grid">
          {[0, 1, 2].map((i) => (
            <div key={i} className="ah-skel" style={{ height: 200 }} />
          ))}
        </div>
      ) : groups.length === 0 ? (
        <Card>
          <EmptyState
            icon={<IconLayers size={34} />}
            title="还没有分组"
            desc="分组决定 Key 能用哪些渠道和模型；内网匿名调用不受分组限制"
            action={
              <Button variant="primary" icon={<IconPlus size={18} />} onClick={() => setEditing('new')}>
                新建分组
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="ah-chan-grid">
          {groups.map((g) => (
            <GroupCard key={g.name} g={g} channels={channels} onEdit={() => setEditing(g)} onDelete={() => del(g)} />
          ))}
        </div>
      )}

      <div className="ah-mini ah-faint" style={{ marginTop: 10 }}>
        Key 只能调用所属分组里同时勾选了渠道和模型的组合；管理员发的 Key 属于多个分组时，按倍率最低的命中分组计费。
      </div>

      {editing && (
        <GroupModal
          group={editing === 'new' ? null : editing}
          channels={channels}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
    </div>
  )
}

function GroupCard({
  g,
  channels,
  onEdit,
  onDelete,
}: {
  g: ChannelGroupView
  channels: Channel[]
  onEdit: () => void
  onDelete: () => void
}) {
  const members = channels.filter((c) => g.channel_ids.includes(c.id))
  return (
    <Card hover className="ah-chan">
      <div className="ah-chan-top">
        <div style={{ minWidth: 0 }}>
          <div className="ah-chan-name">
            <IconLayers size={16} />
            <span className="ah-truncate">{g.name}</span>
          </div>
          <div className="ah-chan-sub ah-truncate">{g.description || '无描述'}</div>
        </div>
        {g.is_public ? <span className="ah-tag ah-tag-pub">公开</span> : <span className="ah-tag">需分配</span>}
      </div>

      <div className="ah-chan-meta">
        <div className="ah-meta-box">
          <div className="k">倍率</div>
          <div className="v">×{g.ratio}</div>
        </div>
        <div className="ah-meta-box">
          <div className="k">渠道</div>
          <div className="v">{members.length}</div>
        </div>
        <div className="ah-meta-box">
          <div className="k">模型</div>
          <div className="v">{g.models.length}</div>
        </div>
      </div>

      <div className="ah-pp-chips">
        {members.map((c) => (
          <span key={c.id} className="ah-tag" style={c.status === 1 ? undefined : { opacity: 0.5 }} title={c.status === 1 ? undefined : '渠道未启用'}>
            {c.name}
          </span>
        ))}
        {!members.length && <span className="ah-mini ah-faint">未勾选渠道</span>}
        {g.ua_blacklist?.length ? <span className="ah-tag" title={`UA 黑名单：${g.ua_blacklist.join('、')}`}>UA 黑名单 {g.ua_blacklist.length}</span> : null}
      </div>

      <div className="ah-chan-actions">
        <span className="ah-mini ah-muted">
          {g.is_public ? '所有用户' : `${g.user_count} 个用户`} · {g.key_count} 个 Key · 排序 {g.sort}
        </span>
        <span className="sp" />
        <IconButton title="编辑" onClick={onEdit}>
          <IconEdit size={17} />
        </IconButton>
        <IconButton title="删除" danger onClick={onDelete}>
          <IconTrash size={17} />
        </IconButton>
      </div>
    </Card>
  )
}
