import './helpers/isolated'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/db'
import { cleanupOldLogs, recordLog } from '../src/stats/recorder'
import { getJsonBody } from '../src/stats/blobstore'

after(() => db.close())

test('维护单飞，小批删除期间新增日志不会被回收，旧日志按预算逐轮清完', async () => {
  const insert = db.prepare("INSERT INTO request_logs(created_at,status) VALUES (1,'success')")
  db.transaction(() => { for (let i = 0; i < 5100; i++) insert.run() })()
  const first = cleanupOldLogs()
  assert.equal(cleanupOldLogs(), first)
  const body = JSON.stringify({ messages: [{ role: 'user', content: '维护期间新增的日志'.repeat(50) }] })
  recordLog({ channel_id: null, channel_name: null, entry_format: 'openai', model: 'new', upstream_model: null,
    status: 'success', status_code: 200, latency_ms: 1, request_body: body, request_id: 'during-maintenance' })
  await first
  assert.equal(db.prepare('SELECT COUNT(*) FROM request_logs WHERE created_at=1').pluck().get(), 100)
  const ref = db.prepare("SELECT request_body_ref FROM request_logs WHERE request_id='during-maintenance'").pluck().get() as number
  assert.equal(getJsonBody(ref), body)
  await cleanupOldLogs()
  assert.equal(db.prepare('SELECT COUNT(*) FROM request_logs WHERE created_at=1').pluck().get(), 0)
  assert.equal(getJsonBody(ref), body)
})
