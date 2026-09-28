import crypto from 'node:crypto'
import { db } from '../db'
import { compressText, decompressText } from '../stats/blobCodec'
import type { ReasoningStoreItem } from '../convert/responses'

// 两类记录共用一张表：
//   kind='text'       伪思考：签名 ↔ 思维链正文（thinking 列）
//   kind='responses'  Responses 上游推理组：签名 ↔ payload JSON { items: [{ id, encrypted, followers }] }
//                     供 Anthropic 客户端把 thinking 块签名回传后还原成 reasoning 项
//                     payload 以 compressText 压缩存为 BLOB
// 签名除 digest 外的字节都能由 digest 推出，表里只存 32 字节 digest，对外仍收发完整签名。
// 旧版以整段签名文本为主键，不再自动迁移，需停服后用独立脚本转换。
const storeColumns = db.prepare("SELECT name FROM pragma_table_info('thinking_store')").pluck().all() as string[]
if (storeColumns.includes('signature')) throw new Error('思维链暂存表仍是旧版布局，当前版本不再自动迁移；请停服后先转换数据库')
db.exec(`
CREATE TABLE IF NOT EXISTS thinking_store (
  digest     BLOB    PRIMARY KEY,
  thinking   TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  kind       TEXT    NOT NULL DEFAULT 'text',
  payload    BLOB
);
`)

const SIG_MAGIC = Buffer.from([0x12, 0xaf, 0x03, 0x0a, 0x63])
const SIG_TOTAL_BYTES = 280
const DIGEST_BYTES = 32

function deriveBytes(seed: Buffer, n: number): Buffer {
  const parts: Buffer[] = []
  let total = 0
  let counter = 0
  while (total < n) {
    const buf = Buffer.alloc(4)
    buf.writeUInt32BE(counter)
    parts.push(crypto.createHash('sha256').update(Buffer.concat([seed, buf])).digest())
    total += 32
    counter++
  }
  return Buffer.concat(parts).subarray(0, n)
}

const digestOf = (text: string): Buffer => crypto.createHash('sha256').update(text, 'utf8').digest()

function signatureOf(digest: Buffer): string {
  const body = deriveBytes(digest, SIG_TOTAL_BYTES - SIG_MAGIC.length - digest.length)
  return Buffer.concat([SIG_MAGIC, digest, body]).toString('base64')
}

/** 从签名取出 digest，并按原算法复核整段签名，任何字节被改动都视为无效 */
function signatureDigest(signature: string): Buffer | null {
  if (typeof signature !== 'string' || !signature) return null
  const digest = Buffer.from(signature, 'base64').subarray(SIG_MAGIC.length, SIG_MAGIC.length + DIGEST_BYTES)
  return digest.length === DIGEST_BYTES && signatureOf(digest) === signature ? digest : null
}

const insertStmt = db.prepare(
  'INSERT OR IGNORE INTO thinking_store (digest, thinking, created_at, kind, payload) VALUES (?, ?, ?, ?, ?)',
)
const lookupStmt = db.prepare('SELECT thinking, kind, payload FROM thinking_store WHERE digest = ?')
const countStmt = db.prepare('SELECT COUNT(*) AS n FROM thinking_store WHERE kind = ?')
const listStmt = db.prepare(
  'SELECT digest, thinking, created_at FROM thinking_store WHERE kind = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
)
const deleteStmt = db.prepare('DELETE FROM thinking_store WHERE digest = ?')
const evictStmt = db.prepare(
  'DELETE FROM thinking_store WHERE digest IN (SELECT digest FROM thinking_store WHERE kind = ? ORDER BY created_at ASC LIMIT ?)',
)

function evict(kind: string, maxEntries: number): void {
  const c = (countStmt.get(kind) as { n: number }).n
  if (c > maxEntries) evictStmt.run(kind, c - maxEntries)
}

export function save(thinking: string, maxEntries: number): string {
  if (!thinking) return ''
  const digest = digestOf(thinking)
  insertStmt.run(digest, thinking, Date.now(), 'text', null)
  evict('text', maxEntries)
  return signatureOf(digest)
}

export function lookup(signature: string): string | null {
  const digest = signatureDigest(signature)
  if (!digest) return null
  const row = lookupStmt.get(digest) as { thinking: string; kind: string } | undefined
  if (!row || row.kind !== 'text') return null
  return row.thinking
}

// ── Responses 推理项暂存 ─────────────────────────────────

const upsertStmt = db.prepare(
  'INSERT INTO thinking_store (digest, thinking, created_at, kind, payload) VALUES (?, ?, ?, ?, ?) ' +
    'ON CONFLICT(digest) DO UPDATE SET thinking = excluded.thinking, payload = excluded.payload',
)

/**
 * 存一条 Responses 推理组（可含多个 reasoning 项），返回可放进 Claude thinking 块的合成签名。
 * 签名只由密文决定，同一组重复 save 会覆盖 payload（流式时 followers 计数是事后补写的）。
 */
export function saveReasoning(items: ReasoningStoreItem[], maxEntries: number): string {
  const digest = digestOf('responses:' + items.map((it) => it.encrypted).join('\n'))
  upsertStmt.run(digest, '', Date.now(), 'responses', compressText(JSON.stringify({ items })))
  evict('responses', maxEntries)
  return signatureOf(digest)
}

export function lookupReasoning(signature: string): ReasoningStoreItem[] | null {
  const digest = signatureDigest(signature)
  if (!digest) return null
  const row = lookupStmt.get(digest) as { kind: string; payload: Buffer | string | null } | undefined
  if (row?.kind !== 'responses' || !row.payload) return null
  return JSON.parse(decompressText(row.payload)).items ?? null
}

export function count(): number {
  return (countStmt.get('text') as { n: number }).n
}

export function list(
  offset: number,
  limit: number,
  previewLen = 200,
): { signature: string; preview: string; length: number; created_at: number }[] {
  const rows = listStmt.all('text', limit, offset) as { digest: Buffer; thinking: string; created_at: number }[]
  return rows.map((r) => ({
    signature: signatureOf(r.digest),
    preview: r.thinking.slice(0, previewLen),
    length: r.thinking.length,
    created_at: r.created_at,
  }))
}

export function remove(signatures: string[]): number {
  let deleted = 0
  const tx = db.transaction(() => {
    for (const sig of signatures) {
      const digest = signatureDigest(sig)
      if (digest) deleted += deleteStmt.run(digest).changes
    }
  })
  tx()
  return deleted
}
