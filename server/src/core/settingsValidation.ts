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
const sources = new Set(['owner', 'lan_key', 'public_key', 'user', 'probe'])
const RATIO_FIELDS = ['input', 'output', 'cache_read', 'cache_write']
/** 按次点数的上限与额度一致，Token 倍率 100 万已相当于每百万 Token 上百万美元 */
const PER_REQUEST_MAX = 1_000_000_000_000
function object(value: any): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function text(value: any, max: number): boolean {
  return typeof value === 'string' && !!value.trim() && value.length <= max
}
/** 品牌图标：上传后的门户地址、http(s) 图片链接，或不超过 16 字符的 emoji / 文字 */
function brandIcon(value: any): boolean {
  if (typeof value !== 'string') return false
  if (value.startsWith('/api/user/brand-icon')) return value.length <= 128
  if (/^https?:\/\//i.test(value)) {
    try { return value.length <= 2048 && !!new URL(value) } catch { return false }
  }
  return [...value].length <= 16
}
/** 门户背景图：留空、上传后的门户地址或 http(s) 图片链接；会写进 CSS url("…")，不允许引号、括号、反斜杠、尖括号与空白 */
export function validBackground(value: any): boolean {
  if (typeof value !== 'string') return false
  if (!value) return true
  if (value.length > 2048 || /["'()\\<>\s]/.test(value)) return false
  if (/^\/api\/user\/background(\?v=\d+)?$/.test(value)) return true
  if (!/^https?:\/\//i.test(value)) return false
  try { return !!new URL(value) } catch { return false }
}
function strings(value: any): boolean {
  return Array.isArray(value) && value.every(v => typeof v === 'string' && v.length > 0)
}
function ids(value: any): boolean {
  return Array.isArray(value) && value.every(v => Number.isSafeInteger(v) && v > 0)
}
/** Discord 的 ID（应用、服务器、身份组）都是 17～20 位数字 */
const SNOWFLAKE = /^\d{17,20}$/
/** Discord 登录门槛的规模上限；每个服务器登录时要单独查询一次成员信息 */
const DISCORD_MAX_GROUPS = 10
const DISCORD_MAX_CONDITIONS = 10
const DISCORD_MAX_GUILDS = 20
/** 跨字段校验的错误记在前者上，提交任一字段都要报告 */
const LINKED: Record<string, string[]> = {
  pseudo_thinking_open_tag: ['pseudo_thinking_close_tag'], checkin_min_points: ['checkin_max_points'], portal_concurrency: ['portal_register_enabled'],
  discord_enabled: ['discord_client_id', 'discord_client_secret'],
}

/**
 * 对合并后的完整设置校验，但只报告本次提交涉及的字段：库里遗留的旧值（如早期版本允许的更大范围）
 * 不应阻止其他页面保存。调用者仅保存规范化后的 patch。
 */
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
  if (Number.isSafeInteger(merged.checkin_min_points) && Number.isSafeInteger(merged.checkin_max_points)) {
    check(merged.checkin_min_points <= merged.checkin_max_points, 'checkin_min_points', '最小奖励不能大于最大奖励')
  }
  // 开放注册时并发必须非零，否则可由无限并发透支用户额度
  if (merged.portal_register_enabled && !(Number.isSafeInteger(merged.portal_concurrency) && merged.portal_concurrency > 0)) {
    check(false, 'portal_concurrency', '开放注册时并发上限须大于 0，否则用户可无限透支额度')
  }
  check(text(merged.currency_symbol, 8), 'currency_symbol', '须为 1～8 字符的非空文本')
  check(text(merged.portal_brand_name, 64), 'portal_brand_name', '须为 1～64 字符的非空文本')
  check(text(merged.portal_site_title, 128), 'portal_site_title', '须为 1～128 字符的非空文本')
  check(brandIcon(merged.portal_brand_icon), 'portal_brand_icon', '须为图片链接或不超过 16 字符的 emoji / 文字')
  check(validBackground(merged.portal_background), 'portal_background', '须留空，或为不含引号、括号、空白的 http(s) 图片链接')
  check(typeof merged.portal_notice === 'string' && merged.portal_notice.length <= 20_000, 'portal_notice', '须为不超过 20000 字符的字符串')
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
  try {
    if (typeof merged.public_base_url !== 'string' || merged.public_base_url.length > 512) throw new Error()
    if (merged.public_base_url) {
      const url = new URL(merged.public_base_url)
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error()
    }
  } catch { errors.public_base_url = '须为空串或有效的 HTTP/HTTPS 地址' }
  // Discord：ID 与密钥去掉首尾空白再存
  for (const key of ['discord_client_id', 'discord_client_secret']) {
    if (typeof merged[key] === 'string') merged[key] = merged[key].trim()
    if (Object.hasOwn(patch, key)) patch[key] = merged[key]
  }
  check(typeof merged.discord_client_id === 'string' && (!merged.discord_client_id || SNOWFLAKE.test(merged.discord_client_id)), 'discord_client_id', '须为空或 17～20 位数字 ID')
  check(typeof merged.discord_client_secret === 'string' && merged.discord_client_secret.length <= 256, 'discord_client_secret', '须为不超过 256 字符的字符串')
  if (merged.discord_enabled && !(merged.discord_client_id && merged.discord_client_secret)) {
    check(false, 'discord_enabled', '开启 Discord 登录前须先填写 Client ID 和 Client Secret')
  }
  // 登录门槛：只保留已知字段，服务器 ID 去掉首尾空白，身份组缺省为空并去重
  if (!Array.isArray(merged.discord_rules)) errors.discord_rules = '须为规则组数组'
  else {
    check(merged.discord_rules.length <= DISCORD_MAX_GROUPS, 'discord_rules', `最多 ${DISCORD_MAX_GROUPS} 个规则组`)
    const guilds = new Set<string>()
    const rules = merged.discord_rules.map((group: any, index: number) => {
      const at = `discord_rules[${index}]`
      if (!object(group) || !Array.isArray(group.conditions) || !group.conditions.length || group.conditions.length > DISCORD_MAX_CONDITIONS) {
        errors[at] = `规则组须包含 1～${DISCORD_MAX_CONDITIONS} 个服务器条件`
        return group
      }
      const seen = new Set<string>()
      const conditions = group.conditions.map((condition: any, i: number) => {
        const where = `${at}.conditions[${i}]`
        if (!object(condition)) { errors[where] = '服务器条件须为对象'; return condition }
        const guildId = typeof condition.guild_id === 'string' ? condition.guild_id.trim() : condition.guild_id
        check(typeof guildId === 'string' && SNOWFLAKE.test(guildId), `${where}.guild_id`, '须为 17～20 位数字的服务器 ID')
        check(!seen.has(guildId), `${where}.guild_id`, '同一规则组内服务器不能重复')
        seen.add(guildId)
        guilds.add(guildId)
        const normalized: Record<string, unknown> = { guild_id: guildId }
        for (const key of ['all_roles', 'any_roles', 'deny_roles']) {
          const roles = condition[key] ?? []
          const valid = Array.isArray(roles) && roles.length <= 50 && roles.every((v: any) => typeof v === 'string' && SNOWFLAKE.test(v))
          check(valid, `${where}.${key}`, '须为不超过 50 个 17～20 位数字的身份组 ID')
          normalized[key] = valid ? [...new Set(roles)] : roles
        }
        return normalized
      })
      return { conditions }
    })
    check(guilds.size <= DISCORD_MAX_GUILDS, 'discord_rules', `规则最多涉及 ${DISCORD_MAX_GUILDS} 个不同的服务器`)
    if (Object.hasOwn(patch, 'discord_rules')) patch.discord_rules = rules
  }
  if (!Array.isArray(merged.model_ratios)) errors.model_ratios = '须为倍率数组'
  else {
    const ratioIds = new Set<string>()
    const patterns = new Set<string>()
    merged.model_ratios.forEach((ratio: any, index: number) => {
      const at = `model_ratios[${index}]`
      if (!object(ratio)) { errors[at] = '倍率须为对象'; return }
      check(typeof ratio.id === 'string' && !!ratio.id && !ratioIds.has(ratio.id), `${at}.id`, 'ID 须为非空且不重复的字符串')
      ratioIds.add(ratio.id)
      check(typeof ratio.pattern === 'string' && !!ratio.pattern.trim() && ratio.pattern.length <= 128 && !patterns.has(ratio.pattern), `${at}.pattern`, '模型模式须为 1～128 字符且不重复')
      patterns.add(ratio.pattern)
      for (const field of RATIO_FIELDS) {
        check(typeof ratio[field] === 'number' && Number.isFinite(ratio[field]) && ratio[field] >= 0 && ratio[field] <= 1_000_000, `${at}.${field}`, '须为 0～1000000 的数字')
      }
      check(typeof ratio.per_request === 'number' && Number.isFinite(ratio.per_request) && ratio.per_request >= 0 && ratio.per_request <= PER_REQUEST_MAX,
        `${at}.per_request`, `须为 0～${PER_REQUEST_MAX} 的数字`)
    })
  }
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
      if (rule.sources !== undefined) check(Array.isArray(rule.sources) && rule.sources.every((v: any) => sources.has(v)), `${at}.sources`, '含不支持的调用来源')
      if (rule.keyIds !== undefined) check(ids(rule.keyIds), `${at}.keyIds`, '须为正整数数组')
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
  for (const key of Object.keys(errors)) {
    const root = key.split(/[.[]/, 1)[0]
    const linked = Object.hasOwn(LINKED, root) ? LINKED[root] : []
    if (![root, ...linked].some(k => Object.hasOwn(input, k))) delete errors[key]
  }
  if (Object.keys(errors).length) throw new SettingsValidationError(errors)
  return patch
}
