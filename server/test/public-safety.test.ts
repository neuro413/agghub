import './helpers/isolated'
import test, { after, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/db'
import { sanitizePublicError } from '../src/core/failover'
import { ruleMatchesMeta } from '../src/core/preprocess'
import { handleRelay } from '../src/core/relay'
import type { ApiKey, Caller } from '../src/types'
import { FakeResponse, reset, channel, logs } from './helpers/relay'

const originalFetch = globalThis.fetch
beforeEach(reset)
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
  id: 1, name: 'k', key: 'sk-agh-x', enabled: true, groups: ['default'], models: [], rpm: null, concurrency: null,
  quota_total: null, quota_used: 0, quota_daily: null, log_bodies: null, expires_at: null, note: null, user_id: null,
  created_at: 0, updated_at: 0, last_used_at: null,
}
const caller: Caller = { surface: 'public', source: 'public_key', key, ip: '203.0.113.9' }

function runRelay() {
  const raw = { model: 'alias', stream: false, messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 }
  const res = new FakeResponse()
  return { res, run: () => handleRelay({ entryFormat: 'openai', stream: false, ir: raw, rawBody: raw, rawHeaders: {}, res: res as any, caller }) }
}

test('公网集成：上游错误脱敏返回，日志保留原文', async () => {
  channel('openai')
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'bad gateway at http://10.0.0.5:8080/v1' } }), { status: 500 })) as typeof fetch
  const { res, run } = runRelay()
  await run()
  assert.ok(!JSON.stringify(res.jsonBody).includes('10.0.0.5'))
  assert.ok(logs().at(-1).error_message.includes('10.0.0.5'))
})

test('公网集成：网络错误统一为连接失败', async () => {
  channel('openai')
  globalThis.fetch = (async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:8080') }) as typeof fetch
  const { res, run } = runRelay()
  await run()
  assert.equal(res.jsonBody.error.message, '上游连接失败')
})
