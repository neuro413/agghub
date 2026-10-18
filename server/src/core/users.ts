import crypto from 'node:crypto'
import { promisify } from 'node:util'
import { db } from '../db'
import { userGroups } from './groups'
import type { ApiKey, DiscordGuild, DiscordGuildRank, DiscordGuildRanking, PortalUser, Settings, UserListResult, UserView } from '../types'

const scrypt = promisify(crypto.scrypt) as (password: string, salt: Buffer, keylen: number, options: crypto.ScryptOptions) => Promise<Buffer>

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/
const SCRYPT = { N: 16384, r: 8, p: 1 }
const KEY_LEN = 32

/** scrypt 跑在 libuv 线程池（默认 4 线程），必须限定并发，否则会拖垮 DNS 与文件 IO */
const SCRYPT_CONCURRENCY = 2
let scryptRunning = 0
const scryptWaiting: (() => void)[] = []

/** 全局 scrypt 并发闸门：所有 hashPassword / verifyPassword 都要走它 */
async function withScryptSlot<T>(task: () => Promise<T>): Promise<T> {
  // 名额满时排队；释放方把名额直接移交给队首，避免移交间隙被新请求插队而超出上限
  if (scryptRunning >= SCRYPT_CONCURRENCY) await new Promise<void>(resolve => scryptWaiting.push(resolve))
  else scryptRunning++
  try { return await task() }
  finally {
    const next = scryptWaiting.shift()
    if (next) next()
    else scryptRunning--
  }
}

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
  const hash = await withScryptSlot(() => scrypt(password, salt, KEY_LEN, SCRYPT))
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$')
  if (scheme !== 'scrypt' || !salt || !hash) return false
  const expected = Buffer.from(hash, 'base64')
  const actual = await withScryptSlot(() => scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) }))
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

// 用户不存在时也跑一次同样耗时的校验，登录耗时不暴露用户名是否存在
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'))
export async function burnPasswordCheck(password: string): Promise<void> {
  await verifyPassword(password, await DUMMY_HASH)
}

function parseGroups(raw: string | null | undefined): string[] {
  try {
    const value = JSON.parse(raw || '[]')
    return Array.isArray(value) ? value.map(String) : []
  } catch {
    return []
  }
}

/** users 行的 groups 为 JSON 字符串 */
export function rowToUser(row: (Omit<PortalUser, 'groups'> & { groups: string }) | undefined): PortalUser | null {
  return row ? { ...row, groups: parseGroups(row.groups) } : null
}

export function getUserById(id: number): PortalUser | null {
  return rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any)
}

export function getUserByName(username: string): PortalUser | null {
  return rowToUser(db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any)
}

/** 该 IP 自 since 起注册的用户数；networkOf 把地址归并成限流网段（IPv6 按 /64），历史行存的是完整地址，逐行归并比对 */
export function countRegistrations(ip: string, since: number, networkOf: (ip: string) => string = ip => ip): number {
  const network = networkOf(ip)
  if (network === ip) return (db.prepare('SELECT COUNT(*) FROM users WHERE register_ip = ? AND created_at >= ?').pluck().get(ip, since) as number) ?? 0
  const rows = db.prepare("SELECT register_ip FROM users WHERE created_at >= ? AND register_ip LIKE '%:%'").pluck().all(since) as string[]
  return rows.filter(other => networkOf(other) === network).length
}

/** 用户名重复（不区分大小写）时返回 null */
export function createUser(input: { username: string; password_hash: string; quota: number; ip: string }, now = Date.now()): PortalUser | null {
  const info = db
    .prepare('INSERT OR IGNORE INTO users (username, password_hash, status, quota, register_ip, created_at) VALUES (?, ?, 1, ?, ?, ?)')
    .run(input.username, input.password_hash, input.quota, input.ip || null, now)
  return info.changes ? getUserById(Number(info.lastInsertRowid)) : null
}

export function getUserByDiscordId(discordId: string): PortalUser | null {
  return rowToUser(db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId) as any)
}

/** 门户用户名候选：Discord 用户名（. 换成 _）→ 截短后加随机数字 → dc_ 加 36 进制的 Discord ID */
function discordUsernames(discordName: string, discordId: string): string[] {
  const base = discordName.replace(/\./g, '_').replace(/[^A-Za-z0-9_]/g, '').slice(0, 20)
  const stem = base.slice(0, 15)
  const names = [base]
  if (stem) for (let i = 0; i < 3; i++) names.push(`${stem}_${crypto.randomInt(1000, 10000)}`)
  names.push(`dc_${BigInt(discordId).toString(36)}`)
  return names.filter(name => USERNAME_RE.test(name))
}

/**
 * Discord 建号：没有密码，只能用 Discord 登录；用户名被占用时换下一个候选。
 * 同一 Discord 账号并发建号时唯一索引兜底，返回已建好的那个；候选全部被占用时返回 null
 */
export function createDiscordUser(input: { discord_id: string; discord_username: string; quota: number; ip: string }, now = Date.now()): PortalUser | null {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO users (username, password_hash, status, quota, register_ip, created_at, discord_id, discord_username)
     VALUES (?, '', 1, ?, ?, ?, ?, ?)`,
  )
  for (const username of discordUsernames(input.discord_username, input.discord_id)) {
    const info = insert.run(username, input.quota, input.ip || null, now, input.discord_id, input.discord_username)
    if (info.changes) return getUserById(Number(info.lastInsertRowid))
    const existing = getUserByDiscordId(input.discord_id)
    if (existing) return existing
  }
  return null
}

export function setDiscordUsername(id: number, discordUsername: string): void {
  db.prepare('UPDATE users SET discord_username = ? WHERE id = ?').run(discordUsername, id)
}

/** 用本次 Discord 登录拿到的服务器列表覆盖旧记录 */
export function setDiscordGuilds(id: number, guilds: DiscordGuild[], now = Date.now()): void {
  const insert = db.prepare('INSERT OR REPLACE INTO user_discord_guilds (user_id, guild_id, name, icon, owner, member_count) VALUES (?, ?, ?, ?, ?, ?)')
  db.transaction(() => {
    db.prepare('DELETE FROM user_discord_guilds WHERE user_id = ?').run(id)
    for (const g of guilds) insert.run(id, g.id, g.name, g.icon, g.owner ? 1 : 0, g.member_count)
    db.prepare('UPDATE users SET discord_guilds_at = ? WHERE id = ?').run(now, id)
  })()
}

/** 服主的服务器排前面，其余按名称 */
export function listDiscordGuilds(id: number): DiscordGuild[] {
  const rows = db
    .prepare('SELECT guild_id AS id, name, icon, owner, member_count FROM user_discord_guilds WHERE user_id = ? ORDER BY owner DESC, name COLLATE NOCASE')
    .all(id) as (Omit<DiscordGuild, 'owner'> & { owner: number })[]
  return rows.map(row => ({ ...row, owner: !!row.owner }))
}

/** 按库内加入人数给服务器排名 */
export function rankDiscordGuilds(limit = 50): DiscordGuildRanking {
  // 只有一个 MAX 聚合时 SQLite 的裸列取自 MAX 所在行，名称、图标、成员数因此来自最近一次记录
  const rows = db
    .prepare(
      `SELECT g.guild_id AS id, g.name, g.icon, g.member_count, COUNT(*) AS user_count, MAX(u.discord_guilds_at) AS latest
       FROM user_discord_guilds g JOIN users u ON u.id = g.user_id
       GROUP BY g.guild_id ORDER BY user_count DESC, g.member_count DESC, g.name COLLATE NOCASE LIMIT ?`,
    )
    .all(limit) as (DiscordGuildRank & { latest: number | null })[]
  return {
    recorded_users: db.prepare('SELECT COUNT(*) FROM users WHERE discord_guilds_at IS NOT NULL').pluck().get() as number,
    total_guilds: db.prepare('SELECT COUNT(DISTINCT guild_id) FROM user_discord_guilds').pluck().get() as number,
    items: rows.map(({ latest, ...row }) => row),
  }
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

/** 覆盖用户的专属分组 */
export function setUserGroups(id: number, groups: string[]): boolean {
  return db.prepare('UPDATE users SET groups = ? WHERE id = ?').run(JSON.stringify(groups), id).changes > 0
}

/** 余额加减，可以减成负数 */
export function adjustUserQuota(id: number, delta: number): boolean {
  return db.prepare('UPDATE users SET quota = quota + ? WHERE id = ?').run(delta, id).changes > 0
}

/** 删除用户及其 Key、会话、签到、每日用量和 Discord 服务器记录；请求日志保留 */
export function deleteUser(id: number): boolean {
  return db.transaction(() => {
    const keyIds = db.prepare('SELECT id FROM api_keys WHERE user_id = ?').pluck().all(id) as number[]
    const deleteKeyUsage = db.prepare("DELETE FROM usage_daily WHERE account_type = 'key' AND account_id = ?")
    for (const keyId of keyIds) deleteKeyUsage.run(keyId)
    db.prepare('DELETE FROM api_keys WHERE user_id = ?').run(id)
    db.prepare("DELETE FROM usage_daily WHERE account_type = 'user' AND account_id = ?").run(id)
    db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(id)
    db.prepare('DELETE FROM user_checkins WHERE user_id = ?').run(id)
    db.prepare('DELETE FROM user_discord_guilds WHERE user_id = ?').run(id)
    return db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0
  })()
}

const VIEW_COLUMNS = `id, username, status, quota, used_quota, request_count, register_ip, created_at, last_login_at, last_login_ip, groups,
  discord_id, discord_username, discord_guilds_at, password_hash != '' AS has_password,
  (SELECT COUNT(*) FROM api_keys WHERE api_keys.user_id = users.id) AS key_count`

type UserViewRow = Omit<UserView, 'groups' | 'has_password'> & { groups: string; has_password: number }
const toView = (row: UserViewRow): UserView => ({ ...row, groups: parseGroups(row.groups), has_password: !!row.has_password })

export function getUserView(id: number): UserView | null {
  const row = db.prepare(`SELECT ${VIEW_COLUMNS} FROM users WHERE id = ?`).get(id) as UserViewRow | undefined
  return row ? toView(row) : null
}

/** 管理端分页列表，q 按用户名、Discord 用户名、所在服务器名模糊匹配，或按 Discord ID、服务器 ID 精确匹配 */
export function listUsers(query: { q?: string; page?: number; size?: number }): UserListResult {
  const size = Math.min(100, Math.max(1, Math.floor(query.size || 20)))
  const page = Math.max(1, Math.floor(query.page || 1))
  const q = (query.q || '').trim()
  const like = `%${q.replace(/[\\%_]/g, m => '\\' + m)}%`
  const where = q
    ? `WHERE username LIKE ? ESCAPE '\\' OR discord_username LIKE ? ESCAPE '\\' OR discord_id = ?
       OR id IN (SELECT user_id FROM user_discord_guilds WHERE guild_id = ? OR name LIKE ? ESCAPE '\\')`
    : ''
  const args = q ? [like, like, q, q, like] : []
  const total = db.prepare(`SELECT COUNT(*) FROM users ${where}`).pluck().get(...args) as number
  const rows = db
    .prepare(`SELECT ${VIEW_COLUMNS} FROM users ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...args, size, (page - 1) * size) as UserViewRow[]
  return { items: rows.map(toView), total, page, size }
}

/**
 * 门户用户 Key 的有效配置：分组须仍在用户可用范围内（否则返回 null），限流取门户设置，
 * 不设模型白名单与 Key 自身额度，正文记录跟随全局
 */
export function effectivePortalKey(key: ApiKey, user: PortalUser, settings: Settings): ApiKey | null {
  const group = key.groups[0]
  if (!group || !userGroups(user).some(g => g.name === group)) return null
  return {
    ...key,
    groups: [group],
    models: [],
    rpm: settings.portal_rpm || null,
    concurrency: settings.portal_concurrency || null,
    quota_total: null,
    quota_daily: null,
    log_bodies: null,
  }
}
