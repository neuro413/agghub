import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import { Button, IconButton } from '../components/Button'
import { Card } from '../components/Card'
import { EmptyState } from '../components/EmptyState'
import { IconEdit, IconLayers, IconPlus, IconRefresh, IconTrash } from '../components/Icons'
import { useToast } from '../components/Toast'
import type { Channel, ChannelGroupView } from '../types'
import { GroupModal } from './GroupModal'
import { PageHead } from '../components/PageHead'

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
      <PageHead
        title="分组"
        sub="按分组开放渠道与模型 · 分组倍率 · 公开或分配给门户用户"
        actions={
          <>
            <IconButton title="刷新" onClick={refresh}>
              <IconRefresh size={16} />
            </IconButton>
            <Button variant="primary" icon={<IconPlus size={18} />} onClick={() => setEditing('new')}>
              新建分组
            </Button>
          </>
        }
      />

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

      <div className="ah-page-foot">
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
    <Card hover className="ah-chan ah-group-card">
      <div className="ah-chan-top">
        <span className="ah-group-icon">
          <IconLayers size={14} />
        </span>
        <h3 className="ah-chan-name" title={g.name}>
          {g.name}
        </h3>
        {g.is_public ? <span className="ah-tag ah-tag-pub">公开</span> : <span className="ah-tag">需分配</span>}
      </div>
      <div className="ah-chan-sub" title={g.description || undefined}>
        {g.description || '无描述'}
      </div>

      <div className="ah-chan-nums">
        <div>
          <label>倍率</label>
          <b>×{g.ratio}</b>
        </div>
        <div>
          <label>渠道</label>
          <b>{members.length}</b>
        </div>
        <div>
          <label>模型</label>
          <b>{g.models.length}</b>
        </div>
      </div>

      <div className="ah-group-chans">
        {members.map((c) => (
          <span key={c.id} className={`ah-tag${c.status === 1 ? '' : ' is-off'}`} title={c.status === 1 ? undefined : '渠道未启用'}>
            {c.name}
          </span>
        ))}
        {!members.length && <span className="ah-muted">未勾选渠道</span>}
        {g.ua_blacklist?.length ? <span className="ah-tag ah-tag-warn" title={`UA 黑名单：${g.ua_blacklist.join('、')}`}>UA 黑名单 {g.ua_blacklist.length}</span> : null}
      </div>

      <div className="ah-chan-foot">
        <span className="ah-truncate">
          {g.is_public ? '所有用户' : `${g.user_count} 个用户`} · {g.key_count} 个 Key · 排序 {g.sort}
        </span>
        <span className="sp" />
        <IconButton title="编辑" onClick={onEdit}>
          <IconEdit size={15} />
        </IconButton>
        <IconButton title="删除" danger onClick={onDelete}>
          <IconTrash size={15} />
        </IconButton>
      </div>
    </Card>
  )
}
