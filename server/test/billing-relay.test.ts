import './helpers/isolated'
import test, { after, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/db'
import { handleRelay } from '../src/core/relay'
import { localDay } from '../src/core/billing'
import { FakeResponse, channel, jsonResponse, logs, oaiBody, reset } from './helpers/relay'
import type { ApiKey, ApiKeyRow, Caller } from '../src/types'

const originalFetch = globalThis.fetch
beforeEach(() => {
  reset()
  db.exec('DELETE FROM api_keys; DELETE FROM usage_daily')
})
afterEach(() => { globalThis.fetch = originalFetch })
after(() => db.close())

function insertKey(models: string[] = []): ApiKey {
  const info = db
    .prepare(`INSERT INTO api_keys (name, key, groups, models, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)`)
    .run('分发Key', 'sk-agh-test1', '["default"]', JSON.stringify(models))
  const r = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(Number(info.lastInsertRowid)) as ApiKeyRow
  return {
    id: r.id, name: r.name, key: r.key, enabled: !!r.enabled,
    groups: JSON.parse(r.groups) as string[], models: JSON.parse(r.models) as string[],
    rpm: r.rpm, concurrency: r.concurrency, quota_total: r.quota_total, quota_used: r.quota_used,
    quota_daily: r.quota_daily, log_bodies: r.log_bodies == null ? null : !!r.log_bodies,
    expires_at: r.expires_at, note: r.note, user_id: r.user_id,
    created_at: r.created_at, updated_at: r.updated_at, last_used_at: r.last_used_at,
  }
}

function getUsage(keyId: number) {
  return db
    .prepare('SELECT requests, points FROM usage_daily WHERE account_type = ? AND account_id = ? AND day = ?')
    .get('key', keyId, localDay(Date.now())) as { requests: number; points: number } | undefined
}

test('Key 调用成功：点数写入日志、扣减额度并记入 usage_daily', async () => {
  const key = insertKey()
  channel('openai')
  globalThis.fetch = (async () => jsonResponse(oaiBody)) as typeof fetch
  const rawBody = { model: 'alias', stream: false, messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 }
  const res = new FakeResponse()
  const caller: Caller = { surface: 'lan', source: 'lan_key', key, ip: '127.0.0.1' }

  await handleRelay({ entryFormat: 'openai', ir: rawBody, stream: false, rawBody, rawHeaders: {}, res: res as any, caller })

  assert.equal(res.statusCode, 200)
  const final = logs().find(row => row.is_retry === 0)!
  // 默认倍率表 * 全 1：prompt 2 + completion 3 = 5
  assert.equal(final.quota_points, 5)
  assert.equal(final.key_id, key.id)
  assert.equal(final.source, 'lan_key')
  assert.equal(final.client_ip, '127.0.0.1')
  assert.equal((db.prepare('SELECT quota_used FROM api_keys WHERE id = ?').get(key.id) as { quota_used: number }).quota_used, 5)
  const usage = getUsage(key.id)!
  assert.equal(usage.requests, 1)
  assert.equal(usage.points, 5)
})

test('Key 白名单不允许的模型：返回 503，不增加点数（requests 仍 +1）', async () => {
  const key = insertKey(['other-model'])
  channel('openai')
  let calls = 0
  globalThis.fetch = (async () => { calls++; return jsonResponse(oaiBody) }) as typeof fetch
  const rawBody = { model: 'alias', stream: false, messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 }
  const res = new FakeResponse()
  const caller: Caller = { surface: 'lan', source: 'lan_key', key, ip: '127.0.0.1' }

  await handleRelay({ entryFormat: 'openai', ir: rawBody, stream: false, rawBody, rawHeaders: {}, res: res as any, caller })

  assert.equal(calls, 0)
  assert.equal(res.statusCode, 503)
  assert.equal((db.prepare('SELECT quota_used FROM api_keys WHERE id = ?').get(key.id) as { quota_used: number }).quota_used, 0)
  const usage = getUsage(key.id)!
  assert.equal(usage.requests, 1)
  assert.equal(usage.points, 0)
})
