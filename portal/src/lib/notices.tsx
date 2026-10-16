import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '../api'
import type { Announcement, Notices } from '../types'

// 通知中心（仿 new-api）：通知按内容哈希、公告按 id + 更新时间记录已读，存在本地并按用户区分。
// 在哪个 tab 上看到就算读过；通知内容有变化时，进控制台自动弹出一次

export type NoticeTab = 'notice' | 'announcements'

interface ReadState {
  notice: string
  announcements: string[]
}

interface NoticeCenter {
  notice: string
  announcements: Announcement[]
  loading: boolean
  unreadNotice: boolean
  unreadAnnouncements: number
  open: boolean
  tab: NoticeTab
  /** 不传 tab 时优先打开有未读的一栏 */
  openCenter: (tab?: NoticeTab) => void
  closeCenter: () => void
  setTab: (tab: NoticeTab) => void
}

const NoticeContext = createContext<NoticeCenter | null>(null)

/** 已读记录只保留最近这么多条公告 */
const READ_LIMIT = 200

function hashText(text: string): string {
  let hash = 0
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0
  return `${text.length}:${(hash >>> 0).toString(36)}`
}

const announcementKey = (a: Announcement) => `${a.id}:${a.updated_at}`
const storageKey = (userId: number) => `agh_portal_read:${userId}`

function loadRead(userId: number): ReadState {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(userId)) || '{}')
    return {
      notice: typeof value.notice === 'string' ? value.notice : '',
      announcements: Array.isArray(value.announcements) ? value.announcements.filter((k: unknown) => typeof k === 'string') : [],
    }
  } catch {
    return { notice: '', announcements: [] }
  }
}

export function NoticeProvider({ userId, children }: { userId: number; children: ReactNode }) {
  const [data, setData] = useState<Notices | null>(null)
  const [read, setRead] = useState(() => loadRead(userId))
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<NoticeTab>('notice')
  const autoOpened = useRef(false)

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setData(await api.notices(signal))
    } catch {
      if (!signal?.aborted) setData(prev => prev ?? { notice: '', announcements: [] })
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const notice = data?.notice ?? ''
  const announcements = useMemo(() => data?.announcements ?? [], [data])
  const noticeHash = notice ? hashText(notice) : ''
  const unreadNotice = !!notice && read.notice !== noticeHash
  const unreadAnnouncements = useMemo(() => {
    const seen = new Set(read.announcements)
    return announcements.filter(a => !seen.has(announcementKey(a))).length
  }, [announcements, read.announcements])

  const saveRead = useCallback((next: ReadState) => {
    setRead(next)
    try { localStorage.setItem(storageKey(userId), JSON.stringify(next)) } catch {}
  }, [userId])

  // 打开状态下停留在哪一栏，哪一栏就算已读
  useEffect(() => {
    if (!open) return
    if (tab === 'notice' && unreadNotice) saveRead({ ...read, notice: noticeHash })
    if (tab === 'announcements' && unreadAnnouncements) {
      const keys = [...new Set([...announcements.map(announcementKey), ...read.announcements])].slice(0, READ_LIMIT)
      saveRead({ ...read, announcements: keys })
    }
  }, [open, tab, unreadNotice, unreadAnnouncements, noticeHash, announcements, read, saveRead])

  const openCenter = useCallback((next?: NoticeTab) => {
    setTab(prev => next ?? (unreadNotice ? 'notice' : unreadAnnouncements ? 'announcements' : prev))
    setOpen(true)
    void load()
  }, [unreadNotice, unreadAnnouncements, load])

  // 通知有更新时自动弹出一次
  useEffect(() => {
    if (!data || autoOpened.current) return
    autoOpened.current = true
    if (unreadNotice) {
      setTab('notice')
      setOpen(true)
    }
  }, [data, unreadNotice])

  const value = useMemo<NoticeCenter>(() => ({
    notice,
    announcements,
    loading: data == null,
    unreadNotice,
    unreadAnnouncements,
    open,
    tab,
    openCenter,
    closeCenter: () => setOpen(false),
    setTab,
  }), [notice, announcements, data, unreadNotice, unreadAnnouncements, open, tab, openCenter])

  return <NoticeContext.Provider value={value}>{children}</NoticeContext.Provider>
}

export function useNoticeCenter(): NoticeCenter {
  const center = useContext(NoticeContext)
  if (!center) throw new Error('NoticeProvider 未初始化')
  return center
}
