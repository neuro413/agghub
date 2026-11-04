/** 代理池设置（settings 表 key=proxy_pool，JSON 存储） */
export interface PoolSettings {
  /** 总开关：开启时随网关自启 mihomo */
  enabled: boolean
  /** 内核路径，空串 = data/mihomo/mihomo(.exe) */
  core_path: string
  controller_port: number
  /** 节点入站端口从这里递增分配 */
  listen_base_port: number
  /** 控制器鉴权，首次加载随机生成 */
  secret: string
  test_url: string
  test_timeout_ms: number
  test_concurrency: number
  /** 定时拨测 */
  probe_enabled: boolean
  probe_interval_minutes: number
  /** 拨测连续失败达到 N 次自动禁用，0 = 不自动禁用 */
  auto_disable_failures: number
  /** 单次尝试最多换几个节点 */
  node_retry_times: number
  /** 429/403 冷却秒数（上游 Retry-After 更大时取它） */
  limit_cooldown_seconds: number
  /** 入口代理：节点 URI 或 http(s)/socks5 地址，空串 = 不启用 */
  entry_proxy: string
  /** 下载内核 / 拉订阅失败时用的代理，空串 = 用全局 proxy_url */
  download_proxy: string
}

/** 解析后的节点（导入前） */
export interface ParsedNode {
  name: string
  type: string
  /** mihomo proxy map，不含 name */
  config: Record<string, unknown>
  raw: string | null
  identity: string
}

/** 节点（库字段 + 内存运行态） */
export interface PoolNode {
  id: number
  name: string
  type: string
  config: Record<string, unknown>
  raw: string | null
  identity: string
  sources: string[]
  disabled: boolean
  invalid_reason: string | null
  success_count: number
  fail_count: number
  consecutive_failures: number
  limit_count: number
  last_delay_ms: number | null
  last_error: string | null
  last_test_at: number | null
  last_success_at: number | null
  last_fail_at: number | null
  cooldown_until: number | null
  created_at: number
  updated_at: number
  /** 以下为内存态，不落库 */
  inFlight: number
  lastSelectedAt: number
}

export interface PoolSubscription {
  id: number
  name: string
  url: string
  user_agent: string
  /** 分钟，0 = 仅手动 */
  update_interval: number
  last_update_at: number | null
  last_error: string | null
  node_count: number
  /** subscription-userinfo 响应头原文 */
  userinfo: string | null
  created_at: number
  updated_at: number
}

/** 给前端的节点视图（不含 config） */
export interface NodeView {
  id: number
  name: string
  type: string
  server: string
  server_port: number | null
  sources: string[]
  disabled: boolean
  invalid_reason: string | null
  local_port: number | null
  in_flight: number
  success_count: number
  fail_count: number
  consecutive_failures: number
  limit_count: number
  last_delay_ms: number | null
  last_error: string | null
  last_test_at: number | null
  last_success_at: number | null
  last_fail_at: number | null
  cooldown_until: number | null
  sub_healthy: boolean
}

export type CoreState = 'not_installed' | 'stopped' | 'starting' | 'running' | 'error'

export interface CoreStatus {
  state: CoreState
  version: string | null
  path: string
  installed: boolean
  pid: number | null
  error: string | null
  /** 入口代理配置被 mihomo 拒绝时的错误 */
  entry_error: string | null
  /** 当前生效的节点入站数 */
  listeners: number
  downloading: boolean
}

export interface TestProgress {
  running: boolean
  paused: boolean
  /** batch = 手动批量测速，probe = 定时拨测 */
  kind: 'batch' | 'probe' | null
  total: number
  done: number
  ok: number
  fail: number
  started_at: number | null
  finished_at: number | null
}

export interface DelayResult {
  ok: boolean
  delay?: number
  error?: string
}
