import { useEffect, useRef } from 'react'
import { ago, dateTime } from '../lib/format'
import { Markdown } from '../lib/markdown'
import { useNoticeCenter } from '../lib/notices'
import type { Announcement } from '../types'
import { Button, Empty, Skeleton } from './ui'
import { IconBell, IconMegaphone } from './Icons'

const MONTH = 30 * 86_400_000

/** 公告时间线：类型颜色点 + 内容 + 附加说明 + 发布时间（30 天内带相对时间） */
export function AnnouncementList({ items }: { items: Announcement[] }) {
  return (
    <div className="pt-ann-list">
      {items.map(a => (
        <div key={a.id} className="pt-ann-item">
          <span className={`pt-ann-dot is-${a.type}`} />
          <div className="pt-ann-main">
            <Markdown content={a.content} />
            {a.extra && <Markdown content={a.extra} className="pt-ann-extra" />}
            <div className="pt-ann-time">
              {Date.now() - a.publish_at < MONTH && `${ago(a.publish_at)} · `}{dateTime(a.publish_at, false)}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

/** 顶栏铃铛 + 通知中心弹层（通知 / 公告两栏） */
export function NoticeBell() {
  const { notice, announcements, loading, unreadNotice, unreadAnnouncements, open, tab, openCenter, closeCenter, setTab } = useNoticeCenter()
  const ref = useRef<HTMLDivElement>(null)
  const count = (unreadNotice ? 1 : 0) + unreadAnnouncements

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) closeCenter() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeCenter() }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, closeCenter])

  return (
    <div className="pt-menu-anchor" ref={ref}>
      <Button variant="ghost" size="icon" className="pt-bell" onClick={() => (open ? closeCenter() : openCenter())} aria-label="通知中心" aria-expanded={open}>
        <IconBell size={18} />
        {count > 0 && <span className="pt-bell-count">{count > 99 ? '99+' : count}</span>}
      </Button>
      {open && (
        <div className="pt-notice-pop" role="dialog" aria-label="通知中心">
          <div className="pt-notice-head">
            <div className="pt-notice-title">通知中心</div>
            <div className="pt-notice-desc">平台通知与最新公告</div>
          </div>
          <div className="pt-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'notice'} className={`pt-tab${tab === 'notice' ? ' is-active' : ''}`} onClick={() => setTab('notice')}>
              <IconBell size={14} />通知{unreadNotice && <span className="pt-tab-dot" />}
            </button>
            <button role="tab" aria-selected={tab === 'announcements'} className={`pt-tab${tab === 'announcements' ? ' is-active' : ''}`} onClick={() => setTab('announcements')}>
              <IconMegaphone size={14} />公告{unreadAnnouncements > 0 && <span className="pt-tab-count">{unreadAnnouncements}</span>}
            </button>
          </div>
          <div className="pt-notice-body">
            {loading ? (
              <div style={{ display: 'grid', gap: 8 }}>{[0, 1, 2].map(i => <Skeleton key={i} height={18} />)}</div>
            ) : tab === 'notice' ? (
              notice ? <Markdown content={notice} /> : <Empty icon={<IconBell size={20} />} title="暂无通知" />
            ) : announcements.length ? (
              <AnnouncementList items={announcements} />
            ) : (
              <Empty icon={<IconMegaphone size={20} />} title="暂无公告" />
            )}
          </div>
          <div className="pt-notice-foot">
            <Button size="sm" onClick={closeCenter}>关闭</Button>
          </div>
        </div>
      )}
    </div>
  )
}
