import './helpers/isolated'
import test, { after, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { db, getSettings, setSettings } from '../src/db'
import { createApp } from '../src/app'
import { sanitizePublicError } from '../src/core/failover'
import { ruleMatchesMeta } from '../src/core/preprocess'
import { handleRelay } from '../src/core/relay'
import { createGroup } from '../src/core/groups'
import { createKey, createUserKey } from '../src/core/keys'
import { createUser, effectivePortalKey, getUserById } from '../src/core/users'
import type { ApiKey, ApiKeyInput, Caller } from '../src/types'
import { FakeResponse, reset, channel, logs, jsonResponse, oaiBody, oaiEvents, sse } from './helpers/relay'

const originalFetch = globalThis.fetch
beforeEach(() => {
  reset()
  db.exec('DELETE FROM channel_groups')
})
afterEach(() => { globalThis.fetch = originalFetch })
after(() => db.close())

test('sanitizePublicError 按错误类型处理', () => {
  assert.equal(sanitizePublicError('network', 'connect ECONNREFUSED 10.0.0.5:8080'), '上游连接失败')
  assert.equal(sanitizePublicError('local', '没有可用渠道支持模型 x'), '没有可用渠道支持模型 x')
  const upstream = sanitizePublicError('upstream', 'see https://internal.example/path?key=abc and 10.0.0.5:8080 or fd00::1, key sk-abcdefghijklmnop')
  assert.ok(!upstream.includes('internal.example'))
  assert.ok(!upstream.includes('10.0.0.5'))
  assert.ok(!upstream.includes('fd00::1'))
  assert.ok(!upstream.includes('sk-abcdefghijklmnop'))
  assert.ok(upstream.includes('[url]') && upstream.includes('[ip]'))
  assert.equal(sanitizePublicError('upstream', 'at 12:30:45 rate limited'), 'at 12:30:45 rate limited')
  assert.equal(sanitizePublicError('upstream', '错'.repeat(400)).length, 300)
  assert.equal(sanitizePublicError('upstream', '   '), '上游返回错误')
})

const meta = (extra: Record<string, unknown> = {}) => ({ entryFormat: 'openai' as const, channelId: 1, model: 'm', ...extra })

test('ruleMatchesMeta 按来源与 Key 限定作用域', () => {
  assert.equal(ruleMatchesMeta({ sources: ['public_key'] }, meta()), false)
  assert.equal(ruleMatchesMeta({ sources: ['public_key'] }, meta({ source: 'public_key' })), true)
  assert.equal(ruleMatchesMeta({ keyIds: [3] }, meta({ keyId: 3 })), true)
  assert.equal(ruleMatchesMeta({ keyIds: [3] }, meta({ keyId: null })), false)
  assert.equal(ruleMatchesMeta({ keyIds: [3] }, meta({ keyId: 4 })), false)
  assert.equal(ruleMatchesMeta({}, meta()), true)
  assert.equal(ruleMatchesMeta({}, meta({ source: 'public_key', keyId: 3 })), true)
})

const key: ApiKey = {
  id: 1, name: 'k', key: 'sk-agh-x', enabled: true, admin_disabled: false, groups: ['default'], models: [], rpm: null, concurrency: null,
  quota_total: null, quota_used: 0, quota_daily: null, log_bodies: null, expires_at: null, note: null, user_id: null,
  created_at: 0, updated_at: 0, last_used_at: null,
}
const caller: Caller = { surface: 'public', source: 'public_key', key, ip: '203.0.113.9' }

function runRelay() {
  const raw = { model: 'alias', stream: false, messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 }
  const res = new FakeResponse()
  return { res, run: () => handleRelay({ entryFormat: 'openai', stream: false, ir: raw, rawBody: raw, rawHeaders: {}, res: res as any, caller, admitted: true }) }
}

test('公网集成：上游错误脱敏返回，日志保留原文', async () => {
  const channelId = channel('openai')
  createGroup({ name: 'default', channel_ids: [channelId], models: ['alias'] })
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'bad gateway at http://10.0.0.5:8080/v1' } }), { status: 500 })) as typeof fetch
  const { res, run } = runRelay()
  await run()
  assert.ok(!JSON.stringify(res.jsonBody).includes('10.0.0.5'))
  assert.ok(logs().at(-1).error_message.includes('10.0.0.5'))
})

test('公网集成：网络错误统一为连接失败', async () => {
  const channelId = channel('openai')
  createGroup({ name: 'default', channel_ids: [channelId], models: ['alias'] })
  globalThis.fetch = (async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:8080') }) as typeof fetch
  const { res, run } = runRelay()
  await run()
  assert.equal(res.jsonBody.error.message, '上游连接失败')
})

test('公网集成：脱敏上游报错只返回状态码，排除的状态码照常返回原文', async () => {
  setSettings({ mask_upstream_errors: true, mask_upstream_errors_exclude_codes: '400' })
  const channelId = channel('openai')
  createGroup({ name: 'default', channel_ids: [channelId], models: ['alias'] })
  let status = 503
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'upstream detail' } }), { status })) as typeof fetch
  const masked = runRelay()
  await masked.run()
  assert.equal(masked.res.statusCode, 503)
  assert.equal(masked.res.jsonBody.error.message, '503 Service Unavailable')
  assert.equal(logs().at(-1).error_message, 'upstream detail')
  assert.equal(logs().at(-1).client_error, '503 Service Unavailable')
  status = 400
  const excluded = runRelay()
  await excluded.run()
  assert.equal(excluded.res.jsonBody.error.message, 'upstream detail')
  assert.equal(logs().at(-1).client_error, null)
})

// ── 公网安全修复回归 ──

test('S1：POST /v1//chat/completions 直接 404，不进中继', async () => {
  const channelId = channel('openai')
  createGroup({ name: 'default', channel_ids: [channelId], models: ['alias'] })
  const real = createKey({ name: 'slash', groups: ['default'] } as ApiKeyInput)
  let calls = 0
  globalThis.fetch = (async () => { calls++; return jsonResponse(oaiBody) }) as typeof fetch
  const server = createApp('public').listen(0)
  await new Promise<void>(resolve => server.once('listening', resolve))
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    for (const path of ['/v1//chat/completions', '//v1/chat/completions', '/v1/chat//completions']) {
      const response = await originalFetch(base + path, {
        method: 'POST', headers: { authorization: `Bearer ${real.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'alias', messages: [{ role: 'user', content: 'hi' }] }),
      })
      assert.equal(response.status, 404, path)
    }
    assert.equal(calls, 0)
    assert.equal(logs().length, 0)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.exec('DELETE FROM api_keys')
  }
})

test('S1：带 Key 但未经准入的中继调用返回 429，不请求上游', async () => {
  const channelId = channel('openai')
  createGroup({ name: 'default', channel_ids: [channelId], models: ['alias'] })
  let calls = 0
  globalThis.fetch = (async () => { calls++; return jsonResponse(oaiBody) }) as typeof fetch
  const raw = { model: 'alias', messages: [{ role: 'user', content: 'hi' }] }
  const res = new FakeResponse()
  await handleRelay({ entryFormat: 'openai', stream: false, ir: raw, rawBody: raw, rawHeaders: {}, res: res as any, caller })
  assert.equal(res.statusCode, 429)
  assert.equal(calls, 0)
})

test('H1：超长 model 与超长上游错误都在毫秒级返回', async () => {
  const raw = { model: 'm'.repeat(1_000_000), messages: [{ role: 'user', content: 'hi' }] }
  const res = new FakeResponse()
  const started = performance.now()
  await handleRelay({ entryFormat: 'openai', stream: false, ir: raw, rawBody: raw, rawHeaders: {}, res: res as any, caller, admitted: true })
  assert.ok(performance.now() - started < 200)
  assert.equal(res.statusCode, 400)
  assert.ok(!JSON.stringify(res.jsonBody).includes('mmmm'))
  assert.equal(logs().at(-1).model.length, 256)

  const long = 'a'.repeat(10_000_000)
  const begin = performance.now()
  sanitizePublicError('upstream', long)
  assert.ok(performance.now() - begin < 100)
  // 无冒号的长十六进制串曾触发 O(n²) 回溯
  assert.equal(sanitizePublicError('upstream', 'see fe80::1 and 2001:db8::8a2e:370:7334'), 'see [ip] and [ip]')
})

test('H5：2xx 空回复不重试不换渠道，按上游 usage 或输入估算计费', async () => {
  setSettings({ single_retry_times: 2 })
  const first = channel('openai', 1)
  const second = channel('openai', 0)
  createGroup({ name: 'default', channel_ids: [first, second], models: ['alias'] })
  for (const [body, points] of [[{ choices: [], usage: { prompt_tokens: 7, completion_tokens: 0 } }, 7], [{ choices: [] }, 1]] as const) {
    db.exec('DELETE FROM request_logs')
    let calls = 0
    globalThis.fetch = (async () => { calls++; return jsonResponse(body) }) as typeof fetch
    const { res, run } = runRelay()
    await run()
    assert.equal(calls, 1)
    assert.equal(res.statusCode, 502)
    const final = logs().find(row => row.is_retry === 0)
    assert.equal(final.quota_points, points)
  }
})

test('H5/M2：换渠道前已消耗的上游 usage 累计计费', async () => {
  const first = channel('openai', 1)
  const second = channel('openai', 0)
  createGroup({ name: 'default', channel_ids: [first, second], models: ['alias'] })
  let calls = 0
  // 第一个渠道报了用量后断流（尚未向客户端输出，可换渠道），第二个渠道正常完成
  globalThis.fetch = (async () => {
    calls++
    return calls === 1 ? sse([{ choices: [], usage: { prompt_tokens: 4, completion_tokens: 0 } }]) : sse(oaiEvents())
  }) as typeof fetch
  const raw = { model: 'alias', stream: true, messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 }
  const res = new FakeResponse()
  await handleRelay({ entryFormat: 'openai', stream: true, ir: raw, rawBody: raw, rawHeaders: {}, res: res as any, caller, admitted: true })
  assert.equal(calls, 2)
  assert.ok(res.chunks.join('').includes('你好'))
  // 4（第一次）+ 2 + 3（第二次）
  assert.equal(logs().find(row => row.is_retry === 0).quota_points, 9)
})

test('H4：门户用户余额不足以覆盖预扣时拦截，在途预扣对后续请求可见', async () => {
  createGroup({ name: 'public', is_public: true, channel_ids: [channel('openai')], models: ['alias'] })
  const user = createUser({ username: 'reserve', password_hash: 'x', quota: 1, ip: '' })!
  const userKey = createUserKey(user.id, 'r', 'public', null)
  const callerOf = () => {
    const current = getUserById(user.id)!
    return { surface: 'public', source: 'user', key: effectivePortalKey(userKey, current, getSettings())!, user: current, ip: '203.0.113.9' } as Caller
  }
  const raw = { model: 'alias', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 }
  const send = (res = new FakeResponse()) => ({ res, done: handleRelay({ entryFormat: 'openai', stream: false, ir: raw, rawBody: raw, rawHeaders: {}, res: res as any, caller: callerOf(), admitted: true }) })
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  globalThis.fetch = (async () => { calls++; await gate; return jsonResponse(oaiBody) }) as typeof fetch
  try {
    // 余额 1 点：单个请求的预扣（输入 + 100 输出）就超出
    const poor = send()
    await poor.done
    assert.equal(poor.res.statusCode, 429)
    assert.equal(calls, 0)

    // 余额 150 点：第一个请求预扣约 101 点后在途，第二个并发请求看到剩余不足被拦
    db.prepare('UPDATE users SET quota = 150 WHERE id = ?').run(user.id)
    const a = send()
    await new Promise(resolve => setImmediate(resolve))
    const b = send()
    await b.done
    assert.equal(b.res.statusCode, 429)
    release()
    await a.done
    assert.equal(a.res.statusCode, 200)
    assert.equal(calls, 1)
    // 结算后预扣释放：余额 145 仍可再发一次
    const c = send()
    await c.done
    assert.equal(c.res.statusCode, 200)
  } finally {
    release()
    db.exec('DELETE FROM api_keys; DELETE FROM users')
  }
})
