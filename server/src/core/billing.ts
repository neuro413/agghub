import type { ApiKey, Caller, IRUsage, ModelRatio } from '../types'
import { contentToText } from '../convert/ir'

// 【签名桩】由「计费与限流」任务实现函数体；导出名称和参数类型不得修改，relay.ts 与鉴权中间件已按此调用。

/** 计费账户：现在只有 Key；预留以后的 { type: 'user', id } */
export interface BillingAccount {
  type: 'key'
  id: number
}

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
  return caller.key ? { type: 'key', id: caller.key.id } : null
}

/** 服务器本地日期 YYYY-MM-DD */
export function localDay(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 按请求模型名查倍率：精确 > 通配符非通配部分最长 > 列表顺序；无命中返回 null */
export function findRatio(ratios: ModelRatio[], model: string): ModelRatio | null {
  return ratios.find(r => r.pattern === model) ?? ratios.find(r => r.pattern === '*') ?? null
}

/** 点数公式（见方案 6.2），结果向上取整；produced=false 时不计 per_request */
export function computePoints(_ratio: ModelRatio, _usage: BillableUsage, _produced: boolean): number {
  return 0
}

/** 额度预检：总额度 quota_used < quota_total；今日 points < quota_daily；字段为 null 表示不限 */
export function precheckQuota(_key: ApiKey, _now = Date.now()): QuotaCheck {
  return { ok: true }
}

/** 记账：一个事务里累加 api_keys.quota_used / last_used_at，并 upsert usage_daily（requests +1） */
export function commitUsage(_account: BillingAccount, _entry: { points: number; prompt_tokens: number; completion_tokens: number }, _now = Date.now()): void {}

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
}

/**
 * 请求结束时调用一次：计算点数（usage 缺失时按 meter / estimatePrompt 估算），
 * Key 调用则记账。返回点数写入日志；未命中倍率返回 null。任何异常都不得抛出（内部捕获并 console.error）。
 */
export function settleRequest(_input: SettleInput): number | null {
  return null
}
