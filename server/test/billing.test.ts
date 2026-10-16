import './helpers/isolated'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/db'
import { OutputMeter, commitUsage, computePoints, findRatio, localDay, precheckQuota, settleRequest } from '../src/core/billing'
import type { ApiKey, ApiKeyRow, Caller, ModelRatio } from '../src/types'

after(() => db.close())

const R = (pattern: string): ModelRatio => ({ id: pattern, pattern, input: 1, output: 1, cache_read: 1, cache_write: 1, per_request: 0 })

function clearBilling(): void {
  db.exec('DELETE FROM api_keys; DELETE FROM usage_daily; DELETE FROM request_logs')
}

let keySeq = 0
function insertKey(opts: { quota_total?: number | null; quota_daily?: number | null } = {}): ApiKey {
  const info = db
    .prepare(`INSERT INTO api_keys (name, key, groups, quota_total, quota_daily, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0)`)
    .run('k', `sk-agh-test${++keySeq}`, '["default"]', opts.quota_total ?? null, opts.quota_daily ?? null)
  return apiKeyById(Number(info.lastInsertRowid))
}

function apiKeyById(id: number): ApiKey {
  const r = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as ApiKeyRow
  return {
    id: r.id,
    name: r.name,
    key: r.key,
    enabled: !!r.enabled,
    admin_disabled: !!r.admin_disabled,
    groups: JSON.parse(r.groups) as string[],
    models: JSON.parse(r.models) as string[],
    rpm: r.rpm,
    concurrency: r.concurrency,
    quota_total: r.quota_total,
    quota_used: r.quota_used,
    quota_daily: r.quota_daily,
    log_bodies: r.log_bodies == null ? null : !!r.log_bodies,
    expires_at: r.expires_at,
    note: r.note,
    user_id: r.user_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
    last_used_at: r.last_used_at,
  }
}

test('findRatio: 精确 > 更长通配 > 短通配 > 兜底，具体度相同取靠前，无命中返回 null', () => {
  const ratios = ['*', 'claude-*', 'claude-opus-*', 'claude-opus-4-5'].map(R)
  assert.equal(findRatio(ratios, 'claude-opus-4-5')?.pattern, 'claude-opus-4-5')
  assert.equal(findRatio(ratios, 'claude-opus-4-1')?.pattern, 'claude-opus-*')
  assert.equal(findRatio(ratios, 'claude-sonnet-4')?.pattern, 'claude-*')
  assert.equal(findRatio(ratios, 'gpt-5')?.pattern, '*')
  assert.equal(findRatio(ratios.filter(r => r.pattern !== '*'), 'gpt-5'), null)
  // 具体度相同时保留列表中靠前的一条
  assert.equal(findRatio([R('claude-*'), R('claude-*')], 'claude-x')?.id, 'claude-*')
})

test('computePoints: 缓存拆分、per_request 仅在 produced 时计入、浮点先舍后进', () => {
  const ratio: ModelRatio = { id: 'r', pattern: '*', input: 5, output: 25, cache_read: 0.5, cache_write: 6.25, per_request: 0 }
  // 200×5 + 800×0.5 + 200×25 = 6400
  assert.equal(computePoints(ratio, { prompt_tokens: 1000, completion_tokens: 200, cache_read_tokens: 800, cache_write_tokens: 0 }, true), 6400)

  const perReq: ModelRatio = { id: 'p', pattern: '*', input: 1, output: 1, cache_read: 1, cache_write: 1, per_request: 10 }
  const zero = { prompt_tokens: 0, completion_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }
  assert.equal(computePoints(perReq, zero, false), 0)
  assert.equal(computePoints(perReq, zero, true), 10)

  // 缓存读写之和大于 prompt 时未缓存输入按 0
  assert.equal(computePoints(ratio, { prompt_tokens: 50, completion_tokens: 0, cache_read_tokens: 100, cache_write_tokens: 100 }, true), Math.ceil(100 * 0.5 + 100 * 6.25))

  // 0.1 倍率 × 3 Token = 0.3 → 向上取整 1
  const tiny: ModelRatio = { id: 't', pattern: '*', input: 0.1, output: 0, cache_read: 0, cache_write: 0, per_request: 0 }
  assert.equal(computePoints(tiny, { prompt_tokens: 3, completion_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }, true), 1)
})

test('commitUsage: 累加 quota_used 并 upsert usage_daily（requests +1）', () => {
  clearBilling()
  const key = insertKey()
  commitUsage({ type: 'key', id: key.id }, { points: 5, prompt_tokens: 100, completion_tokens: 20 })
  commitUsage({ type: 'key', id: key.id }, { points: 3, prompt_tokens: 50, completion_tokens: 10 })
  const row = db.prepare('SELECT quota_used, last_used_at FROM api_keys WHERE id = ?').get(key.id) as { quota_used: number; last_used_at: number }
  assert.equal(row.quota_used, 8)
  assert.ok(row.last_used_at > 0)
  const daily = db
    .prepare('SELECT requests, points, prompt_tokens, completion_tokens FROM usage_daily WHERE account_type = ? AND account_id = ? AND day = ?')
    .get('key', key.id, localDay(Date.now())) as { requests: number; points: number; prompt_tokens: number; completion_tokens: number }
  assert.equal(daily.requests, 2)
  assert.equal(daily.points, 8)
  assert.equal(daily.prompt_tokens, 150)
  assert.equal(daily.completion_tokens, 30)
})

test('precheckQuota: 总额度用尽、今日额度用尽、跨天恢复', () => {
  clearBilling()
  const now = Date.now()

  const totalKey = insertKey({ quota_total: 10 })
  assert.deepEqual(precheckQuota(totalKey, now), { ok: true })
  commitUsage({ type: 'key', id: totalKey.id }, { points: 10, prompt_tokens: 0, completion_tokens: 0 }, now)
  assert.deepEqual(precheckQuota(apiKeyById(totalKey.id), now), { ok: false, reason: 'total' })

  const dailyKey = insertKey({ quota_daily: 5 })
  assert.deepEqual(precheckQuota(dailyKey, now), { ok: true })
  commitUsage({ type: 'key', id: dailyKey.id }, { points: 5, prompt_tokens: 0, completion_tokens: 0 }, now)
  assert.deepEqual(precheckQuota(apiKeyById(dailyKey.id), now), { ok: false, reason: 'daily' })
  // 第二天是新的一行，用量归零
  assert.deepEqual(precheckQuota(apiKeyById(dailyKey.id), now + 86_400_000), { ok: true })
})

test('settleRequest: usage 全 0 时按计量器估算，owner 只记份额不写 usage_daily，model 为空返回 null', () => {
  clearBilling()
  const ratios = [R('*')]
  const key = insertKey()
  const keyCaller: Caller = { surface: 'lan', source: 'lan_key', key, ip: '127.0.0.1' }

  // 失败 + usage 全 0 + meter 里有文本：输出按 meter 估算（2 个 CJK），输入用 estimatePrompt 估算 3
  const meter = new OutputMeter()
  meter.append('你好')
  const billed = settleRequest({
    caller: keyCaller, model: 'alias', ratios,
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    meter, success: false, estimatePrompt: () => 3,
  })
  assert.equal(billed, 5)
  assert.equal((db.prepare('SELECT quota_used FROM api_keys WHERE id = ?').get(key.id) as { quota_used: number }).quota_used, 5)

  // owner：返回点数但不新增 usage_daily 行
  const before = (db.prepare('SELECT COUNT(*) AS n FROM usage_daily').get() as { n: number }).n
  const ownerCaller: Caller = { surface: 'lan', source: 'owner', key: null, ip: '' }
  const ownerPoints = settleRequest({
    caller: ownerCaller, model: 'alias', ratios,
    usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
    meter: null, success: true, estimatePrompt: () => 0,
  })
  assert.equal(ownerPoints, 5)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM usage_daily').get() as { n: number }).n, before)

  // model 为 null（未命中倍率）返回 null
  assert.equal(settleRequest({
    caller: ownerCaller, model: null, ratios,
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    meter: null, success: true, estimatePrompt: () => 0,
  }), null)
})
