import './helpers/isolated'
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import Database from 'better-sqlite3'

// 正文内嵌的旧块表与以签名文本为主键的旧暂存表都不再自动迁移
const legacy = new Database(path.join(process.env.AGGHUB_DATA_DIR!, 'agghub.db'))
legacy.exec(`
CREATE TABLE blobs (
  id INTEGER PRIMARY KEY, hash BLOB NOT NULL, kind INTEGER NOT NULL DEFAULT 0, raw_size INTEGER NOT NULL,
  codec INTEGER NOT NULL, created_at INTEGER NOT NULL, pack_id INTEGER, pack_offset INTEGER, data BLOB, UNIQUE(kind, hash)
);
CREATE TABLE thinking_store (signature TEXT PRIMARY KEY, thinking TEXT NOT NULL, created_at INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'text', payload BLOB);
`)
legacy.close()

test('旧版存储布局启动时明确报错，不修改数据库', async () => {
  const { db } = await import('../src/db')
  await assert.rejects(import('../src/stats/blobstore'), /旧版布局/)
  await assert.rejects(import('../src/core/thinkingStore'), /旧版布局/)
  const columns = db.prepare("SELECT name FROM pragma_table_info('blobs')").pluck().all()
  assert.ok(columns.includes('data'))
  assert.equal(db.prepare("SELECT COUNT(*) FROM sqlite_master WHERE name = 'blob_data'").pluck().get(), 0)
  db.close()
})
