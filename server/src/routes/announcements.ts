import { Router } from 'express'
import {
  createAnnouncement, deleteAnnouncement, listAnnouncements, MAX_ANNOUNCEMENTS, updateAnnouncement, validateAnnouncementInput,
} from '../core/announcements'

// 门户公告管理（内网管理 API）；通知正文是设置项 portal_notice，走 /api/settings
export const announcementsRouter = Router()

const validId = (raw: string): number => {
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : 0
}

announcementsRouter.get('/', (_req, res) => {
  res.json(listAnnouncements())
})

announcementsRouter.post('/', (req, res) => {
  const result = validateAnnouncementInput(req.body, false)
  if (!result.ok) return res.status(400).json({ error: result.error })
  const item = createAnnouncement(result.value)
  if (!item) return res.status(400).json({ error: `公告最多 ${MAX_ANNOUNCEMENTS} 条，请先删除旧公告` })
  res.json(item)
})

announcementsRouter.put('/:id', (req, res) => {
  const result = validateAnnouncementInput(req.body, true)
  if (!result.ok) return res.status(400).json({ error: result.error })
  const item = updateAnnouncement(validId(req.params.id), result.value)
  if (!item) return res.status(404).json({ error: 'not found' })
  res.json(item)
})

announcementsRouter.delete('/:id', (req, res) => {
  deleteAnnouncement(validId(req.params.id))
  res.json({ ok: true })
})
