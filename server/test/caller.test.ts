import './helpers/isolated'
import test from 'node:test'
import assert from 'node:assert/strict'
import { after, beforeEach } from 'node:test'
import { db, setSettings } from '../src/db'
import { createKey, generateKey, validateKeyInput } from '../src/core/keys'
import { createAdmission, createCallerResolver, resetAuthFailures } from '../src/core/caller'
import { createApp } from '../src/app'
import type { ApiKeyInput, Caller } from '../src/types'

after(() => db.close())

function fakeReq(headers: Record<string, string> = {}, url = '/v1/chat/completions') {
  return { headers, ip: '203.0.113.9', socket: { remoteAddress: '203.0.113.9' }, originalUrl: url, method: 'POST' } as any
}

function fakeRes() {
  const res: any = {
    locals: {}, statusCode: 200, headers: {}, body: undefined, headersSent: false,
    status(c: number) { this.statusCode = c; return this },
    json(b: any) { this.body = b; this.headersSent = true; return this },
    setHeader(k: string, v: string) { this.headers[k] = v },
    on() { return this },
  }
  return res
}

/** 同步执行中间件，返回是否调用了 next */
function run(handler: any, req: any, res: any): boolean {
  let nexted = false
  handler(req, res, () => { nexted = true })
  return nexted
}

const newKey = (input: Partial<ApiKeyInput> = {}) => createKey({ name: 'test', groups: ['default'], ...input } as ApiKeyInput)

beforeEach(() => {
  resetAuthFailures()
  db.exec('DELETE FROM api_keys')
  setSettings({ access_token: '' })
})

test('内网无管理令牌时不带令牌视为 owner', () => {
  const res = fakeRes()
  assert.equal(run(createCallerResolver('lan', () => ''), fakeReq(), res), true)
  const caller = res.locals.caller as Caller
  assert.equal(caller.source, 'owner')
  assert.equal(caller.surface, 'lan')
  assert.equal(caller.key, null)
})

test('内网无管理令牌时带一个不存在的令牌仍视为 owner', () => {
  const res = fakeRes()
  assert.equal(run(createCallerResolver('lan', () => ''), fakeReq({ authorization: 'Bearer placeholder' }), res), true)
  assert.equal((res.locals.caller as Caller).source, 'owner')
})

test('内网设置管理令牌后令牌错误 401、令牌正确为 owner', () => {
  const handler = createCallerResolver('lan', () => 'secret')
  const bad = fakeRes()
  assert.equal(run(handler, fakeReq({ authorization: 'Bearer wrong' }), bad), false)
  assert.equal(bad.statusCode, 401)
  const good = fakeRes()
  assert.equal(run(handler, fakeReq({ 'x-api-key': 'secret' }), good), true)
  assert.equal((good.locals.caller as Caller).source, 'owner')
})

test('内网带有效 Key 解析为 lan_key', () => {
  const key = newKey()
  const res = fakeRes()
  assert.equal(run(createCallerResolver('lan', () => ''), fakeReq({ authorization: `Bearer ${key.key}` }), res), true)
  const caller = res.locals.caller as Caller
  assert.equal(caller.source, 'lan_key')
  assert.equal(caller.key?.id, key.id)
})

test('公网端口不接受管理令牌', () => {
  const res = fakeRes()
  assert.equal(run(createCallerResolver('public', () => 'secret'), fakeReq({ authorization: 'Bearer secret' }), res), false)
  assert.equal(res.statusCode, 401)
})

test('公网带有效 Key：Bearer 与 x-api-key 均可', () => {
  const key = newKey()
  const variants: Record<string, string>[] = [{ authorization: `Bearer ${key.key}` }, { 'x-api-key': key.key }]
  for (const headers of variants) {
    const res = fakeRes()
    assert.equal(run(createCallerResolver('public', () => ''), fakeReq(headers), res), true)
    const caller = res.locals.caller as Caller
    assert.equal(caller.source, 'public_key')
    assert.equal(caller.key?.id, key.id)
  }
})

test('停用与过期的 Key 均返回 403', () => {
  const disabled = newKey({ enabled: false })
  const disabledRes = fakeRes()
  assert.equal(run(createCallerResolver('public', () => ''), fakeReq({ authorization: `Bearer ${disabled.key}` }), disabledRes), false)
  assert.equal(disabledRes.statusCode, 403)
  assert.equal(disabledRes.body.error.type, 'key_disabled')

  const expired = newKey({ expires_at: Date.now() - 1000 })
  const expiredRes = fakeRes()
  assert.equal(run(createCallerResolver('public', () => ''), fakeReq({ authorization: `Bearer ${expired.key}` }), expiredRes), false)
  assert.equal(expiredRes.statusCode, 403)
  assert.equal(expiredRes.body.error.type, 'key_expired')
})

test('公网同一 IP 连续失败 10 次后第 11 次即使带有效 Key 也 429', () => {
  const handler = createCallerResolver('public', () => '')
  for (let i = 0; i < 10; i++) {
    const res = fakeRes()
    assert.equal(run(handler, fakeReq(), res), false)
    assert.equal(res.statusCode, 401)
  }
  const key = newKey()
  const blocked = fakeRes()
  assert.equal(run(handler, fakeReq({ authorization: `Bearer ${key.key}` }), blocked), false)
  assert.equal(blocked.statusCode, 429)
  assert.ok(Number(blocked.headers['Retry-After']) >= 1)
})

test('createAdmission：owner 与带 Key 均放行', () => {
  const ownerRes = fakeRes()
  ownerRes.locals.caller = { surface: 'lan', source: 'owner', key: null, ip: '' }
  assert.equal(run(createAdmission(), fakeReq(), ownerRes), true)

  const keyRes = fakeRes()
  const key = newKey()
  keyRes.locals.caller = { surface: 'public', source: 'public_key', key, ip: '1.2.3.4' }
  assert.equal(run(createAdmission(), fakeReq(), keyRes), true)
})

test('validateKeyInput 与 generateKey', () => {
  const missingGroups = validateKeyInput({ name: 'x' }, false)
  assert.equal(missingGroups.ok, false)
  if (!missingGroups.ok) assert.match(missingGroups.error, /分组/)

  const badRpm = validateKeyInput({ name: 'x', groups: ['default'], rpm: 0 }, false)
  assert.equal(badRpm.ok, false)
  if (!badRpm.ok) assert.match(badRpm.error, /rpm/)

  const ignored = validateKeyInput({ name: 'x', groups: ['default'], id: 9, key: 'sk-x', quota_used: 3, today_points: 1 }, false)
  assert.equal(ignored.ok, true)
  if (ignored.ok) assert.deepEqual(Object.keys(ignored.value).sort(), ['groups', 'name'])

  const generated = generateKey()
  assert.ok(generated.startsWith('sk-agh-'))
  assert.equal(generated.length, 47)
})

test('公网 app：鉴权、CORS 与 404', async () => {
  const server = createApp('public').listen(0)
  await new Promise<void>(resolve => server.once('listening', resolve))
  const port = (server.address() as { port: number }).port
  const base = `http://127.0.0.1:${port}`
  try {
    const chat = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(chat.status, 401)
    assert.equal((await chat.json() as any).error.type, 'invalid_api_key')

    const messages = await fetch(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(messages.status, 401)
    const anthropicBody = await messages.json() as any
    assert.equal(anthropicBody.type, 'error')
    assert.equal(anthropicBody.error.type, 'authentication_error')

    const options = await fetch(base + '/v1/chat/completions', { method: 'OPTIONS' })
    assert.equal(options.status, 204)
    assert.equal(options.headers.get('access-control-allow-origin'), '*')

    const health = await fetch(base + '/api/health')
    assert.equal(health.status, 404)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
