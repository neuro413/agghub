import './helpers/isolated'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { migrateLogs } from '../src/migrations/logs'
import { BLOB_SCHEMA, LOG_SCHEMA } from '../src/migrations/logSchema'
import { createBlobStore } from '../src/stats/blobstoreCore'

let serial = 0
function fixture() {
  const dir = path.join(process.env.AGGHUB_DATA_DIR!, `fixture-${serial++}`)
  fs.mkdirSync(dir)
  const database = new Database(path.join(dir, 'synthetic.db'))
  database.pragma('journal_mode = WAL')
  database.exec(`CREATE TABLE request_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, status TEXT NOT NULL,
    model TEXT, prompt_tokens INTEGER, total_tokens INTEGER, is_retry INTEGER,
    request_headers TEXT, request_body TEXT, response_body TEXT, preprocessed_body TEXT,
    thinking_inject TEXT, upstream_response_body TEXT, future_metadata TEXT
  ); CREATE INDEX idx_logs_created ON request_logs(created_at);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  INSERT INTO settings VALUES ('synthetic', '保留设置');`)
  const request = JSON.stringify({ messages: [{ role: 'user', content: '中文🙂'.repeat(300) }], tools: [{ schema: JSON.parse('{"properties":{"__proto__":{"type":"string"}}}') }] })
  const rows = [
    [1, 1700000000123, 'success', 'alias', 10, 15, 0, '{"x-synthetic":"yes"}', request, '{ "reply": "你好" }', request, '[]', 'data: 你好\r\n\r\n', '完整归档'],
    [7, 1700000010123, 'error', null, null, 0, 1, null, '', '非JSON', null, null, '', null],
  ]
  const insert = database.prepare('INSERT INTO request_logs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  for (const row of rows) insert.run(...row)
  database.prepare("UPDATE sqlite_sequence SET seq = 100 WHERE name = 'request_logs'").run()
  return { database, dir, request }
}

test('R01: WAL 旧库一致性备份、正文/id/标量保留、归档保留、索引有效及幂等重启', () => {
  const { database, dir } = fixture()
  try {
    const original = database.prepare('SELECT * FROM request_logs ORDER BY id').all() as any[]
    const result = migrateLogs(database, path.join(dir, 'backups'))
    assert.equal(result.legacyTable, 'request_logs_legacy_v1')
    assert.ok(result.backupPath)
    const backup = new Database(result.backupPath!, { readonly: true })
    try {
      assert.deepEqual(backup.prepare('SELECT * FROM request_logs ORDER BY id').all(), original)
      assert.equal((backup.prepare('SELECT value FROM settings').get() as any).value, '保留设置')
    } finally { backup.close() }
    assert.deepEqual(database.prepare('SELECT * FROM request_logs_legacy_v1 ORDER BY id').all(), original)
    const store = createBlobStore(database)
    const rows = database.prepare('SELECT * FROM request_logs ORDER BY id').all() as any[]
    for (const [i, row] of rows.entries()) {
      for (const field of ['id', 'created_at', 'status', 'model', 'prompt_tokens', 'total_tokens', 'is_retry']) assert.equal(row[field], original[i][field])
      for (const field of ['request_body', 'response_body', 'preprocessed_body']) assert.equal(store.getJsonBody(row[field + '_ref']), original[i][field])
      for (const field of ['request_headers', 'thinking_inject', 'upstream_response_body']) assert.equal(store.getBlob(row[field + '_ref']), original[i][field])
      assert.equal(row.request_id, null)
      assert.equal(row.response_body_truncated, 0)
    }
    const indexes = database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='request_logs'").all() as { name: string }[]
    const indexed = indexes.flatMap(index => database.prepare('SELECT name FROM pragma_index_info(?)').all(index.name) as { name: string }[]).map(c => c.name)
    for (const name of ['created_at', 'channel_id', 'model', 'status', 'request_id']) assert.ok(indexed.includes(name))
    assert.equal(database.prepare("INSERT INTO request_logs(created_at,status) VALUES (1,'success')").run().lastInsertRowid, 101)
    assert.deepEqual(migrateLogs(database, path.join(dir, 'backups')), { migrated: false })
    assert.equal(fs.readdirSync(path.join(dir, 'backups')).filter(n => n.endsWith('.db')).length, 1)
  } finally { database.close() }
})

test('R01: 备份失败不改变旧表与正文', () => {
  const { database, dir } = fixture()
  try {
    const blocked = path.join(dir, 'file-instead-of-directory')
    fs.writeFileSync(blocked, '保留')
    const before = database.prepare('SELECT * FROM request_logs').all()
    assert.throws(() => migrateLogs(database, blocked))
    assert.deepEqual(database.prepare('SELECT * FROM request_logs').all(), before)
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name='request_logs_legacy_v1'").get(), undefined)
  } finally { database.close() }
})

for (const stage of ['row', 'beforeCommit'] as const) {
  test(`R01: ${stage} 故障回滚，保留备份且再次启动可恢复`, () => {
    const { database, dir } = fixture()
    try {
      const original = database.prepare('SELECT * FROM request_logs').all()
      assert.throws(() => migrateLogs(database, path.join(dir, 'backups'), current => { if (current === stage) throw new Error('合成迁移故障') }))
      assert.deepEqual(database.prepare('SELECT * FROM request_logs').all(), original)
      assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name='request_logs_legacy_v1'").get(), undefined)
      assert.ok(migrateLogs(database, path.join(dir, 'backups')).migrated)
    } finally { database.close() }
  })
}

test('R01: 非文本正文转换失败回滚；不识别的旧结构拒绝迁移', () => {
  const { database, dir } = fixture()
  try {
    database.prepare('UPDATE request_logs SET request_body = ? WHERE id = 7').run(Buffer.from('合成错误'))
    assert.throws(() => migrateLogs(database, path.join(dir, 'backups')), /不是文本/)
    assert.ok(Buffer.isBuffer((database.prepare('SELECT request_body FROM request_logs WHERE id = 7').get() as any).request_body))
  } finally { database.close() }
  const other = new Database(':memory:')
  try {
    other.exec('CREATE TABLE request_logs(request_body TEXT)')
    assert.throws(() => migrateLogs(other, path.join(dir, 'unrecognized')), /无法识别/)
  } finally { other.close() }
})

test('R01: 当前块存储库只补列，保留原行，最终记录唯一约束不影响历史 null', () => {
  const dir = path.join(process.env.AGGHUB_DATA_DIR!, `new-${serial++}`)
  const database = new Database(':memory:')
  try {
    database.exec(LOG_SCHEMA + BLOB_SCHEMA)
    database.exec("INSERT INTO request_logs(created_at,status) VALUES (1,'success'),(2,'error')")
    assert.ok(migrateLogs(database, dir).backupPath)
    database.exec("INSERT INTO request_logs(created_at,status,request_id,is_retry) VALUES (3,'error','r',1),(4,'success','r',0)")
    assert.throws(() => database.exec("INSERT INTO request_logs(created_at,status,request_id,is_retry) VALUES (5,'error','r',0)"), /UNIQUE/)
    assert.equal((database.prepare('SELECT COUNT(*) n FROM request_logs WHERE request_id IS NULL').get() as any).n, 2)
    assert.equal(migrateLogs(database, dir).migrated, false)
  } finally { database.close() }
})

test('块存储保持字节还原、中文、非紧凑 JSON、原型同名数据与共享消息去重', () => {
  const database = new Database(':memory:')
  try {
    database.exec(BLOB_SCHEMA)
    const store = createBlobStore(database)
    for (const text of ['', '不是JSON', '{ "a": 1 }', 'null', '[1,2]', '{"__proto__":{"x":1},"constructor":"ok"}']) {
      assert.equal(store.getJsonBody(store.putJsonBody(text)), text)
    }
    const text = JSON.stringify({ system: '系统'.repeat(80), messages: [{ content: '共享🙂'.repeat(200) }], model: 'a' })
    const first = store.putJsonBody(text)
    const before = (database.prepare('SELECT COUNT(*) n FROM blobs').get() as any).n
    assert.deepEqual(store.putJsonBody(text), first)
    assert.equal((database.prepare('SELECT COUNT(*) n FROM blobs').get() as any).n, before)
    const second = store.putJsonBody(text.replace('"model":"a"', '"model":"b"'))
    assert.deepEqual(store.childrenOf(first), store.childrenOf(second))
    assert.equal(store.getJsonBody(first), text)
  } finally { database.close() }
})
