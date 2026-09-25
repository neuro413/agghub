import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { createBlobStore } from '../stats/blobstoreCore'
import { BLOB_SCHEMA, LOG_ADDITIONS, LOG_SCHEMA } from './logSchema'

type Column = { name: string; dflt_value: string | null }
const LEGACY = 'request_logs_legacy_v1'
const BODY_FIELDS = ['request_headers', 'request_body', 'response_body', 'preprocessed_body', 'thinking_inject', 'upstream_response_body']
const JSON_FIELDS = new Set(['request_body', 'response_body', 'preprocessed_body'])

/** VACUUM INTO 读取完整 SQLite 快照（包含 WAL），目标始终是唯一新文件。 */
export function backupDatabase(db: Database.Database, directory: string): string {
  fs.mkdirSync(directory, { recursive: true })
  const filename = path.join(directory, `agghub-before-migration-${Date.now()}-${randomUUID()}.db`)
  db.prepare('VACUUM INTO ?').run(filename)
  if (!fs.statSync(filename).size) throw new Error('数据库备份为空，停止迁移')
  return filename
}

/** 备份失败直接停止；所有表切换与正文转换在同一事务内，旧表保留为只读用途的归档。 */
export function migrateLogs(
  db: Database.Database,
  backupDirectory: string,
  onStage?: (stage: 'row' | 'beforeCommit') => void,
): { migrated: boolean; backupPath?: string; legacyTable?: string } {
  const columns = db.prepare('PRAGMA table_info(request_logs)').all() as Column[]
  const old = columns.some(c => c.name === 'request_body')
  const names = new Set(columns.map(c => c.name))
  if (columns.length && !['id', 'created_at', 'status'].every(name => names.has(name))) throw new Error('无法识别日志表结构，停止迁移')
  if (old && db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(LEGACY)) throw new Error('旧日志归档表已存在，停止迁移以免覆盖')
  const missing = Object.keys(LOG_ADDITIONS).filter(name => !names.has(name))
  const needsChange = old || missing.length > 0
  const backupPath = columns.length && needsChange ? backupDatabase(db, backupDirectory) : undefined
  if (columns.length && !needsChange) return { migrated: false }

  db.transaction(() => {
    let sequence = 0n
    if (old) {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").get()) {
        sequence = (db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'request_logs'").safeIntegers().get() as any)?.seq ?? 0n
      }
      db.exec(`ALTER TABLE request_logs RENAME TO ${LEGACY}`)
    }
    db.exec(BLOB_SCHEMA + LOG_SCHEMA)
    const current = new Set((db.prepare('PRAGMA table_info(request_logs)').all() as Column[]).map(c => c.name))
    for (const [name, definition] of Object.entries(LOG_ADDITIONS)) {
      if (!current.has(name)) db.exec(`ALTER TABLE request_logs ADD COLUMN ${name} ${definition}`)
    }
    if (old) {
      const store = createBlobStore(db)
      const destination = db.prepare('PRAGMA table_info(request_logs)').all() as Column[]
      const targetColumns = destination.map(c => c.name)
      const insert = db.prepare(`INSERT INTO request_logs (${targetColumns.join(',')}) VALUES (${targetColumns.map(() => '?').join(',')})`)
      let count = 0
      // better-sqlite3 不允许在活跃 iterator 中写同一连接；逐行 keyset 查询兼顾内存上限与事务写入。
      const nextRow = db.prepare(`SELECT * FROM ${LEGACY} WHERE id > ? ORDER BY id LIMIT 1`).safeIntegers()
      let row = db.prepare(`SELECT * FROM ${LEGACY} ORDER BY id LIMIT 1`).safeIntegers().get() as Record<string, any> | undefined
      while (row) {
        const values: Record<string, any> = Object.create(null)
        for (const column of destination) {
          values[column.name] = Object.hasOwn(row, column.name) ? row[column.name]
            : column.dflt_value === null ? null
              : column.dflt_value.startsWith("'") ? column.dflt_value.slice(1, -1)
                : Number(column.dflt_value)
        }
        for (const field of BODY_FIELDS) {
          if (!Object.hasOwn(row, field) || row[field] === null) continue
          if (typeof row[field] !== 'string') throw new Error(`旧日志 ${row.id} 的 ${field} 不是文本，停止迁移`)
          const put = JSON_FIELDS.has(field) ? store.putJsonBody : store.putBlob
          const get = JSON_FIELDS.has(field) ? store.getJsonBody : store.getBlob
          const ref = put(row[field])
          if (get(ref) !== row[field]) throw new Error(`旧日志 ${row.id} 的 ${field} 还原校验失败`)
          values[field + '_ref'] = ref
        }
        insert.run(...targetColumns.map(name => values[name]))
        count++
        onStage?.('row')
        row = nextRow.get(row.id) as Record<string, any> | undefined
      }
      const actual = (db.prepare('SELECT COUNT(*) n FROM request_logs').get() as any).n
      if (actual !== count) throw new Error('旧日志迁移行数校验失败')
      db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'request_logs'").run(sequence)
      // 空表迁移也保留之前分配过的最大 ID。
      if (!db.prepare("SELECT 1 FROM sqlite_sequence WHERE name = 'request_logs'").get()) {
        db.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES ('request_logs', ?)").run(sequence)
      }
    }
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'request_logs'").all() as { name: string }[]
    const indexed = new Set(indexes.flatMap(index => {
      const columns = db.prepare('SELECT name FROM pragma_index_info(?)').all(index.name) as { name: string }[]
      return columns.length === 1 ? [columns[0].name] : []
    }))
    for (const column of ['created_at', 'channel_id', 'model', 'status']) {
      if (!indexed.has(column)) db.exec(`CREATE INDEX idx_logs_${column}_${randomUUID().replaceAll('-', '')} ON request_logs(${column})`)
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_logs_request_final ON request_logs(request_id) WHERE request_id IS NOT NULL AND is_retry = 0`)
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, completed_at INTEGER NOT NULL)')
    db.prepare('INSERT OR IGNORE INTO schema_migrations(version, completed_at) VALUES (?, ?)').run('logs-v3', Date.now())
    onStage?.('beforeCommit')
  })()
  return { migrated: needsChange, backupPath, ...(old ? { legacyTable: LEGACY } : {}) }
}
