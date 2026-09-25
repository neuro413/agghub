import './helpers/isolated'
import test, { after, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { generateKeyPairSync } from 'node:crypto'
import { db, getChannelById, setSettings } from '../src/db'
import { openaiEntry } from '../src/entry/openai'
import { anthropicEntry } from '../src/entry/anthropic'
import { responsesEntry } from '../src/entry/responses'
import { channelsRouter } from '../src/routes/channels'
import { getAccessToken } from '../src/adapters/vertex-auth'
import { channel, reset, relay, logs, sse, oaiEvents, anthEvents, jsonResponse, oaiBody, anthBody, gemBody } from './helpers/relay'

const originalFetch = globalThis.fetch
beforeEach(reset)
afterEach(() => { globalThis.fetch = originalFetch })
after(() => db.close())
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const parsedEvents = (frames: string[]) => frames.join('').split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)))

for (const streaming of [false, true]) {
  test(`伪思考组合路径与日志故障隔离 stream=${streaming}`, async () => {
    channel('anthropic')
    setSettings({ pseudo_thinking_enabled: true, drop_thinking: true })
    const text = '<thinking>合成思考</thinking>最终正文'
    globalThis.fetch = (async () => streaming ? sse(anthEvents().map(event => event.type === 'content_block_delta' ? { ...event, delta: { type: 'text_delta', text } } : event)) : jsonResponse({ ...anthBody, content: [{ type: 'text', text }] })) as typeof fetch
    db.exec("CREATE TRIGGER synthetic_log_failure BEFORE INSERT ON request_logs BEGIN SELECT RAISE(FAIL, 'log failed'); END")
    const request = relay('anthropic', streaming)
    try { await request.run() } finally { db.exec('DROP TRIGGER synthetic_log_failure') }
    assert.equal(request.res.statusCode, 200)
    const content = streaming ? request.res.chunks.join('') : JSON.stringify(request.res.jsonBody)
    assert.ok(content.includes('合成思考') && content.includes('最终正文') && content.includes('thinking'))
    assert.ok(!content.includes('<thinking>'))
  })
}

test('D04: Gemini finishReason 后 usage 尾包保留至最终日志', async () => {
  channel('vertex', 0, { alias: 'gemini-synthetic' })
  globalThis.fetch = (async () => sse([{ ...gemBody, usageMetadata: undefined }, { usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 5, totalTokenCount: 9 } }])) as typeof fetch
  const request = relay('openai', true)
  await request.run()
  assert.equal(logs()[0].total_tokens, 9)
  assert.equal(parsedEvents(request.res.chunks).at(-1).usage.total_tokens, 9)
})

test('D05/D22: 中继 custom 并行工具往返每项输入完全一致', async () => {
  channel('anthropic')
  globalThis.fetch = (async () => sse([
    { type: 'message_start', message: { id: 'synthetic' } },
    ...[0, 1].map(index => ({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `c${index}`, name: `run${index}`, input: {} } })),
    ...[0, 1].map(index => ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '{"input":"' } })),
    ...[0, 1].map(index => ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: `中文${index}"}` } })),
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' },
  ])) as typeof fetch
  const request = relay('responses', true, undefined, { tools: [{ type: 'custom', name: 'run0' }, { type: 'custom', name: 'run1' }] })
  await request.run()
  const events = parsedEvents(request.res.chunks)
  const output = events.find(event => event.type === 'response.completed').response.output
  for (const item of output) {
    const deltas = events.filter(event => event.type === 'response.custom_tool_call_input.delta' && event.item_id === item.id).map(event => event.delta).join('')
    const done = events.find(event => event.type === 'response.custom_tool_call_input.done' && event.item_id === item.id)
    assert.equal(deltas, item.input)
    assert.equal(done.input, item.input)
  }
  assert.equal(output.length, 2)
  assert.equal(logs()[0].status, 'success')
})

test('故障转移组合：熔断不再重试当前渠道，参数规则按别名匹配', async () => {
  const primary = channel('openai', 10)
  channel('openai')
  setSettings({ single_retry_times: 3, auto_ban_codes: '500', param_rules: JSON.stringify([{ id: 'rule', enabled: true, models: ['alias'], ops: [{ type: 'set', key: 'temperature', value: '0.2' }] }]) })
  let calls = 0
  globalThis.fetch = (async (_url: any, options: any) => {
    assert.equal(JSON.parse(options.body).temperature, 0.2)
    return ++calls === 1 ? jsonResponse({ error: { message: 'synthetic' } }, 500) : jsonResponse(oaiBody)
  }) as typeof fetch
  await relay('openai', false).run()
  assert.equal(calls, 2)
  assert.equal(getChannelById(primary)!.status, 2)
  assert.equal(logs().at(-1).retry_count, 1)
})

test('真实回环 HTTP 中继：入口路由、模拟上游、非流式/流式与客户端取消', async () => {
  let closed = false
  let hang = false
  const upstream = http.createServer((req, res) => {
    let body = ''
    req.on('data', data => { body += data })
    req.on('end', () => {
      if (hang) { res.on('close', () => { closed = true }); return }
      const input = JSON.parse(body)
      if (input.stream) { res.setHeader('content-type', 'text/event-stream'); res.end(oaiEvents().map(event => typeof event === 'string' ? event : `data: ${JSON.stringify(event)}\n\n`).join('')) }
      else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(oaiBody)) }
    })
  })
  const app = express(); app.use(express.json()); app.use('/v1', openaiEntry); app.use('/v1', anthropicEntry); app.use('/v1', responsesEntry)
  const gateway = http.createServer(app)
  await Promise.all([new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve)), new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve))])
  const id = channel('openai')
  db.prepare('UPDATE channels SET base_url=? WHERE id=?').run(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, id)
  const base = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`
  try {
    for (const [endpoint, input] of [
      ['/chat/completions', { messages: [{ role: 'user', content: 'hi' }] }],
      ['/messages', { messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 }],
      ['/responses', { input: 'hi' }],
    ] as const) for (const stream of [false, true]) {
      const response = await originalFetch(base + '/v1' + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, model: 'alias', stream }) })
      assert.equal(response.status, 200)
      assert.ok((await response.text()).includes('你好'))
    }
    hang = true
    const controller = new AbortController()
    const pending = originalFetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'alias', messages: [{ role: 'user', content: 'hi' }] }), signal: controller.signal })
    await wait(50); controller.abort()
    await assert.rejects(pending)
    for (let i = 0; i < 50 && !closed; i++) await wait(10)
    assert.equal(closed, true)
    assert.equal(logs().filter(row => !row.is_retry).length, 7)
    assert.equal(logs().at(-1).status_code, 499)
  } finally {
    gateway.closeAllConnections(); upstream.closeAllConnections()
    await Promise.all([new Promise<void>(resolve => gateway.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))])
  }
})

test('D09/D14: OAuth 的15秒自身时限、渠道测试10秒时限与准备阶段取消', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
  const creds = { project_id: 'synthetic', client_email: 'deadline@synthetic.invalid', private_key: privateKey }
  let signal: AbortSignal | undefined
  globalThis.fetch = (async (_url: any, options: any) => { signal = options.signal; return new Promise<Response>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })) }) as typeof fetch
  const started = performance.now()
  await assert.rejects(getAccessToken(creds), /15 秒/)
  assert.ok(performance.now() - started < 18_000)
  assert.equal(signal!.aborted, true)
  const app = express(); app.use(express.json()); app.use('/channels', channelsRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  try {
    const started = performance.now()
    const response = await originalFetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/channels/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'vertex', api_key: JSON.stringify(creds), models: ['gemini-synthetic'] }) })
    assert.equal((await response.json() as any).ok, false)
    assert.ok(performance.now() - started < 13_000)
    assert.equal(signal!.aborted, true)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  channel('vertex', 0, { alias: 'gemini-synthetic' }, JSON.stringify(creds))
  const request = relay('openai', false)
  const pending = request.run()
  await wait(20); request.res.disconnect()
  await pending
  assert.equal(logs().at(-1).status_code, 499)
  assert.equal(logs().at(-1).is_retry, 0)
})
