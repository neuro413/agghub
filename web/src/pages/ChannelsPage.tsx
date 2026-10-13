import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import { Button, IconButton } from '../components/Button'
import { Card } from '../components/Card'
import { EmptyState } from '../components/EmptyState'
import { IconChannels, IconEdit, IconPlus, IconTrash } from '../components/Icons'
import { Badge, StatusDot, statusText } from '../components/Primitives'
import { Toggle } from '../components/Toggle'
import { useToast } from '../components/Toast'
import type { Channel } from '../types'
import { ChannelModal } from './ChannelModal'

export function ChannelsPage() {
  const [channels, setChannels] = useState<Channel[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Channel | 'new' | null>(null)
  const toast = useToast()

  const load = useCallback(async () => {
    try {
      setChannels(await api.listChannels())
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

  const enabledCount = channels.filter((c) => c.status === 1).length

  return (
    <div className="ah-fade-up">
      <div className="ah-page-head">
        <div>
          <div className="ah-page-title">渠道管理</div>
          <div className="ah-page-sub">
            聚合 {channels.length} 个上游渠道 · {enabledCount} 个在线
          </div>
        </div>
        <Button variant="primary" icon={<IconPlus size={18} />} onClick={() => setEditing('new')}>
          新增渠道
        </Button>
      </div>

      {loading ? (
        <div className="ah-chan-grid">
          {[0, 1, 2].map((i) => (
            <div key={i} className="ah-skel" />
          ))}
        </div>
      ) : channels.length === 0 ? (
        <Card>
          <EmptyState
            icon={<IconChannels size={34} />}
            title="还没有渠道"
            desc="添加第一个上游渠道，开始聚合你的模型吧～"
            action={
              <Button variant="primary" icon={<IconPlus size={18} />} onClick={() => setEditing('new')}>
                新增渠道
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="ah-chan-grid ah-stagger">
          {channels.map((c) => (
            <ChannelCard
              key={c.id}
              c={c}
              onToggle={() => toggleStatus(c)}
              onEdit={() => setEditing(c)}
              onDelete={() => del(c)}
            />
          ))}
        </div>
      )}

      {editing && (
        <ChannelModal
          channel={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
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

function ChannelCard({
  c,
  onToggle,
  onEdit,
  onDelete,
}: {
  c: Channel
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const req = c.today_requests || 0
  const rate = req ? Math.round(((c.today_success || 0) / req) * 100) : 100

  return (
    <Card hover className="ah-chan">
      <div className="ah-chan-top">
        <div>
          <div className="ah-chan-name">
            <StatusDot status={c.status} />
            {c.name}
          </div>
          <div className="ah-chan-sub">
            {c.base_url || '官方默认地址'} · 模型 ×{c.models.length}
          </div>
        </div>
        <Badge type={c.type} />
      </div>

      <div className="ah-chan-meta">
        <div className="ah-meta-box">
          <div className="k">优先级</div>
          <div className="v">{c.priority}</div>
        </div>
        <div className="ah-meta-box">
          <div className="k">权重</div>
          <div className="v">{c.weight}</div>
        </div>
      </div>

      {(c.groups ?? []).length > 0 && (
        <div className="ah-pp-chips">
          {c.groups.map((g) => (
            <span key={g} className="ah-tag">
              {g}
            </span>
          ))}
        </div>
      )}

      <div className="ah-chan-stat">
        <span className="ah-muted ah-mini">
          今日 <b className="ah-num">{req}</b> 次
        </span>
        <div className="ah-bar">
          <i style={{ width: `${rate}%` }} />
        </div>
        <span className="ah-mini" style={{ color: 'var(--orange-700)', fontWeight: 700 }}>
          {rate}%
        </span>
      </div>

      <div className="ah-chan-actions">
        <Toggle checked={c.status === 1} onChange={onToggle} />
        <span className="ah-mini ah-muted">{statusText(c.status)}</span>
        {c.status === 2 && c.ban_until != null && (
          <span className="ah-mini ah-num" style={{ color: 'var(--warn)', fontWeight: 700 }}>
            {Math.max(1, Math.ceil((c.ban_until - Date.now()) / 60000))} 分钟后自动恢复
          </span>
        )}
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
