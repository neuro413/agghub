import './helpers/isolated'
import test, { after, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { db, setSettings } from '../src/db'
import { getAccessToken } from '../src/adapters/vertex-auth'
import { RequestStopped } from '../src/core/requestLifecycle'
import { FakeResponse, reset, channel, relay, logs, jsonResponse, oaiBody, anthBody, gemBody, respBody, sse, oaiEvents, anthEvents } from './helpers/relay'

const originalFetch = globalThis.fetch
beforeEach(reset)
afterEach(() => { globalThis.fetch = originalFetch })
after(() => db.close())

for (const [format, type, body, events] of [
  ['openai', 'openai', oaiBody, oaiEvents()],
  ['openai', 'anthropic', anthBody, anthEvents()],
  ['anthropic', 'anthropic', anthBody, anthEvents()],
  ['anthropic', 'openai', oaiBody, oaiEvents()],
  ['responses', 'responses', respBody, [{ type: 'response.output_text.delta', delta: '你好🙂' }, { type: 'response.completed', response: respBody }]],
] as const) {
  for (const streaming of [false, true]) {
    test(`四路径成功与 D06 日志故障隔离: ${format}→${type}, stream=${streaming}`, async () => {
      channel(type)
      let calls = 0
      globalThis.fetch = (async () => { calls++; return streaming ? sse([...events]) : jsonResponse(body) }) as typeof fetch
      db.exec("CREATE TRIGGER reject_log BEFORE INSERT ON request_logs BEGIN SELECT RAISE(FAIL, '合成日志故障'); END")
      const request = relay(format, streaming)
      try { await request.run() } finally { db.exec('DROP TRIGGER reject_log') }
      assert.equal(calls, 1)
      assert.equal(request.res.statusCode, 200)
      assert.ok(JSON.stringify(request.res.jsonBody || request.res.chunks).includes('你好'))
      assert.equal(request.res.writableEnded, true)
      assert.equal(request.res.listenerCount('close'), 0)
      const successful = relay(format, streaming)
      await successful.run()
      assert.equal(logs().filter(row => !row.is_retry).length, 1)
      assert.equal(logs()[0].status, 'success')
      assert.equal(logs()[0].total_tokens, 5)
    })
  }
}

for (const streaming of [false, true]) {
  for (const [alias, upstream, body, events] of [
    ['alias', 'claude-synthetic', anthBody, anthEvents()],
    ['claude-alias', 'gemini-synthetic', gemBody, [gemBody]],
  ] as const) {
    test(`D03: Vertex 双向别名解码 ${alias}→${upstream}, stream=${streaming}`, async () => {
      channel('vertex', 0, { [alias]: upstream })
      globalThis.fetch = (async () => streaming ? sse([...events]) : jsonResponse(body)) as typeof fetch
      const request = relay('openai', streaming, undefined, { model: alias })
      await request.run()
      assert.equal(request.res.statusCode, 200)
      assert.ok(JSON.stringify(request.res.jsonBody || request.res.chunks).includes('你好'))
      assert.equal(logs()[0].status, 'success')
      assert.equal(logs()[0].upstream_model, upstream)
      if (!streaming) assert.equal(request.res.jsonBody.model, alias)
    })
  }
}

for (const type of ['openai', 'anthropic'] as const) {
  test(`D04/D11: ${type} 部分正文 EOF 记为截断失败，已开流不切渠道`, async () => {
    channel(type, 10)
    channel('openai')
    let calls = 0
    globalThis.fetch = (async () => { calls++; return sse(type === 'openai' ? oaiEvents(false) : anthEvents(false)) }) as typeof fetch
    const request = relay('openai', true)
    await request.run()
    assert.equal(calls, 1)
    assert.equal(logs()[0].status, 'error')
    assert.match(logs()[0].error_message, /截断/)
    assert.ok(request.res.chunks.join('').includes('upstream_error'))
  })
  test(`D11: ${type} 错误事件立即取消仍打开的上游`, async () => {
    channel(type)
    let cancelled = false
    let signal: AbortSignal | undefined
    globalThis.fetch = (async (_url: any, options: any) => {
      signal = options.signal
      const events = type === 'openai' ? oaiEvents(false) : anthEvents(false)
      return sse([...events, `event: error\ndata: {"error":{"message":"synthetic failure"}}\n\n`], false, () => { cancelled = true })
    }) as typeof fetch
    const request = relay('openai', true)
    await request.run()
    assert.equal(cancelled, true)
    assert.equal(signal?.aborted, true)
    assert.equal(logs()[0].status, 'error')
    assert.equal((request.res.chunks.join('').match(/synthetic failure/g) || []).length, 1)
  })
}

for (const status of [400, 413, 422]) {
  test(`D12: 上游 ${status} 不同渠道可恢复，不重复本渠道`, async () => {
    channel('openai', 10)
    channel('openai')
    setSettings({ single_retry_times: 2 })
    let calls = 0
    globalThis.fetch = (async () => ++calls === 1 ? jsonResponse({ error: { message: '候选拒绝' } }, status) : jsonResponse(oaiBody)) as typeof fetch
    await relay('openai', false).run()
    assert.equal(calls, 2)
    const rows = logs()
    assert.deepEqual(rows.map(row => row.is_retry), [1, 0])
    assert.equal(rows[1].status, 'success')
    assert.equal(rows[0].request_id, rows[1].request_id)
  })
}

test('D13: 有状态 Responses 跳过高优先级不兼容渠道；无兼容候选不发请求', async () => {
  channel('openai', 100)
  channel('responses')
  const urls: string[] = []
  globalThis.fetch = (async (url: any) => { urls.push(String(url)); return jsonResponse(respBody) }) as typeof fetch
  const request = relay('responses', false, undefined, { previous_response_id: 'synthetic_previous' })
  await request.run()
  assert.equal(urls.length, 1)
  assert.ok(urls[0].endsWith('/responses'))
  assert.equal(logs()[0].retry_count, 0)
  db.exec("UPDATE channels SET status=0 WHERE type='responses'")
  const incompatible = relay('responses', false, undefined, { previous_response_id: 'synthetic_previous' })
  await incompatible.run()
  assert.equal(urls.length, 1)
  assert.equal(incompatible.res.statusCode, 400)
})

test('本地缺模型不请求上游，仍有最终错误日志', async () => {
  let calls = 0
  globalThis.fetch = (async () => { calls++; return jsonResponse(oaiBody) }) as typeof fetch
  await relay('openai', false, undefined, { model: '' }).run()
  assert.equal(calls, 0)
  assert.equal(logs()[0].status_code, 400)
})

for (const streaming of [false, true]) {
  test(`D08/D14: 响应头前取消，fetch signal 中止且只留一个最终记录，stream=${streaming}`, async () => {
    channel('openai')
    let signal: AbortSignal | undefined
    let calls = 0
    globalThis.fetch = (async (_url: any, options: any) => {
      calls++
      signal = options.signal
      return new Promise<Response>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }))
    }) as typeof fetch
    const request = relay('openai', streaming)
    const running = request.run()
    await new Promise(resolve => setTimeout(resolve, 15))
    request.res.disconnect()
    await running
    assert.equal(signal?.aborted, true)
    assert.equal(calls, 1)
    assert.equal(request.res.jsonBody, undefined)
    assert.equal(logs().length, 1)
    assert.equal(logs()[0].status_code, 499)
    assert.equal(request.res.listenerCount('close'), 0)
  })
}

test('D14: backoff 取消立即结束，保留原失败并追加唯一最终取消记录', async () => {
  channel('openai')
  setSettings({ single_retry_times: 1, retry_interval_ms: 300 })
  let calls = 0
  globalThis.fetch = (async () => { calls++; return jsonResponse({ error: { message: '原始错误' } }, 500) }) as typeof fetch
  const request = relay('openai', false)
  const running = request.run()
  await new Promise(resolve => setTimeout(resolve, 30))
  request.res.disconnect()
  await running
  const rows = logs()
  assert.equal(calls, 1)
  assert.deepEqual(rows.map(row => row.is_retry), [1, 0])
  assert.equal(rows[0].error_message, '原始错误')
  assert.equal(rows[1].status_code, 499)
  assert.equal(rows[1].retry_count, 0)
  assert.equal(rows[1].total_tokens, 0)
})

test('D15: 请求延迟包含失败、退避和最后尝试', async () => {
  channel('openai')
  setSettings({ single_retry_times: 1, retry_interval_ms: 50 })
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    await new Promise(resolve => setTimeout(resolve, calls === 1 ? 30 : 5))
    return calls === 1 ? jsonResponse({}, 500) : jsonResponse(oaiBody)
  }) as typeof fetch
  await relay('openai', false).run()
  const final = logs().find(row => row.is_retry === 0)
  assert.ok(final.latency_ms >= 80)
  assert.ok(final.latency_ms - final.attempt_latency_ms >= 65)
  assert.equal(final.retry_count, 1)
})

test('D09: OAuth 接收取消；缓存命中不重复交换', async () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
  const creds = { project_id: 'synthetic-project', client_email: 'test@synthetic.invalid', private_key: pair.privateKey }
  const controller = new AbortController()
  let signal: AbortSignal | undefined
  globalThis.fetch = (async (_url: any, options: any) => {
    signal = options.signal
    return new Promise<Response>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }))
  }) as typeof fetch
  const pending = getAccessToken(creds, undefined, controller.signal)
  controller.abort(new RequestStopped('client_cancel'))
  await assert.rejects(pending, /客户端中断/)
  assert.equal(signal?.aborted, true)
  let calls = 0
  globalThis.fetch = (async () => { calls++; return jsonResponse({ access_token: 'synthetic-token' }) }) as typeof fetch
  assert.equal(await getAccessToken(creds), 'synthetic-token')
  assert.equal(await getAccessToken(creds), 'synthetic-token')
  assert.equal(calls, 1)
})

test('D10: SSE 心跳与半行刷新空闲计时，正常正文仍成功', async () => {
  channel('openai')
  setSettings({ request_timeout_ms: 35 })
  let ticks = 0
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      const timer = setInterval(() => {
        ticks++
        if (ticks <= 10) controller.enqueue(new TextEncoder().encode(': ping\n\n'))
        else { clearInterval(timer); controller.enqueue(new TextEncoder().encode(oaiEvents().map(event => typeof event === 'string' ? event : `data: ${JSON.stringify(event)}\n\n`).join(''))); controller.close() }
      }, 8)
    },
  }))) as typeof fetch
  await relay('openai', true).run()
  assert.ok(ticks >= 10)
  assert.equal(logs()[0].status, 'success')
})

test('D10: 无限心跳仍受整次请求总时限约束并释放上游', async () => {
  channel('openai')
  setSettings({ request_timeout_ms: 30, request_max_duration_ms: 80 })
  let cancelled = false
  let timer: ReturnType<typeof setInterval>
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { timer = setInterval(() => controller.enqueue(new TextEncoder().encode(': ping\n\n')), 5) },
    cancel() { cancelled = true; clearInterval(timer) },
  }))) as typeof fetch
  await relay('openai', true).run()
  assert.equal(cancelled, true)
  assert.equal(logs()[0].status_code, 504)
  assert.match(logs()[0].error_message, /总时限/)
})
