import './helpers/isolated'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { db, getSettings, setSettings } from '../src/db'
import { recordLog, safeRecordLog, hydrateLogRow, type LogEntry } from '../src/stats/recorder'
import { gcBlobs, getJsonBody, putJsonBody } from '../src/stats/blobstore'
import { statsRouter } from '../src/routes/stats'
after(() => db.close())

const entry: LogEntry = {
  channel_id: null, channel_name: null, entry_format: 'openai', model: 'synthetic', upstream_model: 'synthetic',
  status: 'success', status_code: 200, latency_ms: 123, attempt_latency_ms: 23,
  request_body: '{"messages":[{"content":"中文"}]}', response_body: '{"reply":"🙂"}', upstream_response_body: 'data: 🙂\n\n',
}

test('D06: 日志构造、序列化及 SQLite 故障不越过安全边界，写入保持事务性', () => {
  assert.equal(safeRecordLog(() => { throw new Error('合成序列化失败') }), false)
  const invalid: any = { ...entry, response_body: { toString() { throw new Error('合成压缩输入失败') } } }
  assert.equal(safeRecordLog(() => invalid), false)
  db.exec("CREATE TRIGGER reject_log BEFORE INSERT ON request_logs BEGIN SELECT RAISE(FAIL, '合成写入失败'); END")
  const before = (db.prepare('SELECT COUNT(*) n FROM blobs').get() as any).n
  try {
    assert.equal(safeRecordLog(() => entry), false)
    assert.equal((db.prepare('SELECT COUNT(*) n FROM blobs').get() as any).n, before)
  } finally { db.exec('DROP TRIGGER reject_log') }
  assert.equal(safeRecordLog(() => ({ ...entry, request_id: 'recorded' })), true)
  const row = hydrateLogRow(db.prepare("SELECT * FROM request_logs WHERE request_id='recorded'").get())
  assert.equal(row.request_body, entry.request_body)
  assert.equal(row.response_body, entry.response_body)
  assert.equal(row.attempt_latency_ms, 23)
})

test('日志存储采用请求快照，关闭正文没有引用，截断元数据独立于业务状态', () => {
  const snapshot = { ...getSettings(), store_request_body: false, store_response_body: false }
  recordLog({ ...entry, request_id: 'disabled' }, snapshot)
  const disabled = hydrateLogRow(db.prepare("SELECT * FROM request_logs WHERE request_id='disabled'").get())
  assert.equal(disabled.request_body, null)
  assert.equal(disabled.response_body, null)
  setSettings({ store_response_body: false })
  recordLog({ ...entry, request_id: 'snapshot', response_body_truncated: true }, { store_request_body: true, store_response_body: true })
  const captured = hydrateLogRow(db.prepare("SELECT * FROM request_logs WHERE request_id='snapshot'").get())
  assert.equal(captured.response_body, entry.response_body)
  assert.equal(captured.response_body_truncated, 1)
  assert.equal(captured.status, 'success')
  setSettings({ store_response_body: true })
})

test('块 GC 保留日志 manifest 子块，只回收未引用块', () => {
  const body = JSON.stringify({ messages: [{ content: '共享'.repeat(300) }] })
  recordLog({ ...entry, request_id: 'gc-kept', request_body: body })
  const ref = (db.prepare("SELECT request_body_ref FROM request_logs WHERE request_id='gc-kept'").get() as any).request_body_ref
  putJsonBody('{"unused":"orphan"}')
  assert.ok(gcBlobs() > 0)
  assert.equal(getJsonBody(ref), body)
})

test('D07: 真实 SQLite REAL 参数分桶，24h/7d/30d 的趋势与总览相等', async () => {
  db.exec('DELETE FROM request_logs')
  const now = 1790043967123
  const originalNow = Date.now
  Date.now = () => now
  const insert = db.prepare('INSERT INTO request_logs(created_at,status,total_tokens,is_retry,latency_ms,cache_read_tokens) VALUES (?,?,?,?,?,?)')
  const ages = [0, 1, 3600000, 86400000, 7 * 86400000, 30 * 86400000, 31 * 86400000, -1]
  ages.forEach((age, i) => insert.run(now - age, i % 2 ? 'error' : 'success', i + 3, 0, 100, 2))
  insert.run(now - 1000, 'error', 900, 1, 10, 0)
  assert.equal((db.prepare('SELECT typeof(?) type').get(3600000) as any).type, 'real')
  const app = express()
  app.use('/stats', statsRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    for (const [range, count] of [['24h', 4], ['7d', 5], ['30d', 6]] as const) {
      const result = await (await fetch(`${base}/stats?range=${range}`)).json() as any
      assert.equal(result.overview.total, count)
      assert.equal(result.trend.reduce((n: number, row: any) => n + row.requests, 0), count)
      assert.equal(result.trend.reduce((n: number, row: any) => n + row.tokens, 0), result.overview.total_tokens)
      assert.ok(result.trend.every((row: any) => row.bucket % result.bucketMs === 0))
    }
    db.exec('DELETE FROM request_logs')
    const empty = await (await fetch(`${base}/stats`)).json() as any
    assert.equal(empty.overview.total, 0)
    assert.ok(empty.trend.every((row: any) => row.requests === 0 && row.tokens === 0))
  } finally {
    Date.now = originalNow
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
