import crypto from 'node:crypto'
import { promisify } from 'node:util'
import { db } from '../db'
import type { ApiKey, PortalUser, Settings, UserListResult, UserView } from '../types'

const scrypt = promisify(crypto.scrypt) as (password: string, salt: Buffer, keylen: number, options: crypto.ScryptOptions) => Promise<Buffer>

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/
const SCRYPT = { N: 16384, r: 8, p: 1 }
const KEY_LEN = 32

export const USER_ENABLED = 1
export const USER_DISABLED = 2

/** 用户名：3～20 位字母、数字、下划线；返回错误信息，合法时为 null */
export function usernameError(value: unknown): string | null {
  return typeof value === 'string' && USERNAME_RE.test(value) ? null : '用户名须为 3～20 位字母、数字或下划线'
}

/** 密码：按 Unicode 字符计 8～128 位 */
export function passwordError(value: unknown): string | null {
  if (typeof value !== 'string') return '密码须为 8～128 个字符'
  const length = [...value].length
  return length >= 8 && length <= 128 ? null : '密码须为 8～128 个字符'
}

/** scrypt$N$r$p$salt$hash（salt / hash 为 base64） */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16)
  const hash = await scrypt(password, salt, KEY_LEN, SCRYPT)
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$')
  if (scheme !== 'scrypt' || !salt || !hash) return false
  const expected = Buffer.from(hash, 'base64')
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) })
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

// 用户不存在时也跑一次同样耗时的校验，登录耗时不暴露用户名是否存在
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'))
export async function burnPasswordCheck(password: string): Promise<void> {
  await verifyPassword(password, await DUMMY_HASH)
}

export function getUserById(id: number): PortalUser | null {
  return (db.prepare('SELECT * FROM users WHERE id = ?').get(id) as PortalUser | undefined) ?? null
}

export function getUserByName(username: string): PortalUser | null {
  return (db.prepare('SELECT * FROM users WHERE username = ?').get(username) as PortalUser | undefined) ?? null
}

/** 该 IP 自 since 起注册的用户数 */
export function countRegistrations(ip: string, since: number): number {
  return (db.prepare('SELECT COUNT(*) FROM users WHERE register_ip = ? AND created_at >= ?').pluck().get(ip, since) as number) ?? 0
}

/** 用户名重复（不区分大小写）时返回 null */
export function createUser(input: { username: string; password_hash: string; quota: number; ip: string }, now = Date.now()): PortalUser | null {
  const info = db
    .prepare('INSERT OR IGNORE INTO users (username, password_hash, status, quota, register_ip, created_at) VALUES (?, ?, 1, ?, ?, ?)')
    .run(input.username, input.password_hash, input.quota, input.ip || null, now)
  return info.changes ? getUserById(Number(info.lastInsertRowid)) : null
}

export function touchLogin(id: number, ip: string, now = Date.now()): void {
  db.prepare('UPDATE users SET last_login_at = ?, last_login_ip = ? WHERE id = ?').run(now, ip || null, id)
}

export function setUserStatus(id: number, status: number): boolean {
  return db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, id).changes > 0
}

export function setUserPassword(id: number, passwordHash: string): boolean {
  return db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id).changes > 0
}

/** 余额加减，可以减成负数 */
export function adjustUserQuota(id: number, delta: number): boolean {
  return db.prepare('UPDATE users SET quota = quota + ? WHERE id = ?').run(delta, id).changes > 0
}

/** 删除用户及其 Key、会话、签到和每日用量；请求日志保留 */
export function deleteUser(id: number): boolean {
  return db.transaction(() => {
    const keyIds = db.prepare('SELECT id FROM api_keys WHERE user_id = ?').pluck().all(id) as number[]
    const deleteKeyUsage = db.prepare("DELETE FROM usage_daily WHERE account_type = 'key' AND account_id = ?")
    for (const keyId of keyIds) deleteKeyUsage.run(keyId)
    db.prepare('DELETE FROM api_keys WHERE user_id = ?').run(id)
    db.prepare("DELETE FROM usage_daily WHERE account_type = 'user' AND account_id = ?").run(id)
    db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(id)
    db.prepare('DELETE FROM user_checkins WHERE user_id = ?').run(id)
    return db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0
  })()
}

const VIEW_COLUMNS = `id, username, status, quota, used_quota, request_count, register_ip, created_at, last_login_at, last_login_ip,
  (SELECT COUNT(*) FROM api_keys WHERE api_keys.user_id = users.id) AS key_count`

export function getUserView(id: number): UserView | null {
  return (db.prepare(`SELECT ${VIEW_COLUMNS} FROM users WHERE id = ?`).get(id) as UserView | undefined) ?? null
}

/** 管理端分页列表，q 按用户名模糊匹配 */
export function listUsers(query: { q?: string; page?: number; size?: number }): UserListResult {
  const size = Math.min(100, Math.max(1, Math.floor(query.size || 20)))
  const page = Math.max(1, Math.floor(query.page || 1))
  const q = (query.q || '').trim()
  const where = q ? "WHERE username LIKE ? ESCAPE '\\'" : ''
  const args = q ? [`%${q.replace(/[\\%_]/g, m => '\\' + m)}%`] : []
  const total = db.prepare(`SELECT COUNT(*) FROM users ${where}`).pluck().get(...args) as number
  const items = db
    .prepare(`SELECT ${VIEW_COLUMNS} FROM users ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...args, size, (page - 1) * size) as UserView[]
  return { items, total, page, size }
}

/** 门户用户 Key 的有效配置：分组、限流取门户设置，不设模型白名单与 Key 自身额度，正文记录跟随全局 */
export function effectivePortalKey(key: ApiKey, settings: Settings): ApiKey {
  return {
    ...key,
    groups: settings.portal_groups,
    models: [],
    rpm: settings.portal_rpm || null,
    concurrency: settings.portal_concurrency || null,
    quota_total: null,
    quota_daily: null,
    log_bodies: null,
  }
}
