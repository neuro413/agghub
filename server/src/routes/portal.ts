import express, { Router } from 'express'
import type { ErrorRequestHandler, Request, RequestHandler, Response } from 'express'
import { db, getSettings } from '../db'
import { beginAuthAttempt, blockedSeconds, clientIp, limitKey, recordAuthFailure } from '../core/caller'
import { checkin, checkinStatus } from '../core/checkin'
import { findRatio, localDay } from '../core/billing'
import { PORTAL_ANNOUNCEMENTS, publishedAnnouncements } from '../core/announcements'
import { userGroups } from '../core/groups'
import { countUserKeys, createUserKey, deleteKey, getUserKey, listUserKeys, updateKey } from '../core/keys'
import { modelsVisibleTo } from '../core/selector'
import { sanitizePublicError } from '../core/failover'
import { createSession, deleteSession, deleteUserSessions, readSessionToken, sessionCookie, sessionUser } from '../core/sessions'
import {
  burnPasswordCheck, countRegistrations, createUser, effectivePortalKey, getUserById, getUserByName, hashPassword,
  passwordError, setUserPassword, touchLogin, USER_ENABLED, usernameError, verifyPassword,
} from '../core/users'
import type { ApiKey, Caller, PortalUser } from '../types'

// 用户门户 API（只挂在公网 app 的 /api/user）；返回格式仿 new-api：{ success, message, data }
export const portalRouter = Router()

const ok = (res: Response, data: unknown = null, message = '') => res.json({ success: true, message, data })
const fail = (res: Response, message: string, status = 200) => res.status(status).json({ success: false, message, data: null })

/** Express 4 不接 async 异常，统一转给末尾的错误处理 */
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => (req, res, next) => {
  fn(req, res).catch(next)
}

const validId = (raw: string): number => {
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : 0
}

const localMidnight = (now: number) => new Date(now).setHours(0, 0, 0, 0)

/** sk-agh-XXXX**********YYYY */
function maskKey(key: string): string {
  return `${key.slice(0, 11)}**********${key.slice(-4)}`
}

/** usable 为用户当前可用的分组名，用来标出分组已失效的 Key */
function keyView(key: ApiKey, usable: string[], now = Date.now()) {
  const expired = key.expires_at != null && key.expires_at <= now
  const group = key.groups[0] ?? null
  return {
    id: key.id,
    name: key.name,
    key: maskKey(key.key),
    status: expired ? 'expired' : key.enabled ? 'enabled' : 'disabled',
    /** 被管理员停用：门户只能查看，不能自行启用 */
    admin_disabled: key.admin_disabled,
    group,
    group_available: !!group && usable.includes(group),
    used_quota: key.quota_used,
    expires_at: key.expires_at,
    created_at: key.created_at,
    last_used_at: key.last_used_at,
  }
}

function selfView(user: PortalUser) {
  const today = db
    .prepare("SELECT requests, points FROM usage_daily WHERE account_type = 'user' AND account_id = ? AND day = ?")
    .get(user.id, localDay(Date.now())) as { requests: number; points: number } | undefined
  return {
    id: user.id,
    username: user.username,
    quota: user.quota,
    used_quota: user.used_quota,
    request_count: user.request_count,
    created_at: user.created_at,
    today_requests: today?.requests ?? 0,
    today_points: today?.points ?? 0,
  }
}

const currentUser = (res: Response) => res.locals.user as PortalUser
const usableNames = (user: PortalUser) => userGroups(user).map(g => g.name)

portalRouter.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store')
  // 写操作只收 JSON：跨站表单发不出 application/json，配合 SameSite=Lax 防 CSRF
  if (req.method !== 'GET' && req.method !== 'HEAD' && !req.is('application/json')) return fail(res, '请求须为 JSON', 415)
  next()
})
portalRouter.use(express.json({ limit: '64kb' }))

// ── 免登录接口 ──────────────────────────────────────────
portalRouter.get('/status', (req, res) => {
  const s = getSettings()
  ok(res, {
    register_enabled: s.portal_register_enabled,
    checkin_enabled: s.checkin_enabled,
    checkin_min_points: s.checkin_min_points,
    checkin_max_points: s.checkin_max_points,
    points_per_usd: s.portal_points_per_usd,
    currency_symbol: s.currency_symbol,
    brand_name: s.portal_brand_name,
    brand_icon: s.portal_brand_icon,
    site_title: s.portal_site_title,
    base_url: s.public_base_url || `${req.protocol}://${req.get('host') ?? ''}`,
    log_retention_days: s.log_retention_days,
  })
})

portalRouter.post('/register', wrap(async (req, res) => {
  const s = getSettings()
  if (!s.portal_register_enabled) return fail(res, '管理员已关闭注册')
  const { username, password } = req.body ?? {}
  const error = usernameError(username) ?? passwordError(password)
  if (error) return fail(res, error)
  const ip = clientIp(req)
  const seconds = blockedSeconds(ip)
  if (seconds > 0) {
    res.setHeader('Retry-After', String(seconds))
    return fail(res, `尝试次数过多，请 ${Math.ceil(seconds / 60)} 分钟后再试`, 429)
  }
  const ipLimitReached = () => s.portal_register_ip_daily > 0 && !!ip
    && countRegistrations(ip, localMidnight(Date.now()), limitKey) >= s.portal_register_ip_daily
  // 先做一次廉价检查，超额请求不进入 scrypt
  if (ipLimitReached()) return fail(res, '该 IP 今日注册次数已达上限，请明天再试')
  // 用户名已被占用计入失败次数，让枚举用户名付出代价
  const taken = () => { recordAuthFailure(ip); return fail(res, '用户名已被占用') }
  if (getUserByName(username)) return taken()
  const release = beginAuthAttempt(`register:${limitKey(ip)}`, 2)
  if (!release) return fail(res, '注册请求过于频繁，请稍后再试', 429)
  try {
    const passwordHash = await hashPassword(password)
    // scrypt 期间可能有并发注册写入；断言紧挨 INSERT，中间没有 await
    if (ipLimitReached()) return fail(res, '该 IP 今日注册次数已达上限，请明天再试')
    const user = createUser({ username, password_hash: passwordHash, quota: s.portal_initial_quota, ip })
    if (!user) return taken()
    ok(res, null, '注册成功')
  } finally {
    release()
  }
}))

portalRouter.post('/login', wrap(async (req, res) => {
  const ip = clientIp(req)
  const { username, password } = req.body ?? {}
  // 只有合法用户名才有账号维度的计数，避免任意长字符串撑大限流表
  const account = usernameError(username) ? '' : `u:${String(username).toLowerCase()}`
  const seconds = Math.max(blockedSeconds(ip), account ? blockedSeconds(account) : 0)
  if (seconds > 0) {
    res.setHeader('Retry-After', String(seconds))
    return fail(res, `登录失败次数过多，请 ${Math.ceil(seconds / 60)} 分钟后再试`, 429)
  }
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) return fail(res, '请输入用户名和密码')
  // 同一 IP 对同一账号最多 2 个并发校验，避免用突发请求在失败计数生效前全部进入 scrypt
  const release = beginAuthAttempt(`login:${limitKey(ip)}:${account}`, 2)
  if (!release) return fail(res, '登录请求过于频繁，请稍后再试', 429)
  try {
    const user = account ? getUserByName(username) : null
    const valid = user && !passwordError(password) ? await verifyPassword(password, user.password_hash) : (await burnPasswordCheck(password), false)
    if (!user || !valid) {
      recordAuthFailure(ip)
      if (account) recordAuthFailure(account)
      return fail(res, '用户名或密码错误')
    }
    if (user.status !== USER_ENABLED) return fail(res, '账号已停用，请联系管理员')
    const token = createSession(user.id, ip)
    touchLogin(user.id, ip)
    res.setHeader('Set-Cookie', sessionCookie(token, req.secure))
    ok(res, selfView(user), '登录成功')
  } finally {
    release()
  }
}))

portalRouter.post('/logout', (req, res) => {
  deleteSession(readSessionToken(req))
  res.setHeader('Set-Cookie', sessionCookie('', req.secure))
  ok(res)
})

// ── 以下需要登录 ────────────────────────────────────────
portalRouter.use((req, res, next) => {
  const token = readSessionToken(req)
  const user = sessionUser(token)
  if (!user) return fail(res, '未登录或登录已过期', 401)
  res.locals.user = user
  res.locals.sessionToken = token
  next()
})

portalRouter.get('/self', (_req, res) => {
  ok(res, selfView(currentUser(res)))
})

/** 通知与已发布的最近公告；关闭公告时公告为空数组 */
portalRouter.get('/notices', (_req, res) => {
  const s = getSettings()
  const announcements = s.portal_announcements_enabled ? publishedAnnouncements(PORTAL_ANNOUNCEMENTS) : []
  ok(res, {
    notice: s.portal_notice.trim(),
    announcements: announcements.map(({ id, content, extra, type, publish_at, updated_at }) => ({ id, content, extra, type, publish_at, updated_at })),
  })
})

portalRouter.post('/password', wrap(async (req, res) => {
  const user = currentUser(res)
  const ip = clientIp(req)
  // 按账号与按 IP 各计一份失败，挡住「拿着会话无限次猜原密码」
  const userId = `pw:${user.id}`
  const ipId = `pwip:${limitKey(ip)}`
  const seconds = Math.max(blockedSeconds(userId), blockedSeconds(ipId))
  if (seconds > 0) {
    res.setHeader('Retry-After', String(seconds))
    return fail(res, `尝试次数过多，请 ${Math.ceil(seconds / 60)} 分钟后再试`, 429)
  }
  const release = beginAuthAttempt(userId, 1)
  if (!release) return fail(res, '请求过于频繁，请稍后再试', 429)
  try {
    const { old_password, new_password } = req.body ?? {}
    if (typeof old_password !== 'string' || !(await verifyPassword(old_password, user.password_hash))) {
      recordAuthFailure(userId)
      recordAuthFailure(ipId)
      return fail(res, '原密码错误')
    }
    const error = passwordError(new_password)
    if (error) return fail(res, error)
    setUserPassword(user.id, await hashPassword(new_password))
    // 其他设备上的登录全部失效，保留当前会话
    deleteUserSessions(user.id, res.locals.sessionToken)
    ok(res, null, '密码已修改')
  } finally {
    release()
  }
}))

portalRouter.get('/usage', (req, res) => {
  const days = Math.min(90, Math.max(1, Math.floor(Number(req.query.days)) || 7))
  const from = localDay(Date.now() - (days - 1) * 86_400_000)
  const rows = db
    .prepare(
      `SELECT day, requests, points, prompt_tokens, completion_tokens FROM usage_daily
       WHERE account_type = 'user' AND account_id = ? AND day >= ? ORDER BY day ASC`,
    )
    .all(currentUser(res).id, from)
  ok(res, rows)
})

/** 用户可选的分组（公开 + 分配），按排序 */
portalRouter.get('/groups', (_req, res) => {
  ok(res, userGroups(currentUser(res)).map(g => ({ name: g.name, description: g.description, ratio: g.ratio })))
})

/** 模型列表：用户可用分组，以及每个模型的基础价格（未乘分组倍率）和能用它的分组 */
portalRouter.get('/pricing', (req, res) => {
  const s = getSettings()
  const user = currentUser(res)
  const groups = userGroups(user)
  const ip = clientIp(req)
  const modelGroups = new Map<string, string[]>()
  for (const group of groups) {
    // 用一个占位 Key 套上门户设置，与实际调用时的可见范围一致
    const placeholder: ApiKey = {
      id: 0, name: '', key: '', enabled: true, admin_disabled: false, groups: [group.name], models: [], rpm: null, concurrency: null, quota_total: null,
      quota_used: 0, quota_daily: null, log_bodies: null, expires_at: null, note: null, user_id: user.id,
      created_at: 0, updated_at: 0, last_used_at: null,
    }
    const key = effectivePortalKey(placeholder, user, s)
    if (!key) continue
    const caller: Caller = { surface: 'public', source: 'user', key, user, ip }
    for (const model of modelsVisibleTo(caller, s.model_ratios)) {
      const names = modelGroups.get(model)
      if (names) names.push(group.name)
      else modelGroups.set(model, [group.name])
    }
  }
  ok(res, {
    groups: groups.map(g => ({ name: g.name, description: g.description, ratio: g.ratio })),
    models: [...modelGroups.keys()].sort().map(model => {
      const { input, output, cache_read, cache_write, per_request } = findRatio(s.model_ratios, model)!
      return { model, input, output, cache_read, cache_write, per_request, groups: modelGroups.get(model)! }
    }),
  })
})

// ── 令牌 ──
portalRouter.get('/keys', (_req, res) => {
  const user = currentUser(res)
  const usable = usableNames(user)
  ok(res, listUserKeys(user.id).map(k => keyView(k, usable)))
})

portalRouter.post('/keys', (req, res) => {
  const user = currentUser(res)
  const { name, group, expires_at } = req.body ?? {}
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (!trimmed || trimmed.length > 50) return fail(res, '名称须为 1～50 个字符')
  const usable = usableNames(user)
  if (typeof group !== 'string' || !usable.includes(group)) return fail(res, '请选择可用的分组')
  if (expires_at != null && !(Number.isSafeInteger(expires_at) && expires_at > Date.now())) return fail(res, '过期时间须晚于当前时间')
  const max = getSettings().portal_max_keys
  if (countUserKeys(user.id) >= max) return fail(res, `最多只能创建 ${max} 个令牌`)
  const key = createUserKey(user.id, trimmed, group, expires_at ?? null)
  ok(res, { ...keyView(key, usable), full_key: key.key }, '令牌已创建')
})

portalRouter.post('/keys/:id/key', (req, res) => {
  const key = getUserKey(currentUser(res).id, validId(req.params.id))
  if (!key) return fail(res, '令牌不存在')
  ok(res, { key: key.key })
})

/** 可单独改启用状态或分组 */
portalRouter.put('/keys/:id', (req, res) => {
  const user = currentUser(res)
  const id = validId(req.params.id)
  const existing = getUserKey(user.id, id)
  if (!existing) return fail(res, '令牌不存在')
  const { enabled, group } = req.body ?? {}
  const usable = usableNames(user)
  if (enabled !== undefined && typeof enabled !== 'boolean') return fail(res, 'enabled 须为布尔值')
  if (enabled === true && existing.admin_disabled) return fail(res, '该令牌已被管理员停用，请先联系管理员')
  if (group !== undefined && (typeof group !== 'string' || !usable.includes(group))) return fail(res, '请选择可用的分组')
  if (enabled === undefined && group === undefined) return fail(res, '没有要修改的内容')
  ok(res, keyView(updateKey(id, { enabled, groups: group === undefined ? undefined : [group] })!, usable))
})

portalRouter.delete('/keys/:id', (req, res) => {
  const id = validId(req.params.id)
  if (!getUserKey(currentUser(res).id, id)) return fail(res, '令牌不存在')
  deleteKey(id)
  ok(res, null, '令牌已删除')
})

// ── 调用记录：只返回元数据，错误信息脱敏 ──
portalRouter.get('/logs', (req, res) => {
  const size = Math.min(100, Math.max(1, Math.floor(Number(req.query.size)) || 20))
  const page = Math.max(1, Math.floor(Number(req.query.page)) || 1)
  const where = ['user_id = ?', 'is_retry = 0']
  const args: unknown[] = [currentUser(res).id]
  const keyId = validId(String(req.query.key_id ?? ''))
  if (keyId) {
    where.push('key_id = ?')
    args.push(keyId)
  }
  const model = typeof req.query.model === 'string' ? req.query.model.trim() : ''
  if (model) {
    where.push("model LIKE ? ESCAPE '\\'")
    args.push(`%${model.replace(/[\\%_]/g, m => '\\' + m)}%`)
  }
  const whereSql = where.join(' AND ')
  const total = db.prepare(`SELECT COUNT(*) FROM request_logs WHERE ${whereSql}`).pluck().get(...args) as number
  const rows = db
    .prepare(
      `SELECT id, created_at, key_id, key_name, model, entry_format, is_stream, status, status_code, latency_ms,
              prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens, quota_points, error_message, group_name
       FROM request_logs WHERE ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...args, size, (page - 1) * size) as { error_message: string | null }[]
  const items = rows.map(row => ({ ...row, error_message: row.error_message ? sanitizePublicError('upstream', row.error_message) : null }))
  ok(res, { items, total, page, size })
})

// ── 签到 ──
portalRouter.get('/checkin', (req, res) => {
  const s = getSettings()
  const month = typeof req.query.month === 'string' ? req.query.month : undefined
  ok(res, {
    enabled: s.checkin_enabled,
    min_points: s.checkin_min_points,
    max_points: s.checkin_max_points,
    ...checkinStatus(currentUser(res).id, month),
  })
})

portalRouter.post('/checkin', (_req, res) => {
  const s = getSettings()
  if (!s.checkin_enabled) return fail(res, '签到功能未启用')
  const user = currentUser(res)
  const result = checkin(user.id, { min: s.checkin_min_points, max: s.checkin_max_points })
  if (!result.ok) return fail(res, result.message)
  ok(res, { day: result.day, points: result.points, quota: getUserById(user.id)?.quota ?? 0 }, '签到成功')
})

portalRouter.use((_req, res) => fail(res, 'not found', 404))

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (res.headersSent) return
  if (err?.type === 'entity.parse.failed') return fail(res, '请求体不是合法 JSON', 400)
  if (err?.status === 413 || err?.type === 'entity.too.large') return fail(res, '请求体过大', 413)
  console.error('[agghub] 门户接口异常:', err)
  fail(res, '服务器内部错误', 500)
}
portalRouter.use(errorHandler)
