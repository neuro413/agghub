import { DEFAULT_SETTINGS, INTEGER_RANGES } from '../config'
import type { Settings } from '../types'
import { parseSafePath } from './safePath'

export class SettingsValidationError extends Error {
  readonly status = 400
  constructor(readonly fields: Record<string, string>) {
    super(Object.entries(fields).map(([key, message]) => `${key}: ${message}`).join('；'))
  }
}

export function validateThinkingTags(open: unknown, close: unknown): void {
  if (typeof open !== 'string' || !open.trim() || open.length > 256) throw new Error('开始标签须为 1～256 字符的非空文本')
  if (typeof close !== 'string' || !close.trim() || close.length > 256) throw new Error('结束标签须为 1～256 字符的非空文本')
  if (open === close) throw new Error('开始标签和结束标签不能相同')
}

/** 空串显式关闭鉴权，历史非法非空值始终报错，不隐式降级为免鉴权。 */
export function normalizeAccessToken(value: unknown): string {
  if (typeof value !== 'string') throw new Error('令牌必须为字符串')
  if (value === '') return ''
  if (/[\x00-\x1f\x7f-￿]/.test(value)) throw new Error('令牌只能包含可用于 HTTP 请求头的可打印 ASCII 字符')
  const token = value.trim()
  if (!token) throw new Error('仅含空白的令牌无效；关闭鉴权请明确保存空串')
  if (token.length > 1024) throw new Error('令牌不能超过 1024 字符')
  return token
}

const booleans = Object.keys(DEFAULT_SETTINGS).filter(key => typeof DEFAULT_SETTINGS[key as keyof Settings] === 'boolean')
const formats = new Set(['openai', 'anthropic', 'responses'])
const roles = new Set(['system', 'user', 'assistant', 'tool'])
function object(value: any): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function strings(value: any): boolean {
  return Array.isArray(value) && value.every(v => typeof v === 'string' && v.length > 0)
}
function ids(value: any): boolean {
  return Array.isArray(value) && value.every(v => Number.isSafeInteger(v) && v > 0)
}

/** 对合并后的完整设置校验，调用者仅保存规范化后的 patch。 */
export function validateSettingsPatch(current: Settings, input: unknown): Record<string, unknown> {
  const errors: Record<string, string> = Object.create(null)
  const check = (condition: boolean, key: string, message: string) => { if (!condition) errors[key] = message }
  if (!object(input)) throw new SettingsValidationError({ settings: '设置必须为 JSON 对象' })
  const patch: Record<string, any> = {}
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) errors[key] = '未知设置字段'
    else patch[key] = input[key]
  }
  const merged: Record<string, any> = { ...current, ...patch }
  for (const [key, [min, max]] of Object.entries(INTEGER_RANGES) as [string, [number, number]][]) {
    check(Number.isSafeInteger(merged[key]) && merged[key] >= min && merged[key] <= max, key, `须为 ${min}～${max} 的整数`)
  }
  for (const key of booleans) check(typeof merged[key] === 'boolean', key, '须为布尔值')
  for (const key of ['drop_thinking_channel_ids', 'pseudo_thinking_channel_ids']) check(ids(merged[key]), key, '须为正整数渠道 ID 数组')
  for (const key of ['drop_thinking_models', 'pseudo_thinking_models']) check(strings(merged[key]), key, '须为非空字符串数组')
  check(typeof merged.auto_ban_codes === 'string' && /^(?:[1-5]\d{2}(?:\s*,\s*[1-5]\d{2})*)?$/.test(merged.auto_ban_codes), 'auto_ban_codes', '须为逗号分隔的 HTTP 状态码或空串')
  check(typeof merged.pseudo_thinking_prompt === 'string' && merged.pseudo_thinking_prompt.length <= 100_000, 'pseudo_thinking_prompt', '须为不超过 100000 字符的字符串')
  try { validateThinkingTags(merged.pseudo_thinking_open_tag, merged.pseudo_thinking_close_tag) } catch (error) {
    errors.pseudo_thinking_open_tag = (error as Error).message
  }
  try {
    const token = normalizeAccessToken(merged.access_token)
    if (Object.hasOwn(patch, 'access_token')) patch.access_token = token
  } catch (error) { errors.access_token = (error as Error).message }
  try {
    if (typeof merged.proxy_url !== 'string') throw new Error()
    if (merged.proxy_url) {
      const url = new URL(merged.proxy_url)
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error()
    }
  } catch { errors.proxy_url = '须为空串或有效的 HTTP/HTTPS 代理地址' }
  for (const key of ['preprocess_rules', 'tool_filter_rules', 'param_rules']) {
    const rules = merged[key]
    if (!Array.isArray(rules)) { errors[key] = '须为规则数组'; continue }
    const seen = new Set<string>()
    rules.forEach((rule, index) => {
      const at = `${key}[${index}]`
      if (!object(rule)) { errors[at] = '规则须为对象'; return }
      check(typeof rule.id === 'string' && !!rule.id && !seen.has(rule.id), `${at}.id`, 'ID 须为非空且不重复的字符串')
      seen.add(rule.id)
      check(typeof rule.enabled === 'boolean', `${at}.enabled`, '须为布尔值')
      if (rule.name !== undefined) check(typeof rule.name === 'string', `${at}.name`, '须为字符串')
      if (rule.channelIds !== undefined) check(ids(rule.channelIds), `${at}.channelIds`, '须为正整数数组')
      if (rule.models !== undefined) check(strings(rule.models), `${at}.models`, '须为模型名数组')
      if (rule.formats !== undefined) check(Array.isArray(rule.formats) && rule.formats.every((v: any) => formats.has(v)), `${at}.formats`, '含不支持的入口格式')
      const regex = (op: any, where: string) => {
        check(typeof op.pattern === 'string', `${where}.pattern`, '须为字符串')
        check(typeof op.replacement === 'string', `${where}.replacement`, '须为字符串')
        check(typeof op.flags === 'string', `${where}.flags`, '须为字符串')
        try { new RegExp(op.pattern, op.flags) } catch { errors[where] = '正则表达式无效' }
      }
      if (key === 'preprocess_rules') {
        check(['visual', 'regex'].includes(rule.source), `${at}.source`, '须为 visual 或 regex')
        if (rule.roles !== undefined) check(Array.isArray(rule.roles) && rule.roles.every((v: any) => roles.has(v)), `${at}.roles`, '含不支持的角色')
        if (rule.depth !== undefined) check(Number.isSafeInteger(rule.depth) && rule.depth >= 0 && rule.depth <= 100_000, `${at}.depth`, '须为 0～100000 的整数')
        regex(rule, at)
      } else if (key === 'tool_filter_rules') check(strings(rule.tools), `${at}.tools`, '须为工具名数组')
      else {
        if (!Array.isArray(rule.ops)) { errors[`${at}.ops`] = '须为操作数组'; return }
        rule.ops.forEach((op: any, i: number) => {
          const where = `${at}.ops[${i}]`
          if (!object(op)) { errors[where] = '操作须为对象'; return }
          if (op.type === 'regex') regex(op, where)
          else if (['set', 'set_if_missing', 'set_if_present', 'delete'].includes(op.type)) {
            try { parseSafePath(op.key) } catch (error) { errors[`${where}.key`] = (error as Error).message }
            if (op.type !== 'delete') check(typeof op.value === 'string', `${where}.value`, '须为字符串形式的参数值')
          } else errors[`${where}.type`] = '未知操作类型'
        })
      }
    })
  }
  if (Object.keys(errors).length) throw new SettingsValidationError(errors)
  return patch
}
