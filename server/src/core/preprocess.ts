import type { CallerScope, CallerSource, EntryFormat, PreprocessRule, Settings } from '../types'

export interface PreprocessMeta {
  entryFormat: EntryFormat
  channelId: number
  model: string
  /** 是否为同格式直通（决定操作 rawBody 还是 ir，且丢弃 thinking 仅对直通生效）*/
  passthrough: boolean
  /** 调用来源；缺省按 owner 处理（伪思考等内部判断不传） */
  source?: CallerSource
  /** 调用所用 Key id；owner 为 null / 缺省 */
  keyId?: number | null
}

const THINKING_TYPES = new Set(['thinking', 'redacted_thinking'])
const REDACTED_TYPES = new Set(['redacted_thinking'])
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

/** 过滤 Claude 消息的内容块；被清空的消息补占位文本，避免上游拒绝空 content */
function filterBlocks(target: any, keep: (block: any) => boolean): void {
  for (const msg of target.messages || []) {
    if (!Array.isArray(msg?.content)) continue
    const filtered = msg.content.filter(keep)
    if (filtered.length !== msg.content.length) msg.content = filtered.length ? filtered : [{ type: 'text', text: '...' }]
  }
}

/** 丢弃指定类型的思考块（仅对 anthropic 直通请求生效）；keepLast > 0 时保留最后 N 个 */
function dropThinking(target: any, types: Set<string>, keepLast = 0): void {
  const blocks = (target.messages || []).flatMap((msg: any) => Array.isArray(msg?.content) ? msg.content : [])
  let remove = blocks.filter((b: any) => types.has(b?.type)).length - keepLast
  filterBlocks(target, b => !(types.has(b?.type) && remove-- > 0))
}

/** 规则通用限定范围（渠道 / 入口格式 / 模型 / 调用来源），PreprocessRule / ToolFilterRule / ParamRule 共用 */
export interface RuleScope extends CallerScope {
  channelIds?: number[]
  formats?: EntryFormat[]
  models?: string[]
}

/** 规则的渠道/入口格式/模型/调用来源过滤是否命中本次请求 */
export function ruleMatchesMeta(rule: RuleScope, meta: Pick<PreprocessMeta, 'entryFormat' | 'channelId' | 'model' | 'source' | 'keyId'>): boolean {
  if (rule.formats?.length && !rule.formats.includes(meta.entryFormat)) return false
  if (rule.channelIds?.length && !rule.channelIds.includes(meta.channelId)) return false
  if (rule.models?.length && !rule.models.includes(meta.model)) return false
  if (rule.sources?.length && !rule.sources.includes(meta.source ?? 'owner')) return false
  if (rule.keyIds?.length && (meta.keyId == null || !rule.keyIds.includes(meta.keyId))) return false
  return true
}

function applyRule(target: any, rule: PreprocessRule): void {
  const re = new RegExp(rule.pattern, rule.flags || 'g')
  const replacement = rule.replacement
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
  for (const rule of settings.tool_filter_rules) {
    if (!rule.enabled || !rule.tools.length) continue
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
  const blockedIds = new Set<string>()
  for (const msg of target.messages || []) {
    if (!Array.isArray(msg?.content)) continue
    for (const b of msg.content) {
      if (b?.type === 'tool_use' && blocked.has(b.name)) blockedIds.add(b.id)
    }
  }
  if (blockedIds.size) filterBlocks(target, b => !(b?.type === 'tool_use' && blockedIds.has(b.id)) && !(b?.type === 'tool_result' && blockedIds.has(b.tool_use_id)))
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

/** 丢弃 thinking 的渠道/模型限定（空 = 全部），伪思考同样依赖它 */
export function dropThinkingScope(settings: Settings): RuleScope {
  return { channelIds: settings.drop_thinking_channel_ids, models: settings.drop_thinking_models }
}

/**
 * 对发往上游的请求体做预处理（在 relay 判定 passthrough 后、构造 upReq 前调用）。
 * target 为「直通的 rawBody 克隆」或「转换路径的 ir 克隆」；会就地修改 target，
 * 调用方须传入克隆体以保留请求日志中的客户端原始请求体。
 */
export function applyPreprocess(target: any, meta: PreprocessMeta, settings: Settings): void {
  if (meta.passthrough && meta.entryFormat === 'anthropic') {
    if (settings.drop_thinking && ruleMatchesMeta(dropThinkingScope(settings), meta)) dropThinking(target, THINKING_TYPES, settings.drop_thinking_keep_last)
    if (settings.drop_redacted_thinking) dropThinking(target, REDACTED_TYPES)
  }
  applyToolFilter(target, meta, settings)
  for (const rule of settings.preprocess_rules) {
    if (!rule.enabled || !rule.pattern) continue
    if (!ruleMatchesMeta(rule, meta)) continue
    applyRule(target, rule)
  }
}
