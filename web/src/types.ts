export type ChannelType = 'openai' | 'anthropic' | 'vertex' | 'responses'
/** 对外入口格式 */
export type EntryFormat = 'openai' | 'anthropic' | 'responses'

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
  status: number // 1=启用 0=手动禁用 2=自动禁用
  region: string | null
  timeout_ms: number | null
  ua_override: boolean
  ua_value: string | null
  strip_headers: boolean
  created_at: number
  updated_at: number
  today_requests?: number
  today_success?: number
}

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
  image_total_max_bytes: number
  image_max_count: number
  image_download_concurrency: number
  image_allowed_hosts: string[]
  failover_strategy: string
  auto_ban: boolean
  auto_ban_codes: string
  log_retention_days: number
  store_request_body: boolean
  store_response_body: boolean
  access_token: string
  drop_thinking: boolean
  drop_thinking_keep_last: number
  drop_thinking_channel_ids: number[]
  drop_thinking_models: string[]
  drop_redacted_thinking: boolean
  strip_top_p: boolean
  preprocess_rules: PreprocessRule[]
  tool_filter_rules: ToolFilterRule[]
  param_rules: ParamRule[]
  pseudo_thinking_enabled: boolean
  pseudo_thinking_channel_ids: number[]
  pseudo_thinking_models: string[]
  pseudo_thinking_open_tag: string
  pseudo_thinking_close_tag: string
  pseudo_thinking_prompt: string
  pseudo_thinking_store_max: number
  reasoning_store_max: number
  reasoning_auto_adjust: boolean
  proxy_url: string
}

export interface PreprocessRule {
  id: string
  enabled: boolean
  name?: string
  source: 'visual' | 'regex'
  pattern: string
  flags: string
  replacement: string
  roles?: string[]
  channelIds?: number[]
  formats?: EntryFormat[]
  models?: string[]
  depth?: number
}

export interface ToolFilterRule {
  id: string
  enabled: boolean
  name?: string
  tools: string[]
  channelIds?: number[]
  formats?: EntryFormat[]
  models?: string[]
}

export type ParamOpType = 'set' | 'set_if_missing' | 'set_if_present' | 'delete' | 'regex'

export interface ParamOp {
  type: ParamOpType
  /** 参数路径，支持 a.b.c 点路径；regex 不使用 */
  key?: string
  /** 值文本：按 JSON 解析，失败按字符串；delete / regex 不使用 */
  value?: string
  /** regex 专用 */
  pattern?: string
  flags?: string
  replacement?: string
}

export interface ParamRule {
  id: string
  enabled: boolean
  name?: string
  ops: ParamOp[]
  channelIds?: number[]
  formats?: EntryFormat[]
  models?: string[]
}

export interface ParamTestResult {
  wireFormat: string
  changed: boolean
  body: any
  errors: string[]
}

export interface StatsOverview {
  total: number
  success: number
  error: number
  success_rate: number
  total_tokens: number
  avg_latency: number
}

export interface Stats {
  range: string
  bucketMs: number
  since: number
  overview: StatsOverview
  trend: { bucket: number; requests: number; tokens: number }[]
  by_channel: { channel_id: number; channel_name: string; count: number; success: number }[]
  by_model: { model: string; count: number }[]
}

export interface LogItem {
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
  request_id?: string | null
  attempt_latency_ms?: number | null
  response_body_truncated?: number
  upstream_response_body_truncated?: number
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  /** 缓存读取 / 写入 token（prompt_tokens 的子集；旧日志可能缺省）*/
  cache_read_tokens?: number
  cache_write_tokens?: number
  retry_count: number
  is_stream: number
  error_message: string | null
  preprocessed?: number
  pseudo_thinking?: number
}

export interface LogDetail extends LogItem {
  request_headers: string | null
  request_body: string | null
  response_body: string | null
  preprocessed_body?: string | null
  thinking_inject?: string | null
  /** 上游原始回复：非流式为原始 JSON，流式为原始 SSE 帧，HTTP 错误为原始错误体（旧日志缺省）*/
  upstream_response_body?: string | null
}

export interface TestResult {
  ok: boolean
  message: string
  models?: string[]
  latency_ms: number
}

export interface LogFacets {
  models: { model: string; n: number }[]
  channels: { channel_id: number; channel_name: string; n: number }[]
}

export interface ThinkingEntry {
  signature: string
  preview: string
  length: number
  created_at: number
}

export interface ThinkingDetail {
  signature: string
  thinking: string
  length: number
}
