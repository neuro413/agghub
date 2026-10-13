import { Router } from 'express'
import { handleRelay } from '../core/relay'
import * as anthConv from '../convert/anthropic'

export const anthropicEntry = Router()

// 对外 Anthropic 原生入口
anthropicEntry.post('/messages', async (req, res) => {
  try {
    const { ir, stream } = anthConv.parseRequest(req.body)
    await handleRelay({ entryFormat: 'anthropic', ir, stream, rawBody: req.body, rawHeaders: req.headers, res, caller: res.locals.caller })
  } catch (e: any) {
    if (!res.headersSent) {
      res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: String(e?.message || e) } })
    }
  }
})
