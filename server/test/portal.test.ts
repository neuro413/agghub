import './helpers/isolated'
import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import { db, setSettings } from '../src/db'
import { createApp } from '../src/app'
import { localDay } from '../src/core/billing'
import { resetAuthFailures } from '../src/core/caller'
import { resetLimiter } from '../src/core/limiter'
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
  db.exec('DELETE FROM users; DELETE FROM user_sessions; DELETE FROM user_checkins; DELETE FROM api_keys; DELETE FROM usage_daily')
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
  db.prepare(`UPDATE channels SET groups = '["public"]' WHERE id = ?`).run(channel('openai'))

  const created = await call('/api/user/keys', { method: 'POST', cookie: alice, body: { name: '测试' } })
  assert.equal(created.json.success, true)
  const fullKey: string = created.json.data.full_key
  assert.ok(fullKey.startsWith('sk-agh-'))
  assert.ok(created.json.data.key.includes('**********'))
  assert.match((await call('/api/user/keys', { method: 'POST', cookie: alice, body: { name: '第二个' } })).json.message, /最多/)
  assert.equal((await call(`/api/user/keys/${created.json.data.id}/key`, { method: 'POST', cookie: bob })).json.success, false)

  const auth = { authorization: `Bearer ${fullKey}` }
  const models = await realFetch(base + '/v1/models', { headers: auth })
  assert.deepEqual(((await models.json()) as any).data.map((m: any) => m.id), ['alias'])

  const chat = (body = { model: 'alias', messages: [{ role: 'user', content: 'hi' }] }) =>
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
