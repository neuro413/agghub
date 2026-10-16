import './helpers/isolated'
import test, { after, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/db'
import { keyFingerprint } from '../src/core/channelKeys'
import { reset, channel, relay, logs, jsonResponse, oaiBody, sse, oaiEvents } from './helpers/relay'

const originalFetch = globalThis.fetch
beforeEach(() => { reset(); db.exec('DELETE FROM channel_key_states') })
afterEach(() => { globalThis.fetch = originalFetch })
after(() => db.close())

function multiKeyChannel(mode: 'poll' | 'race', keys: string[]): number {
  const id = channel('openai', 0, {}, keys.join('\n'))
  db.prepare('UPDATE channels SET key_mode = ?, key_concurrency = ? WHERE id = ?').run(mode, keys.length, id)
  return id
}

const keyOf = (options: any) => String(options.headers.authorization).replace('Bearer ', '')
const slowBody = { ...oaiBody, choices: [{ index: 0, message: { role: 'assistant', content: 'slow' }, finish_reason: 'stop' }] }

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
