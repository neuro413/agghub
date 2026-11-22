import './helpers/isolated'
import test, { after, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import express from 'express'
import { db, setSettings } from '../src/db'
import { canonicalQueryString, canonicalUri, parseAwsCredentials, signAwsV4 } from '../src/adapters/bedrock-auth'
import { crc32, encodeEventStreamFrame, parseBedrockEventStream } from '../src/adapters/bedrock-stream'
import { BEDROCK_ANTHROPIC_VERSION } from '../src/adapters/bedrock'
import { handleRelay } from '../src/core/relay'
import * as anthropicConv from '../src/convert/anthropic'
import { channelsRouter } from '../src/routes/channels'
import { FakeResponse, reset, channel, relay, logs, jsonResponse, anthBody, anthEvents } from './helpers/relay'

const originalFetch = globalThis.fetch
const SAMPLE_AK = 'AKIAIOSFODNN7EXAMPLE'
const SAMPLE_SK = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
const SAMPLE_KEY = `${SAMPLE_AK}|${SAMPLE_SK}`

/** 将标准 Anthropic 事件数组打包为 AWS Bedrock application/vnd.amazon.eventstream 响应 */
function bedrockStreamResponse(events: any[], chunkSize?: number): globalThis.Response {
  const frames = events.map((ev) => {
    const payload = JSON.stringify({ bytes: Buffer.from(JSON.stringify(ev), 'utf8').toString('base64') })
    return encodeEventStreamFrame({ ':message-type': 'event', ':event-type': 'chunk', ':content-type': 'application/json' }, payload)
  })
  const full = Buffer.concat(frames)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (chunkSize && chunkSize > 0) {
        for (let i = 0; i < full.length; i += chunkSize) {
          controller.enqueue(full.subarray(i, Math.min(i + chunkSize, full.length)))
        }
      } else {
        controller.enqueue(full)
      }
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/vnd.amazon.eventstream' } })
}

function createBedrockChannel(extra: Partial<{ region: string; base_url: string | null; mapping: Record<string, string>; apiKey: string; strip_headers: number }> = {}) {
  const id = channel('bedrock', 0, extra.mapping ?? { 'claude-sonnet': 'us.anthropic.claude-sonnet-4-5-20250929-v1:0' }, extra.apiKey ?? SAMPLE_KEY)
  // helpers/relay.ts 的 channel() 默认填充 http://synthetic.invalid，默认置空以验证官方域名拼接
  db.prepare('UPDATE channels SET base_url = ? WHERE id = ?').run(extra.base_url ?? null, id)
  if (extra.region !== undefined) db.prepare('UPDATE channels SET region = ? WHERE id = ?').run(extra.region, id)
  if (extra.strip_headers !== undefined) db.prepare('UPDATE channels SET strip_headers = ? WHERE id = ?').run(extra.strip_headers, id)
  return id
}

beforeEach(reset)
afterEach(() => { globalThis.fetch = originalFetch })
after(() => db.close())

test('parseAwsCredentials 支持多种凭证格式并拒绝非法输入', () => {
  assert.deepEqual(parseAwsCredentials(`${SAMPLE_AK}|${SAMPLE_SK}`), { accessKeyId: SAMPLE_AK, secretAccessKey: SAMPLE_SK })
  assert.deepEqual(parseAwsCredentials(`${SAMPLE_AK}|${SAMPLE_SK}|tok123`), { accessKeyId: SAMPLE_AK, secretAccessKey: SAMPLE_SK, sessionToken: 'tok123' })
  assert.deepEqual(parseAwsCredentials(`${SAMPLE_AK}:${SAMPLE_SK}`), { accessKeyId: SAMPLE_AK, secretAccessKey: SAMPLE_SK })
  assert.deepEqual(parseAwsCredentials(`${SAMPLE_AK}:${SAMPLE_SK}:tok456`), { accessKeyId: SAMPLE_AK, secretAccessKey: SAMPLE_SK, sessionToken: 'tok456' })
  assert.deepEqual(
    parseAwsCredentials(JSON.stringify({ AccessKeyId: SAMPLE_AK, SecretAccessKey: SAMPLE_SK, SessionToken: 'sts', region: 'us-west-2' })),
    { accessKeyId: SAMPLE_AK, secretAccessKey: SAMPLE_SK, sessionToken: 'sts', region: 'us-west-2' },
  )
  assert.deepEqual(
    parseAwsCredentials(JSON.stringify({ access_key_id: SAMPLE_AK, secret_access_key: SAMPLE_SK })),
    { accessKeyId: SAMPLE_AK, secretAccessKey: SAMPLE_SK },
  )
  assert.equal(parseAwsCredentials(''), null)
  assert.equal(parseAwsCredentials('just-a-plain-key'), null)
  assert.equal(parseAwsCredentials('{bad json'), null)
  assert.equal(parseAwsCredentials('only-ak|'), null)
})

test('AWS SigV4 签名：规范 URI 双重编码、Query 排序、Payload Hash 与 SessionToken', () => {
  const modelId = 'anthropic.claude-3-5-sonnet-20241022-v2:0'
  const url = `https://bedrock-runtime.us-east-1.amazonaws.com/model/${encodeURIComponent(modelId)}/invoke`
  // HTTP 路径中 : 为 %3A，SigV4 规范 URI 应双重编码为 %253A
  assert.equal(canonicalUri(new URL(url).pathname), '/model/anthropic.claude-3-5-sonnet-20241022-v2%253A0/invoke')

  // ARN 同时包含 : 与 /，双重编码后应为 %253A 和 %252F
  const arn = 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0'
  const arnUrl = `https://bedrock-runtime.us-east-1.amazonaws.com/model/${encodeURIComponent(arn)}/invoke`
  assert.ok(canonicalUri(new URL(arnUrl).pathname).includes('%252F'))
  assert.ok(canonicalUri(new URL(arnUrl).pathname).includes('%253A'))

  // Query string 按键值排序
  assert.equal(canonicalQueryString(new URL('https://example.com/?b=2&a=1&a=0').searchParams), 'a=0&a=1&b=2')

  const body = JSON.stringify({ anthropic_version: BEDROCK_ANTHROPIC_VERSION, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })
  const fixedDate = new Date('2026-05-01T12:34:56.000Z')
  const signed = signAwsV4({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'test-ua' },
    body,
    credentials: { accessKeyId: SAMPLE_AK, secretAccessKey: SAMPLE_SK, sessionToken: 'temp-session' },
    region: 'us-east-1',
    service: 'bedrock',
    date: fixedDate,
  })

  assert.equal(signed['x-amz-date'], '20260501T123456Z')
  assert.equal(signed['x-amz-security-token'], 'temp-session')
  assert.equal(signed['x-amz-content-sha256'], crypto.createHash('sha256').update(body).digest('hex'))
  assert.match(
    signed.authorization,
    /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20260501\/us-east-1\/bedrock\/aws4_request, SignedHeaders=accept;content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/,
  )
  // user-agent 不参与签名但被保留
  assert.equal(signed['user-agent'], 'test-ua')
})

test('AWS EventStream 二进制解码：跨分片粘包解帧、CRC32 校验与流内异常状态码映射', async () => {
  // 标准 CRC32 测试向量
  assert.equal(crc32(Buffer.from('123456789', 'ascii')), 0xcbf43926)

  // 按极小 7 字节分片流式读取多帧
  const resp = bedrockStreamResponse(anthEvents(), 7)
  const events: any[] = []
  for await (const ev of parseBedrockEventStream(resp.body!)) events.push(ev)
  assert.equal(events.length, anthEvents().length)
  assert.equal(events[0].event, 'message_start')
  assert.equal(JSON.parse(events[2].data).delta.text, '你好🙂')

  // CRC32 损坏应报错
  const corrupt = Buffer.from(encodeEventStreamFrame({ ':message-type': 'event', ':event-type': 'chunk' }, '{"bytes":"e30="}'))
  corrupt[corrupt.length - 1] ^= 0xff
  const corruptStream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(corrupt); c.close() } })
  await assert.rejects(
    async () => { for await (const _ of parseBedrockEventStream(corruptStream)) {} },
    (err: any) => err?.status === 502 && /CRC32/.test(err?.body || ''),
  )

  // 流内 throttlingException 应映射为 429 UpstreamError
  const throttleFrame = encodeEventStreamFrame(
    { ':message-type': 'exception', ':exception-type': 'throttlingException' },
    JSON.stringify({ message: 'Too many requests' }),
  )
  const throttleStream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(throttleFrame); c.close() } })
  await assert.rejects(
    async () => { for await (const _ of parseBedrockEventStream(throttleStream)) {} },
    (err: any) => err?.status === 429 && err?.body?.includes('Too many requests'),
  )
})

for (const format of ['openai', 'anthropic', 'responses'] as const) {
  for (const streaming of [false, true]) {
    test(`端到端中继 ${format} → bedrock (stream=${streaming})`, async () => {
      createBedrockChannel({ region: 'us-west-2' })
      let capturedUrl = ''
      let capturedHeaders: Record<string, string> = {}
      let capturedBody: any = null

      globalThis.fetch = (async (url: any, init: any) => {
        capturedUrl = String(url)
        capturedHeaders = init?.headers || {}
        capturedBody = JSON.parse(String(init?.body || '{}'))
        return streaming ? bedrockStreamResponse(anthEvents(), 13) : jsonResponse(anthBody)
      }) as typeof fetch

      const res = new FakeResponse()
      if (format === 'anthropic') {
        const raw = { model: 'claude-sonnet', stream: streaming, messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 }
        await handleRelay({
          entryFormat: 'anthropic',
          stream: streaming,
          ir: anthropicConv.parseRequest(raw).ir,
          rawBody: raw,
          rawHeaders: { 'anthropic-beta': 'interleaved-thinking-2025-05-14, context-1m-2025-08-07' },
          res: res as any,
        })
      } else {
        await relay(format, streaming, res, { model: 'claude-sonnet' }).run()
      }

      assert.equal(res.statusCode, 200)
      assert.equal(
        capturedUrl,
        `https://bedrock-runtime.us-west-2.amazonaws.com/model/us.anthropic.claude-sonnet-4-5-20250929-v1%3A0/${streaming ? 'invoke-with-response-stream' : 'invoke'}`,
      )
      assert.match(capturedHeaders.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/us-west-2\/bedrock\/aws4_request/)
      assert.equal(capturedBody.anthropic_version, BEDROCK_ANTHROPIC_VERSION)
      assert.equal(capturedBody.model, undefined)
      assert.equal(capturedBody.stream, undefined)
      if (format === 'anthropic') {
        assert.deepEqual(capturedBody.anthropic_beta, ['interleaved-thinking-2025-05-14', 'context-1m-2025-08-07'])
      }
      assert.ok(JSON.stringify(res.jsonBody || res.chunks).includes('你好'))
      const [row] = logs().filter((r) => !r.is_retry)
      assert.equal(row.status, 'success')
      assert.equal(row.total_tokens, 5)
    })
  }
}

test('参数规则与请求体压缩后重签 SigV4，Payload Hash 与实际发出字节严格一致', async () => {
  const channelId = createBedrockChannel({ region: 'us-east-1' })
  setSettings({
    upstream_compression_enabled: true,
    upstream_compression_default: 'gzip',
    upstream_compression_min_bytes: 0,
    param_rules: [{ id: 'r1', enabled: true, channelIds: [channelId], ops: [{ type: 'set', key: 'top_k', value: '42' }] }],
  })

  let sentHeaders: Record<string, string> = {}
  let sentBody: string | Buffer = ''
  globalThis.fetch = (async (_url: any, init: any) => {
    sentHeaders = init?.headers || {}
    sentBody = init?.body
    return jsonResponse(anthBody)
  }) as typeof fetch

  const req = relay('openai', false, undefined, { model: 'claude-sonnet' })
  await req.run()

  assert.equal(req.res.statusCode, 200)
  assert.equal(sentHeaders['content-encoding'], 'gzip')
  assert.ok(Buffer.isBuffer(sentBody))
  // 校验签名头里的 payload hash 确实等于压缩后 Buffer 的 SHA-256
  assert.equal(sentHeaders['x-amz-content-sha256'], crypto.createHash('sha256').update(sentBody).digest('hex'))
  assert.ok(sentHeaders.authorization.includes('content-encoding'))
})

test('POST /channels/test：Bedrock 拉取模型列表与 403 最小权限自动回退探活', async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/channels', channelsRouter)
  const server = app.listen(0)
  const port = (server.address() as any).port
  const base = `http://127.0.0.1:${port}`

  try {
    // 1. 正常拉取控制面 Inference Profiles + Foundation Models
    globalThis.fetch = (async (url: any, init: any) => {
      const u = String(url)
      if (u.startsWith(base)) return originalFetch(url, init)
      if (u.includes('/inference-profiles')) {
        return jsonResponse({
          inferenceProfileSummaries: [
            { inferenceProfileId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0' },
            { inferenceProfileId: 'us.amazon.nova-pro-v1:0' },
          ],
        })
      }
      if (u.includes('/foundation-models')) {
        return jsonResponse({
          modelSummaries: [{ modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0' }],
        })
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch

    const res1 = await originalFetch(`${base}/api/channels/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'bedrock', region: 'us-east-1', api_key: SAMPLE_KEY, models: [] }),
    })
    const data1: any = await res1.json()
    assert.equal(data1.ok, true)
    assert.deepEqual(data1.models, ['us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'anthropic.claude-3-5-sonnet-20241022-v2:0'])

    // 2. 控制面 403 AccessDenied 时，有配置模型则自动回退到 InvokeModel 探活
    let invoked = false
    globalThis.fetch = (async (url: any, init: any) => {
      const u = String(url)
      if (u.startsWith(base)) return originalFetch(url, init)
      if (u.includes('/inference-profiles') || u.includes('/foundation-models')) {
        return new Response(JSON.stringify({ message: 'User is not authorized to perform: bedrock:ListFoundationModels' }), { status: 403 })
      }
      if (u.includes('/model/') && u.endsWith('/invoke')) {
        invoked = true
        return jsonResponse(anthBody)
      }
      return new Response('unexpected', { status: 500 })
    }) as typeof fetch

    const res2 = await originalFetch(`${base}/api/channels/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'bedrock', region: 'us-east-1', api_key: SAMPLE_KEY, models: ['us.anthropic.claude-sonnet-4-5-20250929-v1:0'] }),
    })
    const data2: any = await res2.json()
    assert.equal(data2.ok, true)
    assert.equal(invoked, true)
  } finally {
    server.close()
  }
})
