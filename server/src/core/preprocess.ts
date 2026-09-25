import type { EntryFormat, PreprocessRule, Settings } from '../types'

export interface PreprocessMeta {
  entryFormat: EntryFormat
  channelId: number
  model: string
  /** 是否为同格式直通（决定操作 rawBody 还是 ir，且丢弃 thinking 仅对直通生效）*/
  passthrough: boolean
}

const THINKING_TYPES = new Set(['thinking', 'redacted_thinking'])
// 可做文本替换的内容块类型：Chat/Claude 的 text，Responses 的 input_text / output_text
const TEXT_PART_TYPES = new Set(['text', 'input_text', 'output_text'])

/** 对 message.content（string 或 part 数组）里的文本应用替换函数，返回新结构（不 mutate 原 part）*/
function transformContentText(content: any, fn: (s: string) => string): any {
  if (content == null) return content
  if (typeof content === 'string') return fn(content)
  if (Array.isArray(content)) {
    return content.map((p) => {
      if (typeof p === 'string') return fn(p)
      if (p && typeof p === 'object' && TEXT_PART_TYPES.has(p.type) && typeof p.text === 'string') {
        return { ...p, text: fn(p.text) }
      }
      return p
    })
  }
  return content
}

function isThinkingBlock(b: any): boolean {
  return b && typeof b === 'object' && THINKING_TYPES.has(b.type)
}

/**
 * 丢弃 thinking / redacted_thinking 块（仅对 anthropic 直通请求生效）。
 * keepLast > 0 时保留最后 N 个 thinking 块（按消息顺序从后往前计）。
 */
function dropThinking(target: any, keepLast: number): void {
  if (!target || !Array.isArray(target.messages)) return

  if (keepLast <= 0) {
    for (const msg of target.messages) {
      if (!msg || !Array.isArray(msg.content)) continue
      const filtered = msg.content.filter((b: any) => !isThinkingBlock(b))
      if (filtered.length !== msg.content.length) {
        msg.content = filtered.length ? filtered : [{ type: 'text', text: '...' }]
      }
    }
    return
  }

  // 收集所有 thinking 块的位置 [msgIndex, blockIndex]
  const positions: [number, number][] = []
  for (let mi = 0; mi < target.messages.length; mi++) {
    const msg = target.messages[mi]
    if (!msg || !Array.isArray(msg.content)) continue
    for (let bi = 0; bi < msg.content.length; bi++) {
      if (isThinkingBlock(msg.content[bi])) positions.push([mi, bi])
    }
  }
  if (positions.length <= keepLast) return

  const toRemove = new Set(positions.slice(0, positions.length - keepLast).map(([mi, bi]) => `${mi}:${bi}`))
  for (let mi = 0; mi < target.messages.length; mi++) {
    const msg = target.messages[mi]
    if (!msg || !Array.isArray(msg.content)) continue
    const filtered = msg.content.filter((_: any, bi: number) => !toRemove.has(`${mi}:${bi}`))
    if (filtered.length !== msg.content.length) {
      msg.content = filtered.length ? filtered : [{ type: 'text', text: '...' }]
    }
  }
}

/** 单独去除 redacted_thinking 块 */
function dropRedactedThinking(target: any): void {
  if (!target || !Array.isArray(target.messages)) return
  for (const msg of target.messages) {
    if (!msg || !Array.isArray(msg.content)) continue
    const filtered = msg.content.filter((b: any) => !(b && typeof b === 'object' && b.type === 'redacted_thinking'))
    if (filtered.length !== msg.content.length) {
      msg.content = filtered.length ? filtered : [{ type: 'text', text: '...' }]
    }
  }
}

/** 规则通用限定范围（渠道 / 入口格式 / 模型），PreprocessRule / ToolFilterRule / ParamRule 共用 */
export interface RuleScope {
  channelIds?: number[]
  formats?: EntryFormat[]
  models?: string[]
}

/** 规则的渠道/入口格式/模型过滤是否命中本次请求 */
export function ruleMatchesMeta(rule: RuleScope, meta: Pick<PreprocessMeta, 'entryFormat' | 'channelId' | 'model'>): boolean {
  if (rule.formats?.length && !rule.formats.includes(meta.entryFormat)) return false
  if (rule.channelIds?.length && !rule.channelIds.includes(meta.channelId)) return false
  if (rule.models?.length && !rule.models.includes(meta.model)) return false
  return true
}

function applyRule(target: any, rule: PreprocessRule): void {
  let re: RegExp
  try {
    re = new RegExp(rule.pattern, rule.flags || 'g')
  } catch {
    return // 非法正则跳过，不影响请求
  }
  const replacement = rule.replacement ?? ''
  const roles = rule.roles?.length ? new Set(rule.roles) : null
  const apply = (s: string): string => {
    re.lastIndex = 0
    return s.replace(re, replacement)
  }

  // anthropic 直通的 top-level system 当作虚拟 role='system'（openai/ir 的 system 在 messages 内）
  if (target.system != null && (!roles || roles.has('system'))) {
    target.system = transformContentText(target.system, apply)
  }
  // responses 直通：instructions 视作 system；input 为字符串时视作单条 user
  if (typeof target.instructions === 'string' && (!roles || roles.has('system'))) {
    target.instructions = apply(target.instructions)
  }
  if (typeof target.input === 'string' && (!roles || roles.has('user'))) {
    target.input = apply(target.input)
  }

  // Chat / Claude 的 messages，或 Responses 的 input 项数组
  const list: any[] | null = Array.isArray(target.messages) ? target.messages : Array.isArray(target.input) ? target.input : null
  if (list) {
    const len = list.length
    const start = rule.depth && rule.depth > 0 ? Math.max(0, len - rule.depth) : 0
    for (let i = start; i < len; i++) {
      const msg = list[i]
      if (!msg) continue
      // Responses 的 function_call_output 相当于 Chat 的 tool 消息
      if (msg.type === 'function_call_output' || msg.type === 'custom_tool_call_output') {
        if (!roles || roles.has('tool')) msg.output = transformContentText(msg.output, apply)
        continue
      }
      const role = msg.role === 'developer' ? 'system' : msg.role
      if (!role) continue
      const selected = !roles || roles.has(role)
      // Claude 将工具结果放在 user.content 中，角色按文本节点的语义区分。
      if (Array.isArray(msg.content)) {
        msg.content = msg.content.map((part: any) => {
          if (part?.type === 'tool_result') {
            return !roles || roles.has('tool') ? { ...part, content: transformContentText(part.content, apply) } : part
          }
          return selected ? transformContentText([part], apply)[0] : part
        })
      } else if (selected) msg.content = transformContentText(msg.content, apply)
    }
  }
}

/** 收集所有命中的工具过滤规则，合并为一个黑名单集合 */
function collectBlockedTools(meta: PreprocessMeta, settings: Settings): Set<string> {
  const blocked = new Set<string>()
  for (const rule of settings.tool_filter_rules || []) {
    if (!rule?.enabled || !rule.tools?.length) continue
    if (!ruleMatchesMeta(rule, meta)) continue
    for (const t of rule.tools) blocked.add(t)
  }
  return blocked
}

function toolName(tool: any): string | undefined {
  return tool?.function?.name || tool?.custom?.name || tool?.name
}

function filterToolDefinitions(tools: any[], blocked: Set<string>): any[] {
  return tools.filter(tool => {
    if (tool?.type === 'namespace' && Array.isArray(tool.tools)) {
      tool.tools = filterToolDefinitions(tool.tools, blocked)
      return tool.tools.length > 0
    }
    return !blocked.has(toolName(tool) || '')
  })
}

/** 从 Anthropic 格式请求体中移除被屏蔽的工具 */
function filterToolsAnthropic(target: any, blocked: Set<string>): void {
  // 1. 移除 tools 定义
  if (Array.isArray(target.tools)) {
    target.tools = target.tools.filter((t: any) => !blocked.has(t?.name))
    if (target.tools.length === 0) delete target.tools
  }

  // 2. 处理 tool_choice
  if (target.tool_choice?.type === 'tool' && blocked.has(target.tool_choice.name)) {
    target.tool_choice = { type: 'auto' }
  }

  // 3. 清理消息中的 tool_use / tool_result
  if (!Array.isArray(target.messages)) return
  const blockedIds = new Set<string>()
  for (const msg of target.messages) {
    if (!Array.isArray(msg?.content)) continue
    for (const b of msg.content) {
      if (b?.type === 'tool_use' && blocked.has(b.name)) blockedIds.add(b.id)
    }
  }
  if (blockedIds.size === 0) return
  for (const msg of target.messages) {
    if (!Array.isArray(msg?.content)) continue
    const filtered = msg.content.filter((b: any) => {
      if (b?.type === 'tool_use' && blockedIds.has(b.id)) return false
      if (b?.type === 'tool_result' && blockedIds.has(b.tool_use_id)) return false
      return true
    })
    if (filtered.length !== msg.content.length) {
      msg.content = filtered.length ? filtered : [{ type: 'text', text: '...' }]
    }
  }
}

/** 从 OpenAI / IR 格式请求体中移除被屏蔽的工具 */
function filterToolsOpenAI(target: any, blocked: Set<string>): void {
  // 1. 移除 tools 定义
  if (Array.isArray(target.tools)) {
    target.tools = filterToolDefinitions(target.tools, blocked)
    if (target.tools.length === 0) delete target.tools
  }

  // 2. 处理 tool_choice
  if (blocked.has(toolName(target.tool_choice) || '')) {
    target.tool_choice = 'auto'
  }

  // 3. 清理消息中的 tool_calls / tool role
  if (!Array.isArray(target.messages)) return
  const blockedCallIds = new Set<string>()
  for (const msg of target.messages) {
    if (msg?.role !== 'assistant' || !Array.isArray(msg.tool_calls)) continue
    const orig = msg.tool_calls
    msg.tool_calls = orig.filter((tc: any) => {
      if (blocked.has(toolName(tc) || '')) {
        if (tc.id) blockedCallIds.add(tc.id)
        return false
      }
      return true
    })
    if (msg.tool_calls.length === 0) {
      delete msg.tool_calls
      if (msg.content == null || msg.content === '') msg.content = '...'
    }
  }
  if (blockedCallIds.size === 0) return
  target.messages = target.messages.filter((msg: any) => {
    if (msg?.role === 'tool' && blockedCallIds.has(msg.tool_call_id)) return false
    return true
  })
}

/** 从 Responses 格式请求体中移除被屏蔽的工具 */
function filterToolsResponses(target: any, blocked: Set<string>): void {
  // 1. 移除 tools 定义（function / custom 按 name；命名空间内递归）
  if (Array.isArray(target.tools)) {
    target.tools = filterToolDefinitions(target.tools, blocked)
    if (target.tools.length === 0) delete target.tools
  }

  // 2. 处理 tool_choice
  const tc = target.tool_choice
  if (tc && typeof tc === 'object') {
    if ((tc.type === 'function' || tc.type === 'custom') && blocked.has(tc.name)) target.tool_choice = 'auto'
    else if (tc.type === 'allowed_tools' && Array.isArray(tc.tools)) {
      tc.tools = tc.tools.filter((x: any) => !blocked.has(x?.name))
      if (tc.tools.length === 0) target.tool_choice = 'auto'
    }
  }

  // 3. 清理 input 中的调用记录与结果
  if (!Array.isArray(target.input)) return
  const blockedIds = new Set<string>()
  for (const it of target.input) {
    if ((it?.type === 'function_call' || it?.type === 'custom_tool_call') && blocked.has(it.name)) {
      if (it.call_id) blockedIds.add(it.call_id)
      if (it.id) blockedIds.add(it.id)
    }
  }
  target.input = target.input.filter((it: any) => {
    if ((it?.type === 'function_call' || it?.type === 'custom_tool_call') && blocked.has(it.name)) return false
    if ((it?.type === 'function_call_output' || it?.type === 'custom_tool_call_output') && blockedIds.has(it.call_id)) return false
    return true
  })
}

function applyToolFilter(target: any, meta: PreprocessMeta, settings: Settings): void {
  const blocked = collectBlockedTools(meta, settings)
  if (blocked.size === 0) return
  const hadTools = Array.isArray(target.tools) && target.tools.length > 0
  if (meta.passthrough && meta.entryFormat === 'anthropic') filterToolsAnthropic(target, blocked)
  else if (meta.passthrough && meta.entryFormat === 'responses') filterToolsResponses(target, blocked)
  else filterToolsOpenAI(target, blocked)
  if (Array.isArray(target.custom_tool_names)) target.custom_tool_names = target.custom_tool_names.filter((name: string) => !blocked.has(name))
  if (hadTools && !target.tools?.length && !target.hosted_tools?.length) delete target.tool_choice
}

/** 丢弃 thinking 的渠道/模型限定是否命中本次请求（空 = 全部） */
export function matchesDropThinking(channelId: number, model: string, settings: Settings): boolean {
  const cIds = settings.drop_thinking_channel_ids
  if (cIds?.length && !cIds.includes(channelId)) return false
  const models = settings.drop_thinking_models
  if (models?.length && !models.includes(model)) return false
  return true
}

/**
 * 对发往上游的请求体做预处理（在 relay 判定 passthrough 后、构造 upReq 前调用）。
 * target 为「直通的 rawBody 克隆」或「转换路径的 ir 克隆」；会就地修改 target，
 * 调用方须传入克隆体以保留请求日志中的客户端原始请求体。
 */
export function applyPreprocess(target: any, meta: PreprocessMeta, settings: Settings): void {
  if (!target) return
  if (settings.strip_top_p) {
    delete target.top_p
  }
  if (meta.passthrough && meta.entryFormat === 'anthropic') {
    if (settings.drop_thinking && matchesDropThinking(meta.channelId, meta.model, settings)) {
      dropThinking(target, settings.drop_thinking_keep_last)
    }
    if (settings.drop_redacted_thinking) {
      dropRedactedThinking(target)
    }
  }
  applyToolFilter(target, meta, settings)
  for (const rule of settings.preprocess_rules || []) {
    if (!rule || !rule.enabled || !rule.pattern) continue
    if (!ruleMatchesMeta(rule, meta)) continue
    applyRule(target, rule)
  }
}
