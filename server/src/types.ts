// ── 渠道 ───────────────────────────────────────────────
export type ChannelType = 'openai' | 'anthropic' | 'vertex' | 'responses'

/** 0=手动禁用 1=启用 2=自动禁用（命中熔断） */
export type ChannelStatus = 0 | 1 | 2

/** 单 role 渠道兼容：对话历史打包进一条 user 消息 / 打包进系统提示 */
export type SingleRoleMode = 'user' | 'system'

/** 多 key 模式：轮询（按顺序用第一个可用 key，失效即切下一个）/ 并发（同时用多个 key 请求，先出结果者胜） */
export type KeyMode = 'poll' | 'race'

export type CompressionAlgorithm = 'gzip' | 'br' | 'zstd'
/** 渠道请求体压缩：null = 跟随全局 */
export type RequestCompression = CompressionAlgorithm | 'off'
/** 日志里的压缩状态 */
export type CompressStatus =
  | 'compressed'          // 已压缩发送
  | 'fallback_ok'         // 压缩被拒，明文重发成功（并写入内存记忆）
  | 'fallback_failed'     // 压缩被拒，明文重发仍失败（不记忆）
  | 'rejected'            // 判定为压缩被拒，但回退开关关闭
  | 'off'                 // 渠道设为关闭
  | 'below_min'           // 请求体小于阈值
  | 'channel_unsupported' // 渠道 × 算法在记忆期内被判定不支持
  | 'runtime_unsupported' // 当前 Node 不支持该算法（zstd 需 ≥ 22.15）
  | 'compress_error'      // 压缩本身抛错，改发明文

/** 渠道在记忆期内被判定不支持的压缩算法；until 为 null 表示直到重启 */
export interface CompressionUnsupported {
  algorithm: CompressionAlgorithm
  until: number | null
}

/** 渠道压缩测试的单项结果 */
export interface CompressionTestItem {
  algorithm: 'plain' | CompressionAlgorithm
  /** 'plain' / 'gzip-1' / 'br-2' / 'zstd-2 w23' */
  label: string
  /** ok = 2xx；rejected = 命中回退状态码 + 正则；error = 其他错误；skipped = 未执行 */
  verdict: 'ok' | 'rejected' | 'error' | 'skipped'
  status: number | null
  latency_ms: number
  raw_bytes: number
  sent_bytes: number
  /** 错误摘要（≤300 字）或跳过原因 */
  message: string
}
export interface CompressionTestResult { model: string; items: CompressionTestItem[] }

/** 数据库原始行（models / model_mapping 为 JSON 字符串） */
export interface ChannelRow {
  id: number
  name: string
  type: ChannelType
  base_url: string | null
  base_url_full: number
  models_url: string | null
  api_key: string
  models: string
  model_mapping: string | null
  model_alias: string | null
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
  key_mode: string | null
  key_concurrency: number
  key_cooldown_seconds: number
  ban_until: number | null
  request_compression: string | null
  created_at: number
  updated_at: number
}

/** 应用层渠道（已解析 JSON 字段） */
export interface Channel {
  id: number
  name: string
  type: ChannelType
  base_url: string | null
  /** 完整地址模式：base_url 原样作为请求地址，不补 /v1 和接口路径（Vertex 不支持） */
  base_url_full: boolean
  /** 完整地址模式下的模型列表地址，留空按 base_url 推导 */
  models_url: string | null
  api_key: string
  models: string[]
  model_mapping: Record<string, string> | null
  /** 模型专属名：模型列表原名 → 专属名；设了专属名的模型只能用专属名路由到本渠道，原名不再匹配 */
  model_alias: Record<string, string> | null
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
  /** 多 key 模式，null = 单 key（api_key 整串使用）；开启时 api_key 每行一个 key（Vertex 不支持） */
  key_mode: KeyMode | null
  /** 并发模式下同时请求的 key 数 */
  key_concurrency: number
  /** 多 key 模式下 429/402 熔断 key 的冷却秒数（上游带 Retry-After 时优先） */
  key_cooldown_seconds: number
  /** 自动熔断的恢复时间（毫秒时间戳），null = 需手动恢复 */
  ban_until: number | null
  /** 发往上游的请求体压缩，null = 跟随全局 */
  request_compression: RequestCompression | null
  created_at: number
  updated_at: number
}

/** 多 key 渠道里单个 key 的状态（脱敏后给管理端展示） */
export interface ChannelKeyStatus {
  index: number
  fingerprint: string
  masked: string
  state: 'ok' | 'cooldown' | 'banned'
  /** 冷却恢复时间（毫秒时间戳）；banned 为 null */
  until: number | null
  status_code: number | null
  message: string | null
}

// ── 调用主体与分发 Key ─────────────────────────────────
/** 请求从哪个监听器进入：内网 app / 公网 app */
export type Surface = 'lan' | 'public'

/** 调用来源：内网匿名或管理令牌 / 内网带 Key / 公网带 Key / 门户用户的 Key（不区分端口）/ 可用性页面的自动测活 */
export type CallerSource = 'owner' | 'lan_key' | 'public_key' | 'user' | 'probe'

/** api_keys 数据库原始行 */
export interface ApiKeyRow {
  id: number
  name: string
  key: string
  enabled: number
  /** 1 = 被管理员停用；门户用户不能自行恢复 */
  admin_disabled: number
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
  /** 被管理员停用；管理员再启用时置回 false，门户用户只能停用不能启用 */
  admin_disabled: boolean
  /** 分组名：管理员发的 Key 可多个（至少一个），门户用户的 Key 只有一个 */
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
  /** source 为 lan_key / public_key / user 时存在；user 时为按门户设置覆盖后的有效 Key */
  key: ApiKey | null
  /** source 为 user 时存在：Key 所属的门户用户 */
  user?: PortalUser | null
  /** source 为 probe 时存在：测活限定的分组，没有 Key 也按这些分组选渠道 */
  groups?: string[]
  /** 客户端 IP（已去掉 ::ffff: 前缀），未知时为空串 */
  ip: string
}

// ── 门户用户 ───────────────────────────────────────────
/** users 数据库行；quota 为剩余点数，请求结束才扣费，可能透支为负 */
export interface PortalUser {
  id: number
  username: string
  password_hash: string
  /** 1 启用 / 2 停用 */
  status: number
  quota: number
  used_quota: number
  request_count: number
  register_ip: string | null
  created_at: number
  last_login_at: number | null
  last_login_ip: string | null
  /** 管理员分配的专属分组；公开分组不必分配 */
  groups: string[]
  /** Discord 登录建的号 password_hash 为空串，只能用 Discord 登录 */
  discord_id: string | null
  /** 最近一次 Discord 登录时的用户名 */
  discord_username: string | null
  /** 最近一次记录 Discord 服务器列表的时间；从未记录时为 null */
  discord_guilds_at: number | null
}

// ── 分组 ───────────────────────────────────────────────
/** 分组：限定可用的渠道和模型，按分组倍率计费；Key 与用户按名称引用 */
export interface ChannelGroup {
  name: string
  description: string
  /** 分组倍率：点数 × ratio */
  ratio: number
  /** 公开分组：所有门户用户都能选，无须分配 */
  is_public: boolean
  /** 允许的渠道 id */
  channel_ids: number[]
  /** 允许的模型（渠道对外的模型名），逐个列出 */
  models: string[]
  /** UA 黑名单关键词：对客户端 User-Agent 做不区分大小写的包含匹配，命中即拒绝；空 = 不启用 */
  ua_blacklist: string[]
  /** 命中 UA 黑名单时返回的提示；空 = 「不支持的客户端」 */
  ua_block_message: string
  /** 越小越靠前 */
  sort: number
  created_at: number
  updated_at: number
}

/** GET /api/groups 列表项 */
export interface ChannelGroupView extends ChannelGroup {
  /** 分配了该分组的用户数（公开分组的默认可用不计） */
  user_count: number
  /** 引用该分组的 Key 数 */
  key_count: number
}

/** POST /api/groups 与 PUT /api/groups/:name 的请求体；PUT 只更新出现的字段 */
export interface ChannelGroupInput {
  name?: string
  description?: string
  ratio?: number
  is_public?: boolean
  channel_ids?: number[]
  models?: string[]
  ua_blacklist?: string[]
  ua_block_message?: string
  sort?: number
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

/** OpenRouter 模型定价（美元），Token 价格为每百万 Token */
export interface OpenRouterPrice {
  id: string
  name: string
  input: number
  output: number
  cache_read: number | null
  cache_write: number | null
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
  /** 实际返回客户端的错误信息，仅与 error_message 不同（被脱敏改写）时记录 */
  client_error: string | null
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
  /** 门户用户 id；删除 Key 后仍可按用户查询 */
  user_id: number | null
  /** 本次请求命中的分组（计费所用）；owner 调用为 null */
  group_name: string | null
  /** 多 key 渠道本次使用的上游 key（序号 + 脱敏值）；单 key 渠道为 null */
  channel_key: string | null
  /** 上游请求体的压缩编码，如 zstd-2 w23、gzip-1；未压缩为 null */
  upstream_encoding: string | null
  /** 发往上游的明文字节数 */
  upstream_raw_bytes: number | null
  /** 实际发出的字节数；回退时为两次发送之和 */
  upstream_sent_bytes: number | null
  /** 压缩墙钟耗时（含线程池排队）；命中请求级缓存为 0 */
  compress_ms: number | null
  /** 压缩状态；总开关关闭时为 null */
  compress_status: CompressStatus | null
  /** 被拒时的上游错误摘要 / 压缩异常信息 */
  compress_note: string | null
}

// ── 设置 ───────────────────────────────────────────────
export interface Settings {
  single_retry_times: number
  channel_retry_times: number
  retry_interval_ms: number
  request_timeout_ms: number
  request_max_duration_ms: number
  stream_keepalive_ms: number
  log_response_max_bytes: number
  stream_buffer_max_bytes: number
  image_max_bytes: number
  auto_ban: boolean
  auto_ban_codes: string
  /** 公网端口的上游 / 网络错误只向客户端返回状态码 */
  mask_upstream_errors: boolean
  /** 不脱敏的状态码，逗号分隔 */
  mask_upstream_errors_exclude_codes: string
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
  /** 门户可用性页自动测活：关闭后不再主动探活，只统计真实请求 */
  probe_enabled: boolean
  /** 仅用于显示：给分发用户的公网 Base URL */
  public_base_url: string
  // 用户门户
  /** 注册总开关：关闭后密码注册和 Discord 都不能新建账号 */
  portal_register_enabled: boolean
  /** 注册子开关：用户名密码注册 */
  portal_password_register_enabled: boolean
  /** 新用户赠送点数 */
  portal_initial_quota: number
  /** 同一 IP 每天最多注册数，0 = 不限 */
  portal_register_ip_daily: number
  /** 每个用户最多 Key 数 */
  portal_max_keys: number
  /** 每用户每分钟请求数上限（名下 Key 共享），0 = 不限 */
  portal_rpm: number
  /** 每用户并发上限（名下 Key 共享），0 = 不限 */
  portal_concurrency: number
  /** 金额换算：每 1 单位金额对应的点数（内部常量，设置页不提供修改） */
  portal_points_per_usd: number
  /** 余额符号，管理端与门户显示金额时前置 */
  currency_symbol: string
  /** 门户品牌名称（顶栏与登录页） */
  portal_brand_name: string
  /** 门户品牌图标：emoji / 文字、http(s) 图片链接，或上传后的 /api/user/brand-icon 地址 */
  portal_brand_icon: string
  /** 门户网页标题 */
  portal_site_title: string
  /** 门户背景图：留空不启用；http(s) 图片链接，或上传后的 /api/user/background 地址 */
  portal_background: string
  /** 有背景图时内容面板的不透明度（%） */
  portal_background_opacity: number
  /** 有背景图时内容面板的毛玻璃模糊半径（px） */
  portal_background_blur: number
  /** 背景图上叠加的白色遮罩浓度（%），保证直接压在图上的顶栏 / 侧栏文字可读 */
  portal_background_dim: number
  checkin_enabled: boolean
  /** 签到奖励随机区间（点数，含两端） */
  checkin_min_points: number
  checkin_max_points: number
  /** 门户通知（Markdown），空串不显示 */
  portal_notice: string
  /** 门户是否显示公告 */
  portal_announcements_enabled: boolean
  // Discord 登录
  /** 注册子开关：Discord 登录，未注册的 Discord 账号登录时自动建号 */
  discord_enabled: boolean
  discord_client_id: string
  discord_client_secret: string
  /** 服务器与身份组门槛：满足任一规则组即可登录；空数组不检查 */
  discord_rules: DiscordRuleGroup[]
  // 上游请求体压缩
  /** 总开关；关闭时所有渠道都不压缩 */
  upstream_compression_enabled: boolean
  /** 渠道「跟随全局」时使用的算法 */
  upstream_compression_default: CompressionAlgorithm
  upstream_compression_gzip_level: number
  upstream_compression_br_quality: number
  upstream_compression_zstd_level: number
  /** zstd 窗口：0 = 用级别自带窗口；23 = 8 MB（RFC 9659 上限） */
  upstream_compression_zstd_window_log: number
  /** 请求体小于该字节数不压缩；0 = 全部压缩 */
  upstream_compression_min_bytes: number
  /** 压缩被拒时自动明文重发 */
  upstream_compression_fallback: boolean
  /** 判定为压缩被拒的状态码，逗号分隔 */
  upstream_compression_fallback_codes: string
  /** 判定为压缩被拒的错误体正则（不区分大小写，只匹配前 2000 字符）；空 = 只看状态码 */
  upstream_compression_fallback_pattern: string
  /** 「不支持」内存记忆时长（分钟）；0 = 直到重启 */
  upstream_compression_unsupported_minutes: number
  // 响应压缩与静态缓存
  /** 管理端 / 门户 API 与静态资源的响应压缩；/v1 与 SSE 永远不压缩 */
  response_compression_enabled: boolean
  /** gzip 级别 */
  response_compression_level: number
  /** brotli 质量；0 = 不用 br，只用 gzip */
  response_compression_br_quality: number
  /** 小于该字节数不压缩 */
  response_compression_threshold: number
  /** /assets/* 的长缓存天数；0 = 保持 express 默认 */
  static_assets_max_age_days: number
  /** 存在 .br / .gz 预压缩文件时直接返回 */
  static_precompressed: boolean
}

/** Discord 登录门槛的规则组：组内每个服务器条件都满足才算通过 */
export interface DiscordRuleGroup {
  conditions: DiscordGuildCondition[]
}

/** 服务器条件：须为该服务器成员（已通过成员审核），身份组按三个列表判断，空列表不检查 */
export interface DiscordGuildCondition {
  guild_id: string
  /** 必须全部拥有 */
  all_roles: string[]
  /** 至少拥有其中一个 */
  any_roles: string[]
  /** 拥有其中任一即不满足 */
  deny_roles: string[]
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
  admin_disabled?: boolean
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
  node_version: string
  /** 当前 Node 是否支持 zstd（需 ≥ 22.15） */
  zstd_available: boolean
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

// ── 门户用户管理 API 契约（内网管理端）──────────────────
/** GET /api/users 列表项，不含密码哈希 */
export interface UserView {
  id: number
  username: string
  status: number
  quota: number
  used_quota: number
  request_count: number
  register_ip: string | null
  created_at: number
  last_login_at: number | null
  last_login_ip: string | null
  key_count: number
  groups: string[]
  discord_id: string | null
  discord_username: string | null
  /** 没有密码的账号只能用 Discord 登录 */
  has_password: boolean
  discord_guilds_at: number | null
}

/** 用户 Discord 登录时所在的服务器，供管理端排查 */
export interface DiscordGuild {
  id: string
  name: string
  /** 图标哈希，拼 CDN 地址用 */
  icon: string | null
  /** 是否为服主 */
  owner: boolean
  /** Discord 给出的近似成员数 */
  member_count: number | null
}

/** 统计页服务器排名的一项；名称、图标、成员数取最近一次记录 */
export interface DiscordGuildRank extends Omit<DiscordGuild, 'owner'> {
  /** 库内加入了该服务器的用户数 */
  user_count: number
}

export interface DiscordGuildRanking {
  /** 已记录过服务器列表的用户数，用来算占比 */
  recorded_users: number
  /** 库内用户加入的服务器总数（去重） */
  total_guilds: number
  items: DiscordGuildRank[]
}

export interface UserListResult {
  items: UserView[]
  total: number
  page: number
  size: number
}

/** 公告类型，决定门户上的颜色点 */
export type AnnouncementType = 'default' | 'ongoing' | 'success' | 'warning' | 'error'

/** 门户公告 */
export interface Announcement {
  id: number
  /** Markdown */
  content: string
  /** 附加说明，显示在内容下方 */
  extra: string
  type: AnnouncementType
  /** 发布时间；晚于当前时间的为定时发布，到点前门户不显示 */
  publish_at: number
  created_at: number
  updated_at: number
}

/** POST /api/announcements 与 PUT /api/announcements/:id 的请求体；PUT 只更新出现的字段 */
export interface AnnouncementInput {
  content?: string
  extra?: string
  type?: AnnouncementType
  publish_at?: number
}
