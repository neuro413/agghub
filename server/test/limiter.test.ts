import './helpers/isolated'
import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { admitRequest, resetLimiter } from '../src/core/limiter'
import type { ApiKey } from '../src/types'

// 每个测试前清空内存计数
beforeEach(resetLimiter)

function key(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 1, name: 'k', key: 'sk-agh-test1', enabled: true, admin_disabled: false, groups: ['default'], models: [],
    rpm: null, concurrency: null, quota_total: null, quota_used: 0, quota_daily: null,
    log_bodies: null, expires_at: null, note: null, user_id: null,
    created_at: 0, updated_at: 0, last_used_at: null,
    ...overrides,
  }
}

test('RPM 滑动窗口：超出拒绝并给出 Retry-After，窗口滑过后放行', () => {
  const k = key({ rpm: 2 })
  const now = 1_000_000
  assert.equal(admitRequest(k, now).ok, true)
  assert.equal(admitRequest(k, now + 1).ok, true)
  const third = admitRequest(k, now + 2)
  assert.equal(third.ok, false)
  if (third.ok) throw new Error('应当拒绝')
  assert.equal(third.reason, 'rpm')
  assert.ok(third.retryAfterSeconds >= 1 && third.retryAfterSeconds <= 60)
  // 最早一条（now）过期后即可再放行
  assert.equal(admitRequest(k, now + 60_001).ok, true)
})

test('并发上限：超出拒绝；release 后可再进；重复 release 不会把计数减成负数', () => {
  const k = key({ concurrency: 1 })
  const now = 2_000_000
  const first = admitRequest(k, now)
  assert.equal(first.ok, true)
  if (!first.ok) throw new Error('应当放行')
  assert.equal(admitRequest(k, now).ok, false)

  first.release()
  first.release() // 重复释放无副作用

  const second = admitRequest(k, now)
  assert.equal(second.ok, true)
  if (!second.ok) throw new Error('释放后应当放行')
  // 计数只回到 1（没有减成负数），因此再进一个会被拒绝
  assert.equal(admitRequest(k, now).ok, false)
  second.release()
})

test('rpm 与 concurrency 都为 null 时总是放行', () => {
  const k = key()
  const now = 3_000_000
  for (let i = 0; i < 100; i++) {
    const result = admitRequest(k, now + i)
    assert.equal(result.ok, true)
  }
})
