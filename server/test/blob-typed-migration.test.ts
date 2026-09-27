import './helpers/isolated'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createHash } from 'node:crypto'
import zlib from 'node:zlib'
import Database from 'better-sqlite3'

const body = JSON.stringify({ system: '迁移后保留共享消息'.repeat(100) })
const child = JSON.stringify(JSON.parse(body).system)
const manifest = JSON.stringify({ v: 2, s: { system: null }, c: [[['system'], 1]] })
const packed = zlib.zstdCompressSync(Buffer.from(child))
const legacy = new Database(path.join(process.env.AGGHUB_DATA_DIR!, 'agghub.db'))
legacy.exec(`
CREATE TABLE blobs (
  id INTEGER PRIMARY KEY, hash BLOB NOT NULL UNIQUE, kind INTEGER NOT NULL DEFAULT 0,
  raw_size INTEGER NOT NULL, codec INTEGER NOT NULL, created_at INTEGER NOT NULL,
  pack_id INTEGER, pack_offset INTEGER, data BLOB
);
CREATE INDEX idx_blobs_pack ON blobs(pack_id) WHERE pack_id IS NOT NULL;
CREATE INDEX idx_blobs_loose ON blobs(created_at) WHERE pack_id IS NULL AND kind=0;
CREATE TABLE blob_packs(id INTEGER PRIMARY KEY, codec INTEGER NOT NULL, raw_size INTEGER NOT NULL, created_at INTEGER NOT NULL, data BLOB NOT NULL);
`)
legacy.prepare('INSERT INTO blob_packs VALUES (1,1,?,1,?)').run(Buffer.byteLength(child), packed)
legacy.prepare('INSERT INTO blobs VALUES (1,?,0,?,1,1,1,0,NULL)').run(createHash('sha256').update(child).digest(), Buffer.byteLength(child))
// 模拟旧版普通块与 manifest 已发生类型混用，迁移不能丢掉其原 id。
legacy.prepare('INSERT INTO blobs VALUES (2,?,0,?,0,1,NULL,NULL,?)').run(createHash('sha256').update(manifest).digest(), Buffer.byteLength(manifest), Buffer.from(manifest))
legacy.close()

const { db } = await import('../src/db')
db.prepare("INSERT INTO request_logs(created_at,status,request_body_ref) VALUES (1,'success',2)").run()
const { gcBlobs, getJsonBody, putJsonBody } = await import('../src/stats/blobstore')
after(() => db.close())

test('整数 id 旧库无损迁移复合唯一键，保留包字节、偏移、旧引用与索引', () => {
  assert.equal(getJsonBody(2), body)
  assert.deepEqual(db.prepare('SELECT data FROM blob_packs WHERE id=1').pluck().get(), packed)
  assert.deepEqual(db.prepare('SELECT pack_id,pack_offset FROM blobs WHERE id=1').get(), { pack_id: 1, pack_offset: 0 })
  const indexes = db.prepare("SELECT name FROM pragma_index_list('blobs')").pluck().all()
  assert.ok(indexes.includes('idx_blobs_pack') && indexes.includes('idx_blobs_loose'))
  const next = putJsonBody(body)
  assert.notEqual(next, 2)
  assert.equal(getJsonBody(next), body)
  gcBlobs()
  assert.equal(getJsonBody(2), body)
  assert.equal(db.prepare("SELECT COUNT(*) FROM sqlite_master WHERE name='blobs_untyped'").pluck().get(), 0)
})
