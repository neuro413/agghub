import net from 'node:net'
import type { Request, RequestHandler, Response } from 'express'
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

/** 展开 IPv6 的前 4 组（/64 前缀），每组补足 4 位；入参须已通过 net.isIPv6 */
function ipv6Prefix64(ip: string): string {
  const bare = ip.split('%')[0].toLowerCase()
  const [left, right] = bare.split('::')
  const head = left ? left.split(':') : []
  let groups = head
  if (right !== undefined) {
    const tail = right ? right.split(':') : []
    // 末尾内嵌的 IPv4 占两组
    const tailSize = tail.length + (tail.length && tail[tail.length - 1].includes('.') ? 1 : 0)
    groups = [...head, ...Array<string>(Math.max(0, 8 - head.length - tailSize)).fill('0'), ...tail]
  }
  return groups.slice(0, 4).map(g => g.padStart(4, '0')).join(':')
}

/** IPv6 按 /64 归并，避免持有大段地址的一方换地址绕过限速；IPv4 与其他标识符原样返回 */
export function limitKey(ip: string): string {
  if (!ip || !net.isIPv6(ip)) return ip
  return `${ipv6Prefix64(ip)}::/64`
}

// ── 鉴权失败限速：按限流标识符计数（IP 或 u:<用户名> 等）──
const FAIL_WINDOW_MS = 5 * 60_000
const FAIL_LIMIT = 10
const BLOCK_MS = 15 * 60_000

const authFailures = new Map<string, { failures: number[]; blockedUntil: number }>()

/** 记录一次鉴权失败；窗口内失败数达到上限则封禁一段时间并清空失败计数 */
export function recordAuthFailure(id: string, now = Date.now()): void {
  if (!id) return
  const key = limitKey(id)
  const entry = authFailures.get(key) ?? { failures: [], blockedUntil: 0 }
  entry.failures = entry.failures.filter(t => now - t < FAIL_WINDOW_MS)
  entry.failures.push(now)
  if (entry.failures.length >= FAIL_LIMIT) {
    entry.blockedUntil = now + BLOCK_MS
    entry.failures = []
  }
  // 先删后设，让该标识成为 Map 里最新一条，便于按插入顺序淘汰
  authFailures.delete(key)
  authFailures.set(key, entry)
  if (authFailures.size > 10_000) {
    const oldest = authFailures.keys().next().value
    if (oldest !== undefined) authFailures.delete(oldest)
  }
}

/** 被封禁时返回剩余秒数（向上取整，至少 1），否则 0；封禁已过期则删除记录 */
export function blockedSeconds(id: string, now = Date.now()): number {
  const key = limitKey(id)
  const entry = authFailures.get(key)
  if (!entry) return 0
  if (entry.blockedUntil > now) return Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000))
  if (entry.blockedUntil !== 0) authFailures.delete(key)
  return 0
}

/** 清空失败记录与在途校验计数（测试用） */
export function resetAuthFailures(): void {
  authFailures.clear()
  authInFlight.clear()
}

// ── 在途的密码校验：进入 scrypt 之前先占名额，避免突发请求在失败计数生效前全部进入校验 ──
const authInFlight = new Map<string, number>()

/** 占一个在途校验名额，返回释放函数（幂等）；返回 null 表示已达上限 */
export function beginAuthAttempt(id: string, max: number): (() => void) | null {
  const current = authInFlight.get(id) ?? 0
  if (current >= max) return null
  authInFlight.set(id, current + 1)
  let done = false
  return () => {
    if (done) return
    done = true
    const left = (authInFlight.get(id) ?? 1) - 1
    if (left > 0) authInFlight.set(id, left)
    else authInFlight.delete(id)
  }
}

/**
 * 解析调用方并挂到 res.locals.caller。
 * 内网：令牌命中 Key 走 Key；否则未设管理令牌或令牌正确时视为 owner，其余 401。
 * 公网：只认 Key，管理令牌无效；有效 Key 不受 IP 封禁影响，鉴权失败才按 IP 限速。
 */
export function createCallerResolver(surface: Surface, getAdminToken: () => string): RequestHandler {
  /** 公网鉴权失败：已封禁返回 429，否则计一次失败并返回 401 */
  const rejectPublic = (req: Request, res: Response, ip: string, now: number): void => {
    const seconds = blockedSeconds(ip, now)
    if (seconds > 0) {
      res.setHeader('Retry-After', String(seconds))
      return sendEntryError(req, res, 429, 'rate_limit_exceeded', 'rate_limit_error', '鉴权失败次数过多，请稍后再试')
    }
    recordAuthFailure(ip, now)
    sendEntryError(req, res, 401, 'invalid_api_key', 'authentication_error', 'API Key 无效')
  }

  return (req, res, next): void => {
    const ip = clientIp(req)
    const now = Date.now()
    const token = extractToken(req)
    const key = token ? getKeyByToken(token) : null
    if (key) {
      if (!key.enabled || key.admin_disabled) return sendEntryError(req, res, 403, 'key_disabled', 'permission_error', 'API Key 已停用')
      if (key.expires_at != null && key.expires_at <= now) {
        return sendEntryError(req, res, 403, 'key_expired', 'permission_error', 'API Key 已过期')
      }
      // 门户用户的 Key：账号状态优先，分组须仍对该用户可用，限流取门户设置
      if (key.user_id != null) {
        const user = getUserById(key.user_id)
        if (!user) {
          if (surface === 'public') return rejectPublic(req, res, ip, now)
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

    rejectPublic(req, res, ip, now)
  }
}

/** 生成接口的额度预检与限流占位；只挂在三个生成接口上，放行时写 res.locals.admitted 供中继断言 */
export function createAdmission(): RequestHandler {
  return (req, res, next): void => {
    const caller = res.locals.caller as Caller | undefined
    if (!caller?.key) {
      res.locals.admitted = true
      return next()
    }
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
    res.locals.admitted = true
    // release 本身保证只生效一次
    res.on('close', admission.release)
    next()
  }
}
