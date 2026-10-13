import './helpers/isolated'
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { isBlockedAddress, assertPublicUrl, safeLookup } from '../src/core/ssrf'
import { resolveImageUrls } from '../src/core/imageResolver'
import { CandidateError } from '../src/core/failover'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

const imageIr = (url: string) => ({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }] })
const imageSettings = { image_max_bytes: 1024 * 1024, proxy_url: '' }
const signal = () => new AbortController().signal

test('isBlockedAddress 拒绝内网与保留地址', () => {
  for (const ip of [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', '[::1]',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', 'not-an-ip',
  ]) {
    assert.equal(isBlockedAddress(ip), true, `${ip} 应被拒绝`)
  }
})

test('isBlockedAddress 放行公网地址', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isBlockedAddress(ip), false, `${ip} 应放行`)
  }
})

test('assertPublicUrl 拒绝非 http(s)、内网 IP 与内网域名', async () => {
  for (const url of ['http://127.0.0.1/x', 'http://[::1]/x', 'http://localhost/x', 'ftp://example.com/x']) {
    await assert.rejects(assertPublicUrl(new URL(url)), CandidateError, `${url} 应拒绝`)
  }
})

test('公网模式：拦截内网 URL，不发出请求', async () => {
  let calls = 0
  globalThis.fetch = (async () => { calls++; return new Response(null) }) as typeof fetch
  await assert.rejects(resolveImageUrls(imageIr('http://127.0.0.1:1/a.png'), imageSettings, signal(), { restrictPrivate: true }), CandidateError)
  assert.equal(calls, 0)
})

test('公网模式：重定向到内网被拦截，只请求一跳', async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } })
  }) as typeof fetch
  await assert.rejects(resolveImageUrls(imageIr('http://93.184.216.34/a.png'), imageSettings, signal(), { restrictPrivate: true }), CandidateError)
  assert.equal(calls, 1)
})

test('公网模式：直连公网 IP 图片成功转 data URL', async () => {
  globalThis.fetch = (async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })) as typeof fetch
  const ir: any = imageIr('http://93.184.216.34/a.png')
  await resolveImageUrls(ir, imageSettings, signal(), { restrictPrivate: true })
  assert.equal(ir.messages[0].content[0].image_url.url, 'data:image/png;base64,AQID')
})

test('safeLookup 拒绝解析到回环的域名', async () => {
  await new Promise<void>((resolve, reject) => {
    safeLookup('localhost', { all: true }, (error) => error ? resolve() : reject(new Error('应返回错误')))
  })
})
