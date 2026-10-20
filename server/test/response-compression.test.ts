import './helpers/isolated'
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import express from 'express'
import type { Server } from 'node:http'
import { db, setSettings } from '../src/db'
import { createApp } from '../src/app'
import { precompressedAssets, shouldCompressResponse, staticOptions } from '../src/core/responseCompression'

let portal: Server
let assets: Server
let portalBase = ''
let assetsBase = ''
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agghub-assets-'))
const script = `console.log(${JSON.stringify('x'.repeat(4096))})`

async function listen(app: express.Express): Promise<[Server, string]> {
  const server = app.listen(0)
  await new Promise<void>(resolve => server.once('listening', resolve))
  return [server, `http://127.0.0.1:${(server.address() as { port: number }).port}`]
}

before(async () => {
  const root = path.join(dir, 'assets')
  fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, 'a.js'), script)
  fs.writeFileSync(path.join(root, 'a.js.br'), zlib.brotliCompressSync(script))
  fs.writeFileSync(path.join(root, 'a.js.gz'), zlib.gzipSync(script))
  // assets 目录之外的文件，路径穿越不能读到
  fs.writeFileSync(path.join(dir, 'secret.js'), script)
  fs.writeFileSync(path.join(dir, 'secret.js.br'), zlib.brotliCompressSync(script))
  ;[portal, portalBase] = await listen(createApp('public'))
  ;[assets, assetsBase] = await listen(express().use('/assets', precompressedAssets(root), (_req, res) => { res.status(404).send('next') }))
})
after(async () => {
  await Promise.all([portal, assets].map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  db.close()
})

const get = (url: string, encoding?: string) => fetch(url, { headers: encoding === undefined ? {} : { 'accept-encoding': encoding } })

test('门户接口按设置压缩，关闭开关后不压缩', async () => {
  setSettings({ response_compression_enabled: true, response_compression_threshold: 0, response_compression_br_quality: 0 })
  const gzip = await get(`${portalBase}/api/user/status`, 'gzip')
  assert.equal(gzip.headers.get('content-encoding'), 'gzip')
  await gzip.json()
  // br 质量为 0 时只用 gzip
  assert.equal((await get(`${portalBase}/api/user/status`, 'br, gzip')).headers.get('content-encoding'), 'gzip')
  setSettings({ response_compression_br_quality: 4 })
  assert.equal((await get(`${portalBase}/api/user/status`, 'br, gzip')).headers.get('content-encoding'), 'br')
  setSettings({ response_compression_enabled: false })
  assert.equal((await get(`${portalBase}/api/user/status`, 'gzip')).headers.get('content-encoding'), null)
})

test('/v1 不压缩', async () => {
  setSettings({ response_compression_enabled: true, response_compression_threshold: 0 })
  const res = await get(`${portalBase}/v1/models`, 'gzip')
  assert.equal(res.headers.get('content-encoding'), null)
})

test('SSE 与显示 Key 明文的接口不压缩', () => {
  const res = (type: string) => ({ getHeader: (name: string) => (name === 'Content-Type' ? type : undefined) }) as any
  assert.equal(shouldCompressResponse({ path: '/api/user/self' } as any, res('text/event-stream; charset=utf-8')), false)
  assert.equal(shouldCompressResponse({ path: '/api/user/keys/1/key' } as any, res('application/json')), false)
  assert.equal(shouldCompressResponse({ path: '/api/user/keys' } as any, res('application/json')), true)
})

test('预压缩文件：按 Accept-Encoding 优先 br 再 gzip，未接受压缩时交给后续中间件', async () => {
  setSettings({ static_precompressed: true, static_assets_max_age_days: 365 })
  const br = await get(`${assetsBase}/assets/a.js`, 'br, gzip')
  assert.equal(br.headers.get('content-encoding'), 'br')
  assert.match(br.headers.get('content-type') ?? '', /javascript/)
  assert.match(br.headers.get('vary') ?? '', /Accept-Encoding/)
  assert.equal(br.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  assert.equal(await br.text(), script)
  const gz = await get(`${assetsBase}/assets/a.js`, 'gzip')
  assert.equal(gz.headers.get('content-encoding'), 'gzip')
  assert.equal(await gz.text(), script)
  assert.equal(await (await get(`${assetsBase}/assets/a.js`, 'identity')).text(), 'next')
  assert.equal(await (await get(`${assetsBase}/assets/a.js`, 'br;q=0, gzip;q=0')).text(), 'next')
  assert.equal(await (await get(`${assetsBase}/assets/..%2fsecret.js`, 'br')).text(), 'next')
  assert.equal(await (await get(`${assetsBase}/assets/missing.js`, 'br')).text(), 'next')
  setSettings({ static_precompressed: false })
  assert.equal(await (await get(`${assetsBase}/assets/a.js`, 'br')).text(), 'next')
})

test('静态长缓存只加在 assets 目录下', () => {
  setSettings({ static_assets_max_age_days: 365 })
  const headers: Record<string, string> = {}
  const res = { setHeader: (name: string, value: string) => { headers[name] = value } } as any
  const { setHeaders } = staticOptions()
  setHeaders!(res, path.join('dist', 'index.html'), {} as fs.Stats)
  assert.equal(headers['Cache-Control'], undefined)
  setHeaders!(res, path.join('dist', 'assets', 'a.js'), {} as fs.Stats)
  assert.equal(headers['Cache-Control'], 'public, max-age=31536000, immutable')
})
