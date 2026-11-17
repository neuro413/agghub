import './helpers/isolated'
import test, { after, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/db'
import { parseSSEEvents } from '../src/convert/ir'
import * as oaiConv from '../src/convert/openai'
import * as anthConv from '../src/convert/anthropic'
import * as respConv from '../src/convert/responses'
import type { ChannelType, EntryFormat } from '../src/types'
import { reset, channel, relay, logs, jsonResponse, oaiBody, anthBody, respBody } from './helpers/relay'

const originalFetch = globalThis.fetch
beforeEach(reset)
afterEach(() => { globalThis.fetch = originalFetch })
after(() => db.close())

const upstreamBody: Record<string, any> = { openai: oaiBody, anthropic: anthBody, responses: respBody }

/** 用各协议自己的流式解码器回读客户端收到的 SSE，验证合成事件能被正常累积 */
async function decodeText(format: EntryFormat, sseText: string): Promise<string> {
  const decoder = format === 'anthropic' ? anthConv.createStreamDecoder('alias') : format === 'responses' ? respConv.createStreamDecoder('alias') : oaiConv.createStreamDecoder('alias')
  const body = new Response(sseText).body!
  let text = ''
  for await (const ev of parseSSEEvents(body)) {
    for (const chunk of decoder.push(ev)) for (const c of chunk.choices || []) text += c.delta?.content || ''
  }
  for (const chunk of decoder.flush()) for (const c of chunk.choices || []) text += c.delta?.content || ''
  return text
}

const cases: [EntryFormat, ChannelType][] = [
  ['openai', 'openai'], ['anthropic', 'anthropic'], ['responses', 'responses'],
  ['openai', 'anthropic'], ['anthropic', 'openai'], ['responses', 'anthropic'],
]

for (const [entry, upstream] of cases) {
  test(`假流式：${entry} 入口 → ${upstream} 上游按非流式请求，客户端收到可解码的 SSE`, async () => {
    const id = channel(upstream)
    db.prepare('UPDATE channels SET fake_stream = 1 WHERE id = ?').run(id)
    const sent: any[] = []
    globalThis.fetch = (async (_url: any, options: any) => {
      sent.push(JSON.parse(options.body))
      return jsonResponse(upstreamBody[upstream])
    }) as typeof fetch
    const request = relay(entry, true)
    await request.run()
    assert.equal(sent.length, 1)
    assert.equal(sent[0].stream, false)
    assert.equal(request.res.headers['Content-Type'], 'text/event-stream; charset=utf-8')
    assert.equal(request.res.writableEnded, true)
    assert.equal(await decodeText(entry, request.res.chunks.join('')), '你好🙂')
    const [log] = logs()
    assert.equal(log.status, 'success')
    assert.equal(!!log.is_stream, true)
  })
}

test('假流式关闭时仍按流式请求上游', async () => {
  channel('openai')
  const sent: any[] = []
  globalThis.fetch = (async (_url: any, options: any) => {
    sent.push(JSON.parse(options.body))
    return jsonResponse({ error: { message: 'x' } }, 400)
  }) as typeof fetch
  await relay('openai', true).run()
  assert.equal(sent[0].stream, true)
})
