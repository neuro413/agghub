import './helpers/isolated'
import test, { after, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { gzipSync } from 'node:zlib'
import { db, getSettings, setSettings } from '../src/db'
import { resolveImageUrls, imageDownloads } from '../src/core/imageResolver'
import { validateImageTarget } from '../src/core/imagePolicy'
import { pinnedImageTransport } from '../src/core/imageTransport'
import { applyPreprocess } from '../src/core/preprocess'
import { buildRequest } from '../src/convert/gemini'
import * as responses from '../src/convert/responses'
import * as anthropic from '../src/convert/anthropic'
import { reset, channel, relay, logs, jsonResponse, oaiBody, gemBody } from './helpers/relay'

const originalFetch = globalThis.fetch
beforeEach(reset)
afterEach(() => { globalThis.fetch = originalFetch })
after(() => db.close())
const imageRequest = (...urls: string[]) => ({ model: 'alias', messages: [{ role: 'user', content: [{ type: 'text', text: '图片内容' }, ...urls.map(url => ({ type: 'image_url', image_url: { url } }))] }] })
const publicLookup = async () => [{ address: '8.8.8.8', family: 4 }]
const transport = (response: Response) => async () => ({ response, async dispose() {} })
const signal = () => new AbortController().signal

function freeze(value: any) { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) } return value }

test('R03: 默认拒绝私网、保留、mapped/非规范地址和域名重绑定；白名单精确允许', async () => {
  for (const host of ['127.0.0.1', '2130706433', '0x7f000001', '[::1]', '[::ffff:127.0.0.1]', '10.2.3.4', '169.254.169.254', '[fe80::1]', '192.168.1.1', '100.100.100.200']) {
    await assert.rejects(validateImageTarget(`http://${host}/image`, [], signal()))
  }
  await assert.rejects(validateImageTarget('http://public.test/image', [], signal(), async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]))
  assert.equal((await validateImageTarget('http://trusted.test/image', ['trusted.test'], signal(), async () => [{ address: '127.0.0.1', family: 4 }])).address, '127.0.0.1')
  assert.equal((await validateImageTarget('http://10.2.3.4/image', ['10.0.0.0/8'], signal())).address, '10.2.3.4')
  await assert.rejects(validateImageTarget('http://169.254.169.254/image', ['169.254.169.254'], signal()))
  for (const url of ['file:///a', 'http://secret:password@public.test/a?secret=x']) await assert.rejects(validateImageTarget(url, [], signal(), publicLookup))
})

test('D17/R03: 404/超限/重定向到内网明确失败，全部失败原子保留输入', async () => {
  const settings = { ...getSettings(), image_max_bytes: 8, image_total_max_bytes: 12 }
  for (const response of [new Response('404', { status: 404 }), new Response('123456789'), new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } })]) {
    const body = imageRequest('http://public.test/a?private=secret')
    const before = structuredClone(body)
    await assert.rejects(resolveImageUrls(body, undefined, { settings, lookup: publicLookup, transport: transport(response) }))
    assert.deepEqual(body, before)
  }
  await assert.rejects(resolveImageUrls(imageRequest('data:image/png;base64,' + Buffer.alloc(9).toString('base64')), undefined, { settings }), /单张/)
  await assert.rejects(resolveImageUrls(imageRequest(...Array(21).fill('http://public.test/a')), undefined, { settings }), /数量/)
  assert.throws(() => buildRequest(imageRequest('http://public.test/a'), 'gemini-synthetic'), /尚未解析/)
})

test('R03: 重定向次数和总下载预算有界，重复 URL 只下载一次', async () => {
  let calls = 0
  await assert.rejects(resolveImageUrls(imageRequest('http://public.test/a'), undefined, { lookup: publicLookup, transport: async () => { calls++; return { response: new Response('', { status: 302, headers: { location: '/next' } }), async dispose() {} } } }), /3 次/)
  assert.equal(calls, 4)
  calls = 0
  const body = imageRequest('http://public.test/a', 'http://public.test/a')
  await resolveImageUrls(body, undefined, { lookup: publicLookup, transport: async () => { calls++; return { response: new Response('abc'), async dispose() {} } } })
  assert.equal(calls, 1)
  assert.equal((body.messages[0].content[1] as any).image_url.url, 'data:text/plain;base64,YWJj')
  const multi = imageRequest('http://public.test/a', 'http://public.test/b')
  await assert.rejects(resolveImageUrls(multi, undefined, { settings: { ...getSettings(), image_total_max_bytes: 5 }, lookup: publicLookup, transport: async () => ({ response: new Response('abc'), async dispose() {} }) }), /总大小/)
  assert.ok((multi.messages[0].content[1] as any).image_url.url.startsWith('http:'))
})

test('R03: 每请求并发与进程8并发限制，取消释放活跃下载及队列', async () => {
  const controller = new AbortController()
  let active = 0, peak = 0, released = 0
  const download = async () => {
    active++; peak = Math.max(peak, active)
    return { response: new Response(new ReadableStream({ cancel() { released++ } })), async dispose() { active-- } }
  }
  const runs = Array.from({ length: 4 }, () => resolveImageUrls(imageRequest(...Array.from({ length: 8 }, (_, i) => `http://public.test/${i}`)), undefined, { signal: controller.signal, lookup: publicLookup, transport: download }))
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(peak, 8)
  assert.ok(imageDownloads.waiting > 0)
  controller.abort(new Error('合成取消'))
  await Promise.allSettled(runs)
  assert.equal(imageDownloads.active, 0)
  assert.equal(imageDownloads.waiting, 0)
  assert.equal(active, 0)
  assert.equal(released, 8)
})

test('D17/D18: 图片失败切备用渠道，deepFreeze 原请求及原日志保留 URL', async () => {
  channel('vertex', 10, { alias: 'gemini-synthetic' })
  channel('openai')
  setSettings({ image_allowed_hosts: JSON.stringify(['127.0.0.1']) })
  const sent: any[] = []
  globalThis.fetch = (async (_url: any, options: any) => {
    if (options.method === 'GET') return new Response('missing', { status: 404 })
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
  setSettings({ image_allowed_hosts: '["127.0.0.1"]', store_request_body: false })
  let sent: any
  globalThis.fetch = (async (_url: any, options: any) => {
    if (options.method === 'GET') return new Response('abc', { headers: { 'content-type': 'image/png' } })
    sent = JSON.parse(options.body); return jsonResponse(gemBody)
  }) as typeof fetch
  const request = relay('openai', false, undefined, imageRequest('http://127.0.0.1/synthetic.png'))
  freeze(request.raw)
  await request.run()
  assert.ok(sent.contents[0].parts.some((part: any) => part.inlineData?.data === 'YWJj'))
  assert.equal(logs()[0].preprocessed, 1)
  assert.equal(logs()[0].request_body, null)
})

test('R03: 真实回环直连/HTTP代理 CONNECT 绑定指定IP，原 Host 保留且不发送网关凭证', async () => {
  const seen: any[] = [], tunnels: string[] = []
  const target = http.createServer((req, res) => { seen.push(req.headers); res.end('image') })
  const proxy = http.createServer()
  const sockets = new Set<net.Socket>()
  proxy.on('connect', (req, client, head) => {
    tunnels.push(req.url!)
    const [host, port] = req.url!.split(':')
    const upstream = net.connect(Number(port), host, () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); upstream.pipe(client); client.pipe(upstream) })
    sockets.add(upstream); sockets.add(client as net.Socket)
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy())
  })
  await Promise.all([new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve)), new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))])
  const port = (target.address() as net.AddressInfo).port
  try {
    for (const proxyUrl of [undefined, `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`]) {
      const result = await pinnedImageTransport({ url: new URL(`http://unresolvable.synthetic:${port}/image`), address: '127.0.0.1', signal: signal(), proxyUrl })
      assert.equal(await result.response.text(), 'image')
      await result.dispose()
    }
    assert.deepEqual(tunnels, [`127.0.0.1:${port}`])
    for (const headers of seen) { assert.equal(headers.host, `unresolvable.synthetic:${port}`); assert.equal(headers.authorization, undefined); assert.equal(headers['x-api-key'], undefined) }
  } finally {
    for (const socket of sockets) socket.destroy()
    await Promise.all([new Promise<void>(resolve => target.close(() => resolve())), new Promise<void>(resolve => proxy.close(() => resolve()))])
  }
})

test('R03: 压缩响应按解压后字节限制，Content-Length 提前拒绝、空 data URL 拒绝', async () => {
  const compressed = gzipSync(Buffer.alloc(2000, 65))
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png', 'content-encoding': 'gzip', 'content-length': compressed.length })
    res.end(compressed)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    await assert.rejects(resolveImageUrls(imageRequest(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}/image`), undefined, {
      settings: { ...getSettings(), image_allowed_hosts: ['127.0.0.1'], image_max_bytes: 100 },
    }), /单张/)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  await assert.rejects(resolveImageUrls(imageRequest('http://public.test/a'), undefined, {
    lookup: publicLookup, settings: { ...getSettings(), image_max_bytes: 100 },
    transport: transport(new Response('a', { headers: { 'content-length': '1000' } })),
  }), /Content-Length/)
  await assert.rejects(resolveImageUrls(imageRequest('data:image/png;base64,')), /base64/)
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
