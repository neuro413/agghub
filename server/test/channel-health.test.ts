import './helpers/isolated'
import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/db'
import { onBanSignal, onAttemptSuccess, recoverChannels, resetChannelHealth } from '../src/core/channelHealth'
import { reset, channel } from './helpers/relay'

beforeEach(reset)
after(() => db.close())

const row = (id: number) => db.prepare('SELECT status, ban_until FROM channels WHERE id = ?').get(id) as { status: number; ban_until: number | null }

test('阈值 3：前两次不停用，第三次停用', () => {
  const id = channel('openai')
  resetChannelHealth(id)
  const settings = { auto_ban_threshold: 3, auto_ban_cooldown_minutes: 0 }
  assert.equal(onBanSignal(id, settings), false)
  assert.equal(row(id).status, 1)
  assert.equal(onBanSignal(id, settings), false)
  assert.equal(row(id).status, 1)
  assert.equal(onBanSignal(id, settings), true)
  assert.equal(row(id).status, 2)
  assert.equal(row(id).ban_until, null)
})

test('冷却到期自动恢复', () => {
  const id = channel('openai')
  resetChannelHealth(id)
  const now = Date.now()
  assert.equal(onBanSignal(id, { auto_ban_threshold: 1, auto_ban_cooldown_minutes: 30 }, now), true)
  assert.equal(row(id).ban_until, now + 1_800_000)
  assert.equal(recoverChannels(now + 1_799_999), 0)
  assert.equal(recoverChannels(now + 1_800_000), 1)
  assert.equal(row(id).status, 1)
  assert.equal(row(id).ban_until, null)
})

test('半开渠道再命中一次立即停用', () => {
  const id = channel('openai')
  resetChannelHealth(id)
  onBanSignal(id, { auto_ban_threshold: 1, auto_ban_cooldown_minutes: 30 })
  assert.equal(recoverChannels(Date.now() + 1_800_000), 1)
  assert.equal(onBanSignal(id, { auto_ban_threshold: 3, auto_ban_cooldown_minutes: 0 }), true)
  assert.equal(row(id).status, 2)
})

test('成功清零连续失败计数', () => {
  const id = channel('openai')
  resetChannelHealth(id)
  const settings = { auto_ban_threshold: 3, auto_ban_cooldown_minutes: 0 }
  assert.equal(onBanSignal(id, settings), false)
  assert.equal(onBanSignal(id, settings), false)
  onAttemptSuccess(id)
  assert.equal(onBanSignal(id, settings), false)
  assert.equal(onBanSignal(id, settings), false)
  assert.equal(row(id).status, 1)
})

test('resetChannelHealth 清除半开标记', () => {
  const id = channel('openai')
  resetChannelHealth(id)
  onBanSignal(id, { auto_ban_threshold: 1, auto_ban_cooldown_minutes: 30 })
  assert.equal(recoverChannels(Date.now() + 1_800_000), 1)
  resetChannelHealth(id)
  assert.equal(onBanSignal(id, { auto_ban_threshold: 3, auto_ban_cooldown_minutes: 0 }), false)
  assert.equal(row(id).status, 1)
})
