// ── 渠道 ───────────────────────────────────────────────
export type ChannelType = 'openai' | 'anthropic' | 'vertex' | 'responses'

/** 0=手动禁用 1=启用 2=自动禁用（命中熔断） */
export type ChannelStatus = 0 | 1 | 2

/** 单 role 渠道兼容：对话历史打包进一条 user 消息 / 打包进系统提示 */
export type SingleRoleMode = 'user' | 'system'

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
  single_role: string | null
  single_role_merge_system: number
  single_role_exclude_last_user: number
  /** JSON 字符串数组 */
  groups: string
  ban_until: number | null
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
  /** 单 role 兼容模式，null = 关闭 */
  single_role: SingleRoleMode | null
  /** user 模式下把系统提示合并进打包的 user 消息最前，原系统提示置空 */
  single_role_merge_system: boolean
  /** system 模式下最后一条 user 消息不打包，原样作为随后的 user 消息 */
  single_role_exclude_last_user: boolean
  /** 渠道分组；Key 只能使用与自身分组有交集的渠道，owner 不受限 */
  groups: string[]
  /** 自动熔断的恢复时间（毫秒时间戳），null = 需手动恢复 */
  ban_until: number | null
  created_at: number
  updated_at: number
}

// ── 调用主体与分发 Key ─────────────────────────────────
/** 请求从哪个监听器进入：内网 app / 公网 app */
export type Surface = 'lan' | 'public'

/** 调用来源：内网匿名或管理令牌 / 内网带 Key / 公网带 Key（预留以后的 'user'） */
export type CallerSource = 'owner' | 'lan_key' | 'public_key'

/** api_keys 数据库原始行 */
export interface ApiKeyRow {
  id: number
  name: string
  key: string
  enabled: number
  groups: string
  models: string
  rpm: number | null
  concurrency: number | null
  quota_total: number | null
  quota_used: number
  quota_daily: number | null
  log_bodies: number | null
  expires_at: number | null
  note: string | null
  user_id: number | null
  created_at: number
  updated_at: number
  last_used_at: number | null
}

/** 应用层分发 Key */
export interface ApiKey {
  id: number
  name: string
  /** 明文 Key：sk-agh- + 40 位 base62 */
  key: string
  enabled: boolean
  /** 可用渠道分组（至少一个） */
  groups: string[]
  /** 模型白名单，支持 * 通配符；空 = 不限 */
  models: string[]
  /** 每分钟请求数上限，null = 不限 */
  rpm: number | null
  /** 同时进行中的请求数上限，null = 不限 */
  concurrency: number | null
  /** 总额度点数，null = 不限 */
  quota_total: number | null
  /** 累计已用点数 */
  quota_used: number
  /** 每日额度点数（服务器本地时间 0 点重置），null = 不限 */
  quota_daily: number | null
  /** 正文记录：null 跟随全局 / true 记录 / false 不记录 */
  log_bodies: boolean | null
  /** 过期时间（毫秒时间戳），null = 永不过期 */
  expires_at: number | null
  note: string | null
  /** 预留：用户系统 */
  user_id: number | null
  created_at: number
  updated_at: number
  last_used_at: number | null
}

/** 本次请求的调用主体，由鉴权中间件解析后挂在 res.locals.caller */
export interface Caller {
  surface: Surface
  source: CallerSource
  /** source 为 lan_key / public_key 时存在 */
  key: ApiKey | null
  /** 客户端 IP（已去掉 ::ffff: 前缀），未知时为空串 */
  ip: string
}

/** 模型倍率：点数 = 未缓存输入×input + 缓存读×cache_read + 缓存写×cache_write + 输出×output + per_request */
export interface ModelRatio {
  id: string
  /** 精确模型名或 * 通配符模式，按客户端请求的模型名（映射前）匹配 */
  pattern: string
  input: number
  output: number
  cache_read: number
  cache_write: number
  /** 每次请求固定点数，仅在产生输出时计入 */
  per_request: number
}

// ── 请求日志（统计 + 正文）───────────────────────────────
export type LogBodyField = 'request_headers' | 'request_body' | 'response_body' | 'preprocessed_body' | 'thinking_inject' | 'upstream_response_body'

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
  /** 调用来源；旧日志为 null，按 owner 显示 */
  source: CallerSource | null
  key_id: number | null
  /** Key 名称快照，删除 Key 后仍可显示 */
  key_name: string | null
  client_ip: string | null
  /** 本次请求折算点数；未命中倍率时为 null */
  quota_points: number | null
}

// ── 设置 ───────────────────────────────────────────────
export interface Settings {
  single_retry_times: number
  channel_retry_times: number
  retry_interval_ms: number
  request_timeout_ms: number
  request_max_duration_ms: number
  log_response_max_bytes: number
  stream_buffer_max_bytes: number
  image_max_bytes: number
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
  proxy_url: string
  /** 模型倍率表 */
  model_ratios: ModelRatio[]
  /** 连续命中熔断状态码 N 次才停用渠道 */
  auto_ban_threshold: number
  /** 自动停用后多少分钟自动恢复，0 = 只能手动恢复 */
  auto_ban_cooldown_minutes: number
  /** 仅用于显示：给分发用户的公网 Base URL */
  public_base_url: string
}

/** 规则「调用来源」作用域，三类规则共用 */
export interface CallerScope {
  /** 限定调用来源，空/缺省 = 全部 */
  sources?: CallerSource[]
  /** 限定 Key id，空/缺省 = 全部 */
  keyIds?: number[]
}

// ── 提示词预处理规则 ─────────────────────────────────────
export interface PreprocessRule extends CallerScope {
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
export interface ToolFilterRule extends CallerScope {
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

export interface ParamRule extends CallerScope {
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

// ── 分发相关管理 API 契约（后端实现与前端调用共用）────────
/** GET /api/keys 列表项及各 Key 接口的返回值 */
export interface ApiKeyView extends ApiKey {
  /** 今日（服务器本地日期）已用点数 */
  today_points: number
  /** 今日请求数 */
  today_requests: number
}

/** POST /api/keys 与 PUT /api/keys/:id 的请求体；PUT 只更新出现的字段 */
export interface ApiKeyInput {
  name?: string
  enabled?: boolean
  groups?: string[]
  models?: string[]
  rpm?: number | null
  concurrency?: number | null
  quota_total?: number | null
  quota_daily?: number | null
  log_bodies?: boolean | null
  expires_at?: number | null
  note?: string | null
}

/** POST /api/keys/:id/quota 的请求体 */
export type KeyQuotaOp = { op: 'reset_used' } | { op: 'add_total'; value: number }

/** GET /api/keys/:id/usage 的数组元素，按日期升序，没有用量的日期不返回 */
export interface KeyUsageDay {
  day: string
  requests: number
  points: number
  prompt_tokens: number
  completion_tokens: number
}

/** GET /api/system */
export interface SystemInfo {
  lan_host: string | null
  lan_port: number
  public_enabled: boolean
  public_host: string | null
  public_port: number | null
  /** AGGHUB_TRUST_PROXY 的解析结果转为字符串 */
  trust_proxy: string
}

/** POST /api/billing/preview 的请求体 */
export interface BillingPreviewInput {
  model: string
  prompt_tokens: number
  completion_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
}

/** POST /api/billing/preview 的返回值；未命中倍率时两项都为 null */
export interface BillingPreviewResult {
  ratio: ModelRatio | null
  points: number | null
}
