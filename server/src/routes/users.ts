import { Router } from 'express'
import type { Request, RequestHandler, Response } from 'express'
import { keyView, listUserKeys } from '../core/keys'
import { listGroups } from '../core/groups'
import { deleteUserSessions } from '../core/sessions'
import {
  adjustUserQuota, deleteUser, getUserView, hashPassword, listUsers, passwordError, setUserGroups, setUserPassword, setUserStatus,
  USER_DISABLED, USER_ENABLED,
} from '../core/users'

// 门户用户管理（内网管理 API，受管理令牌保护）
export const usersRouter = Router()

const validId = (raw: string): number | null => {
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => (req, res, next) => {
  fn(req, res).catch(next)
}

usersRouter.get('/', (req, res) => {
  res.json(listUsers({ q: typeof req.query.q === 'string' ? req.query.q : '', page: Number(req.query.page), size: Number(req.query.size) }))
})

usersRouter.put('/:id', (req, res) => {
  const id = validId(req.params.id)
  const status = req.body?.status
  if (status !== USER_ENABLED && status !== USER_DISABLED) return res.status(400).json({ error: 'status 须为 1（启用）或 2（停用）' })
  if (!id || !setUserStatus(id, status)) return res.status(404).json({ error: 'not found' })
  if (status === USER_DISABLED) deleteUserSessions(id)
  res.json(getUserView(id))
})

usersRouter.put('/:id/groups', (req, res) => {
  const id = validId(req.params.id)
  const groups = req.body?.groups
  if (!Array.isArray(groups) || !groups.every(g => typeof g === 'string')) return res.status(400).json({ error: 'groups 须为分组名数组' })
  const names = new Set(listGroups().map(g => g.name))
  const missing = groups.filter(g => !names.has(g))
  if (missing.length) return res.status(400).json({ error: `分组不存在：${missing.join('、')}` })
  if (!id || !setUserGroups(id, [...new Set(groups as string[])])) return res.status(404).json({ error: 'not found' })
  res.json(getUserView(id))
})

usersRouter.post('/:id/quota', (req, res) => {
  const id = validId(req.params.id)
  const delta = req.body?.delta
  if (!Number.isSafeInteger(delta) || delta === 0) return res.status(400).json({ error: 'delta 须为非零整数' })
  if (!id || !adjustUserQuota(id, delta)) return res.status(404).json({ error: 'not found' })
  res.json(getUserView(id))
})

usersRouter.post('/:id/password', wrap(async (req, res) => {
  const id = validId(req.params.id)
  const password = req.body?.password
  const error = passwordError(password)
  if (error) return res.status(400).json({ error })
  if (!id || !setUserPassword(id, await hashPassword(password))) return res.status(404).json({ error: 'not found' })
  deleteUserSessions(id)
  res.json({ ok: true })
}))

usersRouter.delete('/:id', (req, res) => {
  const id = validId(req.params.id)
  if (id) deleteUser(id)
  res.json({ ok: true })
})

usersRouter.get('/:id/keys', (req, res) => {
  const id = validId(req.params.id)
  res.json(id ? listUserKeys(id).map(k => keyView(k)) : [])
})
