import Database from 'better-sqlite3'
import fs from 'node:fs'
import { DATA_DIR, DB_PATH, DEFAULT_SETTINGS } from './config'
import type { Channel, ChannelRow, ChannelStatus, ParamRule, PreprocessRule, Settings, ToolFilterRule } from './types'

fs.mkdirSync(DATA_DIR, { recursive: true })

export const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('busy_timeout = 5000')

// ── 旧版日志表迁移（破坏性）────────────────────────────
// 旧版把请求 / 响应正文以 TEXT 直接存在 request_logs 行里，重试行、原始 / 预处理双份、多轮对话历史全部重复落盘。
// 新版改为 blobs 内容寻址块存储，格式不兼容：检测到旧列则整表丢弃重建（渠道 / 设置不受影响）。
{
  const cols = db.prepare('PRAGMA table_info(request_logs)').all() as { name: string }[]
  if (cols.length && cols.some((c) => c.name === 'request_body')) {
    console.warn('[agghub] 检测到旧版 request_logs（行内正文），迁移到块存储：丢弃旧日志并重建表')
    db.exec('DROP TABLE request_logs')
  }
}
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

CREATE TABLE IF NOT EXISTS request_logs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at      INTEGER NOT NULL,
  channel_id      INTEGER,
  channel_name    TEXT,
  entry_format    TEXT    NOT NULL DEFAULT 'openai',
  model           TEXT,
  upstream_model  TEXT,
  status          TEXT    NOT NULL,
  status_code     INTEGER,
  latency_ms      INTEGER,
  prompt_tokens   INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  total_tokens    INTEGER DEFAULT 0,
  cache_read_tokens  INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0,
  retry_count     INTEGER DEFAULT 0,
  is_stream       INTEGER DEFAULT 0,
  is_retry        INTEGER DEFAULT 0,
  error_message   TEXT,
  preprocessed    INTEGER DEFAULT 0,
  pseudo_thinking INTEGER DEFAULT 0,
  -- 大正文一律存 blobs 表，这里只放 32 字节 sha256 引用（见 stats/blobstore.ts）
  request_headers_ref        BLOB,
  request_body_ref           BLOB,
  response_body_ref          BLOB,
  preprocessed_body_ref      BLOB,
  thinking_inject_ref        BLOB,
  upstream_response_body_ref BLOB
);

CREATE INDEX IF NOT EXISTS idx_logs_created  ON request_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_logs_channel  ON request_logs(channel_id);
CREATE INDEX IF NOT EXISTS idx_logs_model    ON request_logs(model);
CREATE INDEX IF NOT EXISTS idx_logs_status   ON request_logs(status);

-- 内容寻址块：hash = sha256(原文)，codec 0=raw 1=zstd 2=gzip
CREATE TABLE IF NOT EXISTS blobs (
  hash       BLOB    PRIMARY KEY,
  raw_size   INTEGER NOT NULL,
  codec      INTEGER NOT NULL,
  data       BLOB    NOT NULL,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;

-- manifest → 子块 引用边，供 GC 判活
CREATE TABLE IF NOT EXISTS blob_edges (
  parent BLOB NOT NULL,
  child  BLOB NOT NULL,
  PRIMARY KEY (parent, child)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_blob_edges_child ON blob_edges(child);

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
  const o: Record<string, string> = {}
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
