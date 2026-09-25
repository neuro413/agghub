import './helpers/isolated'
import test, { after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { db, setSettings } from '../src/db'
import { BoundedCapture, BufferBudget } from '../src/core/capture'
import { parseSSEEvents } from '../src/convert/ir'
import { StreamState } from '../src/core/streamState'
import { createStreamWriter } from '../src/core/streamWriter'
import { AttemptLifecycle, RequestStopped } from '../src/core/requestLifecycle'
import { FakeResponse, reset, relay, channel, logs, sse, oaiEvents } from './helpers/relay'
const originalFetch = globalThis.fetch
beforeEach(reset)
afterEach(() => { globalThis.fetch = originalFetch })
after(() => db.close())
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('R02: 64MiB 合成数据只保留预算前缀，关闭采集不累计，UTF-8 截断不产生半字', () => {
  const enabled = new BoundedCapture(true, 1024), disabled = new BoundedCapture(false, 1024)
  const block = new Uint8Array(64 * 1024).fill(97)
  for (let i = 0; i < 1024; i++) { enabled.append(block); disabled.append(block) }
  assert.equal(enabled.totalBytes, 64 * 1024 * 1024)
  assert.equal(enabled.capturedBytes, 1024)
  assert.equal(enabled.truncated, true)
  assert.equal(disabled.capturedBytes, 0)
  assert.equal(disabled.totalBytes, 0)
  assert.equal(disabled.text(), undefined)
  const utf8 = new BoundedCapture(true, 5)
  utf8.append('你🙂好')
  assert.equal(utf8.text(), '你')
})

test('D10/R02: SSE 任意 UTF-8 分片、CRLF、多行 data 和尾行解析一致，超大事件取消', async () => {
  const bytes = new TextEncoder().encode(': 心跳\r\nevent: message\r\ndata: 中文🙂\r\ndata: 后一行\r\n\r\ndata: 尾行')
  let calls = 0
  const body = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close() } })
  const result = []
  for await (const event of parseSSEEvents(body, undefined, { onBytes() { calls++ } })) result.push(event)
  assert.equal(calls, bytes.length)
  assert.deepEqual(result, [{ event: 'message', data: '中文🙂\n后一行' }, { event: null, data: '尾行' }])
  let cancelled = false
  const oversized = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: ' + 'x'.repeat(3000))) }, cancel() { cancelled = true } })
  const budget = new BufferBudget(1024)
  await assert.rejects(async () => { for await (const _event of parseSSEEvents(oversized, undefined, { budget })) {} }, /缓冲/)
  assert.equal(cancelled, true)
  assert.equal(budget.used, 0)
})

test('D04: 多 choice 完成、长度限制、usage尾包、错误状态单向保持', () => {
  const state = new StreamState('openai', 2)
  const feed = (data: any) => state.observe({ event: null, data: JSON.stringify(data) })
  feed({ choices: [{ index: 0, delta: { content: 'a' }, finish_reason: 'stop' }, { index: 1, delta: { content: 'b' }, finish_reason: null }] })
  assert.throws(() => state.assertComplete(), (error: any) => error.body.includes('截断'))
  feed({ choices: [{ index: 1, finish_reason: 'length' }] })
  assert.doesNotThrow(() => state.assertComplete())
  assert.equal(state.closed, false)
  feed({ usage: { total_tokens: 7 } })
  feed({ error: { message: 'failed' } })
  state.observe({ event: null, data: '[DONE]' })
  assert.throws(() => state.assertComplete(), /upstream/)
  const responses = new StreamState('responses')
  responses.observe({ event: null, data: JSON.stringify({ type: 'response.incomplete', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial' }] }], incomplete_details: { reason: 'max_output_tokens' } } }) })
  assert.doesNotThrow(() => responses.assertComplete())
})

test('R02: 等待 drain 不继续写、暂停上游空闲时钟，恢复后清理所有监听', async () => {
  const parent = new AbortController(), attempt = new AttemptLifecycle(parent.signal, 20)
  const res = new FakeResponse(); res.writeResult = false
  const write = createStreamWriter(res as any, parent.signal, attempt, 300)
  const pending = write('first')
  await wait(65)
  assert.equal(res.chunks.length, 1)
  assert.equal(attempt.signal.aborted, false)
  res.emit('drain')
  await pending
  assert.equal(res.listenerCount('drain'), 0)
  assert.equal(res.listenerCount('error'), 0)
  assert.equal(res.listenerCount('close'), 0)
  attempt.dispose()
})

for (const kind of ['close', 'cancel', 'timeout']) {
  test(`R02: 背压期间 ${kind} 结束等待并移除监听`, async () => {
    const parent = new AbortController(), attempt = new AttemptLifecycle(parent.signal, 20)
    const res = new FakeResponse(); res.writeResult = false
    const pending = createStreamWriter(res as any, parent.signal, attempt, 30)('first')
    if (kind === 'close') res.disconnect()
    if (kind === 'cancel') parent.abort(new RequestStopped('request_deadline'))
    await assert.rejects(pending)
    assert.equal(res.listenerCount('drain'), 0)
    assert.equal(res.listenerCount('error'), 0)
    assert.equal(res.listenerCount('close'), 0)
    attempt.dispose()
  })
}

test('R02: 中继截断日志不截断业务输出；关闭存储没有响应引用', async () => {
  channel('openai')
  setSettings({ log_response_max_bytes: 10 })
  globalThis.fetch = (async () => sse(oaiEvents())) as typeof fetch
  const request = relay('openai', true)
  await request.run()
  assert.ok(request.res.chunks.join('').includes('你好🙂'))
  assert.equal(logs()[0].status, 'success')
  assert.equal(logs()[0].upstream_response_body_truncated, 1)
  setSettings({ store_response_body: false })
  await relay('openai', true).run()
  assert.equal(logs().at(-1).upstream_response_body, null)
  assert.equal(logs().at(-1).response_body, null)
})

for (const type of ['openai', 'anthropic'] as const) {
  for (const streaming of [false, true]) {
    test(`四路径读取超时与取消: openai→${type} stream=${streaming}`, async () => {
      channel(type)
      setSettings({ request_timeout_ms: 30 })
      let cancelled = 0
      globalThis.fetch = (async () => new Response(new ReadableStream({ cancel() { cancelled++ } }))) as typeof fetch
      const timeout = relay('openai', streaming)
      await timeout.run()
      assert.equal(logs().at(-1).status_code, 504)
      assert.equal(cancelled, 1)
      const request = relay('openai', streaming)
      const pending = request.run()
      await wait(5)
      request.res.disconnect()
      await pending
      assert.equal(logs().at(-1).status_code, 499)
      assert.equal(cancelled, 2)
    })
  }
}

test('R02: 真实回环 socket 暂停读取产生背压，客户端关闭可中止写出', async () => {
  let resolveDone: () => void
  const done = new Promise<void>(resolve => { resolveDone = resolve })
  let sawBackpressure = false
  const server = http.createServer(async (_req, res) => {
    const parent = new AbortController(), attempt = new AttemptLifecycle(parent.signal, 300)
    const original = res.write.bind(res)
    res.write = ((...args: any[]) => { const ok = (original as any)(...args); sawBackpressure ||= !ok; return ok }) as any
    const close = () => parent.abort(new RequestStopped('client_cancel'))
    res.on('close', close)
    try {
      const writer = createStreamWriter(res as any, parent.signal, attempt, 1000)
      for (let i = 0; i < 256; i++) await writer('x'.repeat(64 * 1024))
    } catch {} finally { res.off('close', close); attempt.dispose(); res.end(); resolveDone!() }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const client = net.connect((server.address() as net.AddressInfo).port, '127.0.0.1')
  try {
    await new Promise<void>(resolve => client.once('connect', resolve))
    client.pause(); client.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n')
    await wait(80)
    client.destroy()
    await done
    assert.equal(sawBackpressure, true)
  } finally { client.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
