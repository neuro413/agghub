// 渠道 / 设置 / 规则类型与后端共用（type-only 导入，构建时擦除）
import type { Channel as ServerChannel, CallerSource, CompressionUnsupported, CompressStatus, LogBodyField } from '../../server/src/types'
export type { LogBodyField } from '../../server/src/types'
export type {
  ChannelType, SingleRoleMode, KeyMode, ChannelKeyStatus, EntryFormat, Settings, PreprocessRule, ToolFilterRule, ParamOpType, ParamOp, ParamRule,
  CallerSource, ModelRatio, ApiKey, ApiKeyView, ApiKeyInput, KeyQuotaOp, KeyUsageDay, SystemInfo, BillingPreviewInput, BillingPreviewResult,
  UserView, UserListResult, DiscordGuild, DiscordGuildRanking, DiscordRuleGroup, DiscordGuildCondition, OpenRouterPrice, ChannelGroup, ChannelGroupView, ChannelGroupInput,
  Announcement, AnnouncementInput, AnnouncementType,
  CompressionAlgorithm, RequestCompression, CompressStatus, CompressionUnsupported, CompressionTestResult, CompressionTestItem,
} from '../../server/src/types'
import type { CoreStatus as PoolCoreStatusT, PoolSettings as PoolSettingsT, TestProgress as PoolTestProgressT } from '../../server/src/pool/types'
export type {
  PoolSettings, NodeView as PoolNodeView, PoolSubscription, CoreStatus as PoolCoreStatus, TestProgress as PoolTestProgress, DelayResult,
} from '../../server/src/pool/types'

/** 列表接口附带今日统计；多 key 渠道附带 key 总数与当前可用数；附带记忆期内被判定不支持的压缩算法
 *  today_avg_latency / today_hourly 需要后端支持，缺失时前端不渲染对应内容 */
export type Channel = ServerChannel & {
  today_requests?: number; today_success?: number; key_total?: number; key_available?: number
  today_avg_latency?: number | null; today_hourly?: number[]
  compression_unsupported?: CompressionUnsupported[]
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
  total_points: number
}

/** 当前值为最近 60 秒；峰值为所选范围内的自然分钟，at 为该分钟起点 */
export interface StatsThroughput {
  current_rpm: number
  current_tpm: number
  peak_rpm: number
  peak_rpm_at: number | null
  peak_tpm: number
  peak_tpm_at: number | null
}

export interface Stats {
  range: string
  bucketMs: number
  since: number
  overview: StatsOverview
  /** 上一个等长区间的概览，用于环比；需要后端支持，缺失时不显示涨跌 */
  overview_prev?: StatsOverview
  throughput: StatsThroughput
  /** peak_rpm / peak_tpm 为该桶内的峰值分钟；errors 为失败数，需要后端支持 */
  trend: { bucket: number; requests: number; tokens: number; points: number; peak_rpm: number; peak_tpm: number; errors?: number }[]
  by_channel: { channel_id: number; channel_name: string; count: number; success: number }[]
  by_model: { model: string; count: number }[]
  by_key: { key_id: number; key_name: string | null; count: number; success: number; points: number }[]
  /** ip 为 null 表示未记录；keys 为用量最多的前 5 个，key_id 为 null 表示内网匿名调用 */
  by_ip: {
    ip: string | null
    count: number
    success: number
    tokens: number
    points: number
    key_count: number
    keys: { key_id: number | null; key_name: string | null; user_id: number | null; user_name: string | null; count: number }[]
  }[]
  /** ua 为 null 表示未记录（旧日志未存请求头或请求不带 UA） */
  by_ua: { ua: string | null; count: number; success: number; tokens: number; points: number }[]
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
  /** 首字延迟：从网关收到请求到开始输出首个内容（含思考）；非流式与旧日志为 null */
  first_token_ms: number | null
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
  /** 实际返回客户端的错误信息，仅被脱敏改写时有值 */
  client_error: string | null
  preprocessed: number
  pseudo_thinking: number
  /** 调用来源；旧日志为 null，按 owner 显示 */
  source: CallerSource | null
  key_id: number | null
  key_name: string | null
  client_ip: string | null
  /** 本次请求折算点数；未命中倍率时为 null */
  quota_points: number | null
  /** 门户用户 id 与当前用户名（用户已删除时用户名为 null） */
  user_id: number | null
  user_name: string | null
  /** 门户用户绑定的 Discord 用户名 */
  user_discord_name: string | null
  /** 计费所用分组；owner 调用为 null */
  group_name: string | null
  /** 多 key 渠道本次使用的上游 key（序号 + 脱敏值） */
  channel_key: string | null
  /** 代理池节点名；本次尝试换过节点时用「 → 」连接 */
  proxy_node: string | null
  /** 上游请求体压缩（列表接口不返回，只在详情里有） */
  upstream_encoding?: string | null
  upstream_raw_bytes?: number | null
  upstream_sent_bytes?: number | null
  compress_ms?: number | null
  compress_status?: CompressStatus | null
  compress_note?: string | null
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

// ── 代理池 ──
export interface PoolCounts {
  total: number
  enabled: number
  available: number
  cooling: number
  invalid: number
}

export interface PoolStatus {
  /** 不含 secret */
  settings: Omit<PoolSettingsT, 'secret'>
  core: PoolCoreStatusT
  counts: PoolCounts
  test: PoolTestProgressT
}

export interface PoolImportResult {
  added: number
  updated: number
  total: number
  errors: string[]
}

export interface PoolMatch {
  matched: number
  available: number
  running: boolean
  node_retry_times: number
}

export type PoolBatchAction = 'enable' | 'disable' | 'delete' | 'reset'

export interface PoolSubscriptionInput {
  name: string
  url: string
  user_agent: string
  update_interval: number
}
