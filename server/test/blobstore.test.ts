import './helpers/isolated'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/db'
import { getJsonBody, putJsonBody } from '../src/stats/blobstore'

after(() => db.close())
const count = () => (db.prepare('SELECT COUNT(*) n FROM blobs').get() as any).n
const children = (hash: Buffer) => (db.prepare('SELECT child FROM blob_edges WHERE parent = ? ORDER BY child').all(hash) as any[]).map(row => row.child)

test('块存储保持字节还原、中文、非紧凑 JSON、原型同名数据与共享消息去重', () => {
  for (const text of ['', '不是JSON', '{ "a": 1 }', 'null', '[1,2]', '{"__proto__":{"x":1},"constructor":"ok"}']) {
    assert.equal(getJsonBody(putJsonBody(text)), text)
  }
  const text = JSON.stringify({ system: '系统'.repeat(80), messages: [{ content: '共享🙂'.repeat(200) }], model: 'a' })
  const first = putJsonBody(text)
  const before = count()
  assert.deepEqual(putJsonBody(text), first)
  assert.equal(count(), before)
  const second = putJsonBody(text.replace('"model":"a"', '"model":"b"'))
  assert.deepEqual(children(first), children(second))
  assert.equal(getJsonBody(first), text)
})

test('最终记录唯一约束只约束非重试行，不影响历史 null', () => {
  db.exec("INSERT INTO request_logs(created_at,status) VALUES (1,'success'),(2,'error')")
  db.exec("INSERT INTO request_logs(created_at,status,request_id,is_retry) VALUES (3,'error','r',1),(4,'success','r',0)")
  assert.throws(() => db.exec("INSERT INTO request_logs(created_at,status,request_id,is_retry) VALUES (5,'error','r',0)"), /UNIQUE/)
  assert.equal((db.prepare('SELECT COUNT(*) n FROM request_logs WHERE request_id IS NULL').get() as any).n, 2)
})
