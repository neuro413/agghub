import { matchesPattern, patternSpecificity } from '../../../server/src/core/modelPattern'
import { amountText, priceToRatio, ratioToPrice, toPoints, trimNum } from '../lib/money'
import type { ModelRatio, OpenRouterPrice } from '../types'

export const PRICE_FIELDS = ['input', 'output', 'cache_read', 'cache_write', 'per_request'] as const
export type PriceField = (typeof PRICE_FIELDS)[number]
/** Token 价格为「金额 / 1M Token」，按次为「金额 / 次」，保留输入框原文 */
export type Prices = Record<PriceField, string>

/** 编辑中的定价规则：保存时再换算回每 Token 倍率 */
export interface PriceRow extends Prices {
  id: string
  pattern: string
}

export function fromRatio(r: ModelRatio): PriceRow {
  return {
    id: r.id,
    pattern: r.pattern,
    input: trimNum(ratioToPrice(r.input)),
    output: trimNum(ratioToPrice(r.output)),
    cache_read: trimNum(ratioToPrice(r.cache_read)),
    cache_write: trimNum(ratioToPrice(r.cache_write)),
    per_request: amountText(r.per_request),
  }
}

export function toRatio(r: PriceRow): ModelRatio {
  return {
    id: r.id,
    pattern: r.pattern.trim(),
    input: priceToRatio(Number(r.input)),
    output: priceToRatio(Number(r.output)),
    cache_read: priceToRatio(Number(r.cache_read)),
    cache_write: priceToRatio(Number(r.cache_write)),
    per_request: toPoints(Number(r.per_request)),
  }
}

export function pickPrices(r: Prices): Prices {
  return { input: r.input, output: r.output, cache_read: r.cache_read, cache_write: r.cache_write, per_request: r.per_request }
}

/** 价格必须填写且为不小于 0 的数字 */
export function validPrice(v: string): boolean {
  return v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0
}

/** 按编辑中的规则找命中的那条，与后端 findRatio 同一套规则：精确 > 通配非通配部分最长 > 列表顺序 */
export function findRow(rows: PriceRow[], model: string): PriceRow | null {
  let best: PriceRow | null = null
  let bestScore = -1
  for (const row of rows) {
    const pattern = row.pattern.trim()
    if (!pattern || !matchesPattern(pattern, model)) continue
    const score = patternSpecificity(pattern)
    if (score > bestScore) {
      best = row
      bestScore = score
    }
  }
  return best
}

/** 去掉厂商前缀和 :free 之类的变体后缀，小写，点、下划线、空格统一成连字符 */
function normalize(id: string): string {
  return id.toLowerCase().replace(/^.*\//, '').replace(/:.*$/, '').replace(/[._\s]+/g, '-')
}

const VERSION_SUFFIX = /-(\d{8}|\d{4}-\d{2}-\d{2}|\d{2}-\d{2}|\d{3,4}|latest|preview|exp|thinking)$/

/** 再去掉日期、latest、preview 等版本后缀，用于最后一轮宽松匹配 */
function loose(id: string): string {
  let s = normalize(id)
  for (let prev = ''; prev !== s; ) {
    prev = s
    s = s.replace(VERSION_SUFFIX, '')
  }
  return s
}

/** 本地模型名 → OpenRouter 定价：完整 id > 归一化名 > 去版本后缀，逐轮放宽 */
export function openRouterMatcher(list: OpenRouterPrice[]): (model: string) => OpenRouterPrice | null {
  // 不带 :变体 的优先，其次 id 短的优先，避免匹配到 :free 或带日期的旧版本
  const sorted = [...list].sort((a, b) => Number(a.id.includes(':')) - Number(b.id.includes(':')) || a.id.length - b.id.length)
  const exact = new Map<string, OpenRouterPrice>()
  const normal = new Map<string, OpenRouterPrice>()
  const wide = new Map<string, OpenRouterPrice>()
  const add = (map: Map<string, OpenRouterPrice>, key: string, price: OpenRouterPrice) => {
    if (!map.has(key)) map.set(key, price)
  }
  for (const price of sorted) {
    add(exact, price.id.toLowerCase(), price)
    add(normal, normalize(price.id), price)
    add(wide, loose(price.id), price)
  }
  return (model) => exact.get(model.toLowerCase()) ?? normal.get(normalize(model)) ?? wide.get(loose(model)) ?? null
}

/** OpenRouter 没给缓存价格时按输入价计 */
export function openRouterPrices(p: OpenRouterPrice): Prices {
  return {
    input: trimNum(p.input),
    output: trimNum(p.output),
    cache_read: trimNum(p.cache_read ?? p.input),
    cache_write: trimNum(p.cache_write ?? p.input),
    per_request: trimNum(p.per_request),
  }
}
