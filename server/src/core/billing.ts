import type { ApiKey, Caller, IRUsage, ModelRatio } from '../types'
import { contentToText } from '../convert/ir'
import { db } from '../db'
import { matchesPattern, patternSpecificity } from './modelPattern'

/** 计费账户：管理员发的 Key 扣 Key 自身额度；门户用户的 Key 扣用户余额，同时累计到 Key 上 */
export type BillingAccount =
  | { type: 'key'; id: number }
  | { type: 'user'; id: number; keyId: number }

export interface BillableUsage {
  /** 含缓存读写在内的输入总量（IR 语义） */
  prompt_tokens: number
  completion_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
}

export type QuotaCheck = { ok: true } | { ok: false; reason: 'total' | 'daily' }

// 假名、CJK 统一表意文字（含扩展 A）、谚文、兼容表意文字、全角符号
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g

function countCjk(text: string): number {
  return text.match(CJK)?.length ?? 0
}

/** 中日韩字符 1 个算 1 Token，其他 UTF-16 码元 4 个算 1 Token（向上取整） */
export function estimateTokens(text: string): number {
  const cjk = countCjk(text)
  return cjk + Math.ceil((text.length - cjk) / 4)
}

/** 只累计计数、不保存正文的输出计量器；与正文记录开关无关，用于 usage 缺失时估算输出 Token */
export class OutputMeter {
  private cjk = 0
  private other = 0
  append(text: unknown): void {
    if (typeof text !== 'string' || !text) return
    const cjk = countCjk(text)
    this.cjk += cjk
    this.other += text.length - cjk
  }
  /** 是否产生过输出 */
  get produced(): boolean { return this.cjk + this.other > 0 }
  /** 估算的输出 Token 数 */
  get estimate(): number { return this.cjk + Math.ceil(this.other / 4) }
}

/** 估算 IR 请求的输入 Token（系统提示与全部消息文本） */
export function estimateIRPrompt(ir: any): number {
  return estimateTokens((ir?.messages || []).map((m: any) => contentToText(m?.content)).join(' '))
}

/** Caller 对应的计费账户；owner 没有账户（只记录点数不扣费） */
export function accountOf(caller: Caller): BillingAccount | null {
  if (caller.user && caller.key) return { type: 'user', id: caller.user.id, keyId: caller.key.id }
  return caller.key ? { type: 'key', id: caller.key.id } : null
}

/** 服务器本地日期 YYYY-MM-DD */
export function localDay(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 按请求模型名查倍率：精确 > 通配符非通配部分最长 > 列表顺序；无命中返回 null */
export function findRatio(ratios: ModelRatio[], model: string): ModelRatio | null {
  let best: ModelRatio | null = null
  let bestScore = -1
  for (const ratio of ratios) {
    if (!matchesPattern(ratio.pattern, model)) continue
    const score = patternSpecificity(ratio.pattern)
    // 严格大于才替换，保证具体度相同时保留列表中靠前的那条
    if (score > bestScore) {
      best = ratio
      bestScore = score
    }
  }
  return best
}

/** 点数公式（见方案 6.2）再乘分组倍率，结果向上取整；produced=false 时不计 per_request */
export function computePoints(ratio: ModelRatio, usage: BillableUsage, produced: boolean, groupRatio = 1): number {
  const uncached = Math.max(0, usage.prompt_tokens - usage.cache_read_tokens - usage.cache_write_tokens)
  const raw = uncached * ratio.input
    + usage.cache_read_tokens * ratio.cache_read
    + usage.cache_write_tokens * ratio.cache_write
    + usage.completion_tokens * ratio.output
    + (produced ? ratio.per_request : 0)
  const total = raw * groupRatio
  // 先按 6 位小数四舍五入再向上取整，避免浮点误差把 6400.0000000001 抬成 6401
  return total > 0 ? Math.ceil(Math.round(total * 1e6) / 1e6) : 0
}

const dailyPointsStmt = db.prepare(
  `SELECT points FROM usage_daily WHERE account_type = 'key' AND account_id = ? AND day = ?`,
)
const addUsedStmt = db.prepare('UPDATE api_keys SET quota_used = quota_used + ?, last_used_at = ? WHERE id = ?')
const upsertDailyStmt = db.prepare(
  `INSERT INTO usage_daily (account_type, account_id, day, requests, points, prompt_tokens, completion_tokens)
   VALUES (?, ?, ?, 1, ?, ?, ?)
   ON CONFLICT(account_type, account_id, day) DO UPDATE SET
     requests = requests + 1,
     points = points + excluded.points,
     prompt_tokens = prompt_tokens + excluded.prompt_tokens,
     completion_tokens = completion_tokens + excluded.completion_tokens`,
)
const commitTx = db.transaction((accountId: number, day: string, now: number, points: number, prompt: number, completion: number) => {
  addUsedStmt.run(points, now, accountId)
  upsertDailyStmt.run('key', accountId, day, points, prompt, completion)
})
const chargeUserStmt = db.prepare('UPDATE users SET quota = quota - ?, used_quota = used_quota + ?, request_count = request_count + 1 WHERE id = ?')
const commitUserTx = db.transaction((userId: number, keyId: number, day: string, now: number, points: number, prompt: number, completion: number) => {
  chargeUserStmt.run(points, points, userId)
  addUsedStmt.run(points, now, keyId)
  upsertDailyStmt.run('user', userId, day, points, prompt, completion)
  upsertDailyStmt.run('key', keyId, day, points, prompt, completion)
})

/** 额度预检：总额度 quota_used < quota_total；今日 points < quota_daily；字段为 null 表示不限 */
export function precheckQuota(key: ApiKey, now = Date.now()): QuotaCheck {
  if (key.quota_total != null && key.quota_used >= key.quota_total) return { ok: false, reason: 'total' }
  if (key.quota_daily != null) {
    const row = dailyPointsStmt.get(key.id, localDay(now)) as { points: number } | undefined
    if ((row?.points ?? 0) >= key.quota_daily) return { ok: false, reason: 'daily' }
  }
  return { ok: true }
}

/**
 * 记账：一个事务里累加 api_keys.quota_used / last_used_at，并 upsert usage_daily（requests +1）；
 * 用户账户另外扣 users.quota、累加 used_quota / request_count，用户与 Key 各记一条每日用量。
 */
export function commitUsage(account: BillingAccount, entry: { points: number; prompt_tokens: number; completion_tokens: number }, now = Date.now()): void {
  if (account.type === 'user') commitUserTx(account.id, account.keyId, localDay(now), now, entry.points, entry.prompt_tokens, entry.completion_tokens)
  else commitTx(account.id, localDay(now), now, entry.points, entry.prompt_tokens, entry.completion_tokens)
}

export interface SettleInput {
  caller: Caller
  /** 客户端请求的模型名（映射前） */
  model: string | null
  ratios: ModelRatio[]
  /** 最终结果的 usage（可能为部分 usage 或全 0） */
  usage: IRUsage
  /** 最终尝试的输出计量器；没有任何尝试时为 null */
  meter: OutputMeter | null
  /** 最终结果是否成功；失败（含客户端中断）时 usage 可能不完整 */
  success: boolean
  /** 惰性估算输入 Token（仅在 usage.prompt_tokens 为 0 且需要时调用） */
  estimatePrompt: () => number
  /** 本次命中分组的倍率，缺省 1 */
  groupRatio?: number
}

/**
 * 请求结束时调用一次：计算点数（usage 缺失时按 meter / estimatePrompt 估算），
 * Key 调用则记账。返回点数写入日志；未命中倍率返回 null。任何异常都不得抛出（内部捕获并 console.error）。
 */
export function settleRequest(input: SettleInput): number | null {
  try {
    const { caller, model, ratios, usage, meter, success, estimatePrompt, groupRatio = 1 } = input
    const account = accountOf(caller)
    const produced = !!meter?.produced
    let prompt = usage.prompt_tokens || 0
    let completion = usage.completion_tokens || 0
    const cacheRead = usage.prompt_tokens_details?.cached_tokens || 0
    const cacheWrite = usage.prompt_tokens_details?.cache_write_tokens || 0
    // 失败（含客户端中断）或上游没报输出量时，用计量器估算的输出兜底
    if (produced && (!success || completion === 0)) completion = Math.max(completion, meter!.estimate)
    // 产生了输出但上游没报输入量时估算输入
    if (produced && prompt === 0) prompt = estimatePrompt()
    const ratio = model ? findRatio(ratios, model) : null
    const points = ratio
      ? computePoints(ratio, { prompt_tokens: prompt, completion_tokens: completion, cache_read_tokens: cacheRead, cache_write_tokens: cacheWrite }, produced, groupRatio)
      : null
    // Key 调用无论成功失败都记账一次（requests +1），owner 不记账
    if (account) commitUsage(account, { points: points ?? 0, prompt_tokens: prompt, completion_tokens: completion })
    return points
  } catch (error) {
    console.error('[agghub] 计费记账失败:', error)
    return null
  }
}
