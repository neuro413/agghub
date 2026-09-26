/** 内容寻址块存储：日志正文切块去重并压缩。 */
import { createHash } from 'node:crypto'
import zlib from 'node:zlib'
import { db } from '../db'

const CODEC_RAW = 0
const CODEC_ZSTD = 1
const CODEC_GZIP = 2
const COMPRESS_MIN = 256
const CHUNK_MIN = 128
const STRING_CHUNK_MIN = 64
const z = zlib as any
const hasZstd = typeof z.zstdCompressSync === 'function' && typeof z.zstdDecompressSync === 'function'

function compress(buf: Buffer): { codec: number; data: Buffer } {
  if (buf.length < COMPRESS_MIN) return { codec: CODEC_RAW, data: buf }
  if (hasZstd) {
    const data: Buffer = z.zstdCompressSync(buf, { params: { [z.constants.ZSTD_c_compressionLevel]: 3 } })
    return data.length < buf.length ? { codec: CODEC_ZSTD, data } : { codec: CODEC_RAW, data: buf }
  }
  const data = zlib.gzipSync(buf, { level: 6 })
  return data.length < buf.length ? { codec: CODEC_GZIP, data } : { codec: CODEC_RAW, data: buf }
}

function decompress(codec: number, data: Buffer): Buffer {
  switch (codec) {
    case CODEC_RAW: return data
    case CODEC_ZSTD:
      if (!hasZstd) throw new Error('当前 Node 不支持 zstd，无法解压日志正文')
      return z.zstdDecompressSync(data)
    case CODEC_GZIP: return zlib.gunzipSync(data)
    default: throw new Error(`未知 blob 编码 ${codec}`)
  }
}

const ARRAY_KEYS = ['messages', 'input', 'tools', 'system']
const STRING_KEYS = ['system', 'instructions']
/** s：去掉大块后的骨架；c：[路径, 块哈希]。非 JSON 正文存为 { raw: 哈希 } */
type Manifest = { v: 1; s: any; c: [(string | number)[], string][] } | { v: 1; raw: string }

const insertBlob = db.prepare('INSERT OR IGNORE INTO blobs (hash, raw_size, codec, data, created_at) VALUES (?, ?, ?, ?, ?)')
const selectBlob = db.prepare('SELECT codec, data FROM blobs WHERE hash = ?')
const insertEdge = db.prepare('INSERT OR IGNORE INTO blob_edges (parent, child) VALUES (?, ?)')

export function putBlob(text: string): Buffer {
  const buf = Buffer.from(text, 'utf8')
  const hash = createHash('sha256').update(buf).digest()
  const { codec, data } = compress(buf)
  insertBlob.run(hash, buf.length, codec, data, Date.now())
  return hash
}

export function getBlob(hash: Buffer | null | undefined): string | null {
  if (!hash) return null
  const row = selectBlob.get(hash) as { codec: number; data: Buffer } | undefined
  return row ? decompress(row.codec, row.data).toString('utf8') : null
}

function putManifest(manifest: Manifest, children: Buffer[]): Buffer {
  const hash = putBlob(JSON.stringify(manifest))
  for (const child of children) insertEdge.run(hash, child)
  return hash
}

/** JSON 请求/响应体：把 messages 等大数组逐项切块，多轮对话重复的历史消息只存一份 */
export function putJsonBody(text: string): Buffer {
  let obj: any
  try { obj = JSON.parse(text) } catch {}
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || JSON.stringify(obj) !== text) {
    const raw = putBlob(text)
    return putManifest({ v: 1, raw: raw.toString('hex') }, [raw])
  }
  const skeleton: any = Object.create(null)
  const chunks: [(string | number)[], string][] = []
  const children: Buffer[] = []
  const emit = (path: (string | number)[], value: any): void => {
    const hash = putBlob(JSON.stringify(value))
    children.push(hash)
    chunks.push([path, hash.toString('hex')])
  }
  for (const key of Object.keys(obj)) {
    const value = obj[key]
    if (ARRAY_KEYS.includes(key) && Array.isArray(value)) {
      skeleton[key] = value.map((item, i) => {
        const text = JSON.stringify(item)
        if (text !== undefined && text.length >= CHUNK_MIN) { emit([key, i], item); return null }
        return item
      })
    } else if (STRING_KEYS.includes(key) && typeof value === 'string' && value.length >= STRING_CHUNK_MIN) {
      skeleton[key] = null
      emit([key], value)
    } else skeleton[key] = value
  }
  return putManifest({ v: 1, s: skeleton, c: chunks }, children)
}

export function getJsonBody(hash: Buffer | null | undefined): string | null {
  const text = getBlob(hash)
  if (text === null) return null
  const manifest = JSON.parse(text) as Manifest
  if ('raw' in manifest) return getBlob(Buffer.from(manifest.raw, 'hex'))
  const root = manifest.s
  for (const [path, hex] of manifest.c) {
    const part = getBlob(Buffer.from(hex, 'hex'))
    if (part === null) throw new Error(`日志块缺失: ${hex}`)
    const parent = path.length === 2 ? root[path[0]] : root
    parent[path[path.length - 1]] = JSON.parse(part)
  }
  return JSON.stringify(root)
}

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

const DROP_HEADERS = new Set(['content-length', 'host', 'connection', 'accept-encoding'])
const MASK_HEADERS = new Set(['authorization', 'x-api-key', 'x-goog-api-key'])
export function sanitizeHeaders(text: string | null | undefined): string | null {
  if (!text) return null
  let headers: any
  try { headers = JSON.parse(text) } catch { return text }
  if (!headers || typeof headers !== 'object') return text
  const out: Record<string, any> = Object.create(null)
  for (const key of Object.keys(headers)) {
    if (DROP_HEADERS.has(key.toLowerCase())) continue
    const value = headers[key]
    out[key] = MASK_HEADERS.has(key.toLowerCase()) && typeof value === 'string' && value.length > 0
      ? value.length > 12 ? `***${value.slice(-4)}` : '***'
      : value
  }
  return JSON.stringify(out)
}
