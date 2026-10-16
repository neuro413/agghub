import type { Request, RequestHandler } from 'express'
import type { Caller, Settings, Surface } from '../types'
import { getSettings } from '../db'
import { getKeyByToken } from './keys'
import { effectivePortalKey, getUserById, USER_ENABLED } from './users'
import { extractToken, safeEqual } from './accessToken'
import { sendEntryError } from './entryError'
import { precheckQuota } from './billing'
import { admitRequest } from './limiter'

/** 未经鉴权中间件的调用（测试、内部调用）一律视为内网 owner，保持旧行为 */
export const OWNER_CALLER: Caller = Object.freeze({ surface: 'lan', source: 'owner', key: null, ip: '' }) as Caller

/** 按 Key 的正文开关覆盖本次请求的设置快照；null 跟随全局 */
export function callerSettings(settings: Settings, caller: Caller): Settings {
  const flag = caller.key?.log_bodies
  if (flag == null) return settings
  return { ...settings, store_request_body: flag, store_response_body: flag }
}

/** 客户端 IP：Express 已按 trust proxy 解析，去掉 IPv4 映射前缀 */
export function clientIp(req: Request): string {
  return (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '')
}

// ── 公网鉴权失败限速（仅公网 app 使用）──
const FAIL_WINDOW_MS = 5 * 60_000
const FAIL_LIMIT = 10
const BLOCK_MS = 15 * 60_000

const authFailures = new Map<string, { failures: number[]; blockedUntil: number }>()

/** 记录一次鉴权失败；窗口内失败数达到上限则封禁一段时间并清空失败计数 */
export function recordAuthFailure(ip: string, now = Date.now()): void {
  if (!ip) return
  const entry = authFailures.get(ip) ?? { failures: [], blockedUntil: 0 }
  entry.failures = entry.failures.filter(t => now - t < FAIL_WINDOW_MS)
  entry.failures.push(now)
  if (entry.failures.length >= FAIL_LIMIT) {
    entry.blockedUntil = now + BLOCK_MS
    entry.failures = []
  }
  // 先删后设，让该 IP 成为 Map 里最新一条，便于按插入顺序淘汰
  authFailures.delete(ip)
  authFailures.set(ip, entry)
  if (authFailures.size > 10_000) {
    const oldest = authFailures.keys().next().value
    if (oldest !== undefined) authFailures.delete(oldest)
  }
}

/** 被封禁时返回剩余秒数（向上取整，至少 1），否则 0；封禁已过期则删除记录 */
export function blockedSeconds(ip: string, now = Date.now()): number {
  const entry = authFailures.get(ip)
  if (!entry) return 0
  if (entry.blockedUntil > now) return Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000))
  if (entry.blockedUntil !== 0) authFailures.delete(ip)
  return 0
}

/** 清空失败记录（测试用） */
export function resetAuthFailures(): void {
  authFailures.clear()
}

/**
 * 解析调用方并挂到 res.locals.caller。
 * 内网：令牌命中 Key 走 Key；否则未设管理令牌或令牌正确时视为 owner，其余 401。
 * 公网：只认 Key，管理令牌无效；失败按 IP 限速。
 */
export function createCallerResolver(surface: Surface, getAdminToken: () => string): RequestHandler {
  return (req, res, next): void => {
    const ip = clientIp(req)
    const now = Date.now()

    if (surface === 'public') {
      const seconds = blockedSeconds(ip, now)
      if (seconds > 0) {
        res.setHeader('Retry-After', String(seconds))
        return sendEntryError(req, res, 429, 'rate_limit_exceeded', 'rate_limit_error', '鉴权失败次数过多，请稍后再试')
      }
    }

    const token = extractToken(req)
    const key = token ? getKeyByToken(token) : null
    if (key) {
      if (!key.enabled) return sendEntryError(req, res, 403, 'key_disabled', 'permission_error', 'API Key 已停用')
      if (key.expires_at != null && key.expires_at <= now) {
        return sendEntryError(req, res, 403, 'key_expired', 'permission_error', 'API Key 已过期')
      }
      // 门户用户的 Key：账号状态优先，分组须仍对该用户可用，限流取门户设置
      if (key.user_id != null) {
        const user = getUserById(key.user_id)
        if (!user) {
          if (surface === 'public') recordAuthFailure(ip, now)
          return sendEntryError(req, res, 401, 'invalid_api_key', 'authentication_error', 'API Key 无效')
        }
        if (user.status !== USER_ENABLED) return sendEntryError(req, res, 403, 'user_disabled', 'permission_error', '账号已停用')
        const effective = effectivePortalKey(key, user, getSettings())
        if (!effective) return sendEntryError(req, res, 403, 'group_unavailable', 'permission_error', '令牌分组不可用，请在令牌管理里重新选择分组')
        res.locals.caller = { surface, source: 'user', key: effective, user, ip } as Caller
        return next()
      }
      res.locals.caller = { surface, source: surface === 'public' ? 'public_key' : 'lan_key', key, ip } as Caller
      return next()
    }

    if (surface === 'lan') {
      const adminToken = getAdminToken()
      // 未设管理令牌：内网随便填个占位 Key 也匿名放行，保持旧用法
      if (!adminToken || (token && safeEqual(token, adminToken))) {
        res.locals.caller = { surface: 'lan', source: 'owner', key: null, ip } as Caller
        return next()
      }
      return sendEntryError(req, res, 401, 'invalid_api_key', 'authentication_error', 'invalid access token')
    }

    recordAuthFailure(ip, now)
    sendEntryError(req, res, 401, 'invalid_api_key', 'authentication_error', 'API Key 无效')
  }
}

/** 生成接口的额度预检与限流占位；只挂在三个生成接口上 */
export function createAdmission(): RequestHandler {
  return (req, res, next): void => {
    const caller = res.locals.caller as Caller | undefined
    if (!caller?.key) return next()
    if (caller.user && caller.user.quota <= 0) {
      return sendEntryError(req, res, 429, 'insufficient_quota', 'rate_limit_error', '余额不足')
    }
    const quota = precheckQuota(caller.key)
    if (!quota.ok) {
      return sendEntryError(req, res, 429, 'insufficient_quota', 'rate_limit_error', quota.reason === 'daily' ? '今日额度已用完' : '额度已用完')
    }
    const admission = admitRequest(caller.key)
    if (!admission.ok) {
      res.setHeader('Retry-After', String(admission.retryAfterSeconds))
      const message = admission.reason === 'rpm' ? '请求过于频繁，超过每分钟请求数上限' : '并发请求数超过上限'
      return sendEntryError(req, res, 429, 'rate_limit_exceeded', 'rate_limit_error', message)
    }
    // release 本身保证只生效一次
    res.on('close', admission.release)
    next()
  }
}
