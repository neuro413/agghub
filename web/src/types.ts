// 渠道 / 设置 / 规则类型与后端共用（type-only 导入，构建时擦除）
import type { Channel as ServerChannel, CallerSource, LogBodyField } from '../../server/src/types'
export type { LogBodyField } from '../../server/src/types'
export type {
  ChannelType, SingleRoleMode, EntryFormat, Settings, PreprocessRule, ToolFilterRule, ParamOpType, ParamOp, ParamRule,
  CallerSource, ModelRatio, ApiKey, ApiKeyView, ApiKeyInput, KeyQuotaOp, KeyUsageDay, SystemInfo, BillingPreviewInput, BillingPreviewResult,
} from '../../server/src/types'

export type Channel = ServerChannel & { today_requests?: number; today_success?: number }

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
  total_points: number
}

export interface Stats {
  range: string
  bucketMs: number
  since: number
  overview: StatsOverview
  trend: { bucket: number; requests: number; tokens: number; points: number }[]
  by_channel: { channel_id: number; channel_name: string; count: number; success: number }[]
  by_model: { model: string; count: number }[]
  by_key: { key_id: number; key_name: string | null; count: number; success: number; points: number }[]
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
  request_id: string | null
  attempt_latency_ms: number | null
  response_body_truncated: number
  upstream_response_body_truncated: number
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  /** 缓存读取 / 写入 token（prompt_tokens 的子集）*/
  cache_read_tokens: number
  cache_write_tokens: number
  retry_count: number
  is_stream: number
  error_message: string | null
  preprocessed: number
  pseudo_thinking: number
  /** 调用来源；旧日志为 null，按 owner 显示 */
  source: CallerSource | null
  key_id: number | null
  key_name: string | null
  client_ip: string | null
  /** 本次请求折算点数；未命中倍率时为 null */
  quota_points: number | null
}

export type PartialLogDetail = LogItem & Partial<Pick<LogDetail, LogBodyField>> & { available_fields?: LogBodyField[] }

export interface LogDetail extends LogItem {
  available_fields?: LogBodyField[]
  request_headers: string | null
  request_body: string | null
  response_body: string | null
  preprocessed_body: string | null
  thinking_inject: string | null
  /** 上游原始回复：非流式为原始 JSON，流式为原始 SSE 帧，HTTP 错误为原始错误体 */
  upstream_response_body: string | null
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
  keys: { key_id: number; key_name: string | null; n: number }[]
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
