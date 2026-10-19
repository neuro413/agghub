import './helpers/isolated'
import test, { after, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/db'
import { createGroup } from '../src/core/groups'
import { availabilityView, CELL_COUNT, CELL_MS, probeIdleModels, probeModel } from '../src/core/availability'
import { channel, jsonResponse, logs, oaiBody, reset } from './helpers/relay'

const originalFetch = globalThis.fetch
let fetches = 0
beforeEach(() => {
  reset()
  db.exec('DELETE FROM channel_groups; DELETE FROM usage_daily; DELETE FROM users')
  fetches = 0
  globalThis.fetch = (async () => { fetches++; return jsonResponse(oaiBody) }) as typeof fetch
})
afterEach(() => { globalThis.fetch = originalFetch })
after(() => db.close())

function insertLog(row: { created_at: number; channel_id: number | null; status: 'success' | 'error'; status_code: number; source?: string; is_retry?: number; model?: string }) {
  db.prepare(`INSERT INTO request_logs (created_at, channel_id, model, status, status_code, source, is_retry)
    VALUES (@created_at, @channel_id, @model, @status, @status_code, @source, @is_retry)`)
    .run({ source: 'owner', is_retry: 0, model: 'alias', ...row })
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(check(), '等待超时')
}

test('测活只走分组允许的渠道，记为测活来源且不记账', async () => {
  channel('openai', 10)
  const publicId = channel('openai', 0)
  createGroup({ name: 'public', is_public: true, channel_ids: [publicId], models: ['alias'] })

  await probeModel('alias', ['public'])

  const [row] = logs()
  assert.equal(row.source, 'probe')
  assert.equal(row.status, 'success')
  assert.equal(row.channel_id, publicId)
  assert.equal(row.group_name, 'public')
  assert.equal(row.key_id, null)
  assert.equal(db.prepare('SELECT COUNT(*) FROM usage_daily').pluck().get(), 0)
})

test('可用性只统计本组渠道的结果，排除调用方原因的失败', () => {
  const privateId = channel('openai', 10)
  const publicId = channel('openai', 0)
  const group = createGroup({ name: 'public', is_public: true, channel_ids: [publicId], models: ['alias'] })!
  const now = Date.now()
  const cell = Math.floor(now / CELL_MS) * CELL_MS
  insertLog({ created_at: cell, channel_id: publicId, status: 'success', status_code: 200 })
  insertLog({ created_at: cell, channel_id: publicId, status: 'error', status_code: 502 })
  insertLog({ created_at: cell, channel_id: null, status: 'error', status_code: 503 })
  insertLog({ created_at: cell, channel_id: publicId, status: 'error', status_code: 400, source: 'probe' })
  // 不计入：客户端断开、请求参数错误、本地拒绝、其他渠道、中间重试、窗口之外
  insertLog({ created_at: cell, channel_id: publicId, status: 'error', status_code: 499 })
  insertLog({ created_at: cell, channel_id: publicId, status: 'error', status_code: 400 })
  insertLog({ created_at: cell, channel_id: null, status: 'error', status_code: 429, source: 'user' })
  insertLog({ created_at: cell, channel_id: privateId, status: 'success', status_code: 200 })
  insertLog({ created_at: cell, channel_id: publicId, status: 'error', status_code: 502, is_retry: 1 })
  insertLog({ created_at: cell - CELL_COUNT * CELL_MS, channel_id: publicId, status: 'error', status_code: 502 })
  insertLog({ created_at: cell - CELL_MS, channel_id: publicId, status: 'success', status_code: 200 })

  const view = availabilityView([group], now)
  assert.equal(view.start, cell - (CELL_COUNT - 1) * CELL_MS)
  assert.deepEqual(view.models.map(m => m.model), ['alias'])
  const cells = view.models[0].cells
  assert.equal(cells.length, CELL_COUNT)
  assert.deepEqual(cells[CELL_COUNT - 1], { total: 4, errors: 3, probes: 1 })
  assert.deepEqual(cells[CELL_COUNT - 2], { total: 1, errors: 0, probes: 0 })
  assert.equal(cells.slice(0, CELL_COUNT - 2).reduce((s, c) => s + c.total, 0), 0)

  // 熔断停用的渠道照样显示，手动停用的不显示
  db.prepare('UPDATE channels SET status = 2 WHERE id = ?').run(publicId)
  assert.equal(availabilityView([group], now).models.length, 1)
  db.prepare('UPDATE channels SET status = 0 WHERE id = ?').run(publicId)
  assert.equal(availabilityView([group], now).models.length, 0)
})

test('10 分钟内没有结果的模型自动测活，只测门户用户看得到的分组', async () => {
  const publicId = channel('openai', 0)
  const vipId = channel('openai', 0)
  db.prepare(`UPDATE channels SET models = '["vip-model"]' WHERE id = ?`).run(vipId)
  createGroup({ name: 'public', is_public: true, channel_ids: [publicId], models: ['alias'] })
  createGroup({ name: 'vip', channel_ids: [vipId], models: ['vip-model'] })
  const now = Date.now()
  insertLog({ created_at: now, channel_id: publicId, status: 'success', status_code: 200 })

  // alias 刚有人调用过，vip 分组没分配给任何用户
  probeIdleModels(now)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(fetches, 0)

  db.prepare(`INSERT INTO users (username, password_hash, created_at, groups) VALUES ('tester', '', 0, '["vip"]')`).run()
  probeIdleModels(now)
  probeIdleModels(now)
  await waitFor(() => logs().some(row => row.source === 'probe'))
  assert.equal(fetches, 1)
  const probe = logs().find(row => row.source === 'probe')!
  assert.equal(probe.model, 'vip-model')
  assert.equal(probe.channel_id, vipId)

  // 10 分钟后两个模型都已空闲
  probeIdleModels(now + CELL_MS + 5000)
  await waitFor(() => logs().filter(row => row.source === 'probe').length === 3)
  assert.equal(fetches, 3)
})
