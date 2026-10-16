import './helpers/isolated'
import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import { db, setSettings } from '../src/db'
import { createApp } from '../src/app'
import { localDay } from '../src/core/billing'
import { resetAuthFailures } from '../src/core/caller'
import { resetLimiter } from '../src/core/limiter'
import { createGroup } from '../src/core/groups'
import { getUserByName, setUserStatus } from '../src/core/users'
import { channel, jsonResponse, oaiBody, reset } from './helpers/relay'

const realFetch = globalThis.fetch
let server: Server
let base = ''

before(async () => {
  server = createApp('public').listen(0)
  await new Promise<void>(resolve => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  // 发往本地服务的请求走真实 fetch，其余视为上游，返回固定的 OpenAI 回复
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url ?? String(input)
    return url.startsWith(base) ? realFetch(input, init) : jsonResponse(oaiBody)
  }) as typeof fetch
})
after(async () => {
  globalThis.fetch = realFetch
  await new Promise<void>(resolve => server.close(() => resolve()))
  db.close()
})
beforeEach(() => {
  reset()
  db.exec('DELETE FROM users; DELETE FROM user_sessions; DELETE FROM user_checkins; DELETE FROM api_keys; DELETE FROM usage_daily; DELETE FROM channel_groups; DELETE FROM announcements')
  resetAuthFailures()
  resetLimiter()
})

async function call(path: string, options: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
  const method = options.method ?? 'GET'
  const r = await realFetch(base + path, {
    method,
    headers: { ...(method === 'GET' ? {} : { 'content-type': 'application/json' }), ...(options.cookie ? { cookie: options.cookie } : {}), ...options.headers },
    body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}),
  })
  return { status: r.status, json: await r.json() as any, setCookie: r.headers.get('set-cookie') ?? '' }
}

async function signup(username: string, password = 'password1'): Promise<string> {
  assert.equal((await call('/api/user/register', { method: 'POST', body: { username, password } })).json.success, true)
  const login = await call('/api/user/login', { method: 'POST', body: { username, password } })
  assert.equal(login.json.success, true)
  return login.setCookie.split(';')[0]
}

test('注册、登录、会话与修改密码', async () => {
  setSettings({ portal_initial_quota: 1000 })
  assert.equal((await call('/api/user/register', { method: 'POST', body: { username: 'a', password: 'password1' } })).json.success, false)
  assert.equal((await call('/api/user/register', { method: 'POST', body: { username: 'alice', password: 'short' } })).json.success, false)
  assert.equal((await call('/api/user/register', { method: 'POST', body: { username: 'alice', password: 'password1' } })).json.success, true)
  const dup = await call('/api/user/register', { method: 'POST', body: { username: 'ALICE', password: 'password1' } })
  assert.equal(dup.json.message, '用户名已被占用')

  assert.equal((await call('/api/user/login', { method: 'POST', body: { username: 'alice', password: 'wrong-pass' } })).json.success, false)
  const login = await call('/api/user/login', { method: 'POST', body: { username: 'Alice', password: 'password1' } })
  assert.equal(login.json.success, true)
  assert.match(login.setCookie, /^agh_session=[^;]+; Path=\/api\/user; Max-Age=\d+; HttpOnly; SameSite=Lax$/)
  const cookie = login.setCookie.split(';')[0]

  assert.equal((await call('/api/user/self')).status, 401)
  const self = await call('/api/user/self', { cookie })
  assert.equal(self.json.data.username, 'alice')
  assert.equal(self.json.data.quota, 1000)

  // 写操作只收 JSON
  const form = await realFetch(base + '/api/user/checkin', { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' })
  assert.equal(form.status, 415)

  assert.equal((await call('/api/user/password', { method: 'POST', cookie, body: { old_password: 'nope', new_password: 'password2' } })).json.success, false)
  assert.equal((await call('/api/user/password', { method: 'POST', cookie, body: { old_password: 'password1', new_password: 'password2' } })).json.success, true)
  assert.equal((await call('/api/user/self', { cookie })).status, 200)
  assert.equal((await call('/api/user/login', { method: 'POST', body: { username: 'alice', password: 'password1' } })).json.success, false)

  await call('/api/user/logout', { method: 'POST', cookie })
  assert.equal((await call('/api/user/self', { cookie })).status, 401)
})

test('注册开关与同 IP 每日注册上限', async () => {
  setSettings({ portal_register_ip_daily: 2 })
  assert.equal((await call('/api/user/register', { method: 'POST', body: { username: 'user1', password: 'password1' } })).json.success, true)
  assert.equal((await call('/api/user/register', { method: 'POST', body: { username: 'user2', password: 'password1' } })).json.success, true)
  const third = await call('/api/user/register', { method: 'POST', body: { username: 'user3', password: 'password1' } })
  assert.match(third.json.message, /上限/)

  setSettings({ portal_register_ip_daily: 0, portal_register_enabled: false })
  assert.equal((await call('/api/user/register', { method: 'POST', body: { username: 'user4', password: 'password1' } })).json.success, false)
  assert.equal((await call('/api/user/status')).json.data.register_enabled, false)
})

test('每日签到只能一次并发放奖励', async () => {
  const cookie = await signup('alice')
  assert.equal((await call('/api/user/checkin', { method: 'POST', cookie })).json.message, '签到功能未启用')

  setSettings({ checkin_enabled: true, checkin_min_points: 100, checkin_max_points: 100 })
  const first = await call('/api/user/checkin', { method: 'POST', cookie })
  assert.equal(first.json.success, true)
  assert.equal(first.json.data.points, 100)
  assert.equal(first.json.data.quota, 100)
  assert.equal((await call('/api/user/checkin', { method: 'POST', cookie })).json.message, '今日已签到')

  const status = (await call('/api/user/checkin', { cookie })).json.data
  assert.equal(status.checked_in_today, true)
  assert.equal(status.total_checkins, 1)
  assert.deepEqual(status.records, [{ day: localDay(Date.now()), points: 100 }])
})

test('用户 Key 调用扣用户余额，调用记录只能看到自己的', async () => {
  setSettings({ portal_initial_quota: 1000, portal_max_keys: 1 })
  const alice = await signup('alice')
  const bob = await signup('bob')
  const aliceId = getUserByName('alice')!.id
  const channelId = channel('openai')
  createGroup({ name: 'public', is_public: true, channel_ids: [channelId], models: ['alias'] })

  const created = await call('/api/user/keys', { method: 'POST', cookie: alice, body: { name: '测试', group: 'public' } })
  assert.equal(created.json.success, true)
  const fullKey: string = created.json.data.full_key
  assert.ok(fullKey.startsWith('sk-agh-'))
  assert.ok(created.json.data.key.includes('**********'))
  assert.match((await call('/api/user/keys', { method: 'POST', cookie: alice, body: { name: '第二个', group: 'public' } })).json.message, /最多/)
  assert.equal((await call(`/api/user/keys/${created.json.data.id}/key`, { method: 'POST', cookie: bob })).json.success, false)

  const auth = { authorization: `Bearer ${fullKey}` }
  const models = await realFetch(base + '/v1/models', { headers: auth })
  assert.deepEqual(((await models.json()) as any).data.map((m: any) => m.id), ['alias'])

  // 声明较小的输出上限，让预扣落在 1000 点余额以内
  const chat = (body = { model: 'alias', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }) =>
    realFetch(base + '/v1/chat/completions', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal((await chat()).status, 200)

  // 默认倍率 * 全 1：prompt 2 + completion 3 = 5 点
  const user = db.prepare('SELECT quota, used_quota, request_count FROM users WHERE id = ?').get(aliceId)
  assert.deepEqual({ ...user as object }, { quota: 995, used_quota: 5, request_count: 1 })
  const usage = db.prepare("SELECT points FROM usage_daily WHERE account_type = 'user' AND account_id = ?").pluck().get(aliceId)
  assert.equal(usage, 5)
  assert.equal(db.prepare('SELECT quota_used FROM api_keys WHERE id = ?').pluck().get(created.json.data.id), 5)

  const aliceLogs = (await call('/api/user/logs', { cookie: alice })).json.data
  assert.equal(aliceLogs.total, 1)
  assert.equal(aliceLogs.items[0].quota_points, 5)
  assert.equal(aliceLogs.items[0].key_name, '测试')
  assert.equal((await call('/api/user/logs', { cookie: bob })).json.data.total, 0)

  db.prepare('UPDATE users SET quota = 0 WHERE id = ?').run(aliceId)
  const broke = await chat()
  assert.equal(broke.status, 429)
  assert.equal(((await broke.json()) as any).error.type, 'insufficient_quota')

  db.prepare('UPDATE users SET quota = 100 WHERE id = ?').run(aliceId)
  setUserStatus(aliceId, 2)
  const disabled = await chat()
  assert.equal(disabled.status, 403)
  assert.equal(((await disabled.json()) as any).error.type, 'user_disabled')
  assert.equal((await call('/api/user/self', { cookie: alice })).status, 401)
})

test('管理员停用的令牌，门户用户不能自行启用', async () => {
  setSettings({ portal_initial_quota: 1000, portal_max_keys: 5 })
  const alice = await signup('alice')
  const c1 = channel('openai')
  createGroup({ name: 'public', is_public: true, channel_ids: [c1], models: ['alias'] })

  const created = await call('/api/user/keys', { method: 'POST', cookie: alice, body: { name: '测试', group: 'public' } })
  assert.equal(created.json.success, true)
  const id: number = created.json.data.id
  assert.equal(created.json.data.admin_disabled, false)

  // 管理端在另一个 app 上，用真实 fetch 走 /api/keys（门户测试的 fetch 替身只转发公网端口）
  const lan = createApp('lan').listen(0)
  await new Promise<void>((resolve) => lan.once('listening', resolve))
  const adminBase = `http://127.0.0.1:${(lan.address() as { port: number }).port}`
  const adminPut = async (body: unknown) => {
    const r = await realFetch(`${adminBase}/api/keys/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: r.status, json: (await r.json()) as any }
  }

  try {
    // 管理端点「停用」：enabled 置 0 并打上 admin_disabled 标记
    const disabled = await adminPut({ enabled: false })
    assert.equal(disabled.status, 200)
    assert.equal(disabled.json.enabled, false)
    assert.equal(disabled.json.admin_disabled, true)
    const row = db.prepare('SELECT enabled, admin_disabled FROM api_keys WHERE id = ?').get(id) as any
    assert.deepEqual({ enabled: row.enabled, admin_disabled: row.admin_disabled }, { enabled: 0, admin_disabled: 1 })

    // 门户能看到该标记，且自行启用被拒绝
    const listed = (await call('/api/user/keys', { cookie: alice })).json.data
    assert.equal(listed[0].admin_disabled, true)
    assert.equal(listed[0].status, 'disabled')
    const unlock = await call(`/api/user/keys/${id}`, { method: 'PUT', cookie: alice, body: { enabled: true } })
    assert.equal(unlock.json.success, false)
    assert.match(unlock.json.message, /管理员停用/)
    assert.equal(db.prepare('SELECT enabled FROM api_keys WHERE id = ?').pluck().get(id), 0)

    // 用户自己停用仍然可以（不会误改管理员标记）
    const selfOff = await call(`/api/user/keys/${id}`, { method: 'PUT', cookie: alice, body: { enabled: false } })
    assert.equal(selfOff.json.success, true)
    assert.equal(db.prepare('SELECT admin_disabled FROM api_keys WHERE id = ?').pluck().get(id), 1)

    // 管理端重新启用后标记清空，用户可以自行启停
    const enabled = await adminPut({ enabled: true })
    assert.equal(enabled.json.enabled, true)
    assert.equal(enabled.json.admin_disabled, false)
    const userOn = await call(`/api/user/keys/${id}`, { method: 'PUT', cookie: alice, body: { enabled: true } })
    assert.equal(userOn.json.success, true)
    assert.equal(userOn.json.data.status, 'enabled')
  } finally {
    await new Promise<void>((resolve) => lan.close(() => resolve()))
  }
})

test('/pricing 返回可用分组与模型基础价格', async () => {
  const cookie = await signup('alice')
  // 渠道对外暴露 alias 与 other；倍率表只命中 alias
  const c1 = channel('openai', 0, { other: 'other' })
  setSettings({
    model_ratios: [{ id: 'alias', pattern: 'alias', input: 3, output: 4, cache_read: 5, cache_write: 6, per_request: 7 }],
  })
  // 分组倍率为 2，不应影响返回的基础价格
  createGroup({ name: 'public', is_public: true, ratio: 2, channel_ids: [c1], models: ['alias', 'other'] })

  const res = await call('/api/user/pricing', { cookie })
  assert.equal(res.json.success, true)
  assert.deepEqual(res.json.data.groups, [{ name: 'public', description: '', ratio: 2 }])
  // other 不命中倍率表，被过滤掉
  assert.deepEqual(res.json.data.models, [
    { model: 'alias', input: 3, output: 4, cache_read: 5, cache_write: 6, per_request: 7, groups: ['public'] },
  ])
})

test('/pricing 多分组时汇总能用该模型的分组', async () => {
  const cookie = await signup('alice')
  const c1 = channel('openai')
  createGroup({ name: 'a', is_public: true, channel_ids: [c1], models: ['alias'], sort: 1 })
  createGroup({ name: 'b', is_public: true, channel_ids: [c1], models: ['alias'], sort: 2 })

  const res = await call('/api/user/pricing', { cookie })
  assert.deepEqual(res.json.data.models[0].groups, ['a', 'b'])
})

test('/pricing 不显示非公开且未分配的分组', async () => {
  const cookie = await signup('alice')
  const c1 = channel('openai')
  const c2 = channel('anthropic', 1)
  createGroup({ name: 'public', is_public: true, channel_ids: [c1], models: ['alias'] })
  createGroup({ name: 'vip', is_public: false, channel_ids: [c2], models: ['alias'] })

  const before = await call('/api/user/pricing', { cookie })
  assert.deepEqual(before.json.data.groups.map((g: any) => g.name), ['public'])
  assert.deepEqual(before.json.data.models[0].groups, ['public'])

  // 分配给用户后 vip 才出现
  db.prepare('UPDATE users SET groups = ? WHERE id = ?').run(JSON.stringify(['vip']), getUserByName('alice')!.id)
  const after = await call('/api/user/pricing', { cookie })
  assert.deepEqual(after.json.data.groups.map((g: any) => g.name), ['public', 'vip'])
  assert.deepEqual(after.json.data.models[0].groups, ['public', 'vip'])
})

test('/pricing 需要登录', async () => {
  assert.equal((await call('/api/user/pricing')).status, 401)
})

test('/notices 返回 trim 后的通知与已发布公告', async () => {
  const cookie = await signup('alice')
  setSettings({ portal_notice: '  站点通知  ' })
  const now = Date.now()
  const insert = db.prepare('INSERT INTO announcements (content, extra, type, publish_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
  insert.run('较早公告', '', 'default', now - 5000, now, now)
  insert.run('最新公告', '备注', 'warning', now - 1000, now, now)
  insert.run('定时公告', '', 'default', now + 100_000, now, now)

  const res = await call('/api/user/notices', { cookie })
  assert.equal(res.json.data.notice, '站点通知')
  // 定时公告不返回，其余按发布时间倒序
  assert.deepEqual(res.json.data.announcements.map((a: any) => a.content), ['最新公告', '较早公告'])
  const latest = res.json.data.announcements[0]
  assert.deepEqual(Object.keys(latest).sort(), ['content', 'extra', 'id', 'publish_at', 'type', 'updated_at'])
  assert.equal(latest.extra, '备注')
  assert.equal(latest.type, 'warning')
})

test('/notices 关闭公告开关时 announcements 为空数组', async () => {
  const cookie = await signup('alice')
  setSettings({ portal_notice: '通知', portal_announcements_enabled: false })
  db.prepare('INSERT INTO announcements (content, extra, type, publish_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('已发布公告', '', 'default', Date.now() - 1000, Date.now(), Date.now())

  const res = await call('/api/user/notices', { cookie })
  assert.equal(res.json.data.notice, '通知')
  assert.deepEqual(res.json.data.announcements, [])
})
