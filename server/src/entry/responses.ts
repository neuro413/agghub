import { Router } from 'express'
import { handleRelay } from '../core/relay'
import * as respConv from '../convert/responses'

export const responsesEntry = Router()

// 对外 OpenAI Responses 入口：POST /v1/responses
// 上游为 Responses 渠道时直通（保留有状态字段与内置工具）；其余渠道经 IR 转换
responsesEntry.post('/responses', async (req, res) => {
  try {
    const { ir, stream } = respConv.parseRequest(req.body)
    await handleRelay({ entryFormat: 'responses', ir, stream, rawBody: req.body, rawHeaders: req.headers, res })
  } catch (e: any) {
    if (!res.headersSent) {
      res.status(400).json({ error: { message: String(e?.message || e), type: 'invalid_request_error' } })
    }
  }
})
