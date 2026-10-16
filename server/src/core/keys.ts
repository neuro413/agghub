import crypto from 'node:crypto'
import { db } from '../db'
import { localDay } from './billing'
import type { ApiKey, ApiKeyInput, ApiKeyRow, ApiKeyView, KeyQuotaOp, KeyUsageDay } from '../types'

export const KEY_PREFIX = 'sk-agh-'
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** 生成 Key：前缀 + 40 位 base62；用拒绝采样（< 248）避免取模偏差 */
export function generateKey(): string {
  let out = ''
  while (out.length < 40) {
    for (const byte of crypto.randomBytes(48)) {
      if (byte < 248 && out.length < 40) out += ALPHABET[byte % 62]
    }
  }
  return KEY_PREFIX + out
}

function safeArray(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const value = JSON.parse(raw)
    return Array.isArray(value) ? value.map(String) : []
  } catch {
    return []
  }
}

export function rowToApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    name: row.name,
    key: row.key,
    enabled: !!row.enabled,
    admin_disabled: !!row.admin_disabled,
    groups: safeArray(row.groups),
    models: safeArray(row.models),
    rpm: row.rpm ?? null,
    concurrency: row.concurrency ?? null,
    quota_total: row.quota_total ?? null,
    quota_used: row.quota_used,
    quota_daily: row.quota_daily ?? null,
    log_bodies: row.log_bodies == null ? null : !!row.log_bodies,
    expires_at: row.expires_at ?? null,
    note: row.note ?? null,
    user_id: row.user_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_used_at: row.last_used_at ?? null,
  }
}

export function getKeyByToken(token: string): ApiKey | null {
  if (!token) return null
  const row = db.prepare('SELECT * FROM api_keys WHERE key = ?').get(token) as ApiKeyRow | undefined
  return row ? rowToApiKey(row) : null
}

export function getKeyById(id: number): ApiKey | null {
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as ApiKeyRow | undefined
  return row ? rowToApiKey(row) : null
}

/** 管理员发的 Key；门户用户的 Key 在用户管理里查看 */
export function listKeys(): ApiKey[] {
  const rows = db.prepare('SELECT * FROM api_keys WHERE user_id IS NULL ORDER BY id ASC').all() as ApiKeyRow[]
  return rows.map(rowToApiKey)
}

export function listUserKeys(userId: number): ApiKey[] {
  const rows = db.prepare('SELECT * FROM api_keys WHERE user_id = ? ORDER BY id DESC').all(userId) as ApiKeyRow[]
  return rows.map(rowToApiKey)
}

/** 只返回属于该用户的 Key */
export function getUserKey(userId: number, id: number): ApiKey | null {
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ? AND user_id = ?').get(id, userId) as ApiKeyRow | undefined
  return row ? rowToApiKey(row) : null
}

export function countUserKeys(userId: number): number {
  return db.prepare('SELECT COUNT(*) FROM api_keys WHERE user_id = ?').pluck().get(userId) as number
}

/** 门户用户自建 Key：只存名称、分组和过期时间，限流等在调用时按门户设置覆盖 */
export function createUserKey(userId: number, name: string, group: string, expiresAt: number | null): ApiKey {
  const now = Date.now()
  const info = db
    .prepare(
      `INSERT INTO api_keys (name, key, enabled, groups, models, quota_used, expires_at, user_id, created_at, updated_at)
       VALUES (?, ?, 1, ?, '[]', 0, ?, ?, ?, ?)`,
    )
    .run(name, generateKey(), JSON.stringify([group]), expiresAt, userId, now, now)
  return getKeyById(Number(info.lastInsertRowid))!
}

/** 附带今日用量；没有当天记录时两项为 0 */
export function keyView(key: ApiKey, now = Date.now()): ApiKeyView {
  const row = db
    .prepare("SELECT requests, points FROM usage_daily WHERE account_type = 'key' AND account_id = ? AND day = ?")
    .get(key.id, localDay(now)) as { requests: number; points: number } | undefined
  return { ...key, today_points: row?.points ?? 0, today_requests: row?.requests ?? 0 }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const GROUPS_ERROR = '至少选择一个分组，分组名须为 1～32 字符且不含逗号'

/** 校验请求体；忽略未知字段（前端可能把整个 Key 对象发回来），partial=true 时只校验出现的字段 */
export function validateKeyInput(input: unknown, partial: boolean): { ok: true; value: ApiKeyInput } | { ok: false; error: string } {
  if (!isPlainObject(input)) return { ok: false, error: '请求体必须为 JSON 对象' }
  const value: ApiKeyInput = {}

  if (input.name !== undefined) {
    if (typeof input.name !== 'string') return { ok: false, error: 'name 须为 1～64 字符的字符串' }
    const name = input.name.trim()
    if (name.length < 1 || name.length > 64) return { ok: false, error: 'name 须为 1～64 字符的字符串' }
    value.name = name
  } else if (!partial) {
    return { ok: false, error: 'name 须为 1～64 字符的字符串' }
  }

  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') return { ok: false, error: 'enabled 须为布尔值' }
    value.enabled = input.enabled
  }

  if (input.admin_disabled !== undefined) {
    if (typeof input.admin_disabled !== 'boolean') return { ok: false, error: 'admin_disabled 须为布尔值' }
    value.admin_disabled = input.admin_disabled
  }

  if (input.groups !== undefined) {
    if (!Array.isArray(input.groups)) return { ok: false, error: GROUPS_ERROR }
    const groups: string[] = []
    for (const item of input.groups) {
      if (typeof item !== 'string') return { ok: false, error: GROUPS_ERROR }
      const name = item.trim()
      if (name.length < 1 || name.length > 32 || name.includes(',')) return { ok: false, error: GROUPS_ERROR }
      if (!groups.includes(name)) groups.push(name)
    }
    if (groups.length === 0) return { ok: false, error: GROUPS_ERROR }
    value.groups = groups
  } else if (!partial) {
    return { ok: false, error: GROUPS_ERROR }
  }

  if (input.models !== undefined) {
    if (!Array.isArray(input.models)) return { ok: false, error: 'models 须为字符串数组' }
    const models: string[] = []
    for (const item of input.models) {
      if (typeof item !== 'string') return { ok: false, error: 'models 须为字符串数组' }
      const name = item.trim()
      if (!name) continue
      if (name.length > 128) return { ok: false, error: 'models 每项须不超过 128 字符' }
      if (!models.includes(name)) models.push(name)
    }
    value.models = models
  }

  for (const field of ['rpm', 'concurrency'] as const) {
    const raw = input[field]
    if (raw === undefined) continue
    if (raw === null) {
      value[field] = null
    } else if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 1 && raw <= 100000) {
      value[field] = raw
    } else {
      return { ok: false, error: `${field} 须为空或 1～100000 的整数` }
    }
  }

  for (const field of ['quota_total', 'quota_daily'] as const) {
    const raw = input[field]
    if (raw === undefined) continue
    if (raw === null) {
      value[field] = null
    } else if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) {
      value[field] = raw
    } else {
      return { ok: false, error: `${field} 须为空或非负整数` }
    }
  }

  if (input.log_bodies !== undefined) {
    const raw = input.log_bodies
    if (raw === null) value.log_bodies = null
    else if (typeof raw === 'boolean') value.log_bodies = raw
    else return { ok: false, error: 'log_bodies 须为 null 或布尔值' }
  }

  if (input.expires_at !== undefined) {
    const raw = input.expires_at
    if (raw === null) value.expires_at = null
    else if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) value.expires_at = raw
    else return { ok: false, error: 'expires_at 须为空或正整数毫秒时间戳' }
  }

  if (input.note !== undefined) {
    const raw = input.note
    if (raw === null) {
      value.note = null
    } else if (typeof raw === 'string') {
      const note = raw.trim()
      if (note.length > 500) return { ok: false, error: 'note 须不超过 500 字符' }
      value.note = note || null
    } else {
      return { ok: false, error: 'note 须为不超过 500 字符的字符串' }
    }
  }

  return { ok: true, value }
}

export function createKey(input: ApiKeyInput): ApiKey {
  const now = Date.now()
  const info = db
    .prepare(
      `INSERT INTO api_keys (name, key, enabled, groups, models, rpm, concurrency, quota_total, quota_used, quota_daily, log_bodies, expires_at, note, user_id, created_at, updated_at, last_used_at)
       VALUES (@name, @key, @enabled, @groups, @models, @rpm, @concurrency, @quota_total, 0, @quota_daily, @log_bodies, @expires_at, @note, NULL, @created_at, @updated_at, NULL)`,
    )
    .run({
      name: input.name!,
      key: generateKey(),
      enabled: input.enabled === false ? 0 : 1,
      groups: JSON.stringify(input.groups ?? ['default']),
      models: JSON.stringify(input.models ?? []),
      rpm: input.rpm ?? null,
      concurrency: input.concurrency ?? null,
      quota_total: input.quota_total ?? null,
      quota_daily: input.quota_daily ?? null,
      log_bodies: input.log_bodies == null ? null : input.log_bodies ? 1 : 0,
      expires_at: input.expires_at ?? null,
      note: input.note ?? null,
      created_at: now,
      updated_at: now,
    })
  return getKeyById(Number(info.lastInsertRowid))!
}

export function updateKey(id: number, input: ApiKeyInput): ApiKey | null {
  if (!getKeyById(id)) return null
  const sets: string[] = []
  const params: Record<string, unknown> = { id }
  const set = (column: string, val: unknown) => {
    sets.push(`${column} = @${column}`)
    params[column] = val
  }
  if (input.name !== undefined) set('name', input.name)
  if (input.enabled !== undefined) set('enabled', input.enabled ? 1 : 0)
  if (input.admin_disabled !== undefined) set('admin_disabled', input.admin_disabled ? 1 : 0)
  if (input.groups !== undefined) set('groups', JSON.stringify(input.groups))
  if (input.models !== undefined) set('models', JSON.stringify(input.models))
  if (input.rpm !== undefined) set('rpm', input.rpm)
  if (input.concurrency !== undefined) set('concurrency', input.concurrency)
  if (input.quota_total !== undefined) set('quota_total', input.quota_total)
  if (input.quota_daily !== undefined) set('quota_daily', input.quota_daily)
  if (input.log_bodies !== undefined) set('log_bodies', input.log_bodies == null ? null : input.log_bodies ? 1 : 0)
  if (input.expires_at !== undefined) set('expires_at', input.expires_at)
  if (input.note !== undefined) set('note', input.note)
  set('updated_at', Date.now())
  db.prepare(`UPDATE api_keys SET ${sets.join(', ')} WHERE id = @id`).run(params)
  return getKeyById(id)
}

/** 删除 Key 及其 usage_daily；日志保留 key_name 快照，不动 */
export function deleteKey(id: number): boolean {
  return db.transaction(() => {
    const info = db.prepare('DELETE FROM api_keys WHERE id = ?').run(id)
    db.prepare("DELETE FROM usage_daily WHERE account_type = 'key' AND account_id = ?").run(id)
    return info.changes > 0
  })()
}

export function regenerateKey(id: number): ApiKey | null {
  const info = db.prepare('UPDATE api_keys SET key = ?, updated_at = ? WHERE id = ?').run(generateKey(), Date.now(), id)
  return info.changes > 0 ? getKeyById(id) : null
}

export function applyQuotaOp(id: number, op: KeyQuotaOp): ApiKey | null {
  const existing = getKeyById(id)
  if (!existing) return null
  const now = Date.now()
  if (op.op === 'reset_used') {
    db.prepare('UPDATE api_keys SET quota_used = 0, updated_at = ? WHERE id = ?').run(now, id)
  } else if (existing.quota_total != null) {
    // 不限额的 Key 增加额度没有意义，保持不限
    const total = Math.max(0, existing.quota_total + op.value)
    db.prepare('UPDATE api_keys SET quota_total = ?, updated_at = ? WHERE id = ?').run(total, now, id)
  }
  return getKeyById(id)
}

export function keyUsage(id: number, days: number, now = Date.now()): KeyUsageDay[] {
  const span = Math.min(366, Math.max(1, Math.floor(days) || 1))
  const from = localDay(now - (span - 1) * 86_400_000)
  return db
    .prepare(
      `SELECT day, requests, points, prompt_tokens, completion_tokens FROM usage_daily
       WHERE account_type = 'key' AND account_id = ? AND day >= ? ORDER BY day ASC`,
    )
    .all(id, from) as KeyUsageDay[]
}
