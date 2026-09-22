import { Router } from 'express'
import { handleRelay } from '../core/relay'
import * as oaiConv from '../convert/openai'
import { enabledChannels } from '../db'

export const openaiEntry = Router()

// 对外 OpenAI 兼容入口
openaiEntry.post('/chat/completions', async (req, res) => {
  try {
    const { ir, stream } = oaiConv.parseRequest(req.body)
    await handleRelay({ entryFormat: 'openai', ir, stream, rawBody: req.body, rawHeaders: req.headers, res })
  } catch (e: any) {
    if (!res.headersSent) {
      res.status(400).json({ error: { message: String(e?.message || e), type: 'invalid_request_error' } })
    }
  }
})

// 聚合所有启用渠道的模型（含 model_mapping 的别名）
openaiEntry.get('/models', (_req, res) => {
  const set = new Set<string>()
  for (const c of enabledChannels()) {
    for (const m of c.models) set.add(m)
    if (c.model_mapping) for (const k of Object.keys(c.model_mapping)) set.add(k)
  }
  const data = [...set].sort().map((id) => ({ id, object: 'model', created: 0, owned_by: 'agghub' }))
  res.json({ object: 'list', data })
})
