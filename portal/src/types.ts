// 门户 API 契约，与 server/src/routes/portal.ts 对应；额度字段均为点数

export interface PortalStatus {
  /** 注册总开关 */
  register_enabled: boolean
  /** 可以用用户名密码注册（已计入总开关） */
  password_register_enabled: boolean
  /** 可以用 Discord 登录；未注册的账号能否建号还看总开关 */
  discord_enabled: boolean
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
  /** 背景图地址；空串表示不启用 */
  background: string
  /** 有背景图时：内容面板不透明度（%）、模糊半径（px）、背景白色遮罩浓度（%） */
  background_opacity: number
  background_blur: number
  background_dim: number
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
  /** Discord 建的号才有 */
  discord_username: string | null
  /** 没有密码的账号只能用 Discord 登录 */
  has_password: boolean
}

export interface UsageDay {
  day: string
  requests: number
  points: number
  prompt_tokens: number
  completion_tokens: number
}

/** 模型基础价格（未乘分组倍率）：每 Token 点数，per_request 为每次点数 */
export interface ModelPrice {
  model: string
  input: number
  output: number
  cache_read: number
  cache_write: number
  per_request: number
  /** 用户可用分组中能调用该模型的分组 */
  groups: string[]
}

export interface PricingData {
  groups: PortalGroup[]
  models: ModelPrice[]
}

/** 可用性：一格内计入统计的结果数 */
export interface AvailabilityCell {
  total: number
  errors: number
  /** 其中自动测活的次数 */
  probes: number
}

export interface AvailabilityModel {
  model: string
  /** 用户可用分组里提供该模型的分组 */
  groups: string[]
  cells: AvailabilityCell[]
}

export interface AvailabilityData {
  cell_ms: number
  /** 第一格的开始时间；最后一格是当前尚未结束的格子 */
  start: number
  models: AvailabilityModel[]
}

export type AnnouncementType = 'default' | 'ongoing' | 'success' | 'warning' | 'error'

export interface Announcement {
  id: number
  /** Markdown */
  content: string
  extra: string
  type: AnnouncementType
  publish_at: number
  updated_at: number
}

export interface Notices {
  /** Markdown，空串表示没有通知 */
  notice: string
  /** 已发布的最近公告，管理员关闭公告时为空 */
  announcements: Announcement[]
}

export type KeyStatus = 'enabled' | 'disabled' | 'expired'

/** 用户可选的分组 */
export interface PortalGroup {
  name: string
  description: string
  /** 分组倍率：扣费 = 模型价格 × ratio */
  ratio: number
}

export interface PortalKey {
  id: number
  name: string
  /** 脱敏后的 Key */
  key: string
  status: KeyStatus
  /** 被管理员停用：用户不能自行启用，只能联系管理员 */
  admin_disabled: boolean
  group: string | null
  /** 分组被删除或不再对当前用户开放时为 false，此时令牌无法调用 */
  group_available: boolean
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
  /** 计费所用分组 */
  group_name: string | null
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
