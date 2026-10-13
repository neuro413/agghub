import { Router } from 'express'
import { handleRelay } from '../core/relay'
import * as oaiConv from '../convert/openai'
import { enabledChannels, getSettings } from '../db'
import { channelVisibleTo, keyAllowsModel } from '../core/selector'
import { findRatio } from '../core/billing'
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
  const ratios = getSettings().model_ratios
  const set = new Set<string>()
  for (const c of enabledChannels()) {
    if (!channelVisibleTo(c, caller)) continue
    for (const m of c.models) set.add(m)
    if (c.model_mapping) for (const k of Object.keys(c.model_mapping)) set.add(k)
  }
  const data = [...set]
    .filter(id => keyAllowsModel(caller, id) && (!caller.key || findRatio(ratios, id)))
    .sort()
    .map((id) => ({ id, object: 'model', created: 0, owned_by: 'agghub' }))
  res.json({ object: 'list', data })
})
