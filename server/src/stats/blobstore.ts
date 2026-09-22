/**
 * 内容寻址块存储：日志大正文（请求体 / 预处理体 / 上游原文 / 请求头 …）不再直接落在 request_logs 行里，
 * 而是按 sha256 去重后压缩存进 blobs 表，行内只保留 32 字节哈希引用。
 *
 * 请求体额外做「结构化切块」：system / instructions / messages[i] / input[i] / tools[i] 各自成块，
 * 剩余骨架 + 块哈希列表构成 manifest（本身也是一个 blob）。这样重试行、原始/预处理双份、
 * 多轮对话的历史前缀、每次重发的工具 schema 全部只存一份。
 */
import { createHash } from 'node:crypto'
import zlib from 'node:zlib'
import { db } from '../db'

// ── 编解码 ─────────────────────────────────────────────
const CODEC_RAW = 0
const CODEC_ZSTD = 1
const CODEC_GZIP = 2

/** 小于该长度的内容不压缩（压缩头开销大于收益）*/
const COMPRESS_MIN = 256
/** 数组元素序列化后小于该长度的不切块，直接留在骨架里（块行 + 边表开销 > 收益）*/
const CHUNK_MIN = 128
/** system / instructions 为字符串时切块的最小长度 */
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
    case CODEC_RAW:
      return data
    case CODEC_ZSTD:
      if (!hasZstd) throw new Error('当前 Node 不支持 zstd，无法解压日志正文')
      return z.zstdDecompressSync(data)
    case CODEC_GZIP:
      return zlib.gunzipSync(data)
    default:
      throw new Error(`未知 blob 编码 ${codec}`)
  }
}

export function sha256(buf: Buffer): Buffer {
  return createHash('sha256').update(buf).digest()
}

// ── blobs 表读写 ────────────────────────────────────────
const insertBlob = db.prepare(
  'INSERT OR IGNORE INTO blobs (hash, raw_size, codec, data, created_at) VALUES (?, ?, ?, ?, ?)',
)
const selectBlob = db.prepare('SELECT codec, data FROM blobs WHERE hash = ?')
const insertEdge = db.prepare('INSERT OR IGNORE INTO blob_edges (parent, child) VALUES (?, ?)')
const selectEdges = db.prepare('SELECT child FROM blob_edges WHERE parent = ?')

/** 写入一个 blob（已存在则跳过），返回其哈希 */
export function putBlob(text: string): Buffer {
  const buf = Buffer.from(text, 'utf8')
  const hash = sha256(buf)
  const { codec, data } = compress(buf)
  insertBlob.run(hash, buf.length, codec, data, Date.now())
  return hash
}

export function getBlob(hash: Buffer | null | undefined): string | null {
  if (!hash) return null
  const row = selectBlob.get(hash) as { codec: number; data: Buffer } | undefined
  if (!row) return null
  return decompress(row.codec, row.data).toString('utf8')
}

// ── 请求体结构化切块 ────────────────────────────────────
/** 顶层数组字段：逐元素切块 */
const ARRAY_KEYS = ['messages', 'input', 'tools', 'system']
/** 顶层字符串字段：整体切块 */
const STRING_KEYS = ['system', 'instructions']

interface Manifest {
  v: 1
  /** 去掉大块后的骨架（被切走的位置留 null 占位）*/
  s: any
  /** [路径, 块哈希 hex]；路径形如 ["messages", 3] 或 ["system"] */
  c: [(string | number)[], string][]
}

interface RawManifest {
  v: 1
  /** 无法解析 / 重序列化不一致时：整体作为一个 blob */
  raw: string
}

function setPath(root: any, path: (string | number)[], value: any): void {
  let cur = root
  for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]]
  cur[path[path.length - 1]] = value
}

/**
 * 存一个 JSON 文本正文（请求体 / 预处理体），返回 manifest blob 的哈希。
 * 非 JSON 或重序列化后与原文不一致（非紧凑 JSON）时退化为整体存储，保证还原字节一致。
 */
export function putJsonBody(text: string): Buffer {
  let obj: any
  try {
    obj = JSON.parse(text)
  } catch {
    return putRawManifest(text)
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || JSON.stringify(obj) !== text) {
    return putRawManifest(text)
  }

  const skeleton: any = {}
  const chunks: Manifest['c'] = []
  const children: Buffer[] = []
  const emit = (path: (string | number)[], value: any): void => {
    const h = putBlob(JSON.stringify(value))
    children.push(h)
    chunks.push([path, h.toString('hex')])
  }

  for (const key of Object.keys(obj)) {
    const val = obj[key]
    if (ARRAY_KEYS.includes(key) && Array.isArray(val)) {
      const arr: any[] = new Array(val.length)
      for (let i = 0; i < val.length; i++) {
        const s = JSON.stringify(val[i])
        if (s !== undefined && s.length >= CHUNK_MIN) {
          arr[i] = null
          emit([key, i], val[i])
        } else {
          arr[i] = val[i]
        }
      }
      skeleton[key] = arr
    } else if (STRING_KEYS.includes(key) && typeof val === 'string' && val.length >= STRING_CHUNK_MIN) {
      skeleton[key] = null
      emit([key], val)
    } else {
      skeleton[key] = val
    }
  }

  const manifest: Manifest = { v: 1, s: skeleton, c: chunks }
  const mh = putBlob(JSON.stringify(manifest))
  for (const c of children) insertEdge.run(mh, c)
  return mh
}

function putRawManifest(text: string): Buffer {
  const h = putBlob(text)
  const m: RawManifest = { v: 1, raw: h.toString('hex') }
  const mh = putBlob(JSON.stringify(m))
  insertEdge.run(mh, h)
  return mh
}

/** 由 manifest 哈希还原原始 JSON 文本 */
export function getJsonBody(hash: Buffer | null | undefined): string | null {
  const mtext = getBlob(hash)
  if (mtext == null) return null
  const m = JSON.parse(mtext) as Manifest | RawManifest
  if ('raw' in m) return getBlob(Buffer.from(m.raw, 'hex'))
  const root = m.s
  for (const [path, hex] of m.c) {
    const part = getBlob(Buffer.from(hex, 'hex'))
    if (part == null) throw new Error(`日志块缺失: ${hex}`)
    setPath(root, path, JSON.parse(part))
  }
  return JSON.stringify(root)
}

/** 引用某 manifest 的所有子块（供调试 / 统计）*/
export function childrenOf(hash: Buffer): Buffer[] {
  return (selectEdges.all(hash) as { child: Buffer }[]).map((r) => r.child)
}

// ── 请求头脱敏 ──────────────────────────────────────────
/** 传输层噪音头，对排查无意义 */
const DROP_HEADERS = new Set(['content-length', 'host', 'connection', 'accept-encoding'])
/** 凭证头：只保留末 4 位 */
const MASK_HEADERS = new Set(['authorization', 'x-api-key', 'x-goog-api-key'])

export function sanitizeHeaders(text: string | null | undefined): string | null {
  if (!text) return null
  let h: any
  try {
    h = JSON.parse(text)
  } catch {
    return text
  }
  if (!h || typeof h !== 'object') return text
  const out: Record<string, any> = {}
  for (const k of Object.keys(h)) {
    const lk = k.toLowerCase()
    if (DROP_HEADERS.has(lk)) continue
    const v = h[k]
    if (MASK_HEADERS.has(lk) && typeof v === 'string' && v.length > 0) {
      const tail = v.slice(-4)
      out[k] = v.length > 12 ? `***${tail}` : '***'
    } else {
      out[k] = v
    }
  }
  return JSON.stringify(out)
}

// ── 垃圾回收 ────────────────────────────────────────────
const REF_COLUMNS = [
  'request_headers_ref',
  'request_body_ref',
  'response_body_ref',
  'preprocessed_body_ref',
  'thinking_inject_ref',
  'upstream_response_body_ref',
]

/** 删除不再被任何日志行（直接或经 manifest）引用的 blob，返回删除数量 */
export function gcBlobs(): number {
  const tx = db.transaction(() => {
    db.exec('CREATE TEMP TABLE IF NOT EXISTS live_blobs (hash BLOB PRIMARY KEY) WITHOUT ROWID')
    db.exec('DELETE FROM live_blobs')
    for (const col of REF_COLUMNS) {
      db.exec(`INSERT OR IGNORE INTO live_blobs SELECT ${col} FROM request_logs WHERE ${col} IS NOT NULL`)
    }
    db.exec('INSERT OR IGNORE INTO live_blobs SELECT child FROM blob_edges WHERE parent IN (SELECT hash FROM live_blobs)')
    const r = db.prepare('DELETE FROM blobs WHERE hash NOT IN (SELECT hash FROM live_blobs)').run()
    db.exec('DELETE FROM blob_edges WHERE parent NOT IN (SELECT hash FROM blobs)')
    db.exec('DELETE FROM live_blobs')
    return r.changes
  })
  return tx()
}

/** 存储占用概览 */
export function blobStats(): { blobs: number; raw_bytes: number; stored_bytes: number; logs: number } {
  const b = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(raw_size),0) raw, COALESCE(SUM(LENGTH(data)),0) stored FROM blobs').get() as any
  const l = db.prepare('SELECT COUNT(*) n FROM request_logs').get() as any
  return { blobs: b.n, raw_bytes: b.raw, stored_bytes: b.stored, logs: l.n }
}
