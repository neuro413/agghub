import { Router } from 'express'
import * as thinkingStore from '../core/thinkingStore'

export const thinkingRouter = Router()

thinkingRouter.get('/', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200)
  const offset = Number(req.query.offset) || 0
  const items = thinkingStore.list(offset, limit)
  const total = thinkingStore.count()
  res.json({ total, limit, offset, items })
})

thinkingRouter.get('/:sig', (req, res) => {
  const text = thinkingStore.lookup(req.params.sig)
  if (text == null) return res.status(404).json({ error: 'not found' })
  res.json({ signature: req.params.sig, thinking: text, length: text.length })
})

thinkingRouter.delete('/', (req, res) => {
  const sigs = req.body?.signatures
  if (!Array.isArray(sigs) || !sigs.length) return res.status(400).json({ error: 'signatures list required' })
  const deleted = thinkingStore.remove(sigs)
  res.json({ ok: true, deleted })
})
