import Database from 'better-sqlite3'
import fs from 'node:fs'
import { DATA_DIR, DB_PATH, DEFAULT_SETTINGS } from './config'
import type { Channel, ChannelRow, ChannelStatus, Settings } from './types'

fs.mkdirSync(DATA_DIR, { recursive: true })

export const db = new Database(DB_PATH)
// 增量自动回收：删日志后能逐步归还空闲页而不用整库 VACUUM。只能在空库写入首页（切换 WAL）之前设置，已有库保持原状。
if (db.pragma('page_count', { simple: true }) === 0) db.pragma('auto_vacuum = INCREMENTAL')
db.pragma('journal_mode = WAL')
db.pragma('busy_timeout = 5000')
// checkpoint 后把 WAL 文件截回 4MB 以内，避免一次大事务后长期占着磁盘
db.pragma('journal_size_limit = 4194304')

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
  single_role   TEXT,
  single_role_merge_system INTEGER NOT NULL DEFAULT 0,
  single_role_exclude_last_user INTEGER NOT NULL DEFAULT 0,
  groups        TEXT    NOT NULL DEFAULT '["default"]',
  ban_until     INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- 分发 Key：明文存储；user_id 非空表示门户用户自己创建的 Key
CREATE TABLE IF NOT EXISTS api_keys (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  key           TEXT    NOT NULL UNIQUE,
  enabled       INTEGER NOT NULL DEFAULT 1,
  groups        TEXT    NOT NULL DEFAULT '[]',
  models        TEXT    NOT NULL DEFAULT '[]',
  rpm           INTEGER,
  concurrency   INTEGER,
  quota_total   INTEGER,
  quota_used    INTEGER NOT NULL DEFAULT 0,
  quota_daily   INTEGER,
  log_bodies    INTEGER,
  expires_at    INTEGER,
  note          TEXT,
  user_id       INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);

-- 按账户的每日用量，与请求日志独立（日志过期清理不影响额度）；account_type 为 'key' 或 'user'
CREATE TABLE IF NOT EXISTS usage_daily (
  account_type      TEXT    NOT NULL,
  account_id        INTEGER NOT NULL,
  day               TEXT    NOT NULL,
  requests          INTEGER NOT NULL DEFAULT 0,
  points            INTEGER NOT NULL DEFAULT 0,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_type, account_id, day)
);

-- 门户用户：quota 为剩余点数（请求结束才扣费，可能透支为负），status 1 启用 / 2 停用
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,
  status        INTEGER NOT NULL DEFAULT 1,
  quota         INTEGER NOT NULL DEFAULT 0,
  used_quota    INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  register_ip   TEXT,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER,
  last_login_ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_register ON users(register_ip, created_at);

-- 门户会话：只存令牌的 SHA-256
CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip         TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions(user_id);

-- 每日签到：主键兜底并发重复签到
CREATE TABLE IF NOT EXISTS user_checkins (
  user_id    INTEGER NOT NULL,
  day        TEXT    NOT NULL,
  points     INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 日志行只存元数据，正文以 *_ref 存 blobs 的块 id（块表由 stats/blobstore 建立）
CREATE TABLE IF NOT EXISTS request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  channel_id INTEGER,
  channel_name TEXT,
  entry_format TEXT NOT NULL DEFAULT 'openai',
  model TEXT,
  upstream_model TEXT,
  status TEXT NOT NULL,
  status_code INTEGER,
  latency_ms INTEGER,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0,
  retry_count INTEGER DEFAULT 0,
  is_stream INTEGER DEFAULT 0,
  is_retry INTEGER DEFAULT 0,
  error_message TEXT,
  preprocessed INTEGER DEFAULT 0,
  pseudo_thinking INTEGER DEFAULT 0,
  request_headers_ref INTEGER,
  request_body_ref INTEGER,
  response_body_ref INTEGER,
  preprocessed_body_ref INTEGER,
  thinking_inject_ref INTEGER,
  upstream_response_body_ref INTEGER,
  request_id TEXT,
  attempt_latency_ms INTEGER,
  response_body_truncated INTEGER NOT NULL DEFAULT 0,
  upstream_response_body_truncated INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  key_id INTEGER,
  key_name TEXT,
  client_ip TEXT,
  quota_points INTEGER
);
CREATE INDEX IF NOT EXISTS idx_logs_created ON request_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_logs_channel ON request_logs(channel_id);
CREATE INDEX IF NOT EXISTS idx_logs_model ON request_logs(model);
CREATE INDEX IF NOT EXISTS idx_logs_status ON request_logs(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_logs_request_final ON request_logs(request_id) WHERE request_id IS NOT NULL AND is_retry = 0;
`)

// 后加的列：已有库按缺失补齐
function addMissingColumns(table: string, definitions: [string, string][]): void {
  const columns = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).pluck().all() as string[]
  for (const [name, definition] of definitions) {
    if (!columns.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
  }
}
addMissingColumns('channels', [
  ['single_role', 'TEXT'],
  ['single_role_merge_system', 'INTEGER NOT NULL DEFAULT 0'],
  ['single_role_exclude_last_user', 'INTEGER NOT NULL DEFAULT 0'],
  ['groups', `TEXT NOT NULL DEFAULT '["default"]'`],
  ['ban_until', 'INTEGER'],
])
addMissingColumns('request_logs', [
  ['source', 'TEXT'],
  ['key_id', 'INTEGER'],
  ['key_name', 'TEXT'],
  ['client_ip', 'TEXT'],
  ['quota_points', 'INTEGER'],
  ['user_id', 'INTEGER'],
])
db.exec('CREATE INDEX IF NOT EXISTS idx_logs_key ON request_logs(key_id)')
db.exec('CREATE INDEX IF NOT EXISTS idx_logs_user ON request_logs(user_id, created_at)')
db.exec('CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id)')

function encodeSetting(value: unknown): string {
  return typeof value === 'boolean' ? (value ? '1' : '0') : typeof value === 'object' ? JSON.stringify(value) : String(value)
}

function decodeSetting(raw: string, fallback: unknown): unknown {
  if (typeof fallback === 'number') return Number(raw)
  if (typeof fallback === 'boolean') return raw === '1'
  if (Array.isArray(fallback)) {
    try { const value = JSON.parse(raw); return Array.isArray(value) ? value : fallback } catch { return fallback }
  }
  return raw
}

// 注入默认设置（已存在的 key 不覆盖）
{
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
  db.transaction(() => {
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, encodeSetting(v))
  })()
}

// ── settings 读写 ───────────────────────────────────────
export function getSettings(): Settings {
  const settings: Record<string, unknown> = { ...DEFAULT_SETTINGS }
  for (const { key, value } of db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]) {
    if (Object.hasOwn(DEFAULT_SETTINGS, key)) settings[key] = decodeSetting(value, DEFAULT_SETTINGS[key as keyof Settings])
  }
  return settings as unknown as Settings
}

export function setSettings(patch: Record<string, unknown>): void {
  const up = db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  db.transaction(() => {
    for (const [k, v] of Object.entries(patch)) up.run(k, encodeSetting(v))
  })()
}

// ── 渠道行 ↔ 应用对象 ──────────────────────────────────
function safeArray(s: string | null | undefined): string[] {
  if (!s) return []
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
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
    single_role: r.single_role === 'user' || r.single_role === 'system' ? r.single_role : null,
    single_role_merge_system: !!r.single_role_merge_system,
    single_role_exclude_last_user: !!r.single_role_exclude_last_user,
    groups: safeArray(r.groups),
    ban_until: r.ban_until ?? null,
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
