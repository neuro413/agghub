import { Router } from 'express'
import { handleRelay } from '../core/relay'
import * as oaiConv from '../convert/openai'
import { getSettings } from '../db'
import { modelsVisibleTo } from '../core/selector'
import { OWNER_CALLER } from '../core/caller'
import type { Caller } from '../types'

export const openaiEntry = Router()

// 对外 OpenAI 兼容入口
openaiEntry.post('/chat/completions', async (req, res) => {
  try {
    const { ir, stream } = oaiConv.parseRequest(req.body)
    await handleRelay({ entryFormat: 'openai', ir, stream, rawBody: req.body, rawHeaders: req.headers, res, caller: res.locals.caller })
  } catch (e: any) {
    if (!res.headersSent) {
      res.status(400).json({ error: { message: String(e?.message || e), type: 'invalid_request_error' } })
    }
  }
})

// 按调用方过滤：Key 只能看到自己分组内渠道的模型，再取模型白名单与倍率表的交集
openaiEntry.get('/models', (req, res) => {
  const caller: Caller = res.locals.caller ?? OWNER_CALLER
  const data = modelsVisibleTo(caller, getSettings().model_ratios)
    .map((id) => ({ id, object: 'model', created: 0, owned_by: 'agghub' }))
  res.json({ object: 'list', data })
})
