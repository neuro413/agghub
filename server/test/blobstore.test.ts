import './helpers/isolated'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/db'
import { compressText, decompressText, gcBlobs, getBlob, getJsonBody, packBlobs, putBlob, putJsonBody } from '../src/stats/blobstore'

after(() => db.close())
const count = () => (db.prepare('SELECT COUNT(*) n FROM blobs').get() as any).n
const children = (id: number) => JSON.parse(getBlob(id)!).c.map(([, child]: [unknown, number]) => child)
const packs = () => (db.prepare('SELECT COUNT(*) n FROM blob_packs').get() as any).n
const later = (ms: number) => Date.now() + ms

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

test('冷块打包后按偏移还原，manifest 保持散块，未满最小包的新块等满一天再打', () => {
  const texts = Array.from({ length: 6 }, (_, i) => JSON.stringify({ model: 'p', messages: [{ content: `第${i}条`.repeat(100) }, { content: '共享🙂'.repeat(300) }] }))
  const ids = texts.map(putJsonBody)
  const before = packs()
  assert.equal(packBlobs(later(2 * 3_600_000)), 0)
  assert.equal(packs(), before)
  assert.ok(packBlobs(later(2 * 86_400_000)) >= 1)
  const loose = db.prepare('SELECT kind, COUNT(*) n FROM blobs WHERE pack_id IS NULL GROUP BY kind').all() as any[]
  assert.deepEqual(loose.map(row => row.kind), [1])
  texts.forEach((text, i) => assert.equal(getJsonBody(ids[i]), text))
  const next = putJsonBody(texts[0].replace('"model":"p"', '"model":"q"'))
  assert.deepEqual(children(next), children(ids[0]))
  assert.equal(getJsonBody(next), texts[0].replace('"model":"p"', '"model":"q"'))
})

test('GC 通过 manifest 标记子块，活块不足一半的包拆回散块后重新打包', () => {
  db.exec('DELETE FROM request_logs')
  const keep = JSON.stringify({ messages: [{ content: '保留'.repeat(400) }] })
  const drop = JSON.stringify({ messages: [{ content: '丢弃'.repeat(4000) }] })
  const sse = 'data: 保留\n\n'.repeat(50)
  const insert = db.prepare("INSERT INTO request_logs (created_at, status, request_body_ref, upstream_response_body_ref) VALUES (?, 'success', ?, ?)")
  const kept = insert.run(1, putJsonBody(keep), putBlob(sse)).lastInsertRowid
  insert.run(2, putJsonBody(drop), null)
  gcBlobs()
  packBlobs(later(2 * 86_400_000))
  assert.equal(db.prepare('SELECT COUNT(*) n FROM blobs WHERE pack_id IS NULL AND kind = 0').pluck().get(), 0)
  db.exec('DELETE FROM request_logs WHERE created_at = 2')
  assert.ok(gcBlobs() >= 2)
  const packRows = db.prepare('SELECT p.raw_size, SUM(b.raw_size) live FROM blob_packs p JOIN blobs b ON b.pack_id = p.id GROUP BY p.id').all() as any[]
  assert.ok(packRows.every(row => row.live * 2 >= row.raw_size))
  packBlobs(later(2 * 86_400_000))
  const row = db.prepare('SELECT request_body_ref, upstream_response_body_ref FROM request_logs WHERE id = ?').get(kept) as any
  assert.equal(getJsonBody(row.request_body_ref), keep)
  assert.equal(getBlob(row.upstream_response_body_ref), sse)
  db.exec('DELETE FROM request_logs')
  gcBlobs()
  assert.equal(count(), 0)
  assert.equal(packs(), 0)
})

test('独立压缩文本兼容旧的明文字符串', () => {
  const text = JSON.stringify({ items: [{ encrypted: '密文'.repeat(200) }] })
  assert.equal(decompressText(compressText(text)), text)
  assert.ok(compressText(text).length < Buffer.byteLength(text))
  assert.equal(decompressText(text), text)
})

test('最终记录唯一约束只约束非重试行，不影响历史 null', () => {
  db.exec("INSERT INTO request_logs(created_at,status) VALUES (1,'success'),(2,'error')")
  db.exec("INSERT INTO request_logs(created_at,status,request_id,is_retry) VALUES (3,'error','r',1),(4,'success','r',0)")
  assert.throws(() => db.exec("INSERT INTO request_logs(created_at,status,request_id,is_retry) VALUES (5,'error','r',0)"), /UNIQUE/)
  assert.equal((db.prepare('SELECT COUNT(*) n FROM request_logs WHERE request_id IS NULL').get() as any).n, 2)
})
