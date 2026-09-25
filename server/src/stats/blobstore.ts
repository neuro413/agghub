/** 内容寻址块存储；纯编解码及连接注入实现在 blobstoreCore 中，供安全迁移复用。 */
import { db } from '../db'
import { createBlobStore } from './blobstoreCore'
export { sha256, sanitizeHeaders } from './blobstoreCore'

export const { putBlob, getBlob, putJsonBody, getJsonBody, childrenOf } = createBlobStore(db)

const REF_COLUMNS = [
  'request_headers_ref', 'request_body_ref', 'response_body_ref',
  'preprocessed_body_ref', 'thinking_inject_ref', 'upstream_response_body_ref',
]

/** 删除不再被任何日志行（直接或经 manifest）引用的 blob，返回删除数量。 */
export function gcBlobs(): number {
  return db.transaction(() => {
    db.exec('CREATE TEMP TABLE IF NOT EXISTS live_blobs (hash BLOB PRIMARY KEY) WITHOUT ROWID')
    db.exec('DELETE FROM live_blobs')
    for (const column of REF_COLUMNS) {
      db.exec(`INSERT OR IGNORE INTO live_blobs SELECT ${column} FROM request_logs WHERE ${column} IS NOT NULL`)
    }
    db.exec('INSERT OR IGNORE INTO live_blobs SELECT child FROM blob_edges WHERE parent IN (SELECT hash FROM live_blobs)')
    const result = db.prepare('DELETE FROM blobs WHERE hash NOT IN (SELECT hash FROM live_blobs)').run()
    db.exec('DELETE FROM blob_edges WHERE parent NOT IN (SELECT hash FROM blobs)')
    db.exec('DELETE FROM live_blobs')
    return result.changes
  })()
}

export function blobStats(): { blobs: number; raw_bytes: number; stored_bytes: number; logs: number } {
  const b = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(raw_size),0) raw, COALESCE(SUM(LENGTH(data)),0) stored FROM blobs').get() as any
  const l = db.prepare('SELECT COUNT(*) n FROM request_logs').get() as any
  return { blobs: b.n, raw_bytes: b.raw, stored_bytes: b.stored, logs: l.n }
}
