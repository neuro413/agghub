import { createHash } from 'node:crypto'
import zlib from 'node:zlib'
import type Database from 'better-sqlite3'

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

export function sha256(buf: Buffer): Buffer {
  return createHash('sha256').update(buf).digest()
}

const ARRAY_KEYS = ['messages', 'input', 'tools', 'system']
const STRING_KEYS = ['system', 'instructions']
interface Manifest {
  v: 1
  s: any
  c: [(string | number)[], string][]
}
interface RawManifest { v: 1; raw: string }

/** 显式注入连接，迁移阶段不导入会自动打开真实数据库的模块。 */
export function createBlobStore(db: Database.Database) {
  const insertBlob = db.prepare('INSERT OR IGNORE INTO blobs (hash, raw_size, codec, data, created_at) VALUES (?, ?, ?, ?, ?)')
  const selectBlob = db.prepare('SELECT codec, data FROM blobs WHERE hash = ?')
  const insertEdge = db.prepare('INSERT OR IGNORE INTO blob_edges (parent, child) VALUES (?, ?)')
  const selectEdges = db.prepare('SELECT child FROM blob_edges WHERE parent = ?')

  function putBlob(text: string): Buffer {
    const buf = Buffer.from(text, 'utf8')
    const hash = sha256(buf)
    const { codec, data } = compress(buf)
    insertBlob.run(hash, buf.length, codec, data, Date.now())
    return hash
  }
  function getBlob(hash: Buffer | null | undefined): string | null {
    if (!hash) return null
    const row = selectBlob.get(hash) as { codec: number; data: Buffer } | undefined
    return row ? decompress(row.codec, row.data).toString('utf8') : null
  }
  function putRawManifest(text: string): Buffer {
    const hash = putBlob(text)
    const manifest = putBlob(JSON.stringify({ v: 1, raw: hash.toString('hex') } satisfies RawManifest))
    insertEdge.run(manifest, hash)
    return manifest
  }
  function putJsonBody(text: string): Buffer {
    let obj: any
    try { obj = JSON.parse(text) } catch { return putRawManifest(text) }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || JSON.stringify(obj) !== text) return putRawManifest(text)
    const skeleton: any = Object.create(null)
    const chunks: Manifest['c'] = []
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
    const manifest = putBlob(JSON.stringify({ v: 1, s: skeleton, c: chunks } satisfies Manifest))
    for (const child of children) insertEdge.run(manifest, child)
    return manifest
  }
  function getJsonBody(hash: Buffer | null | undefined): string | null {
    const text = getBlob(hash)
    if (text === null) return null
    const manifest = JSON.parse(text) as Manifest | RawManifest
    if ('raw' in manifest) return getBlob(Buffer.from(manifest.raw, 'hex'))
    const root = manifest.s
    for (const [path, hex] of manifest.c) {
      // manifest 路径只可能来自已知的顶层文本/数组字段，不接受任意点路径。
      if (path.length < 1 || path.length > 2 || ![...ARRAY_KEYS, ...STRING_KEYS].includes(String(path[0]))) throw new Error('日志 manifest 路径无效')
      const part = getBlob(Buffer.from(hex, 'hex'))
      if (part === null) throw new Error(`日志块缺失: ${hex}`)
      let parent = root
      if (path.length === 2) {
        parent = root[path[0]]
        if (!Array.isArray(parent) || !Number.isSafeInteger(path[1]) || Number(path[1]) < 0 || Number(path[1]) >= parent.length) throw new Error('日志 manifest 下标无效')
      }
      Object.defineProperty(parent, path[path.length - 1], { value: JSON.parse(part), enumerable: true, configurable: true, writable: true })
    }
    return JSON.stringify(root)
  }
  function childrenOf(hash: Buffer): Buffer[] {
    return (selectEdges.all(hash) as { child: Buffer }[]).map(row => row.child)
  }
  return { putBlob, getBlob, putJsonBody, getJsonBody, childrenOf }
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
