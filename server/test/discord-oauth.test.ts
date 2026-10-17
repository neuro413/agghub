import './helpers/isolated'
import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import { db, getSettings, setSettings } from '../src/db'
import { createApp } from '../src/app'
import { resetAuthFailures } from '../src/core/caller'
import { resetLimiter } from '../src/core/limiter'
import { listDiscordGuilds, listUsers } from '../src/core/users'
import { SettingsValidationError, validateSettingsPatch } from '../src/core/settingsValidation'
import { jsonResponse, reset } from './helpers/relay'

const realFetch = globalThis.fetch
let server: Server
let base = ''

const DISCORD_API = 'https://discord.com/api/v10'
const CLIENT_ID = '123456789012345678'
const CLIENT_SECRET = 'secret'
const GUILD_ID = '234567890123456789'
const ROLE_A = '200000000000000001'
const ROLE_B = '200000000000000002'

/** 授权码 → 模拟的 Discord 用户与服务器成员身份 */
type Scenario = {
  profile: { id: string; username: string }
  member?: { status: number; body: unknown }
  guilds?: { status: number; body: unknown }
}
const scenarios = new Map<string, Scenario>()
let tokenCalls = 0
/** 换取令牌时收到的 redirect_uri，按调用顺序记录 */
const tokenRedirects: string[] = []

before(async () => {
  server = createApp('public').listen(0)
  await new Promise<void>(resolve => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  // 本地请求走真实 fetch；发往 Discord 的请求按场景表返回
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url ?? String(input)
    if (url.startsWith(base)) return realFetch(input, init)
    const headers = (init?.headers ?? {}) as Record<string, string>
    if (url === `${DISCORD_API}/oauth2/token`) {
      tokenCalls++
      const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '')
      const code = form.get('code') ?? ''
      tokenRedirects.push(form.get('redirect_uri') ?? '')
      if (code === 'bad' || !scenarios.has(code)) return jsonResponse({ error: 'invalid_grant' }, 400)
      return jsonResponse({ access_token: `tok-${code}`, token_type: 'Bearer', expires_in: 3600 })
    }
    const authorization = typeof headers.authorization === 'string' ? headers.authorization : ''
    const code = authorization.startsWith('Bearer tok-') ? authorization.slice('Bearer tok-'.length) : ''
    if (url === `${DISCORD_API}/users/@me`) {
      const found = scenarios.get(code)
      if (!found) return jsonResponse({ message: '401: Unauthorized' }, 401)
      return jsonResponse(found.profile)
    }
    if (new RegExp(`^${DISCORD_API.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/users/@me/guilds/[^/]+/member$`).test(url)) {
      const reply = scenarios.get(code)?.member ?? { status: 200, body: { roles: [], pending: false } }
      return jsonResponse(reply.body, reply.status)
    }
    if (url === `${DISCORD_API}/users/@me/guilds?with_counts=true`) {
      const reply = scenarios.get(code)?.guilds ?? { status: 200, body: [] }
      return jsonResponse(reply.body, reply.status)
    }
    return jsonResponse({ message: 'not found' }, 404)
  }) as typeof fetch
})
after(async () => {
  globalThis.fetch = realFetch
  await new Promise<void>(resolve => server.close(() => resolve()))
  db.close()
})
beforeEach(() => {
  reset()
  db.exec('DELETE FROM users; DELETE FROM user_discord_guilds; DELETE FROM user_sessions; DELETE FROM user_checkins; DELETE FROM api_keys; DELETE FROM usage_daily; DELETE FROM channel_groups; DELETE FROM announcements')
  resetAuthFailures()
  resetLimiter()
  // 大部分用例都会建号；注册上限单独在用例里设置
  setSettings({ portal_register_ip_daily: 0 })
  scenarios.clear()
  tokenCalls = 0
  tokenRedirects.length = 0
})

async function call(path: string, options: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
  const method = options.method ?? 'GET'
  const r = await realFetch(base + path, {
    method,
    headers: { ...(method === 'GET' ? {} : { 'content-type': 'application/json' }), ...(options.cookie ? { cookie: options.cookie } : {}), ...options.headers },
    body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}),
  })
  return { status: r.status, json: await r.json() as any, setCookie: r.headers.getSetCookie() }
}

/** 打开 Discord 登录，默认带回跳用的公网 Base URL */
function enableDiscord(extra: Record<string, unknown> = {}) {
  setSettings({
    discord_enabled: true,
    discord_client_id: CLIENT_ID,
    discord_client_secret: CLIENT_SECRET,
    public_base_url: 'https://portal.example.com',
    ...extra,
  })
}

function scenario(code: string, profile: { id: string; username: string }, member?: Scenario['member'], guilds?: Scenario['guilds']) {
  scenarios.set(code, { profile, member, guilds })
}

async function startLogin() {
  const r = await realFetch(base + '/api/user/oauth/discord/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  const json = await r.json() as any
  const cookies = r.headers.getSetCookie()
  return {
    json,
    state: String(json?.data?.state ?? ''),
    stateCookie: cookies.find(cookie => cookie.startsWith('agh_oauth_state=')) ?? '',
    cookies,
  }
}

async function callback(code: string, state: string, cookie?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (cookie) headers.cookie = cookie
  const r = await realFetch(base + '/api/user/oauth/discord/callback', {
    method: 'POST',
    headers,
    body: JSON.stringify({ code, state }),
  })
  const cookies = r.headers.getSetCookie()
  return {
    status: r.status,
    json: await r.json() as any,
    cookies,
    session: cookies.map(cookie => cookie.split(';')[0]).find(value => value.startsWith('agh_session=')) ?? '',
  }
}

/** 走完 start → callback，返回回调结果与可用于后续请求的 agh_session Cookie */
async function discordLogin(code: string) {
  const started = await startLogin()
  const result = await callback(code, started.state, `agh_oauth_state=${started.state}`)
  return { ...result, started }
}

test('/status：Discord 与密码注册开关', async () => {
  let status = (await call('/api/user/status')).json.data
  assert.equal(status.discord_enabled, false)

  setSettings({ discord_enabled: true })
  status = (await call('/api/user/status')).json.data
  assert.equal(status.discord_enabled, false)

  setSettings({ discord_client_id: CLIENT_ID, discord_client_secret: CLIENT_SECRET })
  status = (await call('/api/user/status')).json.data
  assert.equal(status.discord_enabled, true)

  // password_register_enabled = 注册总开关 && 密码注册子开关
  setSettings({ portal_register_enabled: false })
  status = (await call('/api/user/status')).json.data
  assert.equal(status.register_enabled, false)
  assert.equal(status.password_register_enabled, false)

  setSettings({ portal_register_enabled: true, portal_password_register_enabled: false })
  status = (await call('/api/user/status')).json.data
  assert.equal(status.register_enabled, true)
  assert.equal(status.password_register_enabled, false)

  setSettings({ portal_password_register_enabled: true })
  status = (await call('/api/user/status')).json.data
  assert.equal(status.password_register_enabled, true)
})

test('start：授权地址、state Cookie 与 scope', async () => {
  let started = await startLogin()
  assert.equal(started.json.success, false)

  enableDiscord()
  started = await startLogin()
  assert.equal(started.json.success, true)
  const url = new URL(started.json.data.url)
  assert.equal(url.host, 'discord.com')
  assert.equal(url.pathname, '/oauth2/authorize')
  assert.equal(url.searchParams.get('client_id'), CLIENT_ID)
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('redirect_uri'), 'https://portal.example.com/oauth/discord')
  assert.equal(url.searchParams.get('prompt'), 'none')
  assert.equal(url.searchParams.get('scope'), 'identify guilds')
  assert.equal(url.searchParams.get('state'), started.json.data.state)
  assert.equal(
    started.stateCookie,
    `agh_oauth_state=${started.json.data.state}; Path=/api/user/oauth/discord; Max-Age=600; HttpOnly; SameSite=Lax`,
  )

  setSettings({ discord_guild_id: GUILD_ID })
  started = await startLogin()
  assert.equal(new URL(started.json.data.url).searchParams.get('scope'), 'identify guilds guilds.members.read')
})

test('callback：缺少 Cookie 或 state 不一致时拒绝且不请求 Discord', async () => {
  enableDiscord()
  scenario('valid', { id: '111111111111111111', username: 'valid.user' })

  const noCookie = await callback('valid', 'some-state')
  assert.equal(noCookie.json.success, false)
  assert.match(noCookie.json.message, /登录状态已失效/)

  const started = await startLogin()
  const mismatch = await callback('valid', 'other-state', `agh_oauth_state=${started.state}`)
  assert.equal(mismatch.json.success, false)
  assert.match(mismatch.json.message, /登录状态已失效/)
  assert.equal(tokenCalls, 0)
  assert.equal(db.prepare('SELECT COUNT(*) FROM users').pluck().get(), 0)
})

test('新用户：用户名规整、无密码、初始额度与会话可用', async () => {
  enableDiscord({ portal_initial_quota: 500 })
  scenario('cool', { id: '111111111111111111', username: 'cool.user' })

  const login = await discordLogin('cool')
  assert.equal(login.json.success, true)
  assert.equal(login.json.data.username, 'cool_user')
  assert.equal(login.json.data.has_password, false)
  assert.equal(login.json.data.discord_username, 'cool.user')

  const row = db.prepare('SELECT username, password_hash, discord_id, discord_username, quota FROM users WHERE discord_id = ?').get('111111111111111111') as any
  assert.deepEqual({ ...row }, {
    username: 'cool_user',
    password_hash: '',
    discord_id: '111111111111111111',
    discord_username: 'cool.user',
    quota: 500,
  })
  assert.equal(tokenRedirects.at(-1), 'https://portal.example.com/oauth/discord')

  const self = await call('/api/user/self', { cookie: login.session })
  assert.equal(self.status, 200)
  assert.equal(self.json.data.username, 'cool_user')
  assert.equal(self.json.data.discord_username, 'cool.user')
})

test('同一 Discord ID 再次登录复用账号并更新 Discord 用户名', async () => {
  enableDiscord()
  scenario('first', { id: '222222222222222222', username: 'old.name' })
  const first = await discordLogin('first')
  assert.equal(first.json.success, true)

  scenario('second', { id: '222222222222222222', username: 'new.name' })
  const second = await discordLogin('second')
  assert.equal(second.json.success, true)
  assert.equal(second.json.data.id, first.json.data.id)
  assert.equal(second.json.data.username, first.json.data.username)
  assert.equal(db.prepare('SELECT COUNT(*) FROM users').pluck().get(), 1)
  assert.equal(db.prepare('SELECT discord_username FROM users WHERE discord_id = ?').pluck().get('222222222222222222'), 'new.name')
})

test('用户名冲突时加四位随机数字', async () => {
  enableDiscord()
  const registered = await call('/api/user/register', { method: 'POST', body: { username: 'cool_user', password: 'password1' } })
  assert.equal(registered.json.success, true)

  scenario('conflict', { id: '333333333333333333', username: 'cool_user' })
  const login = await discordLogin('conflict')
  assert.equal(login.json.success, true)
  assert.match(login.json.data.username, /^cool_user_\d{4}$/)
  assert.equal(db.prepare('SELECT COUNT(*) FROM users').pluck().get(), 2)
})

test('注册总开关关闭：新 Discord 账号被拒，已有账号仍可登录', async () => {
  enableDiscord()
  scenario('existing', { id: '444444444444444444', username: 'existing.user' })
  const first = await discordLogin('existing')
  assert.equal(first.json.success, true)

  setSettings({ portal_register_enabled: false })
  scenario('newbie', { id: '555555555555555555', username: 'newbie.user' })
  const blocked = await discordLogin('newbie')
  assert.equal(blocked.json.success, false)
  assert.match(blocked.json.message, /管理员已关闭注册/)

  const again = await discordLogin('existing')
  assert.equal(again.json.success, true)
  assert.equal(again.json.data.id, first.json.data.id)
})

test('密码注册子开关关闭：密码注册被拒，Discord 建号仍正常', async () => {
  enableDiscord()
  setSettings({ portal_password_register_enabled: false })
  const registered = await call('/api/user/register', { method: 'POST', body: { username: 'alice', password: 'password1' } })
  assert.equal(registered.json.success, false)
  assert.match(registered.json.message, /用户名密码注册/)

  scenario('pw-off', { id: '666666666666666666', username: 'discord.only' })
  const login = await discordLogin('pw-off')
  assert.equal(login.json.success, true)
  assert.equal(login.json.data.username, 'discord_only')
})

test('服务器与身份组门槛', async () => {
  enableDiscord({ discord_guild_id: GUILD_ID })

  scenario('not-member', { id: '700000000000000001', username: 'no.member' }, {
    status: 404,
    body: { message: 'Unknown Member', code: 10007 },
  })
  const noMember = await discordLogin('not-member')
  assert.equal(noMember.json.success, false)
  assert.match(noMember.json.message, /加入指定的 Discord 服务器/)

  scenario('pending', { id: '700000000000000002', username: 'pending.user' }, {
    status: 200,
    body: { roles: [], pending: true },
  })
  const pending = await discordLogin('pending')
  assert.equal(pending.json.success, false)
  assert.match(pending.json.message, /成员验证/)

  setSettings({ discord_role_ids: [ROLE_A, ROLE_B] })
  scenario('no-role', { id: '700000000000000003', username: 'no.role' }, {
    status: 200,
    body: { roles: ['200000000000000009'], pending: false },
  })
  const noRole = await discordLogin('no-role')
  assert.equal(noRole.json.success, false)
  assert.match(noRole.json.message, /身份组/)

  scenario('has-role', { id: '700000000000000004', username: 'has.role' }, {
    status: 200,
    body: { roles: [ROLE_A], pending: false },
  })
  const hasRole = await discordLogin('has-role')
  assert.equal(hasRole.json.success, true)
})

test('管理员停用的 Discord 账号不能登录', async () => {
  enableDiscord()
  scenario('disabled', { id: '888888888888888888', username: 'disabled.user' })
  const first = await discordLogin('disabled')
  assert.equal(first.json.success, true)
  db.prepare('UPDATE users SET status = 2 WHERE discord_id = ?').run('888888888888888888')

  const again = await discordLogin('disabled')
  assert.equal(again.json.success, false)
  assert.match(again.json.message, /账号已停用/)
})

test('Discord 建的号不能用密码登录，也不能修改密码', async () => {
  enableDiscord()
  scenario('no-pass', { id: '999999999999999999', username: 'cool.user' })
  const login = await discordLogin('no-pass')
  assert.equal(login.json.success, true)

  const byPassword = await call('/api/user/login', { method: 'POST', body: { username: 'cool_user', password: 'password1' } })
  assert.equal(byPassword.json.success, false)
  assert.equal(byPassword.json.message, '用户名或密码错误')

  const change = await call('/api/user/password', {
    method: 'POST',
    cookie: login.session,
    body: { old_password: 'password1', new_password: 'password2' },
  })
  assert.equal(change.json.success, false)
  assert.match(change.json.message, /Discord/)
})

test('授权码无效（invalid_grant）返回授权已过期', async () => {
  enableDiscord()
  const login = await discordLogin('bad')
  assert.equal(login.json.success, false)
  assert.match(login.json.message, /授权已过期/)
  assert.equal(tokenCalls, 1)
})

test('同 IP 每日注册上限对 Discord 建号同样生效', async () => {
  enableDiscord()
  setSettings({ portal_register_ip_daily: 1 })
  scenario('limit-1', { id: '101010101010101010', username: 'first.user' })
  scenario('limit-2', { id: '202020202020202020', username: 'second.user' })

  const first = await discordLogin('limit-1')
  assert.equal(first.json.success, true)

  const second = await discordLogin('limit-2')
  assert.equal(second.json.success, false)
  assert.match(second.json.message, /注册次数已达上限/)
  assert.equal(db.prepare('SELECT COUNT(*) FROM users').pluck().get(), 1)
})

test('Discord 设置校验', () => {
  const current = getSettings()
  const expectError = (input: Record<string, unknown>, field: string) => {
    assert.throws(
      () => validateSettingsPatch(current, input),
      (error: unknown) => error instanceof SettingsValidationError && Object.hasOwn(error.fields, field),
    )
  }

  expectError({ discord_enabled: true }, 'discord_enabled')
  expectError({ discord_role_ids: ['123456789012345678'] }, 'discord_role_ids')
  expectError({ discord_client_id: 'abc' }, 'discord_client_id')

  const trimmed = validateSettingsPatch(current, { discord_client_id: ' 123456789012345678 ' })
  assert.equal(trimmed.discord_client_id, '123456789012345678')

  const deduped = validateSettingsPatch(current, {
    discord_guild_id: GUILD_ID,
    discord_role_ids: ['123456789012345678', '123456789012345678'],
  })
  assert.deepEqual(deduped.discord_role_ids, ['123456789012345678'])
})

test('listUsers 支持按 Discord 用户名模糊与 Discord ID 精确搜索', async () => {
  enableDiscord()
  scenario('search', { id: '987654321012345678', username: 'cool.user' })
  const login = await discordLogin('search')
  assert.equal(login.json.success, true)

  const byDiscordName = listUsers({ q: 'cool.user' })
  assert.equal(byDiscordName.total, 1)
  assert.equal(byDiscordName.items[0].username, 'cool_user')
  assert.equal(byDiscordName.items[0].discord_username, 'cool.user')
  assert.equal(byDiscordName.items[0].has_password, false)

  const byDiscordId = listUsers({ q: '987654321012345678' })
  assert.equal(byDiscordId.total, 1)
  assert.equal(byDiscordId.items[0].id, login.json.data.id)
})

test('登录时记录服务器列表：每次覆盖、获取失败保留旧记录、支持按服务器搜索', async () => {
  enableDiscord()
  const discordId = '333333333333333333'
  const guildA = { id: '400000000000000001', name: 'Alpha Hub', icon: 'a_0123abcd', owner: true, approximate_member_count: 12 }
  const guildB = { id: '400000000000000002', name: 'beta', icon: '../evil', owner: false }
  scenario('g1', { id: discordId, username: 'guild.user' }, undefined, { status: 200, body: [guildB, guildA, { id: 'bad', name: 'x' }] })
  const first = await discordLogin('g1')
  assert.equal(first.json.success, true)
  const userId = first.json.data.id
  assert.deepEqual(listDiscordGuilds(userId), [
    { id: guildA.id, name: 'Alpha Hub', icon: 'a_0123abcd', owner: true, member_count: 12 },
    { id: guildB.id, name: 'beta', icon: null, owner: false, member_count: null },
  ])
  const recordedAt = listUsers({}).items[0].discord_guilds_at
  assert.ok(recordedAt)

  assert.equal(listUsers({ q: guildA.id }).total, 1)
  assert.equal(listUsers({ q: 'alpha' }).items[0]?.id, userId)
  assert.equal(listUsers({ q: '400000000000000003' }).total, 0)

  // 获取失败不影响登录，也不清掉上次的记录
  scenario('g2', { id: discordId, username: 'guild.user' }, undefined, { status: 500, body: { message: 'boom' } })
  assert.equal((await discordLogin('g2')).json.success, true)
  assert.equal(listDiscordGuilds(userId).length, 2)

  scenario('g3', { id: discordId, username: 'guild.user' }, undefined, { status: 200, body: [guildB] })
  assert.equal((await discordLogin('g3')).json.success, true)
  assert.deepEqual(listDiscordGuilds(userId).map(g => g.id), [guildB.id])
  assert.equal(listUsers({ q: guildA.id }).total, 0)
})
