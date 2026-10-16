import { Router } from 'express'
import { allChannels } from '../db'
import { createGroup, deleteGroup, groupViews, updateGroup, validateGroupInput } from '../core/groups'
import type { ChannelGroupInput } from '../types'

// 分组管理（内网管理 API）
export const groupsRouter = Router()

/** 只保留仍存在的渠道 */
function keepExistingChannels(input: ChannelGroupInput): void {
  if (!input.channel_ids) return
  const ids = new Set(allChannels().map(c => c.id))
  input.channel_ids = input.channel_ids.filter(id => ids.has(id))
}

groupsRouter.get('/', (_req, res) => {
  res.json(groupViews())
})

groupsRouter.post('/', (req, res) => {
  const result = validateGroupInput(req.body, false)
  if (!result.ok) return res.status(400).json({ error: result.error })
  keepExistingChannels(result.value)
  const group = createGroup(result.value)
  if (!group) return res.status(409).json({ error: '同名分组已存在' })
  res.json(group)
})

groupsRouter.put('/:name', (req, res) => {
  const result = validateGroupInput(req.body, true)
  if (!result.ok) return res.status(400).json({ error: result.error })
  keepExistingChannels(result.value)
  const group = updateGroup(req.params.name, result.value)
  if (group === 'not_found') return res.status(404).json({ error: 'not found' })
  if (group === 'conflict') return res.status(409).json({ error: '同名分组已存在' })
  res.json(group)
})

groupsRouter.delete('/:name', (req, res) => {
  deleteGroup(req.params.name)
  res.json({ ok: true })
})
