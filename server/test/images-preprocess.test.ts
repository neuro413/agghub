import './helpers/isolated'
import test, { after, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { gzipSync } from 'node:zlib'
import { db, getSettings, setSettings } from '../src/db'
import { resolveImageUrls } from '../src/core/imageResolver'
import { applyPreprocess } from '../src/core/preprocess'
import { buildRequest } from '../src/convert/gemini'
import * as responses from '../src/convert/responses'
import * as anthropic from '../src/convert/anthropic'
import type { EntryFormat, PreprocessRule } from '../src/types'
import { reset, channel, relay, logs, jsonResponse, oaiBody, gemBody } from './helpers/relay'

const originalFetch = globalThis.fetch
beforeEach(reset)
afterEach(() => { globalThis.fetch = originalFetch })
after(() => db.close())
const imageRequest = (...urls: string[]) => ({ model: 'alias', messages: [{ role: 'user', content: [{ type: 'text', text: '图片内容' }, ...urls.map(url => ({ type: 'image_url', image_url: { url } }))] }] })
const signal = () => new AbortController().signal
const mockFetch = (handler: () => Response) => { globalThis.fetch = (async () => handler()) as typeof fetch }

function freeze(value: any) { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) } return value }

test('D17: 404/超限明确失败，失败时不改动输入', async () => {
  const settings = { ...getSettings(), image_max_bytes: 8 }
  for (const response of [() => new Response('404', { status: 404 }), () => new Response('123456789'), () => new Response('a', { headers: { 'content-length': '1000' } })]) {
    mockFetch(response)
    const body = imageRequest('http://public.test/a', 'data:image/png;base64,YWJj')
    const before = structuredClone(body)
    await assert.rejects(resolveImageUrls(body, settings, signal()))
    assert.deepEqual(body, before)
  }
  await assert.rejects(resolveImageUrls(imageRequest('data:image/png;base64,' + Buffer.alloc(9).toString('base64')), settings, signal()), /单张/)
  await assert.rejects(resolveImageUrls(imageRequest('data:image/png;base64,'), settings, signal()), /base64/)
  await assert.rejects(resolveImageUrls(imageRequest('file:///etc/passwd'), settings, signal()), /地址无效/)
  assert.throws(() => buildRequest(imageRequest('http://public.test/a'), 'gemini-synthetic'), /尚未解析/)
})

test('D17: 重复 URL 只下载一次，媒体类型取自响应头', async () => {
  let calls = 0
  mockFetch(() => { calls++; return new Response('abc', { headers: { 'content-type': 'image/png; charset=binary' } }) })
  const body = imageRequest('http://public.test/a', 'http://public.test/a')
  await resolveImageUrls(body, getSettings(), signal())
  assert.equal(calls, 1)
  assert.equal((body.messages[0].content[1] as any).image_url.url, 'data:image/png;base64,YWJj')
  assert.equal((body.messages[0].content[2] as any).image_url.url, 'data:image/png;base64,YWJj')
})

test('D17: 压缩响应按解压后字节限制', async () => {
  const compressed = gzipSync(Buffer.alloc(2000, 65))
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png', 'content-encoding': 'gzip', 'content-length': compressed.length })
    res.end(compressed)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/image`
    await assert.rejects(resolveImageUrls(imageRequest(url), { ...getSettings(), image_max_bytes: 100 }, signal()), /单张/)
    const body = imageRequest(url)
    await resolveImageUrls(body, getSettings(), signal())
    assert.equal((body.messages[0].content[1] as any).image_url.url, `data:image/png;base64,${Buffer.alloc(2000, 65).toString('base64')}`)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('D17/D18: 图片失败切备用渠道，deepFreeze 原请求及原日志保留 URL', async () => {
  channel('vertex', 10, { alias: 'gemini-synthetic' })
  channel('openai')
  const sent: any[] = []
  globalThis.fetch = (async (_url: any, options: any) => {
    if (!options.body) return new Response('missing', { status: 404 })
    sent.push(JSON.parse(options.body)); return jsonResponse(oaiBody)
  }) as typeof fetch
  const request = relay('openai', false, undefined, imageRequest('http://127.0.0.1/synthetic.png'))
  freeze(request.raw)
  await request.run()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].messages[0].content[1].image_url.url, 'http://127.0.0.1/synthetic.png')
  assert.equal(logs().at(-1).status, 'success')
  assert.equal(JSON.parse(logs().at(-1).request_body).messages[0].content[1].image_url.url, 'http://127.0.0.1/synthetic.png')
})

test('D18: 图片成功仅改尝试副本，关闭请求存储仍标注预处理', async () => {
  channel('vertex', 0, { alias: 'gemini-synthetic' })
  setSettings({ store_request_body: false })
  let sent: any
  globalThis.fetch = (async (_url: any, options: any) => {
    if (!options.body) return new Response('abc', { headers: { 'content-type': 'image/png' } })
    sent = JSON.parse(options.body); return jsonResponse(gemBody)
  }) as typeof fetch
  const request = relay('openai', false, undefined, imageRequest('http://127.0.0.1/synthetic.png'))
  freeze(request.raw)
  await request.run()
  assert.ok(sent.contents[0].parts.some((part: any) => part.inlineData?.data === 'YWJj'))
  assert.equal(logs()[0].preprocessed, 1)
  assert.equal(logs()[0].request_body, null)
})

test('D19: 嵌套 tool_result 按 tool 角色处理，user 文本/图片/参数不误改', () => {
  for (const role of ['user', 'tool']) {
    const body: any = { messages: [{ role: 'user', content: [{ type: 'text', text: 'SECRET' }, { type: 'tool_result', tool_use_id: 'call', content: [{ type: 'text', text: 'SECRET' }, { type: 'image', source: { data: 'SECRET' } }] }] }] }
    const settings = { ...getSettings(), preprocess_rules: [{ id: 'r', enabled: true, source: 'regex' as const, pattern: 'SECRET', flags: 'g', replacement: 'MASKED', roles: [role] }] }
    applyPreprocess(body, { entryFormat: 'anthropic', channelId: 1, model: 'alias', passthrough: true }, settings)
    assert.equal(body.messages[0].content[0].text, role === 'user' ? 'MASKED' : 'SECRET')
    assert.equal(body.messages[0].content[1].content[0].text, role === 'tool' ? 'MASKED' : 'SECRET')
    assert.equal(body.messages[0].content[1].content[1].source.data, 'SECRET')
  }
})

test('D20: custom/function 黑名单完整移除定义、调用、结果，未屏蔽并行工具保留', () => {
  const request = responses.parseRequest({ model: 'alias', tools: [{ type: 'custom', name: 'blocked' }, { type: 'function', name: 'keep', parameters: {} }], input: [{ type: 'custom_tool_call', call_id: 'c1', name: 'blocked', input: 'hello' }, { type: 'custom_tool_call_output', call_id: 'c1', output: 'secret' }, { type: 'function_call', call_id: 'c2', name: 'keep', arguments: '{}' }, { type: 'function_call_output', call_id: 'c2', output: 'keep result' }] }).ir
  const settings = { ...getSettings(), tool_filter_rules: [{ id: 'r', enabled: true, tools: ['blocked'] }] }
  applyPreprocess(request, { entryFormat: 'responses', channelId: 1, model: 'alias', passthrough: false }, settings)
  const body = JSON.stringify(anthropic.buildRequest(request, 'claude-synthetic'))
  assert.ok(!body.includes('blocked') && !body.includes('secret') && !body.includes('c1'))
  assert.ok(body.includes('keep') && body.includes('c2'))
})

test('提示词规则移除模式：命中即移除整条消息，工具调用与结果成对清理', () => {
  const run = (body: any, entryFormat: EntryFormat, rule: Partial<PreprocessRule>) => {
    const base: PreprocessRule = { id: 'r', enabled: true, source: 'regex', pattern: 'SECRET', flags: 'g', replacement: '', action: 'remove_message' }
    applyPreprocess(body, { entryFormat, channelId: 1, model: 'alias', passthrough: true }, { ...getSettings(), preprocess_rules: [{ ...base, ...rule }] })
    return body
  }
  // Chat：只作用于 assistant，命中的消息连同它的工具结果移除，同样含关键词的 system 不受影响
  const chat = run({ messages: [
    { role: 'system', content: 'SECRET' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'SECRET', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    { role: 'user', content: 'bye' },
  ] }, 'openai', { roles: ['assistant'] })
  assert.deepEqual(chat.messages, [{ role: 'system', content: 'SECRET' }, { role: 'user', content: 'hi' }, { role: 'user', content: 'bye' }])

  // Claude：顶层 system 整个移除；tool_result 命中只移除该结果及对应 tool_use，同条消息其余内容保留
  const claude = run({ system: [{ type: 'text', text: 'SECRET' }], messages: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'tool_use', id: 'a', name: 'f', input: {} }, { type: 'tool_use', id: 'b', name: 'f', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'SECRET' }, { type: 'tool_result', tool_use_id: 'b', content: 'ok' }, { type: 'text', text: 'next' }] },
  ] }, 'anthropic', { roles: ['system', 'tool'] })
  assert.equal(claude.system, undefined)
  assert.deepEqual(claude.messages.map((m: any) => (Array.isArray(m.content) ? m.content.map((b: any) => b.id ?? b.tool_use_id ?? b.type) : m.content)), ['hi', ['thinking', 'b'], ['b', 'text']])

  // Responses：深度 2 只看最后两项；结果项命中时连同调用项和它前面的 reasoning 一并移除
  const resp = run({ instructions: 'keep', input: [
    { role: 'user', content: [{ type: 'input_text', text: 'SECRET' }] },
    { type: 'reasoning', id: 'rs', summary: [] },
    { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c1', output: 'SECRET' },
    { role: 'user', content: 'go' },
  ] }, 'responses', { depth: 2 })
  assert.deepEqual(resp, { instructions: 'keep', input: [{ role: 'user', content: [{ type: 'input_text', text: 'SECRET' }] }, { role: 'user', content: 'go' }] })
})
