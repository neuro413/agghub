import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import { Button, IconButton } from '../components/Button'
import { Card } from '../components/Card'
import { EmptyState } from '../components/EmptyState'
import { Textarea } from '../components/Form'
import { IconBell, IconEdit, IconMegaphone, IconPlus, IconRefresh, IconTrash } from '../components/Icons'
import { Toggle } from '../components/Toggle'
import { useToast } from '../components/Toast'
import { Markdown } from '../lib/markdown'
import type { Announcement } from '../types'
import { AnnouncementModal, TYPE_OPTIONS } from './AnnouncementModal'
import { PageHead } from '../components/PageHead'

// 门户通知中心的内容管理：通知（设置项 portal_notice）+ 公告列表

const NOTICE_MAX = 20_000
const TYPE_LABEL = Object.fromEntries(TYPE_OPTIONS.map((o) => [o.value, o.label]))

function fullTime(ts: number): string {
  const d = new Date(ts)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function NoticesPage() {
  const toast = useToast()
  const [notice, setNotice] = useState<string | null>(null)
  const [savedNotice, setSavedNotice] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [items, setItems] = useState<Announcement[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState<Announcement | 'new' | null>(null)

  const loadList = useCallback(async (signal?: AbortSignal) => {
    try {
      const list = await api.listAnnouncements(signal)
      if (!signal?.aborted) setItems(list)
    } catch (e: any) {
      if (!signal?.aborted) toast('err', e.message)
    }
  }, [toast])

  useEffect(() => {
    const controller = new AbortController()
    api.getSettings(controller.signal).then((s) => {
      if (controller.signal.aborted) return
      setNotice(s.portal_notice)
      setSavedNotice(s.portal_notice)
      setEnabled(s.portal_announcements_enabled)
    }).catch((e) => { if (!controller.signal.aborted) toast('err', e.message) })
    loadList(controller.signal)
    return () => controller.abort()
  }, [toast, loadList])

  const dirty = notice != null && notice !== savedNotice

  const saveNotice = async () => {
    if (notice == null || !dirty) return
    setSaving(true)
    try {
      const saved = await api.updateSettings({ portal_notice: notice })
      setNotice(saved.portal_notice)
      setSavedNotice(saved.portal_notice)
      toast('ok', saved.portal_notice.trim() ? '通知已发布' : '通知已清空，门户不再显示')
    } catch (e: any) {
      toast('err', e.message)
    } finally {
      setSaving(false)
    }
  }

  const toggleEnabled = async (value: boolean) => {
    setEnabled(value)
    try {
      const saved = await api.updateSettings({ portal_announcements_enabled: value })
      setEnabled(saved.portal_announcements_enabled)
      toast('ok', value ? '门户已显示公告' : '门户已隐藏公告')
    } catch (e: any) {
      setEnabled(!value)
      toast('err', e.message)
    }
  }

  const del = async (a: Announcement) => {
    if (!window.confirm('确认删除这条公告？')) return
    try {
      await api.deleteAnnouncement(a.id)
      toast('ok', '公告已删除')
      loadList()
    } catch (e: any) {
      toast('err', e.message)
    }
  }

  const now = Date.now()

  return (
    <div className="ah-fade-up">
      <PageHead
        title="通知"
        sub="门户右上角通知中心的内容 · 通知 · 公告"
      />

      <Card className="ah-set-card">
        <div className="ah-notice-head">
          <div>
            <div className="ah-set-title">
              <IconBell size={18} /> 通知
            </div>
            <div className="ah-set-desc">一段常驻说明，支持 Markdown；内容有变化时，用户进入控制台会自动弹出一次。清空后门户不显示</div>
          </div>
          <Button variant="primary" loading={saving} disabled={!dirty} onClick={saveNotice}>
            {dirty ? '保存通知' : '已保存'}
          </Button>
        </div>
        {notice == null ? (
          <div className="ah-skel" style={{ height: 220 }} />
        ) : (
          <div className="ah-md-editor">
            <div className="ah-md-pane">
              <div className="ah-md-pane-label">编辑</div>
              <Textarea
                rows={12}
                value={notice}
                maxLength={NOTICE_MAX}
                onChange={(e) => setNotice(e.target.value)}
                placeholder={'例如：\n## 维护通知\n本周五 22:00 ~ 23:00 线路维护，期间请求可能失败。\n\n- 新用户注册即送额度\n- 有问题请联系管理员'}
              />
              <div className="ah-hint">{notice.length} / {NOTICE_MAX}</div>
            </div>
            <div className="ah-md-pane">
              <div className="ah-md-pane-label">预览</div>
              <div className="ah-md-preview">
                {notice.trim() ? <Markdown content={notice} /> : <span className="ah-mini ah-faint">没有内容，门户不显示通知</span>}
              </div>
            </div>
          </div>
        )}
      </Card>

      <Card className="ah-set-card">
        <div className="ah-notice-head">
          <div>
            <div className="ah-set-title">
              <IconMegaphone size={18} /> 公告
            </div>
            <div className="ah-set-desc">按发布时间倒序显示在通知中心和门户概览页，门户只显示最近 20 条；发布时间晚于现在的为定时发布</div>
          </div>
          <div className="ah-row">
            <span className="ah-mini ah-muted">在门户显示</span>
            <Toggle checked={enabled} onChange={toggleEnabled} />
            <IconButton title="刷新" onClick={() => loadList()}>
              <IconRefresh size={18} />
            </IconButton>
            <Button variant="primary" icon={<IconPlus size={18} />} onClick={() => setEditing('new')}>
              新建公告
            </Button>
          </div>
        </div>

        {!enabled && <div className="ah-ann-off">公告已在门户隐藏，用户看不到下面的公告</div>}

        {items == null ? (
          <div className="ah-skel" style={{ height: 120 }} />
        ) : items.length === 0 ? (
          <EmptyState icon={<IconMegaphone size={34} />} title="还没有公告" desc="新建的公告会出现在门户的通知中心和概览页" />
        ) : (
          <div className="ah-ann-list">
            {items.map((a) => (
              <div key={a.id} className="ah-ann-row">
                <span className={`ah-ann-dot is-${a.type}`} title={TYPE_LABEL[a.type]} />
                <div className="ah-ann-main">
                  <div className="ah-ann-content">
                    <Markdown content={a.content} />
                  </div>
                  {a.extra && <Markdown content={a.extra} className="ah-ann-extra" />}
                  <div className="ah-ann-meta">
                    <span>{fullTime(a.publish_at)}</span>
                    {a.publish_at > now && <span className="ah-tag ah-tag-warn">定时</span>}
                    <span className="ah-tag">{TYPE_LABEL[a.type] ?? a.type}</span>
                  </div>
                </div>
                <div className="ah-ann-actions">
                  <IconButton title="编辑" onClick={() => setEditing(a)}>
                    <IconEdit size={17} />
                  </IconButton>
                  <IconButton title="删除" danger onClick={() => del(a)}>
                    <IconTrash size={17} />
                  </IconButton>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {editing && <AnnouncementModal item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => loadList()} />}
    </div>
  )
}
