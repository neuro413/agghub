import './helpers/isolated'
import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/db'
import { handleRelay } from '../src/core/relay'
import { createGroup, validateGroupInput } from '../src/core/groups'
import { FakeResponse, channel, jsonResponse, oaiBody, reset } from './helpers/relay'
import type { ApiKey, ApiKeyRow, Caller } from '../src/types'

beforeEach(() => {
  reset()
  db.exec('DELETE FROM api_keys; DELETE FROM channel_groups')
})
after(() => db.close())

function insertKey(groups: string[]): ApiKey {
  const info = db
    .prepare(`INSERT INTO api_keys (name, key, groups, created_at, updated_at) VALUES (?, ?, ?, 0, 0)`)
    .run('分发Key', 'sk-agh-test1', JSON.stringify(groups))
  const r = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(Number(info.lastInsertRowid)) as ApiKeyRow
  return {
    id: r.id, name: r.name, key: r.key, enabled: !!r.enabled, admin_disabled: !!r.admin_disabled,
    groups: JSON.parse(r.groups) as string[], models: JSON.parse(r.models) as string[],
    rpm: r.rpm, concurrency: r.concurrency, quota_total: r.quota_total, quota_used: r.quota_used,
    quota_daily: r.quota_daily, log_bodies: r.log_bodies == null ? null : !!r.log_bodies,
    expires_at: r.expires_at, note: r.note, user_id: r.user_id,
    created_at: r.created_at, updated_at: r.updated_at, last_used_at: r.last_used_at,
  }
}

function relay(caller: Caller, rawHeaders: Record<string, any>) {
  const rawBody = { model: 'alias', stream: false, messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 }
  const res = new FakeResponse()
  return {
    res,
    run: () => handleRelay({ entryFormat: 'openai', ir: rawBody, stream: false, rawBody, rawHeaders, res: res as any, caller, admitted: true }),
  }
}

test('UA 黑名单命中：返回 403 与分组自定义提示，不请求上游', async () => {
  const key = insertKey(['default'])
  const channelId = channel('openai')
  createGroup({ name: 'default', channel_ids: [channelId], models: ['alias'], ua_blacklist: ['sillytavern'], ua_block_message: '请使用支持的客户端' })
  let calls = 0
  globalThis.fetch = (async () => { calls++; return jsonResponse(oaiBody) }) as typeof fetch
  const { res, run } = relay(
    { surface: 'public', source: 'public_key', key, ip: '203.0.113.9' },
    { 'user-agent': 'SillyTavern/1.12 (Windows)' },
  )

  await run()

  assert.equal(calls, 0)
  assert.equal(res.statusCode, 403)
  assert.equal(res.jsonBody.error.message, '请使用支持的客户端')
})

test('UA 黑名单命中且未配置提示：返回默认的「不支持的客户端」', async () => {
  const key = insertKey(['default'])
  const channelId = channel('openai')
  createGroup({ name: 'default', channel_ids: [channelId], models: ['alias'], ua_blacklist: ['curl'] })
  globalThis.fetch = (async () => jsonResponse(oaiBody)) as typeof fetch
  const { res, run } = relay(
    { surface: 'public', source: 'public_key', key, ip: '203.0.113.9' },
    { 'user-agent': 'curl/8.9.1' },
  )

  await run()

  assert.equal(res.statusCode, 403)
  assert.equal(res.jsonBody.error.message, '不支持的客户端')
})

test('UA 黑名单不区分大小写；UA 不命中或缺少 UA 时照常调用', async () => {
  const key = insertKey(['default'])
  const channelId = channel('openai')
  createGroup({ name: 'default', channel_ids: [channelId], models: ['alias'], ua_blacklist: ['CURL'] })
  let calls = 0
  globalThis.fetch = (async () => { calls++; return jsonResponse(oaiBody) }) as typeof fetch

  // 不命中：UA 里没有关键词
  const miss = relay({ surface: 'public', source: 'public_key', key, ip: '203.0.113.9' }, { 'user-agent': 'Mozilla/5.0 MyClient' })
  await miss.run()
  assert.equal(miss.res.statusCode, 200)

  // 缺少 UA 头：不做拦截（无法判断）
  const none = relay({ surface: 'public', source: 'public_key', key, ip: '203.0.113.9' }, {})
  await none.run()
  assert.equal(none.res.statusCode, 200)

  assert.equal(calls, 2)
})

test('owner 调用不受 UA 黑名单限制；黑名单为空时不拦截', async () => {
  const channelId = channel('openai')
  createGroup({ name: 'default', channel_ids: [channelId], models: ['alias'], ua_blacklist: ['curl'] })
  let calls = 0
  globalThis.fetch = (async () => { calls++; return jsonResponse(oaiBody) }) as typeof fetch
  const owner = relay({ surface: 'lan', source: 'owner', key: null, ip: '127.0.0.1' }, { 'user-agent': 'curl/8.9.1' })
  await owner.run()
  assert.equal(owner.res.statusCode, 200)
  assert.equal(calls, 1)
})

test('Key 属于多个分组：任一相关分组命中即拒绝，无关键词的分组不拦截', async () => {
  const key = insertKey(['a', 'b'])
  const channelId = channel('openai')
  createGroup({ name: 'a', channel_ids: [channelId], models: ['alias'] })
  createGroup({ name: 'b', channel_ids: [channelId], models: ['alias'], ua_blacklist: ['python'] })

  let calls = 0
  globalThis.fetch = (async () => { calls++; return jsonResponse(oaiBody) }) as typeof fetch
  const blocked = relay(
    { surface: 'public', source: 'public_key', key, ip: '203.0.113.9' },
    { 'user-agent': 'python-requests/2.31' },
  )
  await blocked.run()
  assert.equal(blocked.res.statusCode, 403)
  assert.equal(calls, 0)
})

test('分组输入校验：ua_blacklist 与 ua_block_message 的合法与非法值', () => {
  const ok = validateGroupInput({ name: 'g', ua_blacklist: [' foo ', '', 'foo'], ua_block_message: '  提示  ' }, false)
  assert.ok(ok.ok)
  assert.deepEqual(ok.value.ua_blacklist, ['foo'])
  assert.equal(ok.value.ua_block_message, '提示')

  assert.equal(validateGroupInput({ name: 'g', ua_blacklist: 'not-array' }, false).ok, false)
  assert.equal(validateGroupInput({ name: 'g', ua_blacklist: [123] }, false).ok, false)
  assert.equal(validateGroupInput({ name: 'g', ua_block_message: 'x'.repeat(501) }, false).ok, false)
})
