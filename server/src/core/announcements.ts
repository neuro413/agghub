import { db } from '../db'
import type { Announcement, AnnouncementInput, AnnouncementType } from '../types'

export const ANNOUNCEMENT_TYPES: AnnouncementType[] = ['default', 'ongoing', 'success', 'warning', 'error']
/** 公告总数上限 */
export const MAX_ANNOUNCEMENTS = 100
/** 门户只显示已发布的最近若干条 */
export const PORTAL_ANNOUNCEMENTS = 20

const CONTENT_MAX = 5000
const EXTRA_MAX = 200

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 校验请求体；忽略未知字段，partial=true 时只校验出现的字段 */
export function validateAnnouncementInput(input: unknown, partial: boolean): { ok: true; value: AnnouncementInput } | { ok: false; error: string } {
  if (!isPlainObject(input)) return { ok: false, error: '请求体必须为 JSON 对象' }
  const value: AnnouncementInput = {}

  if (input.content !== undefined || !partial) {
    if (typeof input.content !== 'string' || !input.content.trim() || input.content.length > CONTENT_MAX) {
      return { ok: false, error: `内容须为 1～${CONTENT_MAX} 字符` }
    }
    value.content = input.content.trim()
  }

  if (input.extra !== undefined) {
    if (typeof input.extra !== 'string' || input.extra.trim().length > EXTRA_MAX) return { ok: false, error: `附加说明须为不超过 ${EXTRA_MAX} 字符的字符串` }
    value.extra = input.extra.trim()
  }

  if (input.type !== undefined) {
    if (!ANNOUNCEMENT_TYPES.includes(input.type as AnnouncementType)) return { ok: false, error: `类型须为 ${ANNOUNCEMENT_TYPES.join(' / ')} 之一` }
    value.type = input.type as AnnouncementType
  }

  if (input.publish_at !== undefined) {
    if (!Number.isSafeInteger(input.publish_at) || (input.publish_at as number) <= 0) return { ok: false, error: '发布时间须为毫秒时间戳' }
    value.publish_at = input.publish_at as number
  }

  return { ok: true, value }
}

/** 全部公告（含定时发布），发布时间倒序 */
export function listAnnouncements(): Announcement[] {
  return db.prepare('SELECT * FROM announcements ORDER BY publish_at DESC, id DESC').all() as Announcement[]
}

/** 已发布的最近 limit 条 */
export function publishedAnnouncements(limit: number, now = Date.now()): Announcement[] {
  return db.prepare('SELECT * FROM announcements WHERE publish_at <= ? ORDER BY publish_at DESC, id DESC LIMIT ?').all(now, limit) as Announcement[]
}

export function getAnnouncement(id: number): Announcement | null {
  return (db.prepare('SELECT * FROM announcements WHERE id = ?').get(id) as Announcement | undefined) ?? null
}

/** 发布时间缺省为现在；已达上限返回 null */
export function createAnnouncement(input: AnnouncementInput, now = Date.now()): Announcement | null {
  return db.transaction(() => {
    const count = db.prepare('SELECT COUNT(*) FROM announcements').pluck().get() as number
    if (count >= MAX_ANNOUNCEMENTS) return null
    const info = db
      .prepare('INSERT INTO announcements (content, extra, type, publish_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(input.content!, input.extra ?? '', input.type ?? 'default', input.publish_at ?? now, now, now)
    return getAnnouncement(Number(info.lastInsertRowid))
  })()
}

/** 门户按 id + updated_at 判断已读，编辑后会重新算作未读；不存在返回 null */
export function updateAnnouncement(id: number, input: AnnouncementInput): Announcement | null {
  const existing = getAnnouncement(id)
  if (!existing) return null
  db.prepare('UPDATE announcements SET content = ?, extra = ?, type = ?, publish_at = ?, updated_at = ? WHERE id = ?').run(
    input.content ?? existing.content,
    input.extra ?? existing.extra,
    input.type ?? existing.type,
    input.publish_at ?? existing.publish_at,
    Date.now(),
    id,
  )
  return getAnnouncement(id)
}

export function deleteAnnouncement(id: number): boolean {
  return db.prepare('DELETE FROM announcements WHERE id = ?').run(id).changes > 0
}
