import crypto from 'node:crypto'
import type { Request } from 'express'
import { db } from '../db'
import type { PortalUser } from '../types'
import { rowToUser, USER_ENABLED } from './users'

export const SESSION_COOKIE = 'agh_session'
const SESSION_TTL_MS = 30 * 86_400_000
/** Cookie 只随门户 API 发送 */
const COOKIE_PATH = '/api/user'

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex')

/** 新建会话，返回明文令牌（只出现在 Cookie 里） */
export function createSession(userId: number, ip: string, now = Date.now()): string {
  const token = crypto.randomBytes(32).toString('base64url')
  db.prepare('INSERT INTO user_sessions (token_hash, user_id, created_at, expires_at, ip) VALUES (?, ?, ?, ?, ?)')
    .run(hashToken(token), userId, now, now + SESSION_TTL_MS, ip || null)
  return token
}

/** 会话有效且用户启用时返回用户；停用的用户立即失去全部会话 */
export function sessionUser(token: string, now = Date.now()): PortalUser | null {
  if (!token) return null
  const user = rowToUser(db
    .prepare(
      `SELECT users.* FROM user_sessions JOIN users ON users.id = user_sessions.user_id
       WHERE user_sessions.token_hash = ? AND user_sessions.expires_at > ?`,
    )
    .get(hashToken(token), now) as any)
  return user && user.status === USER_ENABLED ? user : null
}

export function deleteSession(token: string): void {
  if (token) db.prepare('DELETE FROM user_sessions WHERE token_hash = ?').run(hashToken(token))
}

/** 删除用户的全部会话，可保留当前这一个（改密码时） */
export function deleteUserSessions(userId: number, keepToken = ''): void {
  db.prepare('DELETE FROM user_sessions WHERE user_id = ? AND token_hash != ?').run(userId, keepToken ? hashToken(keepToken) : '')
}

export function cleanupSessions(now = Date.now()): void {
  db.prepare('DELETE FROM user_sessions WHERE expires_at <= ?').run(now)
}

/** 从 Cookie 头取指定 Cookie，没有时为空串 */
export function readCookie(req: Request, name: string): string {
  for (const part of (req.headers.cookie || '').split(';')) {
    const at = part.indexOf('=')
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim()
  }
  return ''
}

/** 从 Cookie 头取会话令牌 */
export function readSessionToken(req: Request): string {
  return readCookie(req, SESSION_COOKIE)
}

/** Set-Cookie 值；token 为空时生成立即过期的清除指令 */
export function sessionCookie(token: string, secure: boolean): string {
  const maxAge = token ? Math.floor(SESSION_TTL_MS / 1000) : 0
  return `${SESSION_COOKIE}=${token}; Path=${COOKIE_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
}
