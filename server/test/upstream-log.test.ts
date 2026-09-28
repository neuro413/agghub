import './helpers/isolated'
import test, { after, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/db'
import { BoundedCapture } from '../src/core/capture'
import { ResponsesSseLog, logResponsesBody } from '../src/core/upstreamLog'
import { channel, jsonResponse, logs, relay, reset, respBody, sse } from './helpers/relay'

const originalFetch = globalThis.fetch
beforeEach(reset)
afterEach(() => { globalThis.fetch = originalFetch })
after(() => db.close())

const tools = [{ type: 'function', name: 'read', description: '读取文件🙂'.repeat(50), parameters: { type: 'object' } }]
const instructions = '系统提示词'.repeat(100)
const echo = { id: 'resp_1', object: 'response', model: 'actual', instructions, tools }
const reasoning = (encrypted: string) => ({ id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: encrypted })
const message = { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好🙂' }] }
const frame = (data: any) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`
const frames = [
  frame({ type: 'response.created', response: { ...echo, status: 'in_progress', output: [] } }),
  frame({ type: 'response.in_progress', response: { ...echo, status: 'in_progress', output: [] } }),
  frame({ type: 'response.output_item.added', output_index: 0, item: reasoning('ADDED'.repeat(40)) }),
  frame({ type: 'response.output_item.done', output_index: 0, item: reasoning('DONE'.repeat(80)) }),
  frame({ type: 'response.output_item.added', output_index: 1, item: { ...message, content: [] } }),
  frame({ type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: '你好🙂' }),
  frame({ type: 'response.output_item.done', output_index: 1, item: message }),
  frame({ type: 'response.completed', response: { ...echo, status: 'completed', output: [reasoning('FINAL'.repeat(80)), message], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } } }),
]

function capture(text: string, split: number[], maxBytes = 1 << 20): string {
  const out = new BoundedCapture(true, maxBytes)
  const log = new ResponsesSseLog(out)
  const bytes = Buffer.from(text)
  let start = 0
  for (const end of [...split, bytes.length]) { log.append(bytes.subarray(start, end)); start = end }
  log.flush()
  return out.text()!
}

const parse = (text: string) => text.split(/\r?\n\r?\n/).filter(Boolean).map(part => JSON.parse(part.split(/\r?\n/).find(line => line.startsWith('data:'))!.slice(6)))

test('日志副本省略回显参数与 done 之外的密文，其余帧逐字保留', () => {
  const raw = frames.join('')
  // 在多字节字符和帧分隔符中间切开
  const cuts = [3, raw.indexOf('🙂') + 1, raw.indexOf('\n\n') + 1, raw.length - 7]
  const text = capture(raw, cuts)
  const events = parse(text)
  for (const event of [events[0], events[1], events[7]]) {
    assert.match(event.response.instructions, /省略/)
    assert.match(event.response.tools, /省略/)
  }
  assert.match(events[2].item.encrypted_content, /省略：200 字符密文/)
  assert.equal(events[3].item.encrypted_content, 'DONE'.repeat(80))
  assert.match(events[7].response.output[0].encrypted_content, /省略/)
  assert.deepEqual(events[7].response.output[1], message)
  assert.deepEqual(events[7].response.usage, { input_tokens: 2, output_tokens: 3, total_tokens: 5 })
  for (const i of [4, 5, 6]) assert.ok(text.includes(frames[i]))
  assert.ok(Buffer.byteLength(text) < Buffer.byteLength(raw) / 2)
})

test('终态 output 中没有 done 事件的推理项保留密文，CRLF 帧与无效帧原样保留', () => {
  const completed = frame({ type: 'response.completed', response: { status: 'completed', output: [reasoning('ONLY'.repeat(10))] } }).replace(/\n/g, '\r\n')
  const broken = 'event: response.created\ndata: {"type":"response.created","response":\n\n'
  const text = capture(completed + broken + ': keepalive\n\n', [5])
  assert.equal(text, completed + broken + ': keepalive\n\n')
})

test('超过日志上限时照常截断，非流式回复只改日志副本', () => {
  const text = capture(frames.join(''), [], 600)
  assert.ok(Buffer.byteLength(text) <= 600)
  const out = new BoundedCapture(true, 1 << 20)
  const body = { ...echo, output: [reasoning('KEEP')] }
  out.append(JSON.stringify(body))
  logResponsesBody(out, body)
  const logged = JSON.parse(out.text()!)
  assert.match(logged.tools, /省略/)
  assert.equal(logged.output[0].encrypted_content, 'KEEP')
  assert.deepEqual(body.tools, tools)
})

for (const streaming of [false, true]) {
  test(`Responses 上游经中继：客户端收到完整回复，日志只存精简副本 stream=${streaming}`, async () => {
    channel('responses')
    globalThis.fetch = (async () => streaming ? sse(frames) : jsonResponse({ ...respBody, instructions, tools })) as typeof fetch
    const request = relay('responses', streaming)
    await request.run()
    assert.equal(request.res.statusCode, 200)
    const client = streaming ? request.res.chunks.join('') : JSON.stringify(request.res.jsonBody)
    assert.ok(client.includes('读取文件🙂'))
    const [log] = logs()
    assert.equal(log.status, 'success')
    assert.ok(!log.upstream_response_body.includes('读取文件🙂'))
    assert.ok(log.upstream_response_body.includes('你好🙂'))
  })
}
