import './helpers/isolated'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import zlib from 'node:zlib'
import { db } from '../src/db'
import { hydrateLogRow, recordLog } from '../src/stats/recorder'
import { logsRouter } from '../src/routes/logs'

const app = express()
app.use('/logs', logsRouter)
app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ error: error.message }))
const server = app.listen(0, '127.0.0.1')
await new Promise<void>(resolve => server.once('listening', resolve))
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/logs`
after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  db.close()
})

const message = { role: 'user', content: '共享的长消息🙂'.repeat(200) }
const request = JSON.stringify({ messages: [message], model: 'a' })
const processed = JSON.stringify({ messages: [message], model: 'b' })
await recordLog({
  channel_id: null, channel_name: null, entry_format: 'openai', model: 'test', upstream_model: null,
  status: 'success', status_code: 200, latency_ms: 1,
  request_body: request, preprocessed_body: processed, response_body: '{"reply":"ok"}', upstream_response_body: 'data: 原始回复\n\n',
})
const row = db.prepare('SELECT * FROM request_logs LIMIT 1').get() as any

test('一次详情还原共享子块只解压一次，全部字段保持还原一致', () => {
  const original = zlib.zstdDecompressSync
  let calls = 0
  zlib.zstdDecompressSync = ((...args: Parameters<typeof original>) => { calls++; return original(...args) }) as typeof original
  try {
    const detail = hydrateLogRow(row)
    assert.equal(detail.request_body, request)
    assert.equal(detail.preprocessed_body, processed)
    assert.equal(detail.response_body, '{"reply":"ok"}')
    assert.equal(calls, 1)
  } finally { zlib.zstdDecompressSync = original }
})

test('fields 接口区分未加载与未保存，不泄露存储引用，省略参数兼容完整详情', async () => {
  assert.ok(!Object.hasOwn(hydrateLogRow({ ...row, response_body: '旧的明文列' }, []), 'response_body'))
  const meta = await (await fetch(`${base}/${row.id}?fields=`)).json() as any
  assert.equal(meta.id, row.id)
  assert.ok(meta.available_fields.includes('request_body'))
  assert.ok(meta.available_fields.includes('upstream_response_body'))
  assert.ok(!Object.hasOwn(meta, 'request_body'))
  assert.ok(!Object.keys(meta).some(key => key.endsWith('_ref')))
  const selected = await (await fetch(`${base}/${row.id}?fields=request_body,request_headers`)).json() as any
  assert.equal(selected.request_body, request)
  assert.equal(selected.request_headers, null)
  assert.ok(!Object.hasOwn(selected, 'response_body'))
  const full = await (await fetch(`${base}/${row.id}`)).json() as any
  assert.equal(full.preprocessed_body, processed)
  assert.equal(full.upstream_response_body, 'data: 原始回复\n\n')
  assert.equal((await fetch(`${base}/${row.id}?fields=data`)).status, 400)
  assert.equal((await fetch(`${base}/${row.id}?fields=request_body&fields=response_body`)).status, 400)
  assert.equal((await fetch(`${base}/999999?fields=`)).status, 404)
})

test('只取请求正文时不解压损坏的上游响应字段', async () => {
  db.prepare('UPDATE blobs SET codec=999 WHERE id=?').run(row.upstream_response_body_ref)
  const response = await fetch(`${base}/${row.id}?fields=request_body`)
  assert.equal(response.status, 200)
  assert.equal((await response.json() as any).request_body, request)
  assert.equal((await fetch(`${base}/${row.id}?fields=upstream_response_body`)).status, 500)
})
