// 门户 API 契约，与 server/src/routes/portal.ts 对应；额度字段均为点数

export interface PortalStatus {
  register_enabled: boolean
  checkin_enabled: boolean
  checkin_min_points: number
  checkin_max_points: number
  points_per_usd: number
  /** 余额符号，金额显示时前置 */
  currency_symbol: string
  brand_name: string
  /** emoji / 文字，或图片地址 */
  brand_icon: string
  site_title: string
  base_url: string
  log_retention_days: number
}

export interface Self {
  id: number
  username: string
  /** 剩余点数，透支时为负 */
  quota: number
  used_quota: number
  request_count: number
  created_at: number
  today_requests: number
  today_points: number
}

export interface UsageDay {
  day: string
  requests: number
  points: number
  prompt_tokens: number
  completion_tokens: number
}

/** 模型倍率：每 Token 点数，per_request 为每次点数 */
export interface ModelPrice {
  model: string
  input: number
  output: number
  cache_read: number
  cache_write: number
  per_request: number
}

export type KeyStatus = 'enabled' | 'disabled' | 'expired'

export interface PortalKey {
  id: number
  name: string
  /** 脱敏后的 Key */
  key: string
  status: KeyStatus
  used_quota: number
  expires_at: number | null
  created_at: number
  last_used_at: number | null
  /** 只在创建时返回 */
  full_key?: string
}

export interface LogItem {
  id: number
  created_at: number
  key_id: number | null
  key_name: string | null
  model: string | null
  entry_format: string
  is_stream: number
  status: 'success' | 'error'
  status_code: number | null
  latency_ms: number | null
  prompt_tokens: number
  completion_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  quota_points: number | null
  error_message: string | null
}

export interface LogPage {
  items: LogItem[]
  total: number
  page: number
  size: number
}

export interface CheckinInfo {
  enabled: boolean
  min_points: number
  max_points: number
  checked_in_today: boolean
  total_checkins: number
  total_points: number
  month_points: number
  records: { day: string; points: number }[]
}
