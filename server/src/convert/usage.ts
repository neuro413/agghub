import type { IRUsage } from '../types'

// 用量三方换算。IR 采用 OpenAI 语义：
//   IR prompt_tokens                            = 含缓存读写在内的输入总量
//   IR prompt_tokens_details.cached_tokens      = 缓存读取（命中）
//   IR prompt_tokens_details.cache_write_tokens = 缓存写入（创建）
// 各家上游：
//   Claude    input_tokens 不含缓存；cache_read_input_tokens / cache_creation_input_tokens 单独计，
//             cache_creation.ephemeral_5m_input_tokens / ephemeral_1h_input_tokens 是写入量按 TTL 的细分
//   OpenAI    Chat 的 prompt_tokens / Responses 的 input_tokens 已含缓存，明细在 *_tokens_details
//             （cached_tokens 读取、cache_write_tokens 写入；后者 GPT-5.6+ / OpenRouter / Kimi 同名）
//   Gemini    promptTokenCount 已含缓存，cachedContentTokenCount 为命中量，没有写入字段

export function emptyUsage(): IRUsage {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
}

function num(v: any): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 给 IR usage 挂上缓存明细（0 值不写，保持 usage 精简）*/
function withCache(out: IRUsage, cacheRead: number, cacheWrite: number): IRUsage {
  if (cacheRead || cacheWrite) {
    out.prompt_tokens_details = { ...(out.prompt_tokens_details || {}) }
    if (cacheRead) out.prompt_tokens_details.cached_tokens = cacheRead
    if (cacheWrite) out.prompt_tokens_details.cache_write_tokens = cacheWrite
  }
  return out
}

/** 从 IR usage 取缓存读取 / 写入量（日志落库用）*/
export function cacheParts(u: any): { cache_read_tokens: number; cache_write_tokens: number } {
  return {
    cache_read_tokens: num(u?.prompt_tokens_details?.cached_tokens),
    cache_write_tokens: num(u?.prompt_tokens_details?.cache_write_tokens),
  }
}

/** 合并流式累计 usage：新值非零才覆盖（上游中间 chunk 可能只带部分字段），缓存 / 推理明细按键合并 */
export function mergeUsage(acc: IRUsage, u: IRUsage): IRUsage {
  const prompt = u.prompt_tokens || acc.prompt_tokens
  const completion = u.completion_tokens || acc.completion_tokens
  const out: IRUsage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
  const pd = { ...(acc.prompt_tokens_details || {}), ...(u.prompt_tokens_details || {}) }
  if (Object.keys(pd).length) out.prompt_tokens_details = pd
  const cd = { ...(acc.completion_tokens_details || {}), ...(u.completion_tokens_details || {}) }
  if (Object.keys(cd).length) out.completion_tokens_details = cd
  return out
}

/** Claude usage 对象 → IR usage */
export function usageFromClaude(u: any): IRUsage {
  const input = num(u?.input_tokens)
  const cacheRead = num(u?.cache_read_input_tokens)
  // 写入总量为 cache_creation_input_tokens；缺失时用 cache_creation 的 TTL 细分兜底
  const cacheCreate =
    num(u?.cache_creation_input_tokens) ||
    num(u?.cache_creation?.ephemeral_5m_input_tokens) + num(u?.cache_creation?.ephemeral_1h_input_tokens)
  const output = num(u?.output_tokens)
  const prompt = input + cacheRead + cacheCreate
  const out: IRUsage = { prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output }
  return withCache(out, cacheRead, cacheCreate)
}

/** 合并 Claude message_delta 的累计 usage（含 output_tokens 与新版 API 的 input_tokens / 缓存字段）*/
export function mergeClaudeUsage(acc: IRUsage | null, delta: any): IRUsage {
  return usageFromClaude({ ...(acc ? usageToClaude(acc) : {}), ...(delta || {}) })
}

/** IR usage → Claude usage 对象（input_tokens 剔除缓存部分）*/
export function usageToClaude(u: any): any {
  const prompt = num(u?.prompt_tokens)
  const { cache_read_tokens: cacheRead, cache_write_tokens: cacheCreate } = cacheParts(u)
  const input = Math.max(0, prompt - cacheRead - cacheCreate)
  const out: any = { input_tokens: input, output_tokens: num(u?.completion_tokens) }
  if (cacheRead) out.cache_read_input_tokens = cacheRead
  if (cacheCreate) out.cache_creation_input_tokens = cacheCreate
  return out
}

/**
 * OpenAI Chat Completions usage（含各家兼容变体）→ IR usage。
 * 原始字段全部保留，只把缓存明细归一到 prompt_tokens_details.cached_tokens / cache_write_tokens：
 *   读取：官方 prompt_tokens_details.cached_tokens；DeepSeek 顶层 prompt_cache_hit_tokens；
 *         new-api 一类网关原样附在顶层的 cache_read_input_tokens
 *   写入：官方 prompt_tokens_details.cache_write_tokens；网关附加的 cache_creation_input_tokens
 */
export function usageFromOpenAI(u: any): IRUsage {
  const src = u && typeof u === 'object' ? u : {}
  const d = src.prompt_tokens_details && typeof src.prompt_tokens_details === 'object' ? src.prompt_tokens_details : {}
  const cacheRead = num(d.cached_tokens) || num(src.prompt_cache_hit_tokens) || num(src.cache_read_input_tokens)
  const cacheWrite = num(d.cache_write_tokens) || num(d.cache_creation_input_tokens) || num(src.cache_creation_input_tokens)
  let prompt = num(src.prompt_tokens)
  // 官方语义 prompt_tokens 已含缓存；若小于缓存合计，说明上游按 Claude 语义只给了未缓存量，补齐为总量
  if (prompt < cacheRead + cacheWrite) prompt += cacheRead + cacheWrite
  const completion = num(src.completion_tokens)
  const out: IRUsage = {
    ...src,
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Math.max(num(src.total_tokens), prompt + completion),
  }
  return withCache(out, cacheRead, cacheWrite)
}

/** Gemini usageMetadata → IR usage（promptTokenCount 已含缓存命中；thoughts 与 OpenAI 一样归入输出）*/
export function usageFromGemini(um: any): IRUsage {
  const prompt = num(um?.promptTokenCount)
  const thoughts = num(um?.thoughtsTokenCount)
  const completion = num(um?.candidatesTokenCount) + thoughts
  const out: IRUsage = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Math.max(num(um?.totalTokenCount), prompt + completion),
  }
  if (thoughts) out.completion_tokens_details = { reasoning_tokens: thoughts }
  return withCache(out, num(um?.cachedContentTokenCount), 0)
}

/** Responses usage → IR usage */
export function usageFromResponses(u: any): IRUsage {
  const prompt = num(u?.input_tokens)
  const completion = num(u?.output_tokens)
  const out: IRUsage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: num(u?.total_tokens) || prompt + completion }
  const reasoning = num(u?.output_tokens_details?.reasoning_tokens)
  if (reasoning) out.completion_tokens_details = { reasoning_tokens: reasoning }
  return withCache(out, num(u?.input_tokens_details?.cached_tokens), num(u?.input_tokens_details?.cache_write_tokens))
}

/** IR usage → Responses usage */
export function usageToResponses(u: any): any {
  const input = num(u?.prompt_tokens)
  const output = num(u?.completion_tokens)
  const { cache_read_tokens, cache_write_tokens } = cacheParts(u)
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: cache_read_tokens, cache_write_tokens },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: num(u?.completion_tokens_details?.reasoning_tokens) },
    total_tokens: num(u?.total_tokens) || input + output,
  }
}
