import { Router } from 'express'
import { getSettings } from '../db'
import { computePoints, findRatio } from '../core/billing'
import type { BillingPreviewResult } from '../types'

export const billingRouter = Router()

/** 缺省为 0；提供时必须是 ≥0 的安全整数，否则返回 null 表示非法 */
function nonNegInt(value: unknown): number | null {
  if (value === undefined) return 0
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null
  return value
}

// 倍率试算：输入模型名和各项 Token 数，返回命中的规则与点数（匹配逻辑只在后端写一份）
billingRouter.post('/preview', (req, res) => {
  const body: any = req.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: '试算参数无效' })
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  const prompt = nonNegInt(body.prompt_tokens)
  const completion = nonNegInt(body.completion_tokens)
  const cacheRead = nonNegInt(body.cache_read_tokens)
  const cacheWrite = nonNegInt(body.cache_write_tokens)
  if (!model || prompt === null || completion === null || cacheRead === null || cacheWrite === null) {
    return res.status(400).json({ error: '试算参数无效' })
  }
  const ratio = findRatio(getSettings().model_ratios, model)
  const points = ratio
    ? computePoints(ratio, { prompt_tokens: prompt, completion_tokens: completion, cache_read_tokens: cacheRead, cache_write_tokens: cacheWrite }, true)
    : null
  const result: BillingPreviewResult = { ratio, points }
  res.json(result)
})
