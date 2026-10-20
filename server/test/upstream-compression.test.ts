import './helpers/isolated'
import test, { after, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { db, getSettings, setSettings } from '../src/db'
import { validateSettingsPatch } from '../src/core/settingsValidation'
import { ZSTD_AVAILABLE, createRequestCompressor, isUnsupported, markUnsupported, unsupportedList } from '../src/core/upstreamCompression'
import { reset, channel, relay, logs, jsonResponse, oaiBody } from './helpers/relay'

const originalFetch = globalThis.fetch
beforeEach(() => {
  reset()
  setSettings({ upstream_compression_enabled: true, upstream_compression_min_bytes: 0 })
})
afterEach(() => { globalThis.fetch = originalFetch })
after(() => db.close())

interface Sent { encoding: string | undefined; bytes: number; text: string }

/** 按 content-encoding 解压上游收到的请求体 */
function decode(options: any): Sent {
  const encoding = options.headers['content-encoding']
  const buf = Buffer.from(options.body)
  const plain = encoding === 'gzip' ? zlib.gunzipSync(buf)
    : encoding === 'br' ? zlib.brotliDecompressSync(buf)
      : encoding === 'zstd' ? zlib.zstdDecompressSync(buf) : buf
  return { encoding, bytes: buf.length, text: plain.toString() }
}

function upstream(respond: (sent: Sent) => Response = () => jsonResponse(oaiBody)): Sent[] {
  const calls: Sent[] = []
  globalThis.fetch = (async (_url: any, options: any) => {
    const sent = decode(options)
    calls.push(sent)
    return respond(sent)
  }) as typeof fetch
  return calls
}

const rejected = () => jsonResponse({ error: { message: 'invalid JSON body' } }, 400)
const rejectCompressed = (sent: Sent) => sent.encoding ? rejected() : jsonResponse(oaiBody)

test('总开关关闭：不带 content-encoding，日志只记录字节数', async () => {
  setSettings({ upstream_compression_enabled: false })
  channel('openai')
  const calls = upstream()
  await relay('openai', false).run()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].encoding, undefined)
  const [log] = logs()
  assert.equal(log.compress_status, null)
  assert.equal(log.upstream_encoding, null)
  assert.equal(log.upstream_raw_bytes, calls[0].bytes)
  assert.equal(log.upstream_sent_bytes, log.upstream_raw_bytes)
})

for (const algorithm of ['gzip', 'br', 'zstd'] as const) {
  test(`跟随全局：${algorithm} 压缩发送，解压后与明文一致`, { skip: algorithm === 'zstd' && !ZSTD_AVAILABLE }, async () => {
    setSettings({ upstream_compression_default: algorithm })
    channel('openai')
    const calls = upstream()
    await relay('openai', false).run()
    assert.equal(calls[0].encoding, algorithm)
    assert.equal(JSON.parse(calls[0].text).messages[0].content, 'hi')
    const [log] = logs()
    assert.equal(log.status, 'success')
    assert.equal(log.compress_status, 'compressed')
    assert.equal(log.upstream_encoding, { gzip: 'gzip-1', br: 'br-2', zstd: 'zstd-2 w23' }[algorithm])
    assert.equal(log.upstream_raw_bytes, Buffer.byteLength(calls[0].text))
    assert.equal(log.upstream_sent_bytes, calls[0].bytes)
    assert.equal(typeof log.compress_ms, 'number')
  })
}

test('渠道关闭压缩记为 off，小于阈值记为 below_min', async () => {
  const id = channel('openai')
  db.prepare("UPDATE channels SET request_compression = 'off' WHERE id = ?").run(id)
  const calls = upstream()
  await relay('openai', false).run()
  db.prepare('UPDATE channels SET request_compression = NULL WHERE id = ?').run(id)
  setSettings({ upstream_compression_min_bytes: 1_000_000 })
  await relay('openai', false).run()
  assert.deepEqual(calls.map(c => c.encoding), [undefined, undefined])
  assert.deepEqual(logs().map(l => l.compress_status), ['off', 'below_min'])
})

test('压缩被拒：同一次尝试内明文重发成功并记忆，下一个请求直接发明文', async () => {
  setSettings({ upstream_compression_default: 'gzip' })
  const id = channel('openai')
  const calls = upstream(rejectCompressed)
  const first = relay('openai', false)
  await first.run()
  assert.equal(first.res.statusCode, 200)
  assert.deepEqual(calls.map(c => c.encoding), ['gzip', undefined])
  await relay('openai', false).run()
  assert.equal(calls[2].encoding, undefined)
  const [a, b] = logs()
  assert.equal(a.compress_status, 'fallback_ok')
  assert.equal(a.retry_count, 0)
  assert.equal(a.upstream_sent_bytes, calls[0].bytes + calls[1].bytes)
  assert.match(a.compress_note, /invalid JSON body/)
  // 被拒的错误体只进压缩备注，上游原始回复是重发后的成功响应
  assert.doesNotMatch(a.upstream_response_body, /invalid JSON body/)
  assert.equal(b.compress_status, 'channel_unsupported')
  assert.ok(isUnsupported(id, 'gzip'))
})

test('错误体不匹配正则：不重发，按原错误流程处理', async () => {
  setSettings({ upstream_compression_default: 'gzip' })
  channel('openai')
  const calls = upstream(() => jsonResponse({ error: { message: 'prompt is too long' } }, 400))
  const r = relay('openai', false)
  await r.run()
  assert.equal(calls.length, 1)
  assert.equal(r.res.statusCode, 400)
  const [log] = logs()
  assert.equal(log.compress_status, 'compressed')
  assert.equal(log.compress_note, null)
  assert.match(log.upstream_response_body, /prompt is too long/)
})

test('明文重发仍失败：记为 fallback_failed，不写入记忆', async () => {
  setSettings({ upstream_compression_default: 'gzip' })
  const id = channel('openai')
  const calls = upstream(rejected)
  await relay('openai', false).run()
  assert.deepEqual(calls.map(c => c.encoding), ['gzip', undefined])
  assert.equal(logs()[0].compress_status, 'fallback_failed')
  assert.ok(!isUnsupported(id, 'gzip'))
  await relay('openai', false).run()
  assert.equal(calls[2].encoding, 'gzip')
})

test('回退开关关闭：记为 rejected，不重发', async () => {
  setSettings({ upstream_compression_default: 'gzip', upstream_compression_fallback: false })
  channel('openai')
  const calls = upstream(rejectCompressed)
  const r = relay('openai', false)
  await r.run()
  assert.equal(calls.length, 1)
  assert.equal(r.res.statusCode, 400)
  const [log] = logs()
  assert.equal(log.compress_status, 'rejected')
  assert.match(log.upstream_response_body, /invalid JSON body/)
})

test('记忆按设置的分钟数到期，0 表示直到重启', () => {
  const now = 1_000_000
  markUnsupported(9001, 'zstd', { upstream_compression_unsupported_minutes: 10 }, now)
  assert.ok(isUnsupported(9001, 'zstd', now + 10 * 60_000 - 1))
  assert.ok(!isUnsupported(9001, 'zstd', now + 10 * 60_000 + 1))
  markUnsupported(9002, 'br', { upstream_compression_unsupported_minutes: 0 }, now)
  assert.deepEqual(unsupportedList(9002, now + 1e12), [{ algorithm: 'br', until: null }])
})

test('请求级压缩器：同一请求体并发调用只压缩一次', async () => {
  const settings = { ...getSettings(), upstream_compression_default: 'gzip' as const }
  const compressor = createRequestCompressor()
  const body = JSON.stringify({ text: 'x'.repeat(10_000) })
  const ch = { id: 9999, request_compression: null }
  const [a, b] = await Promise.all([compressor.encode(ch, body, settings), compressor.encode(ch, body, settings)])
  assert.equal(a.body, b.body)
  assert.equal(a.info.status, 'compressed')
  assert.equal(b.info.ms, 0)
  assert.ok(a.info.sent_bytes < a.info.raw_bytes)
  assert.equal(zlib.gunzipSync(a.body as Buffer).toString(), body)
})

test('设置校验：zstd 窗口、回退正则、状态码与默认算法', () => {
  const settings = getSettings()
  for (const patch of [
    { upstream_compression_zstd_window_log: 5 },
    { upstream_compression_zstd_window_log: 24 },
    { upstream_compression_fallback_pattern: '(' },
    { upstream_compression_fallback_codes: '400,abc' },
    { upstream_compression_default: 'lz4' },
  ]) assert.throws(() => validateSettingsPatch(settings, patch), new RegExp(Object.keys(patch)[0]))
  for (const patch of [{ upstream_compression_zstd_window_log: 0 }, { upstream_compression_zstd_window_log: 10 }, { upstream_compression_fallback_pattern: '' }]) {
    assert.deepEqual(validateSettingsPatch(settings, patch), patch)
  }
})
