import './helpers/isolated'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'

// 先按旧版结构（哈希主键 + blob_edges + BLOB 引用列 + 明文 payload）造库，再加载模块触发迁移
const sha = (text: string) => createHash('sha256').update(text).digest()
const legacy = new Database(path.join(process.env.AGGHUB_DATA_DIR!, 'agghub.db'))
legacy.exec(`
CREATE TABLE request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, channel_id INTEGER, channel_name TEXT,
  entry_format TEXT NOT NULL DEFAULT 'openai', model TEXT, upstream_model TEXT, status TEXT NOT NULL, status_code INTEGER,
  latency_ms INTEGER, prompt_tokens INTEGER DEFAULT 0, completion_tokens INTEGER DEFAULT 0, total_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0, retry_count INTEGER DEFAULT 0,
  is_stream INTEGER DEFAULT 0, is_retry INTEGER DEFAULT 0, error_message TEXT, preprocessed INTEGER DEFAULT 0,
  pseudo_thinking INTEGER DEFAULT 0, request_headers_ref BLOB, request_body_ref BLOB, response_body_ref BLOB,
  preprocessed_body_ref BLOB, thinking_inject_ref BLOB, upstream_response_body_ref BLOB, request_id TEXT,
  attempt_latency_ms INTEGER, response_body_truncated INTEGER NOT NULL DEFAULT 0, upstream_response_body_truncated INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE blobs (hash BLOB PRIMARY KEY, raw_size INTEGER NOT NULL, codec INTEGER NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE blob_edges (parent BLOB NOT NULL, child BLOB NOT NULL, PRIMARY KEY (parent, child)) WITHOUT ROWID;
CREATE INDEX idx_blob_edges_child ON blob_edges(child);
CREATE TABLE thinking_store (signature TEXT PRIMARY KEY, thinking TEXT NOT NULL, created_at INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'text', payload TEXT);
`)
const put = (text: string, zstd = false): Buffer => {
  const hash = sha(text)
  const raw = Buffer.from(text)
  legacy.prepare('INSERT OR IGNORE INTO blobs VALUES (?, ?, ?, ?, ?)').run(hash, raw.length, zstd ? 1 : 0, zstd ? zlib.zstdCompressSync(raw) : raw, 1)
  return hash
}
const manifest = (value: object, children: Buffer[]): Buffer => {
  const hash = put(JSON.stringify(value))
  for (const child of children) legacy.prepare('INSERT OR IGNORE INTO blob_edges VALUES (?, ?)').run(hash, child)
  return hash
}
const message = { role: 'user', content: '旧版消息🙂'.repeat(40) }
const requestBody = JSON.stringify({ model: 'legacy', messages: [message, { role: 'user', content: 'hi' }] })
const chunk = put(JSON.stringify(message), true)
const requestRef = manifest({ v: 1, s: { model: 'legacy', messages: [null, { role: 'user', content: 'hi' }] }, c: [[['messages', 0], chunk.toString('hex')]] }, [chunk])
const rawBody = '非 JSON 响应'
const rawChild = put(rawBody)
const responseRef = manifest({ v: 1, raw: rawChild.toString('hex') }, [rawChild])
const upstream = 'data: {"type":"response.completed"}\n\n'.repeat(20)
const upstreamRef = put(upstream, true)
const missingRef = manifest({ v: 1, s: { messages: [null] }, c: [[['messages', 0], sha('不存在').toString('hex')]] }, [])
legacy.prepare(`INSERT INTO request_logs (created_at, status, request_id, request_body_ref, response_body_ref, preprocessed_body_ref, upstream_response_body_ref)
  VALUES (?, 'success', 'legacy', ?, ?, ?, ?)`).run(Date.now(), requestRef, responseRef, missingRef, upstreamRef)
const reasoning = JSON.stringify({ items: [{ id: 'rs_1', encrypted: '密文'.repeat(300), followers: 0 }] })
legacy.prepare("INSERT INTO thinking_store VALUES ('sig', '', 1, 'responses', ?)").run(reasoning)
legacy.close()

const { db } = await import('../src/db')
const { hydrateLogRow } = await import('../src/stats/recorder')
const thinkingStore = await import('../src/core/thinkingStore')
after(() => db.close())

test('旧版块存储迁移为整数 id，正文逐字节还原，缺块的 manifest 引用置空', () => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all() as string[]
  assert.ok(!tables.includes('blob_edges') && !tables.includes('blobs_v1'))
  const raw = db.prepare("SELECT * FROM request_logs WHERE request_id = 'legacy'").get() as any
  for (const column of ['request_body_ref', 'response_body_ref', 'upstream_response_body_ref']) assert.equal(typeof raw[column], 'number')
  const row = hydrateLogRow(raw)
  assert.equal(row.request_body, requestBody)
  assert.equal(row.response_body, rawBody)
  assert.equal(row.upstream_response_body, upstream)
  assert.equal(row.preprocessed_body, null)
  assert.equal(db.prepare('SELECT COUNT(*) FROM blobs WHERE kind = 1').pluck().get(), 2)
})

test('旧版明文 thinking payload 就地压缩且可查回', () => {
  assert.equal(db.prepare("SELECT typeof(payload) FROM thinking_store WHERE signature = 'sig'").pluck().get(), 'blob')
  assert.deepEqual(thinkingStore.lookupReasoning('sig'), JSON.parse(reasoning).items)
})
