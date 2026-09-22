import type { ParamOp, ParamRule, Settings, WireFormat } from '../types'
import { ruleMatchesMeta } from './preprocess'
import type { PreprocessMeta } from './preprocess'

/**
 * 参数修改规则：在发往上游的「最终请求体」上增删改顶层 / 嵌套参数，或对排除消息后的
 * 请求体 JSON 文本做正则替换。用于给兼容性欠佳的上游 API 清理 / 补齐参数。
 *
 * 与提示词预处理不同，本步骤在 adaptor 构造完上游请求之后执行，因此：
 *  - 同格式直通时作用于客户端原始 body（model / stream 已替换）
 *  - 跨格式转换时作用于转换后的上游格式 body
 *  - 可以删掉 adaptor 自动补的字段（如 stream_options）
 */

type ScopeMeta = Pick<PreprocessMeta, 'entryFormat' | 'channelId' | 'model'>

/** 各上游格式的受保护字段：消息 / 系统提示交给提示词预处理；stream 由中继决定，不允许改 */
const PROTECTED_KEYS: Record<WireFormat, string[]> = {
  openai: ['messages', 'stream'],
  anthropic: ['messages', 'system', 'stream'],
  gemini: ['contents', 'systemInstruction', 'system_instruction'],
  responses: ['input', 'instructions', 'stream'],
}

export function protectedKeysFor(wire: WireFormat): Set<string> {
  return new Set(PROTECTED_KEYS[wire] || PROTECTED_KEYS.openai)
}

/** 命中本次请求的启用规则（按配置顺序）*/
export function matchParamRules(settings: Settings, meta: ScopeMeta): ParamRule[] {
  const out: ParamRule[] = []
  for (const rule of settings.param_rules || []) {
    if (!rule?.enabled || !Array.isArray(rule.ops) || !rule.ops.length) continue
    if (!ruleMatchesMeta(rule, meta)) continue
    out.push(rule)
  }
  return out
}

/** 值文本 → JSON 值：能解析就用解析结果（数字 / 布尔 / null / 对象 / 数组），否则按字符串 */
export function parseValue(text: string | undefined): any {
  const t = (text ?? '').trim()
  if (!t) return ''
  try {
    return JSON.parse(t)
  } catch {
    return t
  }
}

function splitPath(key: string | undefined): string[] {
  return (key ?? '')
    .split('.')
    .map((s) => s.trim())
    .filter(Boolean)
}

function isIndex(seg: string): boolean {
  return /^\d+$/.test(seg)
}

function isContainer(v: any): boolean {
  return v !== null && typeof v === 'object'
}

/** 读取路径值；不存在返回 undefined */
function getPath(obj: any, segs: string[]): any {
  let cur = obj
  for (const seg of segs) {
    if (!isContainer(cur)) return undefined
    cur = Array.isArray(cur) ? (isIndex(seg) ? cur[Number(seg)] : undefined) : cur[seg]
    if (cur === undefined) return undefined
  }
  return cur
}

/** 写入路径值；中间层缺失或不是容器时创建为对象 */
function setPath(obj: any, segs: string[], value: any): void {
  let cur = obj
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]
    const k: any = Array.isArray(cur) && isIndex(seg) ? Number(seg) : seg
    if (!isContainer(cur[k])) cur[k] = {}
    cur = cur[k]
  }
  const last = segs[segs.length - 1]
  if (Array.isArray(cur) && isIndex(last)) cur[Number(last)] = value
  else cur[last] = value
}

/** 删除路径值；返回是否真的删掉了东西 */
function deletePath(obj: any, segs: string[]): boolean {
  const parent = segs.length > 1 ? getPath(obj, segs.slice(0, -1)) : obj
  if (!isContainer(parent)) return false
  const last = segs[segs.length - 1]
  if (Array.isArray(parent)) {
    if (!isIndex(last) || Number(last) >= parent.length) return false
    parent.splice(Number(last), 1)
    return true
  }
  if (!(last in parent)) return false
  delete parent[last]
  return true
}

export interface ParamApplyResult {
  body: any
  changed: boolean
  /** 被跳过的操作说明（正则无效 / 结果非 JSON / 受保护字段等）*/
  errors: string[]
}

/** 对已解析的请求体对象就地应用规则 */
export function applyParamRulesToObject(body: any, wire: WireFormat, rules: ParamRule[]): ParamApplyResult {
  const errors: string[] = []
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { body, changed: false, errors }
  const protectedKeys = protectedKeysFor(wire)
  const before = JSON.stringify(body)

  for (const rule of rules) {
    const label = rule.name || rule.id
    for (const op of rule.ops || []) {
      if (!op) continue
      try {
        if (op.type === 'regex') {
          applyRegexOp(body, op, protectedKeys, errors, label)
          continue
        }
        const segs = splitPath(op.key)
        if (!segs.length) {
          errors.push(`[${label}] ${op.type}: 参数名为空，已跳过`)
          continue
        }
        if (protectedKeys.has(segs[0])) {
          errors.push(`[${label}] ${op.type} ${op.key}: ${segs[0]} 为受保护字段，已跳过`)
          continue
        }
        if (op.type === 'delete') {
          deletePath(body, segs)
        } else if (op.type === 'set') {
          setPath(body, segs, parseValue(op.value))
        } else if (op.type === 'set_if_missing') {
          if (getPath(body, segs) === undefined) setPath(body, segs, parseValue(op.value))
        } else if (op.type === 'set_if_present') {
          if (getPath(body, segs) !== undefined) setPath(body, segs, parseValue(op.value))
        } else {
          errors.push(`[${label}] 未知操作类型 ${String((op as any).type)}，已跳过`)
        }
      } catch (e: any) {
        errors.push(`[${label}] ${op.type} ${op.key ?? ''}: ${String(e?.message || e)}`)
      }
    }
  }

  const changed = JSON.stringify(body) !== before
  return { body, changed, errors }
}

/** 正则操作：把受保护字段之外的部分序列化为紧凑 JSON 文本做替换，再解析回写 */
function applyRegexOp(body: any, op: ParamOp, protectedKeys: Set<string>, errors: string[], label: string): void {
  if (!op.pattern) {
    errors.push(`[${label}] regex: 正则为空，已跳过`)
    return
  }
  let re: RegExp
  try {
    re = new RegExp(op.pattern, op.flags || 'g')
  } catch {
    errors.push(`[${label}] regex: 正则表达式无效，已跳过`)
    return
  }
  const rest: Record<string, any> = {}
  for (const [k, v] of Object.entries(body)) if (!protectedKeys.has(k)) rest[k] = v
  const text = JSON.stringify(rest)
  const replaced = text.replace(re, op.replacement ?? '')
  if (replaced === text) return
  let parsed: any
  try {
    parsed = JSON.parse(replaced)
  } catch {
    errors.push(`[${label}] regex: 替换结果不是合法 JSON，已跳过`)
    return
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    errors.push(`[${label}] regex: 替换结果不是 JSON 对象，已跳过`)
    return
  }
  for (const k of Object.keys(body)) if (!protectedKeys.has(k)) delete body[k]
  Object.assign(body, parsed)
}

/**
 * 对上游请求体 JSON 字符串应用规则。
 * 返回 { body: 改写后的 JSON 字符串（未改动为 null）, errors: 被跳过的操作说明 }。
 */
export function applyParamRules(bodyJson: string, wire: WireFormat, rules: ParamRule[]): { body: string | null; errors: string[] } {
  let body: any
  try {
    body = JSON.parse(bodyJson)
  } catch {
    return { body: null, errors: ['上游请求体不是合法 JSON，参数规则未应用'] }
  }
  const res = applyParamRulesToObject(body, wire, rules)
  return { body: res.changed ? JSON.stringify(res.body) : null, errors: res.errors }
}
