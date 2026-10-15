import { Router } from 'express'
import { getSettings } from '../db'
import { computePoints, findRatio } from '../core/billing'
import { getProxyAgent } from '../core/proxy'
import type { BillingPreviewResult, OpenRouterPrice } from '../types'

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

const OPENROUTER_MODELS = 'https://openrouter.ai/api/v1/models'
const OPENROUTER_TTL_MS = 10 * 60_000
let openRouterCache: { at: number; data: OpenRouterPrice[] } | null = null

/** OpenRouter 价格是「美元 / Token」的字符串；负数（自动路由等动态价格）视为无效 */
function usdPerToken(value: unknown): number | null {
  const n = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** 换算成每百万 Token，保留 6 位小数消掉浮点尾巴 */
function perMillion(usd: number): number {
  return Math.round(usd * 1e12) / 1e6
}

// 拉取 OpenRouter 公开的模型定价，供倍率页导入；走设置里的代理，结果缓存 10 分钟
billingRouter.get('/openrouter', async (_req, res) => {
  if (openRouterCache && Date.now() - openRouterCache.at < OPENROUTER_TTL_MS) return res.json(openRouterCache.data)
  const proxyUrl = getSettings().proxy_url
  try {
    const r = await fetch(OPENROUTER_MODELS, {
      signal: AbortSignal.timeout(20_000),
      dispatcher: proxyUrl ? getProxyAgent(proxyUrl) : undefined,
    } as any)
    if (!r.ok) return res.status(502).json({ error: `OpenRouter 返回 HTTP ${r.status}` })
    const body: any = await r.json()
    const data: OpenRouterPrice[] = []
    for (const model of Array.isArray(body?.data) ? body.data : []) {
      const pricing = model?.pricing
      const input = usdPerToken(pricing?.prompt)
      const output = usdPerToken(pricing?.completion)
      if (typeof model?.id !== 'string' || input == null || output == null) continue
      const cacheRead = usdPerToken(pricing?.input_cache_read)
      const cacheWrite = usdPerToken(pricing?.input_cache_write)
      data.push({
        id: model.id,
        name: typeof model.name === 'string' ? model.name : model.id,
        input: perMillion(input),
        output: perMillion(output),
        cache_read: cacheRead == null ? null : perMillion(cacheRead),
        cache_write: cacheWrite == null ? null : perMillion(cacheWrite),
        per_request: usdPerToken(pricing?.request) ?? 0,
      })
    }
    openRouterCache = { at: Date.now(), data }
    res.json(data)
  } catch (e: any) {
    res.status(502).json({ error: e?.name === 'TimeoutError' ? '拉取 OpenRouter 超时' : `拉取 OpenRouter 失败：${e?.message || e}` })
  }
})
