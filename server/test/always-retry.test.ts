import './helpers/isolated'
import test, { after, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { db, getChannelById, setSettings } from '../src/db'
import { channelsRouter } from '../src/routes/channels'
import { LocalRequestError, UpstreamError, UpstreamResponseError, shouldRetry } from '../src/core/failover'
import { reset, channel, relay, logs, jsonResponse, oaiBody } from './helpers/relay'

const originalFetch = globalThis.fetch
beforeEach(() => { reset(); db.exec('DELETE FROM channel_key_states') })
afterEach(() => { globalThis.fetch = originalFetch })
after(() => db.close())

const keyOf = (options: any) => String(options.headers.authorization).replace('Bearer ', '')
const forbidden = () => jsonResponse({ error: { message: 'rate limited' } }, 403)

/** 高优先级主渠道 + 低优先级备用渠道，用 key 区分请求打到哪个渠道 */
function pair(alwaysRetry: boolean): number {
  const primary = channel('openai', 10, {}, 'primary')
  channel('openai', 0, {}, 'backup')
  db.prepare('UPDATE channels SET always_retry = ? WHERE id = ?').run(alwaysRetry ? 1 : 0, primary)
  return primary
}

test('shouldRetry：一律重试时上游任何 HTTP 错误都重试，本地错误与 2xx 后的处理失败仍不重试', () => {
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(shouldRetry(new UpstreamError(status, '')), false, String(status))
    assert.equal(shouldRetry(new UpstreamError(status, ''), true), true, String(status))
  }
  assert.equal(shouldRetry(new UpstreamResponseError('bad json'), true), false)
  assert.equal(shouldRetry(new LocalRequestError('bad input'), true), false)
})

test('未开启：403 命中默认熔断状态码，立即停用渠道并换到备用渠道', async () => {
  const primary = pair(false)
  setSettings({ single_retry_times: 2 })
  const calls: string[] = []
  globalThis.fetch = (async (_url: any, options: any) => {
    calls.push(keyOf(options))
    return keyOf(options) === 'primary' ? forbidden() : jsonResponse(oaiBody)
  }) as typeof fetch
  const request = relay('openai', false)
  await request.run()
  assert.equal(request.res.statusCode, 200)
  assert.deepEqual(calls, ['primary', 'backup'])
  assert.equal(getChannelById(primary)!.status, 2)
})

test('开启：403 在本渠道重试直至成功，不换渠道也不熔断', async () => {
  const primary = pair(true)
  setSettings({ single_retry_times: 2 })
  const calls: string[] = []
  globalThis.fetch = (async (_url: any, options: any) => {
    calls.push(keyOf(options))
    return calls.length < 3 ? forbidden() : jsonResponse(oaiBody)
  }) as typeof fetch
  const request = relay('openai', false)
  await request.run()
  assert.equal(request.res.statusCode, 200)
  assert.deepEqual(calls, ['primary', 'primary', 'primary'])
  assert.equal(getChannelById(primary)!.status, 1)
  assert.deepEqual(logs().map(row => [row.is_retry, row.status_code]), [[1, 403], [1, 403], [0, 200]])
})

test('开启：同渠道重试次数用完后才换渠道，主渠道保持启用', async () => {
  const primary = pair(true)
  setSettings({ single_retry_times: 1 })
  const calls: string[] = []
  globalThis.fetch = (async (_url: any, options: any) => {
    calls.push(keyOf(options))
    return keyOf(options) === 'primary' ? jsonResponse({ error: { message: 'invalid key' } }, 401) : jsonResponse(oaiBody)
  }) as typeof fetch
  const request = relay('openai', false)
  await request.run()
  assert.equal(request.res.statusCode, 200)
  assert.deepEqual(calls, ['primary', 'primary', 'backup'])
  assert.equal(getChannelById(primary)!.status, 1)
})

test('开启：多 key 轮询下 403 不熔断 key，在本渠道重试', async () => {
  const id = channel('openai', 0, {}, 'k1\nk2')
  db.prepare("UPDATE channels SET key_mode = 'poll', always_retry = 1 WHERE id = ?").run(id)
  setSettings({ single_retry_times: 1 })
  const calls: string[] = []
  globalThis.fetch = (async (_url: any, options: any) => {
    calls.push(keyOf(options))
    return calls.length === 1 ? forbidden() : jsonResponse(oaiBody)
  }) as typeof fetch
  const request = relay('openai', false)
  await request.run()
  assert.equal(request.res.statusCode, 200)
  assert.deepEqual(calls, ['k1', 'k1'])
  assert.equal((db.prepare('SELECT COUNT(*) FROM channel_key_states WHERE channel_id = ?').pluck().get(id) as number), 0)
})

test('渠道接口保存、保留并关闭一律重试', async () => {
  const app = express(); app.use(express.json()); app.use('/channels', channelsRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/channels`
  const call = (path: string, method: string, body: any) =>
    originalFetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    const plain = await (await call('', 'POST', { name: 'plain', type: 'openai', models: ['m'] })).json() as any
    assert.equal(plain.always_retry, false)

    const created = await (await call('', 'POST', { name: 'x', type: 'openai', models: ['m'], always_retry: true })).json() as any
    assert.equal(created.always_retry, true)

    // 只改其他字段时保留原设置
    await call(`/${created.id}`, 'PUT', { name: 'y' })
    assert.equal(getChannelById(created.id)!.always_retry, true)

    const updated = await (await call(`/${created.id}`, 'PUT', { always_retry: false })).json() as any
    assert.equal(updated.always_retry, false)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
