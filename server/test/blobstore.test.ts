import './helpers/isolated'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { db } from '../src/db'
import { clearBlobs, compressText, decompressText, gcBlobs, getBlob, getJsonBody, getPackCacheUsage, packBlobs, putBlob, putJsonBody } from '../src/stats/blobstore'
import { decompress } from '../src/stats/blobCodec'

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

test('冷块打包后按偏移还原，manifest 保持散块，未满最小包的新块等满一天再打', async () => {
  const texts = Array.from({ length: 6 }, (_, i) => JSON.stringify({ model: 'p', messages: [{ content: `第${i}条`.repeat(100) }, { content: '共享🙂'.repeat(300) }] }))
  const ids = texts.map(putJsonBody)
  const before = packs()
  assert.equal(await packBlobs(later(2 * 3_600_000)), 0)
  assert.equal(packs(), before)
  assert.ok(await packBlobs(later(2 * 86_400_000)) >= 1)
  const loose = db.prepare('SELECT kind, COUNT(*) n FROM blobs WHERE pack_id IS NULL GROUP BY kind').all() as any[]
  assert.deepEqual(loose.map(row => row.kind), [1])
  texts.forEach((text, i) => assert.equal(getJsonBody(ids[i]), text))
  const next = putJsonBody(texts[0].replace('"model":"p"', '"model":"q"'))
  assert.deepEqual(children(next), children(ids[0]))
  assert.equal(getJsonBody(next), texts[0].replace('"model":"p"', '"model":"q"'))
})

test('GC 通过 manifest 标记子块，稀疏包直接重写有效块且从不写回散块', async () => {
  db.exec('DELETE FROM request_logs')
  const keep = JSON.stringify({ messages: [{ content: '保留'.repeat(400) }] })
  const drop = JSON.stringify({ messages: [{ content: '丢弃'.repeat(4000) }] })
  const sse = 'data: 保留\n\n'.repeat(50)
  const insert = db.prepare("INSERT INTO request_logs (created_at, status, request_body_ref, upstream_response_body_ref) VALUES (?, 'success', ?, ?)")
  const kept = insert.run(1, putJsonBody(keep), putBlob(sse)).lastInsertRowid
  insert.run(2, putJsonBody(drop), null)
  gcBlobs()
  await packBlobs(later(2 * 86_400_000))
  assert.equal(db.prepare('SELECT COUNT(*) n FROM blobs WHERE pack_id IS NULL AND kind = 0').pluck().get(), 0)
  db.exec('DELETE FROM request_logs WHERE created_at = 2')
  assert.ok(gcBlobs() >= 2)
  db.exec(`CREATE TRIGGER forbid_loose BEFORE UPDATE OF data ON blobs
    WHEN OLD.pack_id IS NOT NULL AND NEW.data IS NOT NULL BEGIN SELECT RAISE(ABORT, '禁止回写散块'); END`)
  try { await packBlobs(later(2 * 86_400_000)) } finally { db.exec('DROP TRIGGER forbid_loose') }
  const packRows = db.prepare('SELECT p.raw_size, SUM(b.raw_size) live FROM blob_packs p JOIN blobs b ON b.pack_id = p.id GROUP BY p.id').all() as any[]
  assert.ok(packRows.every(row => row.live === row.raw_size))
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

const reset = db.transaction(() => { db.exec('DELETE FROM request_logs'); clearBlobs() })

test('普通块和 manifest 内容相同时按 kind 去重，GC 仍保留子块', () => {
  reset()
  const system = '保留的系统提示'.repeat(100)
  const child = putBlob(JSON.stringify(system))
  const raw = putBlob(JSON.stringify({ v: 2, s: { system: null }, c: [[['system'], child]] }))
  const body = JSON.stringify({ system })
  const ref = putJsonBody(body)
  assert.notEqual(raw, ref)
  db.prepare("INSERT INTO request_logs(created_at,status,request_body_ref) VALUES (1,'success',?)").run(ref)
  gcBlobs()
  assert.equal(getJsonBody(ref), body)
  assert.equal(getBlob(raw), null)
})

test('GC 根据正文引用识别旧版 kind 混用的 manifest', () => {
  reset()
  const body = JSON.stringify({ system: '旧版类型混用'.repeat(100) })
  const ref = putJsonBody(body)
  db.prepare('UPDATE blobs SET kind=0 WHERE id=?').run(ref)
  db.prepare("INSERT INTO request_logs(created_at,status,request_body_ref) VALUES (1,'success',?)").run(ref)
  gcBlobs()
  assert.equal(getJsonBody(ref), body)
})

test('打包有数量预算和硬大小边界，超大单块保留散块并正确还原', async () => {
  reset()
  const a = putBlob('a'.repeat(15 << 20))
  const b = putBlob('b'.repeat(2 << 20))
  const large = putBlob('c'.repeat(17 << 20))
  assert.equal(await packBlobs(later(2 * 86_400_000), { maxPacks: 1 }), 1)
  assert.equal(packs(), 1)
  assert.equal(await packBlobs(later(2 * 86_400_000), { maxPacks: 1 }), 1)
  assert.ok((db.prepare('SELECT raw_size FROM blob_packs').pluck().all() as number[]).every(size => size <= 16 << 20))
  assert.equal(db.prepare('SELECT pack_id FROM blobs WHERE id=?').pluck().get(large), null)
  assert.equal(getBlob(a)?.length, 15 << 20)
  assert.equal(getBlob(b)?.length, 2 << 20)
  assert.equal(getBlob(large)?.length, 17 << 20)
})

test('异步打包单飞，期间清空并复用块 id 不会提交过期结果', async () => {
  reset()
  const old = putBlob('旧块'.repeat(1000))
  const first = packBlobs(later(2 * 86_400_000))
  assert.equal(packBlobs(), first)
  reset()
  const replacement = putBlob('新的正文')
  assert.equal(replacement, old)
  assert.equal(await first, 0)
  assert.equal(packs(), 0)
  assert.equal(getBlob(replacement), '新的正文')
})

test('异步打包期间 GC 移除候选时安全放弃提交，不产生悬空包', async () => {
  reset()
  putBlob('待回收内容'.repeat(1000))
  const pending = packBlobs(later(2 * 86_400_000))
  gcBlobs()
  assert.equal(await pending, 0)
  assert.equal(count(), 0)
  assert.equal(packs(), 0)
})

test('旧超大包可读取但不进入常驻缓存，错误偏移和解压长度被拒绝', () => {
  reset()
  const raw = Buffer.alloc(65 << 20, 65)
  const pack = db.prepare('INSERT INTO blob_packs(codec,raw_size,created_at,data) VALUES (1,?,1,?)')
    .run(raw.length, zlib.zstdCompressSync(raw)).lastInsertRowid
  const id = putBlob('AAA')
  db.prepare('UPDATE blobs SET pack_id=?,pack_offset=0,data=NULL WHERE id=?').run(pack, id)
  assert.equal(getBlob(id), 'AAA')
  assert.equal(getPackCacheUsage().bytes, 0)
  db.prepare('UPDATE blobs SET pack_offset=? WHERE id=?').run(raw.length, id)
  assert.throws(() => getBlob(id), /偏移或长度/)
  assert.throws(() => decompress(0, Buffer.from('xx'), 1), /长度不匹配/)
  assert.throws(() => decompress(2, zlib.gzipSync('x'.repeat(1000)), 10))
})
