import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Settings } from './types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** server/ 目录 */
export const SERVER_ROOT = path.resolve(__dirname, '..')
/** 项目根 agghub/ */
export const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..')
/** SQLite 数据目录；测试必须在进程启动前指定隔离位置。 */
export const DATA_DIR = path.resolve(process.env.AGGHUB_DATA_DIR || path.join(PROJECT_ROOT, 'data'))
if (process.env.AGGHUB_TESTING === '1' && DATA_DIR.toLowerCase() === path.join(PROJECT_ROOT, 'data').toLowerCase()) {
  throw new Error('测试禁止使用项目实际 data 目录，请通过隔离测试启动器运行')
}
/** 数据库文件 */
export const DB_PATH = path.join(DATA_DIR, 'agghub.db')
/** 前端构建产物（生产托管）*/
export const WEB_DIST = path.resolve(PROJECT_ROOT, 'web', 'dist')
/** 用户门户构建产物，只在公网端口托管 */
export const PORTAL_DIST = path.resolve(PROJECT_ROOT, 'portal', 'dist')
/** 网关端口（默认 3210，避开常见代理端口）*/
export const PORT = Number(process.env.PORT) || 3210
/** 内网监听地址；不设则监听所有网卡 */
export const HOST = process.env.HOST || undefined
/** 公网端口；不设（0）则不开启公网监听器 */
export const PUBLIC_PORT = Number(process.env.AGGHUB_PUBLIC_PORT) || 0
/** 公网监听地址，默认只监听回环，交给隧道 / 反代暴露 */
export const PUBLIC_HOST = process.env.AGGHUB_PUBLIC_HOST || '127.0.0.1'

/** 公网 app 的 Express trust proxy：false / 跳数 / loopback 等预设或 CIDR 列表 */
function parseTrustProxy(raw: string): boolean | number | string {
  const value = raw.trim()
  if (!value || value === 'false' || value === '0') return false
  if (value === 'true') return true
  if (/^\d+$/.test(value)) return Number(value)
  return value
}
export const TRUST_PROXY = parseTrustProxy(process.env.AGGHUB_TRUST_PROXY ?? 'loopback')

/** 设置默认值；库中以字符串存储，读取时按默认值的类型解析（数字 / 布尔 / JSON 数组 / 文本） */
export const DEFAULT_SETTINGS: Settings = {
  single_retry_times: 1,
  channel_retry_times: 2,
  retry_interval_ms: 0,
  request_timeout_ms: 120000,
  request_max_duration_ms: 1800000,
  /** 流式超过该时长没有向客户端输出就发 SSE 注释保活；0 关闭 */
  stream_keepalive_ms: 30000,
  log_response_max_bytes: 4194304,
  stream_buffer_max_bytes: 16777216,
  image_max_bytes: 20971520,
  auto_ban: true,
  auto_ban_codes: '401,403',
  log_retention_days: 30,
  store_request_body: true,
  store_response_body: true,
  access_token: '',
  drop_thinking: false,
  drop_thinking_keep_last: 0,
  drop_thinking_channel_ids: [],
  drop_thinking_models: [],
  drop_redacted_thinking: false,
  preprocess_rules: [],
  tool_filter_rules: [],
  param_rules: [],
  // 伪思考（伪原生思维链）：仅对 Anthropic 入口→Anthropic 上游直通生效，需 drop_thinking 先开启
  pseudo_thinking_enabled: false,
  pseudo_thinking_channel_ids: [],
  pseudo_thinking_models: [],
  pseudo_thinking_open_tag: '<thinking>',
  pseudo_thinking_close_tag: '</thinking>',
  /** 留空则按当前标签自动生成 */
  pseudo_thinking_prompt: '',
  pseudo_thinking_store_max: 5000,
  /** 跨格式思维链往返：Responses 上游密文暂存上限 */
  reasoning_store_max: 2000,
  proxy_url: '',
  /** 默认一条 * 规则，开箱即用；删掉后未定价模型不允许 Key 调用 */
  model_ratios: [{ id: 'default', pattern: '*', input: 1, output: 1, cache_read: 1, cache_write: 1, per_request: 0 }],
  /** 默认值保持旧行为：命中一次即停用、只能手动恢复 */
  auto_ban_threshold: 1,
  auto_ban_cooldown_minutes: 0,
  public_base_url: '',
  portal_register_enabled: true,
  portal_password_register_enabled: true,
  portal_initial_quota: 0,
  portal_register_ip_daily: 3,
  portal_max_keys: 10,
  portal_rpm: 0,
  portal_concurrency: 2,
  /** 与 new-api 的 QuotaPerUnit 一致 */
  portal_points_per_usd: 500000,
  currency_symbol: '$',
  portal_brand_name: 'AggHub',
  portal_brand_icon: '🍊',
  portal_site_title: 'AggHub 控制台',
  portal_background: '',
  portal_background_opacity: 80,
  portal_background_blur: 12,
  portal_background_dim: 10,
  checkin_enabled: false,
  checkin_min_points: 50000,
  checkin_max_points: 250000,
  portal_notice: '',
  portal_announcements_enabled: true,
  discord_enabled: false,
  discord_client_id: '',
  discord_client_secret: '',
  discord_rules: [],
}

/** 整数设置的取值范围（保存时校验） */
export const INTEGER_RANGES: Partial<Record<keyof Settings, [number, number]>> = {
  single_retry_times: [0, 100], channel_retry_times: [0, 20], retry_interval_ms: [0, 300_000],
  request_timeout_ms: [1, 86_400_000], request_max_duration_ms: [0, 86_400_000], stream_keepalive_ms: [0, 600_000],
  log_retention_days: [1, 3650], drop_thinking_keep_last: [0, 100_000], pseudo_thinking_store_max: [0, 1_000_000], reasoning_store_max: [0, 1_000_000],
  log_response_max_bytes: [0, 64 * 1024 * 1024], stream_buffer_max_bytes: [1024, 256 * 1024 * 1024],
  image_max_bytes: [1, 100 * 1024 * 1024],
  auto_ban_threshold: [1, 100], auto_ban_cooldown_minutes: [0, 10_080],
  portal_initial_quota: [0, 1_000_000_000_000], portal_register_ip_daily: [0, 10_000], portal_max_keys: [1, 1000],
  portal_rpm: [0, 100_000], portal_concurrency: [0, 100_000], portal_points_per_usd: [1, 1_000_000_000_000],
  checkin_min_points: [0, 1_000_000_000_000], checkin_max_points: [0, 1_000_000_000_000],
  portal_background_opacity: [0, 100], portal_background_blur: [0, 40], portal_background_dim: [0, 90],
}
