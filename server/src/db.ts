import Database from 'better-sqlite3'
import fs from 'node:fs'
import { BACKUP_DIR, DATA_DIR, DB_PATH, DEFAULT_SETTINGS } from './config'
import { migrateLogs } from './migrations/logs'
import type { Channel, ChannelRow, ChannelStatus, ParamRule, PreprocessRule, Settings, ToolFilterRule } from './types'

fs.mkdirSync(DATA_DIR, { recursive: true })

export const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('busy_timeout = 5000')

// 日志结构变更先创建包含 WAL 的一致性备份；失败时停止启动，旧日志不会被丢弃。
const logMigration = migrateLogs(db, BACKUP_DIR)
if (logMigration.backupPath) console.warn(`[agghub] 日志迁移前备份：${logMigration.backupPath}`)
if (logMigration.legacyTable) console.warn(`[agghub] 旧日志保留于 ${logMigration.legacyTable}，请验收后再安排归档清理`)
// 增量自动回收：删日志后能逐步归还空闲页而不用整库 VACUUM。修改该 pragma 需要 VACUUM 一次才生效。
if (db.pragma('auto_vacuum', { simple: true }) !== 2) {
  db.pragma('auto_vacuum = INCREMENTAL')
  db.exec('VACUUM')
}

db.exec(`
CREATE TABLE IF NOT EXISTS channels (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  type          TEXT    NOT NULL,
  base_url      TEXT,
  api_key       TEXT    NOT NULL DEFAULT '',
  models        TEXT    NOT NULL DEFAULT '[]',
  model_mapping TEXT,
  priority      INTEGER NOT NULL DEFAULT 0,
  weight        INTEGER NOT NULL DEFAULT 1,
  status        INTEGER NOT NULL DEFAULT 1,
  region        TEXT,
  timeout_ms    INTEGER,
  ua_override   INTEGER NOT NULL DEFAULT 0,
  ua_value      TEXT,
  strip_headers INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`)

// 旧库补列（CREATE TABLE IF NOT EXISTS 不会给已存在的表加列）
{
  const cols = db.prepare('PRAGMA table_info(channels)').all() as { name: string }[]
  if (!cols.some((c) => c.name === 'ua_override')) {
    db.exec('ALTER TABLE channels ADD COLUMN ua_override INTEGER NOT NULL DEFAULT 0')
  }
  if (!cols.some((c) => c.name === 'ua_value')) {
    db.exec('ALTER TABLE channels ADD COLUMN ua_value TEXT')
  }
  if (!cols.some((c) => c.name === 'strip_headers')) {
    db.exec('ALTER TABLE channels ADD COLUMN strip_headers INTEGER NOT NULL DEFAULT 0')
  }
}

// 注入默认设置（已存在的 key 不覆盖）
{
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v)
  })
  tx()
}

// ── settings 读写 ───────────────────────────────────────
export function getSettingsRaw(): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
  const o: Record<string, string> = Object.create(null)
  for (const r of rows) o[r.key] = r.value
  return o
}

export function getSettings(): Settings {
  const r = getSettingsRaw()
  return {
    single_retry_times: Number(r.single_retry_times ?? 1),
    channel_retry_times: Number(r.channel_retry_times ?? 2),
    retry_interval_ms: Number(r.retry_interval_ms ?? 0),
    request_timeout_ms: Number(r.request_timeout_ms ?? 120000),
    request_max_duration_ms: Number(r.request_max_duration_ms ?? DEFAULT_SETTINGS.request_max_duration_ms),
    downstream_timeout_ms: Number(r.downstream_timeout_ms ?? DEFAULT_SETTINGS.downstream_timeout_ms),
    log_response_max_bytes: Number(r.log_response_max_bytes ?? DEFAULT_SETTINGS.log_response_max_bytes),
    stream_buffer_max_bytes: Number(r.stream_buffer_max_bytes ?? DEFAULT_SETTINGS.stream_buffer_max_bytes),
    image_max_bytes: Number(r.image_max_bytes ?? DEFAULT_SETTINGS.image_max_bytes),
    image_total_max_bytes: Number(r.image_total_max_bytes ?? DEFAULT_SETTINGS.image_total_max_bytes),
    image_max_count: Number(r.image_max_count ?? DEFAULT_SETTINGS.image_max_count),
    image_download_concurrency: Number(r.image_download_concurrency ?? DEFAULT_SETTINGS.image_download_concurrency),
    image_allowed_hosts: safeArray(r.image_allowed_hosts),
    failover_strategy: 'priority_descend',
    auto_ban: r.auto_ban === '1',
    auto_ban_codes: r.auto_ban_codes ?? '401,403',
    log_retention_days: Number(r.log_retention_days ?? 30),
    store_request_body: r.store_request_body === '1',
    store_response_body: r.store_response_body === '1',
    access_token: r.access_token ?? '',
    drop_thinking: r.drop_thinking === '1',
    drop_thinking_keep_last: Number(r.drop_thinking_keep_last ?? 0),
    drop_thinking_channel_ids: safeArray(r.drop_thinking_channel_ids).map(Number).filter((n) => Number.isFinite(n)),
    drop_thinking_models: safeArray(r.drop_thinking_models),
    drop_redacted_thinking: r.drop_redacted_thinking === '1',
    strip_top_p: r.strip_top_p === '1',
    preprocess_rules: safeRules(r.preprocess_rules),
    tool_filter_rules: safeToolFilterRules(r.tool_filter_rules),
    param_rules: safeJsonArray<ParamRule>(r.param_rules),
    pseudo_thinking_enabled: r.pseudo_thinking_enabled === '1',
    pseudo_thinking_channel_ids: safeArray(r.pseudo_thinking_channel_ids).map(Number).filter((n) => Number.isFinite(n)),
    pseudo_thinking_models: safeArray(r.pseudo_thinking_models),
    pseudo_thinking_open_tag: r.pseudo_thinking_open_tag ?? '<thinking>',
    pseudo_thinking_close_tag: r.pseudo_thinking_close_tag ?? '</thinking>',
    pseudo_thinking_prompt: r.pseudo_thinking_prompt ?? '',
    pseudo_thinking_store_max: Number(r.pseudo_thinking_store_max ?? 5000),
    reasoning_store_max: Number(r.reasoning_store_max ?? 2000),
    reasoning_auto_adjust: (r.reasoning_auto_adjust ?? '1') === '1',
    proxy_url: r.proxy_url ?? '',
  }
}

export function setSettings(patch: Record<string, string | number | boolean>): void {
  const up = db.prepare(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  )
  const entries: [string, string][] = Object.entries(patch).map(([k, v]) => [
    k,
    typeof v === 'boolean' ? (v ? '1' : '0') : String(v),
  ])
  const tx = db.transaction(() => {
    for (const [k, v] of entries) up.run(k, v)
  })
  tx()
}

// ── 渠道行 ↔ 应用对象 ──────────────────────────────────
function safeArray(s: string | null | undefined): string[] {
  if (!s) return []
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    // 兼容逗号分隔的历史写法
    return s.split(',').map((x) => x.trim()).filter(Boolean)
  }
}

function safeObject(s: string | null | undefined): Record<string, string> | null {
  if (!s) return null
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

function safeRules(s: string | null | undefined): PreprocessRule[] {
  if (!s) return []
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? (v as PreprocessRule[]) : []
  } catch {
    return []
  }
}

function safeToolFilterRules(s: string | null | undefined): ToolFilterRule[] {
  if (!s) return []
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? (v as ToolFilterRule[]) : []
  } catch {
    return []
  }
}

/** 通用：JSON 数组字符串 → T[]，非法 / 非数组一律返回空数组 */
function safeJsonArray<T>(s: string | null | undefined): T[] {
  if (!s) return []
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? (v as T[]) : []
  } catch {
    return []
  }
}

export function rowToChannel(r: ChannelRow): Channel {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    base_url: r.base_url,
    api_key: r.api_key,
    models: safeArray(r.models),
    model_mapping: safeObject(r.model_mapping),
    priority: r.priority,
    weight: r.weight,
    status: r.status as ChannelStatus,
    region: r.region,
    timeout_ms: r.timeout_ms,
    ua_override: !!r.ua_override,
    ua_value: r.ua_value,
    strip_headers: !!r.strip_headers,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}

/** 所有渠道（按优先级降序），含禁用 */
export function allChannels(): Channel[] {
  const rows = db
    .prepare('SELECT * FROM channels ORDER BY priority DESC, id ASC')
    .all() as ChannelRow[]
  return rows.map(rowToChannel)
}

/** 仅启用（status=1）的渠道 */
export function enabledChannels(): Channel[] {
  return allChannels().filter((c) => c.status === 1)
}

export function getChannelById(id: number): Channel | null {
  const row = db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as ChannelRow | undefined
  return row ? rowToChannel(row) : null
}

/** 设置渠道状态（用于熔断/手动启停）*/
export function setChannelStatus(id: number, status: ChannelStatus): void {
  db.prepare('UPDATE channels SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id)
}
