import './helpers/isolated'
import test, { after, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { db, setSettings } from '../src/db'
import { keyFingerprint } from '../src/core/channelKeys'
import { reset, channel, relay, logs, jsonResponse, oaiBody, sse, oaiEvents } from './helpers/relay'

const originalFetch = globalThis.fetch
beforeEach(() => { reset(); db.exec('DELETE FROM channel_key_states') })
afterEach(() => { globalThis.fetch = originalFetch })
after(() => db.close())

function multiKeyChannel(mode: 'poll' | 'race', keys: string[], extra: Record<string, number> = {}): number {
  const id = channel('openai', 0, {}, keys.join('\n'))
  db.prepare('UPDATE channels SET key_mode = ?, key_concurrency = ? WHERE id = ?').run(mode, keys.length, id)
  for (const [column, value] of Object.entries(extra)) db.prepare(`UPDATE channels SET ${column} = ? WHERE id = ?`).run(value, id)
  return id
}

const keyOf = (options: any) => String(options.headers.authorization).replace('Bearer ', '')
const slowBody = { ...oaiBody, choices: [{ index: 0, message: { role: 'assistant', content: 'slow' }, finish_reason: 'stop' }] }
const limited = () => jsonResponse({ error: { message: 'rate limited' } }, 429)
const keyStates = (id: number) => db.prepare('SELECT * FROM channel_key_states WHERE channel_id = ?').all(id) as any[]

test('轮询：401 熔断当前 key 并立即换下一个，下次请求直接跳过已熔断的 key', async () => {
  const id = multiKeyChannel('poll', ['k1', 'k2'])
  const calls: string[] = []
  globalThis.fetch = (async (_url: any, options: any) => {
    const key = keyOf(options)
    calls.push(key)
    return key === 'k1' ? jsonResponse({ error: { message: 'invalid key' } }, 401) : jsonResponse(oaiBody)
  }) as typeof fetch
  const first = relay('openai', false)
  await first.run()
  assert.equal(first.res.statusCode, 200)
  assert.deepEqual(calls, ['k1', 'k2'])
  const state = db.prepare('SELECT * FROM channel_key_states WHERE channel_id = ?').all(id) as any[]
  assert.equal(state.length, 1)
  assert.equal(state[0].fingerprint, keyFingerprint('k1'))
  assert.equal(state[0].status_code, 401)
  assert.equal(state[0].until, null)
  assert.deepEqual(logs().map(row => [row.is_retry, row.channel_key]), [[1, '#1 k1…'], [0, '#2 k2…']])

  calls.length = 0
  await relay('openai', false).run()
  assert.deepEqual(calls, ['k2'])
})

test('并发流式：先出内容的 key 胜出，其余请求被中断且不记日志', async () => {
  multiKeyChannel('race', ['k1', 'k2'])
  const signals: Record<string, AbortSignal> = {}
  globalThis.fetch = (async (_url: any, options: any) => {
    const key = keyOf(options)
    signals[key] = options.signal
    if (key === 'k2') return sse(oaiEvents())
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => { try { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(oaiEvents()[0])}\n\n`)) } catch {} }, 200)
      },
    }), { headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  const request = relay('openai', true)
  await request.run()
  assert.ok(request.res.chunks.join('').includes('你好'))
  assert.equal(signals.k1.aborted, true)
  assert.deepEqual(logs().map(row => [row.is_retry, row.status, row.channel_key]), [[0, 'success', '#2 k2…']])
})

test('并发非流式：先完整返回的 key 胜出，较慢的请求被中断', async () => {
  multiKeyChannel('race', ['k1', 'k2'])
  const signals: Record<string, AbortSignal> = {}
  globalThis.fetch = (async (_url: any, options: any) => {
    const key = keyOf(options)
    signals[key] = options.signal
    if (key === 'k2') return jsonResponse(oaiBody)
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(jsonResponse(slowBody)), 200)
      options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal.reason) })
    })
  }) as typeof fetch
  const request = relay('openai', false)
  await request.run()
  assert.equal(request.res.jsonBody.choices[0].message.content, '你好🙂')
  assert.equal(signals.k1.aborted, true)
  assert.deepEqual(logs().map(row => [row.is_retry, row.channel_key]), [[0, '#2 k2…']])
})

test('轮询限流次数：未达次数时用同一个 key 重试且不消耗同渠道重试次数，连续达到后冷却并换下一个 key', async () => {
  const id = multiKeyChannel('poll', ['a1', 'a2'], { key_limit_threshold: 3 })
  const calls: string[] = []
  globalThis.fetch = (async (_url: any, options: any) => {
    const key = keyOf(options)
    calls.push(key)
    return key === 'a1' ? limited() : jsonResponse(oaiBody)
  }) as typeof fetch
  const request = relay('openai', false)
  await request.run()
  assert.equal(request.res.statusCode, 200)
  assert.deepEqual(calls, ['a1', 'a1', 'a1', 'a2'])
  const state = keyStates(id)
  assert.deepEqual(state.map(row => [row.fingerprint, row.status_code]), [[keyFingerprint('a1'), 429]])
  assert.ok(state[0].until > Date.now())
  assert.deepEqual(logs().map(row => [row.is_retry, row.channel_key]), [[1, '#1 a1…'], [1, '#1 a1…'], [1, '#1 a1…'], [0, '#2 a2…']])
})

test('轮询限流次数：key 成功一次即清零连续计数', async () => {
  const id = multiKeyChannel('poll', ['b1', 'b2'], { key_limit_threshold: 2 })
  const calls: string[] = []
  // 每个请求先 429 一次，重试时成功；计数不清零的话第二个请求会冷却 b1 并换到 b2
  globalThis.fetch = (async (_url: any, options: any) => {
    calls.push(keyOf(options))
    return calls.length % 2 ? limited() : jsonResponse(oaiBody)
  }) as typeof fetch
  for (let i = 0; i < 2; i++) {
    const request = relay('openai', false)
    await request.run()
    assert.equal(request.res.statusCode, 200)
  }
  assert.deepEqual(calls, ['b1', 'b1', 'b1', 'b1'])
  assert.equal(keyStates(id).length, 0)
})

test('单 key 竞速：同一个 key 同时发起多路请求，最先返回的胜出，其余请求被中断', async () => {
  multiKeyChannel('race', ['c1'], { key_race_single: 1, key_concurrency: 3 })
  const keys: string[] = []
  const signals: AbortSignal[] = []
  globalThis.fetch = (async (_url: any, options: any) => {
    keys.push(keyOf(options))
    signals.push(options.signal)
    if (signals.length === 2) return jsonResponse(oaiBody)
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(jsonResponse(slowBody)), 200)
      options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal.reason) })
    })
  }) as typeof fetch
  const request = relay('openai', false)
  await request.run()
  assert.equal(request.res.jsonBody.choices[0].message.content, '你好🙂')
  assert.deepEqual(keys, ['c1', 'c1', 'c1'])
  assert.deepEqual([signals[0].aborted, signals[2].aborted], [true, true])
  assert.deepEqual(logs().map(row => [row.is_retry, row.channel_key]), [[0, '#1 c1…']])
})

test('单 key 竞速：整组失败时该 key 只计一次失败', async () => {
  const id = multiKeyChannel('race', ['d1'], { key_race_single: 1, key_concurrency: 3 })
  setSettings({ auto_ban_threshold: 2 })
  let calls = 0
  globalThis.fetch = (async () => { calls++; return jsonResponse({ error: { message: 'invalid key' } }, 401) }) as typeof fetch
  await relay('openai', false).run()
  assert.equal(calls, 3)
  assert.equal(keyStates(id).length, 0)
  await relay('openai', false).run()
  assert.equal(calls, 6)
  assert.deepEqual(keyStates(id).map(row => [row.status_code, row.until]), [[401, null]])
})
