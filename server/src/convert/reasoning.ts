import crypto from 'node:crypto'
import type { IRReasoning, IRReasoningItem } from '../types'

// 推理意图与推理块的跨格式工具：
//   1. Responses reasoning.effort ⇄ Claude thinking.budget_tokens 的档位互转
//   2. Claude thinking 块 ⇄ Responses reasoning 项 encrypted_content 的无状态编解码

// ─────────────────────────── 档位互转 ───────────────────────────

export const EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** effort → Claude budget_tokens */
export function effortToBudget(effort: string | undefined): number | null {
  switch (effort) {
    case 'none':
      return null
    case 'minimal':
    case 'low':
      return 2048
    case 'medium':
      return 8192
    case 'high':
      return 16384
    case 'xhigh':
    case 'max':
      return 32768
    default:
      return 8192
  }
}

/** Claude budget_tokens → effort */
export function budgetToEffort(budget: number): string {
  if (budget < 4096) return 'low'
  if (budget < 12288) return 'medium'
  return 'high'
}

export function isKnownEffort(v: any): v is (typeof EFFORT_LEVELS)[number] {
  return typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v)
}

/** Claude output_config.effort 只接受 low/medium/high/xhigh/max */
export function effortForClaude(effort: string | undefined): string | undefined {
  switch (effort) {
    case 'minimal':
    case 'low':
      return 'low'
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return effort
    default:
      return undefined
  }
}

export type ClaudeThinkingMode = 'adaptive' | 'adaptive-legacy' | 'budget'

/**
 * 按模型名判断 Claude thinking 的写法：
 *   adaptive         4.7+ / 5 / fable / mythos：adaptive + display:'summarized' + output_config.effort；采样参数会被 400
 *   adaptive-legacy  4.6：adaptive + effort；采样参数仍可用；budget_tokens 已弃用
 *   budget           4.5 及更早、或非 claude 命名的第三方模型：enabled + budget_tokens
 */
export function claudeThinkingMode(model: string): ClaudeThinkingMode {
  const m = (model || '').toLowerCase()
  if (!m.includes('claude')) return 'budget'
  if (/fable|mythos/.test(m)) return 'adaptive'
  const fam = /(opus|sonnet|haiku)[-_ ]?(\d+)(?:[-_.](\d+))?/.exec(m)
  if (!fam) return 'budget'
  const major = Number(fam[2])
  const minor = fam[3] != null ? Number(fam[3]) : 0
  // 形如 claude-3-5-sonnet 的旧命名：数字在前
  if (/claude-\d/.test(m) && !/claude-(opus|sonnet|haiku)/.test(m)) return 'budget'
  if (major >= 5) return 'adaptive'
  if (major === 4 && minor >= 7) return 'adaptive'
  if (major === 4 && minor === 6) return 'adaptive-legacy'
  return 'budget'
}

/** Claude 请求的 thinking / output_config → IRReasoning；两者都缺时返回 undefined */
export function reasoningFromClaude(body: any): IRReasoning | undefined {
  const t = body?.thinking
  const effort = body?.output_config?.effort
  if (!t && !effort) return undefined
  const r: IRReasoning = {}
  if (t?.type === 'disabled') {
    r.disabled = true
    r.effort = 'none'
    return r
  }
  if (typeof t?.budget_tokens === 'number' && t.budget_tokens > 0) {
    r.budget_tokens = t.budget_tokens
    r.effort = budgetToEffort(t.budget_tokens)
  }
  if (isKnownEffort(effort)) r.effort = effort
  else if (!r.effort && (t?.type === 'enabled' || t?.type === 'adaptive')) r.effort = 'high'
  return r
}

/** Responses 请求的 reasoning → IRReasoning */
export function reasoningFromResponses(body: any): IRReasoning | undefined {
  const src = body?.reasoning
  if (!src || typeof src !== 'object') return undefined
  const r: IRReasoning = {}
  if (isKnownEffort(src.effort)) {
    r.effort = src.effort
    if (src.effort === 'none') r.disabled = true
  }
  if (typeof src.summary === 'string') r.summary = src.summary
  return Object.keys(r).length ? r : undefined
}

// ─────────────────────────── 无状态密文编解码 ───────────────────────────
// Claude 上游 → Responses 客户端：把 thinking 正文 + 签名（或 redacted data）打包进 encrypted_content。
// 客户端下一轮原样回传后，Responses 入口解包还原成 thinking 块，满足 Claude
// 「带 tool_use 的 assistant 消息必须以 thinking 开头」的约束。

const ENC_MAGIC = 'agghub1:'

interface EncPayload {
  v: 1
  p: 'anthropic'
  t?: string
  s?: string
  r?: string
}

export function encodeReasoningItem(item: IRReasoningItem): string {
  const payload: EncPayload = { v: 1, p: 'anthropic' }
  if (item.redacted) payload.r = item.redacted
  else {
    if (item.text) payload.t = item.text
    if (item.signature) payload.s = item.signature
  }
  return ENC_MAGIC + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
}

/** 解码 agghub 自产的 encrypted_content；不是本网关产物时返回 null */
export function decodeReasoningItem(encrypted: any): IRReasoningItem | null {
  if (typeof encrypted !== 'string' || !encrypted.startsWith(ENC_MAGIC)) return null
  try {
    const payload = JSON.parse(Buffer.from(encrypted.slice(ENC_MAGIC.length), 'base64').toString('utf8')) as EncPayload
    if (payload?.v !== 1 || payload.p !== 'anthropic') return null
    const item: IRReasoningItem = {}
    if (payload.r) item.redacted = payload.r
    if (payload.t) item.text = payload.t
    if (payload.s) item.signature = payload.s
    return item
  } catch {
    return null
  }
}

/** 由签名 / 密文派生稳定的 rs_ 项 id：同一块每次生成相同 id */
export function stableReasoningId(seed: string): string {
  return 'rs_' + crypto.createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 24)
}

/** 把 reasoning_items 拼成可读文本（派生视图）*/
export function reasoningItemsText(items: IRReasoningItem[] | undefined): string {
  if (!Array.isArray(items)) return ''
  return items
    .map((it) => it.text || '')
    .filter(Boolean)
    .join('\n\n')
}
