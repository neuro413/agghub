// ── 渠道 ───────────────────────────────────────────────
export type ChannelType = 'openai' | 'anthropic' | 'vertex' | 'responses'

/** 0=手动禁用 1=启用 2=自动禁用（命中熔断） */
export type ChannelStatus = 0 | 1 | 2

/** 数据库原始行（models / model_mapping 为 JSON 字符串） */
export interface ChannelRow {
  id: number
  name: string
  type: ChannelType
  base_url: string | null
  api_key: string
  models: string
  model_mapping: string | null
  priority: number
  weight: number
  status: number
  region: string | null
  timeout_ms: number | null
  ua_override: number
  ua_value: string | null
  strip_headers: number
  created_at: number
  updated_at: number
}

/** 应用层渠道（已解析 JSON 字段） */
export interface Channel {
  id: number
  name: string
  type: ChannelType
  base_url: string | null
  api_key: string
  models: string[]
  model_mapping: Record<string, string> | null
  priority: number
  weight: number
  status: ChannelStatus
  region: string | null
  timeout_ms: number | null
  ua_override: boolean
  ua_value: string | null
  strip_headers: boolean
  created_at: number
  updated_at: number
}

// ── 请求日志（统计 + 正文）───────────────────────────────
export interface LogRow {
  id: number
  created_at: number
  channel_id: number | null
  channel_name: string | null
  entry_format: string
  model: string | null
  upstream_model: string | null
  status: 'success' | 'error'
  status_code: number | null
  latency_ms: number | null
  request_id: string | null
  attempt_latency_ms: number | null
  response_body_truncated: number
  upstream_response_body_truncated: number
  upstream_response_body: string | null
  prompt_tokens: number | null
  completion_tokens: number | null
  total_tokens: number | null
  /** 缓存读取 / 写入 token（prompt_tokens 的子集）*/
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  retry_count: number | null
  is_stream: number
  is_retry: number
  error_message: string | null
  request_headers: string | null
  request_body: string | null
  response_body: string | null
  /** 1=请求体被后处理实际改动过 */
  preprocessed: number
  /** 后处理改写后的请求体（仅改动时记录）*/
  preprocessed_body: string | null
  /** 1=本次走伪思考（伪原生思维链）路径 */
  pseudo_thinking: number
  /** 伪思考入向续接注入信息 JSON：[{messageIndex, thinking}]（仅注入时记录）*/
  thinking_inject: string | null
}

// ── 设置 ───────────────────────────────────────────────
export interface Settings {
  single_retry_times: number
  channel_retry_times: number
  retry_interval_ms: number
  request_timeout_ms: number
  request_max_duration_ms: number
  downstream_timeout_ms: number
  log_response_max_bytes: number
  stream_buffer_max_bytes: number
  image_max_bytes: number
  failover_strategy: 'priority_descend'
  auto_ban: boolean
  auto_ban_codes: string
  log_retention_days: number
  store_request_body: boolean
  store_response_body: boolean
  access_token: string
  drop_thinking: boolean
  /** 自定义去除深度：保留最近 N 个 thinking 块，0 = 全部去除 */
  drop_thinking_keep_last: number
  /** 丢弃 thinking 限定渠道 id，空 = 全部 */
  drop_thinking_channel_ids: number[]
  /** 丢弃 thinking 限定请求模型名，空 = 全部 */
  drop_thinking_models: string[]
  /** 单独去除 redacted_thinking 块（不影响普通 thinking） */
  drop_redacted_thinking: boolean
  /** 从请求中去除 top_p 参数（对所有方向生效） */
  strip_top_p: boolean
  preprocess_rules: PreprocessRule[]
  tool_filter_rules: ToolFilterRule[]
  param_rules: ParamRule[]
  // 伪思考（伪原生思维链）
  pseudo_thinking_enabled: boolean
  pseudo_thinking_channel_ids: number[]
  pseudo_thinking_models: string[]
  pseudo_thinking_open_tag: string
  pseudo_thinking_close_tag: string
  pseudo_thinking_prompt: string
  pseudo_thinking_store_max: number
  /** Responses 上游推理密文暂存条数上限（Anthropic 客户端思维链回传用） */
  reasoning_store_max: number
  /** 跨格式转换时允许自动调整 max_tokens / 采样参数以满足 Claude thinking 约束 */
  reasoning_auto_adjust: boolean
  proxy_url: string
}

// ── 提示词预处理规则 ─────────────────────────────────────
export interface PreprocessRule {
  id: string
  enabled: boolean
  name?: string
  /** 来源：可视化勾选生成 / 手写正则 */
  source: 'visual' | 'regex'
  /** 正则源串；可视化生成时为 escape 后的字面量 */
  pattern: string
  /** 正则 flags，默认 'g' */
  flags: string
  /** 替换文本，空串 = 删除 */
  replacement: string
  /** 作用角色 system/user/assistant/tool，空/缺省 = 全部 */
  roles?: string[]
  /** 限定渠道 id，空/缺省 = 全部 */
  channelIds?: number[]
  /** 限定入口格式，空/缺省 = 全部 */
  formats?: EntryFormat[]
  /** 限定请求模型名，空/缺省 = 全部 */
  models?: string[]
  /** 只处理最后 N 条消息，0/缺省 = 全部 */
  depth?: number
}

// ── 工具过滤规则 ────────────────────────────────────────
export interface ToolFilterRule {
  id: string
  enabled: boolean
  name?: string
  /** 要屏蔽的工具名列表（黑名单，精确匹配） */
  tools: string[]
  /** 限定渠道 id，空/缺省 = 全部 */
  channelIds?: number[]
  /** 限定入口格式，空/缺省 = 全部 */
  formats?: EntryFormat[]
  /** 限定请求模型名，空/缺省 = 全部 */
  models?: string[]
}

// ── 参数修改规则 ────────────────────────────────────────
export type ParamOpType = 'set' | 'set_if_missing' | 'set_if_present' | 'delete' | 'regex'

export interface ParamOp {
  type: ParamOpType
  /** 参数路径，支持 a.b.c 点路径（数组元素用下标）；regex 不使用 */
  key?: string
  /** 值文本：按 JSON 解析（数字 / 布尔 / null / 对象 / 数组），解析失败则按字符串；delete / regex 不使用 */
  value?: string
  /** regex 专用：对「排除消息与系统提示后的请求体紧凑 JSON 文本」做替换 */
  pattern?: string
  flags?: string
  replacement?: string
}

export interface ParamRule {
  id: string
  enabled: boolean
  name?: string
  /** 按顺序执行的操作列表 */
  ops: ParamOp[]
  /** 限定渠道 id，空/缺省 = 全部 */
  channelIds?: number[]
  /** 限定入口格式，空/缺省 = 全部 */
  formats?: EntryFormat[]
  /** 限定请求模型名，空/缺省 = 全部 */
  models?: string[]
}

// ── 内部中间表示 IR（以 OpenAI Chat 结构为枢纽）──────────
// 详细的多模态/工具调用结构在 convert 层细化，这里给宽松定义并允许透传

/** 一个推理块：保留上游原始 id / 密文 / 签名，供跨格式往返 */
export interface IRReasoningItem {
  /** 上游项 id（Responses 的 rs_xxx）*/
  id?: string
  /** 可读推理文本（Claude thinking / Responses summary）*/
  text?: string
  /** Claude thinking 签名 */
  signature?: string
  /** Responses encrypted_content */
  encrypted?: string
  /** Claude redacted_thinking 的 data */
  redacted?: string
}

/** 统一的推理意图 */
export interface IRReasoning {
  /** none / minimal / low / medium / high / xhigh / max */
  effort?: string
  /** Claude 风格预算，优先级高于 effort 推导 */
  budget_tokens?: number
  /** 是否请求推理摘要 */
  summary?: string
  /** 显式关闭 */
  disabled?: boolean
}

export interface IRMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | any[] | null
  name?: string
  tool_calls?: any[]
  tool_call_id?: string
  /** 可读推理文本（reasoning_items 的派生视图）*/
  reasoning_content?: string
  /** 单块签名（伪思考等旧路径使用）*/
  reasoning_signature?: string
  /** 完整推理块列表，跨格式往返的唯一权威来源 */
  reasoning_items?: IRReasoningItem[]
  /** 拒绝文本，与 content 分离 */
  refusal?: string
  /** tool 消息：工具执行是否失败 */
  is_error?: boolean
  [k: string]: any
}

export interface IRRequest {
  model: string
  messages: IRMessage[]
  stream?: boolean
  temperature?: number
  top_p?: number
  max_tokens?: number
  stop?: string | string[]
  tools?: any[]
  tool_choice?: any
  parallel_tool_calls?: boolean
  reasoning?: IRReasoning
  /** 由 parseRequest 从 tools 提取，供响应侧还原 custom_tool_call */
  custom_tool_names?: string[]
  /** Responses 形状的托管工具定义（如 web_search），仅 Responses / Claude 上游消费 */
  hosted_tools?: any[]
  [k: string]: any
}

export interface IRUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  /** 缓存明细沿用 OpenAI 官方字段名：cached_tokens = 缓存读取，cache_write_tokens = 缓存写入 */
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

/** 入口/上游格式标识 */
export type WireFormat = 'openai' | 'anthropic' | 'gemini' | 'responses'

/** 对外入口格式：OpenAI Chat / Anthropic Messages / OpenAI Responses */
export type EntryFormat = 'openai' | 'anthropic' | 'responses'
