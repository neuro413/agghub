import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { DATA_DIR, DB_PATH, DEFAULT_SETTINGS } from './config'
import { channelModelNames } from './core/channelModels'
import type { Channel, ChannelRow, ChannelStatus, DiscordRuleGroup, ParamRule, RequestCompression, Settings } from './types'

fs.mkdirSync(DATA_DIR, { recursive: true })

export const db = new Database(DB_PATH)
// 增量自动回收：删日志后能逐步归还空闲页而不用整库 VACUUM。只能在空库写入首页（切换 WAL）之前设置，已有库保持原状。
if (db.pragma('page_count', { simple: true }) === 0) db.pragma('auto_vacuum = INCREMENTAL')
db.pragma('journal_mode = WAL')
db.pragma('busy_timeout = 5000')
// checkpoint 后把 WAL 文件截回 4MB 以内，避免一次大事务后长期占着磁盘
db.pragma('journal_size_limit = 4194304')

// 分组表出现之前，分组是渠道上的字符串数组；首次建表时迁移（见文件末尾）
const hadGroupTable = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channel_groups'").get()

db.exec(`
CREATE TABLE IF NOT EXISTS channels (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  type          TEXT    NOT NULL,
  base_url      TEXT,
  api_key       TEXT    NOT NULL DEFAULT '',
  models        TEXT    NOT NULL DEFAULT '[]',
  model_mapping TEXT,
  model_alias   TEXT,
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
  admin_disabled INTEGER NOT NULL DEFAULT 0,
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
  last_login_ip TEXT,
  groups        TEXT    NOT NULL DEFAULT '[]',
  discord_id       TEXT,
  discord_username TEXT,
  discord_guilds_at INTEGER
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

-- 用户最近一次 Discord 登录时所在的服务器，供管理端排查；每次登录整体覆盖
CREATE TABLE IF NOT EXISTS user_discord_guilds (
  user_id      INTEGER NOT NULL,
  guild_id     TEXT    NOT NULL,
  name         TEXT    NOT NULL,
  icon         TEXT,
  owner        INTEGER NOT NULL DEFAULT 0,
  member_count INTEGER,
  PRIMARY KEY (user_id, guild_id)
);
CREATE INDEX IF NOT EXISTS idx_discord_guilds_guild ON user_discord_guilds(guild_id);

-- 分组：channel_ids / models 为 JSON 数组；Key 与用户按 name 引用
CREATE TABLE IF NOT EXISTS channel_groups (
  name        TEXT    PRIMARY KEY,
  description TEXT    NOT NULL DEFAULT '',
  ratio       REAL    NOT NULL DEFAULT 1,
  is_public   INTEGER NOT NULL DEFAULT 0,
  channel_ids TEXT    NOT NULL DEFAULT '[]',
  models      TEXT    NOT NULL DEFAULT '[]',
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 站点资源（门户上传的品牌图标等），不放进 settings，避免每次读设置都带上大文件
CREATE TABLE IF NOT EXISTS site_assets (
  name       TEXT PRIMARY KEY,
  mime       TEXT    NOT NULL,
  data       BLOB    NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 门户公告：content 为 Markdown；publish_at 晚于当前时间的为定时发布
CREATE TABLE IF NOT EXISTS announcements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  content    TEXT    NOT NULL,
  extra      TEXT    NOT NULL DEFAULT '',
  type       TEXT    NOT NULL DEFAULT 'default',
  publish_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
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
  ['base_url_full', 'INTEGER NOT NULL DEFAULT 0'],
  ['models_url', 'TEXT'],
  ['model_alias', 'TEXT'],
  ['key_mode', 'TEXT'],
  ['key_concurrency', 'INTEGER NOT NULL DEFAULT 2'],
  ['key_cooldown_seconds', 'INTEGER NOT NULL DEFAULT 300'],
  ['request_compression', 'TEXT'],
  ['always_retry', 'INTEGER NOT NULL DEFAULT 0'],
  ['proxy_pool', 'INTEGER NOT NULL DEFAULT 0'],
  ['proxy_pool_include', 'TEXT'],
  ['proxy_pool_exclude', 'TEXT'],
])
addMissingColumns('request_logs', [
  ['source', 'TEXT'],
  ['key_id', 'INTEGER'],
  ['key_name', 'TEXT'],
  ['client_ip', 'TEXT'],
  ['quota_points', 'INTEGER'],
  ['user_id', 'INTEGER'],
  ['group_name', 'TEXT'],
  ['channel_key', 'TEXT'],
  ['first_token_ms', 'INTEGER'],
  ['upstream_encoding', 'TEXT'],
  ['upstream_raw_bytes', 'INTEGER'],
  ['upstream_sent_bytes', 'INTEGER'],
  ['compress_ms', 'REAL'],
  ['compress_status', 'TEXT'],
  ['compress_note', 'TEXT'],
  ['client_error', 'TEXT'],
  ['proxy_node', 'TEXT'],
])
addMissingColumns('users', [['groups', `TEXT NOT NULL DEFAULT '[]'`], ['discord_id', 'TEXT'], ['discord_username', 'TEXT'], ['discord_guilds_at', 'INTEGER']])
// 分组的 UA 黑名单与自定义提示（后加的列，已有库按缺失补齐）
addMissingColumns('channel_groups', [
  ['ua_blacklist', `TEXT NOT NULL DEFAULT '[]'`],
  ['ua_block_message', `TEXT NOT NULL DEFAULT ''`],
])
// 一个 Discord 账号只对应一个用户；Discord 建号依赖此约束兜底并发
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_discord ON users(discord_id) WHERE discord_id IS NOT NULL')
// 管理员停用的 Key 标记：与 enabled 分开，门户用户不能自行解锁
addMissingColumns('api_keys', [['admin_disabled', 'INTEGER NOT NULL DEFAULT 0']])
db.exec('CREATE INDEX IF NOT EXISTS idx_logs_key ON request_logs(key_id)')
db.exec('CREATE INDEX IF NOT EXISTS idx_logs_user ON request_logs(user_id, created_at)')
db.exec('CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id)')
// 多 key 渠道里被熔断的 key：按 key 指纹记录，调整顺序或增删其他 key 不影响；until 为空表示需手动恢复
db.exec(`
CREATE TABLE IF NOT EXISTS channel_key_states (
  channel_id  INTEGER NOT NULL,
  fingerprint TEXT    NOT NULL,
  until       INTEGER,
  status_code INTEGER,
  message     TEXT,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (channel_id, fingerprint)
)`)

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

// 「去除 top_p」开关已并入参数修改：开启过的库迁移为一条删除 top_p 的参数规则
{
  const legacy = db.prepare("SELECT value FROM settings WHERE key = 'strip_top_p'").pluck().get()
  if (legacy !== undefined) {
    db.transaction(() => {
      if (legacy === '1') {
        const raw = db.prepare("SELECT value FROM settings WHERE key = 'param_rules'").pluck().get() as string
        const rules = decodeSetting(raw, []) as ParamRule[]
        rules.push({ id: randomUUID(), enabled: true, name: '去除 top_p', ops: [{ type: 'delete', key: 'top_p' }] })
        db.prepare("UPDATE settings SET value = ? WHERE key = 'param_rules'").run(encodeSetting(rules))
      }
      db.prepare("DELETE FROM settings WHERE key = 'strip_top_p'").run()
    })()
  }
}

// 单服务器门槛（服务器 ID + 拥有任一即可的身份组）迁移为一个规则组
{
  const guildId = db.prepare("SELECT value FROM settings WHERE key = 'discord_guild_id'").pluck().get() as string | undefined
  if (guildId !== undefined) {
    db.transaction(() => {
      if (guildId) {
        const raw = db.prepare("SELECT value FROM settings WHERE key = 'discord_role_ids'").pluck().get() as string | undefined
        const roles = raw === undefined ? [] : decodeSetting(raw, []) as string[]
        const rules: DiscordRuleGroup[] = [{ conditions: [{ guild_id: guildId, all_roles: [], any_roles: roles, deny_roles: [] }] }]
        db.prepare("UPDATE settings SET value = ? WHERE key = 'discord_rules'").run(encodeSetting(rules))
      }
      db.prepare("DELETE FROM settings WHERE key IN ('discord_guild_id', 'discord_role_ids')").run()
    })()
  }
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

const REQUEST_COMPRESSIONS: RequestCompression[] = ['off', 'gzip', 'br', 'zstd']

export function rowToChannel(r: ChannelRow): Channel {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    base_url: r.base_url,
    base_url_full: !!r.base_url_full,
    models_url: r.models_url ?? null,
    api_key: r.api_key,
    models: safeArray(r.models),
    model_mapping: safeObject(r.model_mapping),
    model_alias: safeObject(r.model_alias),
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
    key_mode: r.type !== 'vertex' && (r.key_mode === 'poll' || r.key_mode === 'race') ? r.key_mode : null,
    key_concurrency: r.key_concurrency ?? 2,
    key_cooldown_seconds: r.key_cooldown_seconds ?? 300,
    ban_until: r.ban_until ?? null,
    request_compression: REQUEST_COMPRESSIONS.includes(r.request_compression as RequestCompression) ? r.request_compression as RequestCompression : null,
    always_retry: !!r.always_retry,
    proxy_pool: !!r.proxy_pool,
    proxy_pool_include: r.proxy_pool_include ?? null,
    proxy_pool_exclude: r.proxy_pool_exclude ?? null,
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

// 渠道分组迁移为分组表：每个出现过的分组名建一条，渠道为原来属于它的渠道，模型取这些渠道当前对外的全部模型，
// 原「门户可用分组」设为公开；门户用户的 Key 原来不存分组，设为第一个公开分组。迁移后权限与之前一致。
if (!hadGroupTable) {
  db.transaction(() => {
    const channels = allChannels()
    const channelGroups = new Map(
      (db.prepare('SELECT id, groups FROM channels').all() as { id: number; groups: string }[]).map(r => [r.id, safeArray(r.groups)]),
    )
    const portalRaw = db.prepare("SELECT value FROM settings WHERE key = 'portal_groups'").pluck().get() as string | undefined
    const portalGroups = portalRaw === undefined ? [] : safeArray(portalRaw)
    const keyGroups = (db.prepare('SELECT groups FROM api_keys').pluck().all() as string[]).flatMap(safeArray)
    const names = [...new Set([...channels.flatMap(c => channelGroups.get(c.id) ?? []), ...keyGroups, ...portalGroups])]
      .filter(name => name && name.length <= 32 && !name.includes(','))
    const insert = db.prepare(
      `INSERT INTO channel_groups (name, description, ratio, is_public, channel_ids, models, sort, created_at, updated_at)
       VALUES (?, '', 1, ?, ?, ?, ?, ?, ?)`,
    )
    const now = Date.now()
    names.forEach((name, index) => {
      const members = channels.filter(c => channelGroups.get(c.id)?.includes(name))
      const models = [...new Set(members.flatMap(channelModelNames))]
      insert.run(name, portalGroups.includes(name) ? 1 : 0, JSON.stringify(members.map(c => c.id)), JSON.stringify(models), index, now, now)
    })
    const firstPublic = portalGroups.find(name => names.includes(name))
    if (firstPublic) db.prepare("UPDATE api_keys SET groups = ? WHERE user_id IS NOT NULL AND groups = '[]'").run(JSON.stringify([firstPublic]))
    db.prepare("DELETE FROM settings WHERE key = 'portal_groups'").run()
  })()
}
