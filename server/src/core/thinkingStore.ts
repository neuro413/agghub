import crypto from 'node:crypto'
import { db } from '../db'
import type { ReasoningStoreItem } from '../convert/responses'

// 两类记录共用一张表：
//   kind='text'       伪思考：签名 ↔ 思维链正文（thinking 列）
//   kind='responses'  Responses 上游推理组：签名 ↔ payload JSON { items: [{ id, encrypted, followers }] }
//                     供 Anthropic 客户端把 thinking 块签名回传后还原成 reasoning 项
db.exec(`
CREATE TABLE IF NOT EXISTS thinking_store (
  signature  TEXT PRIMARY KEY,
  thinking   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'text',
  payload    TEXT
);
`)

const SIG_MAGIC = Buffer.from([0x12, 0xaf, 0x03, 0x0a, 0x63])
const SIG_TOTAL_BYTES = 280

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

export function makeSignature(thinking: string): string {
  const digest = crypto.createHash('sha256').update(thinking, 'utf8').digest()
  const body = deriveBytes(digest, SIG_TOTAL_BYTES - SIG_MAGIC.length - digest.length)
  return Buffer.concat([SIG_MAGIC, digest, body]).toString('base64')
}

const insertStmt = db.prepare(
  'INSERT OR IGNORE INTO thinking_store (signature, thinking, created_at, kind, payload) VALUES (?, ?, ?, ?, ?)',
)
const lookupStmt = db.prepare('SELECT thinking, kind, payload FROM thinking_store WHERE signature = ?')
const countStmt = db.prepare('SELECT COUNT(*) AS n FROM thinking_store WHERE kind = ?')
const listStmt = db.prepare(
  'SELECT signature, thinking, created_at FROM thinking_store WHERE kind = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
)
const deleteStmt = db.prepare('DELETE FROM thinking_store WHERE signature = ?')
const evictStmt = db.prepare(
  'DELETE FROM thinking_store WHERE signature IN (SELECT signature FROM thinking_store WHERE kind = ? ORDER BY created_at ASC LIMIT ?)',
)

function evict(kind: string, maxEntries: number): void {
  const c = (countStmt.get(kind) as { n: number }).n
  if (c > maxEntries) evictStmt.run(kind, c - maxEntries)
}

export function save(thinking: string, maxEntries: number): string {
  if (!thinking) return ''
  const sig = makeSignature(thinking)
  insertStmt.run(sig, thinking, Date.now(), 'text', null)
  evict('text', maxEntries)
  return sig
}

export function lookup(signature: string): string | null {
  if (!signature) return null
  const row = lookupStmt.get(signature) as { thinking: string; kind: string } | undefined
  if (!row || row.kind !== 'text') return null
  return row.thinking
}

// ── Responses 推理项暂存 ─────────────────────────────────

const upsertStmt = db.prepare(
  'INSERT INTO thinking_store (signature, thinking, created_at, kind, payload) VALUES (?, ?, ?, ?, ?) ' +
    'ON CONFLICT(signature) DO UPDATE SET thinking = excluded.thinking, payload = excluded.payload',
)

/**
 * 存一条 Responses 推理组（可含多个 reasoning 项），返回可放进 Claude thinking 块的合成签名。
 * 签名只由密文决定，同一组重复 save 会覆盖 payload（流式时 followers 计数是事后补写的）。
 */
export function saveReasoning(items: ReasoningStoreItem[], maxEntries: number): string {
  const sig = makeSignature('responses:' + items.map((it) => it.encrypted).join('\n'))
  upsertStmt.run(sig, '', Date.now(), 'responses', JSON.stringify({ items }))
  evict('responses', maxEntries)
  return sig
}

export function lookupReasoning(signature: string): ReasoningStoreItem[] | null {
  const row = lookupStmt.get(signature) as { kind: string; payload: string | null } | undefined
  if (row?.kind !== 'responses' || !row.payload) return null
  return JSON.parse(row.payload).items ?? null
}

export function count(): number {
  return (countStmt.get('text') as { n: number }).n
}

export function list(
  offset: number,
  limit: number,
  previewLen = 200,
): { signature: string; preview: string; length: number; created_at: number }[] {
  const rows = listStmt.all('text', limit, offset) as { signature: string; thinking: string; created_at: number }[]
  return rows.map((r) => ({
    signature: r.signature,
    preview: r.thinking.slice(0, previewLen),
    length: r.thinking.length,
    created_at: r.created_at,
  }))
}

export function remove(signatures: string[]): number {
  let deleted = 0
  const tx = db.transaction(() => {
    for (const sig of signatures) {
      const info = deleteStmt.run(sig)
      deleted += info.changes
    }
  })
  tx()
  return deleted
}
