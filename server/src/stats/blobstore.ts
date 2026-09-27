/** 内容寻址块存储：日志正文切块去重并压缩；冷块再按时间顺序打包，整包用长窗口 zstd 压缩。 */
import { createHash } from 'node:crypto'
import zlib from 'node:zlib'
import { db } from '../db'

const CODEC_RAW = 0
const CODEC_ZSTD = 1
const CODEC_GZIP = 2
const COMPRESS_MIN = 256
const CHUNK_MIN = 128
const STRING_CHUNK_MIN = 64
const KIND_DATA = 0
/** manifest 始终保持散块：GC 每轮都要逐个读取，打进包里会拖慢 GC */
const KIND_MANIFEST = 1
// 打包：相邻请求的正文高度相似（同一文件反复读取、上游回显的系统提示词与工具定义等），
// 整包压缩能消掉逐块压缩看不到的跨块重复。只打包超过 PACK_MIN_AGE 的冷块，凑不满 PACK_MIN_RAW 的尾部放满一天再打。
const PACK_MIN_AGE = 3_600_000
const PACK_FLUSH_AGE = 86_400_000
const PACK_TARGET_RAW = 16 << 20
const PACK_MIN_RAW = 4 << 20
const PACK_CACHE_MAX = 64 << 20
const PACK_CACHE_IDLE = 60_000
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

function compressPack(buf: Buffer): Buffer {
  return z.zstdCompressSync(buf, {
    params: {
      [z.constants.ZSTD_c_compressionLevel]: 9,
      [z.constants.ZSTD_c_enableLongDistanceMatching]: 1,
      [z.constants.ZSTD_c_windowLog]: 24,
    },
  })
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

/** 独立存放的压缩文本（不进块存储）：首字节为编码，其后为数据 */
export function compressText(text: string): Buffer {
  const { codec, data } = compress(Buffer.from(text, 'utf8'))
  return Buffer.concat([Buffer.from([codec]), data])
}

export function decompressText(value: Buffer | string): string {
  return typeof value === 'string' ? value : decompress(value[0], value.subarray(1)).toString('utf8')
}

// 旧版块表以 32 字节哈希为主键、用 blob_edges 记录父子关系；先改名让出表名，建好新表后再搬数据（见文末）
const blobColumns = db.prepare("SELECT name FROM pragma_table_info('blobs')").pluck().all() as string[]
if (blobColumns.length && !blobColumns.includes('id')) db.exec('ALTER TABLE blobs RENAME TO blobs_v1')

db.exec(`
-- 散块：data 为单独压缩的内容；已打包：data 为 NULL，内容是 blob_packs 解压后 [pack_offset, pack_offset + raw_size) 这一段
CREATE TABLE IF NOT EXISTS blobs (
  id          INTEGER PRIMARY KEY,
  hash        BLOB    NOT NULL UNIQUE,
  kind        INTEGER NOT NULL DEFAULT 0,
  raw_size    INTEGER NOT NULL,
  codec       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  pack_id     INTEGER,
  pack_offset INTEGER,
  data        BLOB
);
CREATE INDEX IF NOT EXISTS idx_blobs_pack ON blobs(pack_id) WHERE pack_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_blobs_loose ON blobs(created_at) WHERE pack_id IS NULL AND kind = 0;
CREATE TABLE IF NOT EXISTS blob_packs (
  id         INTEGER PRIMARY KEY,
  codec      INTEGER NOT NULL,
  raw_size   INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  data       BLOB    NOT NULL
);
`)

const ARRAY_KEYS = ['messages', 'input', 'tools', 'system']
const STRING_KEYS = ['system', 'instructions']
/** s：去掉大块后的骨架；c：[路径, 块 id]。非 JSON 正文存为 { raw: 块 id } */
type Manifest = { v: 2; s: any; c: [(string | number)[], number][] } | { v: 2; raw: number }

const selectId = db.prepare('SELECT id FROM blobs WHERE hash = ?').pluck()
const insertBlob = db.prepare('INSERT INTO blobs (hash, kind, raw_size, codec, created_at, data) VALUES (?, ?, ?, ?, ?, ?)')
const selectBlob = db.prepare('SELECT raw_size, codec, pack_id, pack_offset, data FROM blobs WHERE id = ?')
const selectPack = db.prepare('SELECT codec, data FROM blob_packs WHERE id = ?')
const insertPack = db.prepare('INSERT INTO blob_packs (codec, raw_size, created_at, data) VALUES (?, ?, ?, ?)')
const deletePack = db.prepare('DELETE FROM blob_packs WHERE id = ?')
const selectLoose = db.prepare(
  `SELECT id, raw_size, created_at FROM blobs WHERE pack_id IS NULL AND kind = ${KIND_DATA} AND created_at < ? ORDER BY created_at, id`,
)
const selectPacked = db.prepare('SELECT id, raw_size, pack_offset FROM blobs WHERE pack_id = ?')
const setPacked = db.prepare('UPDATE blobs SET pack_id = ?, pack_offset = ?, data = NULL WHERE id = ?')
const setLoose = db.prepare('UPDATE blobs SET pack_id = NULL, pack_offset = NULL, codec = ?, data = ? WHERE id = ?')

export function putBlob(text: string, kind = KIND_DATA): number {
  const buf = Buffer.from(text, 'utf8')
  const hash = createHash('sha256').update(buf).digest()
  const existing = selectId.get(hash) as number | undefined
  if (existing !== undefined) return existing
  const { codec, data } = compress(buf)
  return Number(insertBlob.run(hash, kind, buf.length, codec, Date.now(), data).lastInsertRowid)
}

type BlobRow = { raw_size: number; codec: number; pack_id: number | null; pack_offset: number | null; data: Buffer | null }

export function getBlob(id: number | null | undefined): string | null {
  if (id == null) return null
  const row = selectBlob.get(id) as BlobRow | undefined
  if (!row) return null
  if (row.pack_id == null) return decompress(row.codec, row.data!).toString('utf8')
  return loadPack(row.pack_id).toString('utf8', row.pack_offset!, row.pack_offset! + row.raw_size)
}

// 解压后的包按 LRU 缓存：一条长会话的历史消息分布在多个包里，逐条还原时避免反复解压；闲置一分钟后释放
const packCache = new Map<number, Buffer>()
let packCacheBytes = 0
let packCacheTimer: NodeJS.Timeout | undefined

function clearPackCache(): void {
  packCache.clear()
  packCacheBytes = 0
}

function loadPack(id: number): Buffer {
  clearTimeout(packCacheTimer)
  packCacheTimer = setTimeout(clearPackCache, PACK_CACHE_IDLE).unref()
  let buf = packCache.get(id)
  if (buf) {
    packCache.delete(id)
    packCache.set(id, buf)
    return buf
  }
  const row = selectPack.get(id) as { codec: number; data: Buffer } | undefined
  if (!row) throw new Error(`日志块包缺失: ${id}`)
  buf = decompress(row.codec, row.data)
  packCache.set(id, buf)
  packCacheBytes += buf.length
  for (const [key, value] of packCache) {
    if (packCacheBytes <= PACK_CACHE_MAX || key === id) break
    packCache.delete(key)
    packCacheBytes -= value.length
  }
  return buf
}

function putManifest(manifest: Manifest): number {
  return putBlob(JSON.stringify(manifest), KIND_MANIFEST)
}

function manifestChildren(id: number): number[] {
  const text = getBlob(id)
  if (text === null) return []
  const manifest = JSON.parse(text) as Manifest
  return 'raw' in manifest ? [manifest.raw] : manifest.c.map(([, child]) => child)
}

/** JSON 请求/响应体：把 messages 等大数组逐项切块，多轮对话重复的历史消息只存一份 */
export function putJsonBody(text: string): number {
  let obj: any
  try { obj = JSON.parse(text) } catch {}
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || JSON.stringify(obj) !== text) {
    return putManifest({ v: 2, raw: putBlob(text) })
  }
  const skeleton: any = Object.create(null)
  const chunks: [(string | number)[], number][] = []
  const emit = (path: (string | number)[], value: any): void => {
    chunks.push([path, putBlob(JSON.stringify(value))])
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
  return putManifest({ v: 2, s: skeleton, c: chunks })
}

export function getJsonBody(id: number | null | undefined): string | null {
  const text = getBlob(id)
  if (text === null) return null
  const manifest = JSON.parse(text) as Manifest
  if ('raw' in manifest) return getBlob(manifest.raw)
  const root = manifest.s
  for (const [path, child] of manifest.c) {
    const part = getBlob(child)
    if (part === null) throw new Error(`日志块缺失: ${child}`)
    const parent = path.length === 2 ? root[path[0]] : root
    parent[path[path.length - 1]] = JSON.parse(part)
  }
  return JSON.stringify(root)
}

const REF_COLUMNS = [
  'request_headers_ref', 'request_body_ref', 'response_body_ref',
  'preprocessed_body_ref', 'thinking_inject_ref', 'upstream_response_body_ref',
]
const JSON_REF_COLUMNS = new Set(['request_body_ref', 'response_body_ref', 'preprocessed_body_ref'])

/** 删除不再被任何日志行（直接或经 manifest）引用的块，并整理活块不足一半的包；返回删除的块数。 */
export function gcBlobs(): number {
  return db.transaction(() => {
    db.exec('CREATE TEMP TABLE IF NOT EXISTS live_blobs (id INTEGER PRIMARY KEY)')
    db.exec('DELETE FROM live_blobs')
    for (const column of REF_COLUMNS) {
      db.exec(`INSERT OR IGNORE INTO live_blobs SELECT ${column} FROM request_logs WHERE ${column} IS NOT NULL`)
    }
    const manifests = db.prepare(`SELECT id FROM blobs WHERE kind = ${KIND_MANIFEST} AND id IN (SELECT id FROM live_blobs)`).pluck().all() as number[]
    const children = new Set<number>()
    for (const id of manifests) for (const child of manifestChildren(id)) children.add(child)
    const mark = db.prepare('INSERT OR IGNORE INTO live_blobs (id) VALUES (?)')
    for (const id of children) mark.run(id)
    const result = db.prepare('DELETE FROM blobs WHERE id NOT IN (SELECT id FROM live_blobs)').run()
    db.exec('DELETE FROM live_blobs')
    compactPacks()
    return result.changes
  })()
}

/** 活块不足一半的包拆回散块，由下一轮打包和其他冷块一起重新压缩；已无活块的包直接删除 */
function compactPacks(): void {
  const packs = db.prepare(
    'SELECT p.id, p.raw_size, COALESCE(SUM(b.raw_size), 0) AS live FROM blob_packs p LEFT JOIN blobs b ON b.pack_id = p.id GROUP BY p.id',
  ).all() as { id: number; raw_size: number; live: number }[]
  const sparse = packs.filter(pack => pack.live * 2 < pack.raw_size)
  for (const pack of sparse) {
    if (pack.live > 0) {
      const buf = loadPack(pack.id)
      for (const blob of selectPacked.all(pack.id) as { id: number; raw_size: number; pack_offset: number }[]) {
        const { codec, data } = compress(buf.subarray(blob.pack_offset, blob.pack_offset + blob.raw_size))
        setLoose.run(codec, data, blob.id)
      }
    }
    deletePack.run(pack.id)
  }
  if (sparse.length) clearPackCache()
}

const writePack = db.transaction((group: { id: number }[]): void => {
  const parts = group.map(({ id }) => {
    const row = selectBlob.get(id) as BlobRow
    return decompress(row.codec, row.data!)
  })
  const raw = Buffer.concat(parts)
  const packId = Number(insertPack.run(CODEC_ZSTD, raw.length, Date.now(), compressPack(raw)).lastInsertRowid)
  let offset = 0
  group.forEach(({ id }, i) => {
    setPacked.run(packId, offset, id)
    offset += parts[i].length
  })
})

/** 把冷散块按创建顺序打包，返回写入的包数；运行时不支持 zstd 时不打包 */
export function packBlobs(now = Date.now()): number {
  if (!hasZstd) return 0
  const candidates = selectLoose.all(now - PACK_MIN_AGE) as { id: number; raw_size: number; created_at: number }[]
  let written = 0
  for (let start = 0; start < candidates.length;) {
    let end = start
    let size = 0
    while (end < candidates.length && size < PACK_TARGET_RAW) size += candidates[end++].raw_size
    if (size < PACK_MIN_RAW && candidates[start].created_at > now - PACK_FLUSH_AGE) break
    writePack(candidates.slice(start, end))
    written++
    start = end
  }
  return written
}

/** 清空全部块与包（清空日志用，需在外层事务内调用） */
export function clearBlobs(): void {
  db.exec('DELETE FROM blobs')
  db.exec('DELETE FROM blob_packs')
  clearPackCache()
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

/** 旧版块存储迁移：正文块原样搬运并分配整数 id，manifest 改写为 id 引用，日志引用列同步换成 id，最后删掉 blob_edges 并整库重建 */
function migrateLegacyBlobs(): void {
  console.log('[agghub] 正在迁移日志块存储格式，日志较多时需要一些时间……')
  const logs = db.prepare(`SELECT id, ${REF_COLUMNS.join(', ')} FROM request_logs`).all() as Record<string, any>[]
  const manifests = new Set<string>()
  for (const row of logs) for (const column of JSON_REF_COLUMNS) if (row[column]) manifests.add(row[column].toString('hex'))
  const selectPage = db.prepare('SELECT hash, raw_size, codec, data, created_at FROM blobs_v1 WHERE hash > ? ORDER BY hash LIMIT 256')
  const selectLegacy = db.prepare('SELECT codec, data FROM blobs_v1 WHERE hash = ?')
  const update = db.prepare(`UPDATE request_logs SET ${REF_COLUMNS.map(column => `${column} = ?`).join(', ')} WHERE id = ?`)
  const ids = new Map<string, number>()
  // 旧 manifest 缺子块时无法还原，对应引用置空
  const rewrite = (hex: string): number | null => {
    const row = selectLegacy.get(Buffer.from(hex, 'hex')) as { codec: number; data: Buffer } | undefined
    if (!row) return null
    const old = JSON.parse(decompress(row.codec, row.data).toString('utf8'))
    if ('raw' in old) {
      const raw = ids.get(old.raw)
      return raw === undefined ? null : putManifest({ v: 2, raw })
    }
    const chunks: [(string | number)[], number][] = []
    for (const [path, child] of old.c as [(string | number)[], string][]) {
      const id = ids.get(child)
      if (id === undefined) return null
      chunks.push([path, id])
    }
    return putManifest({ v: 2, s: old.s, c: chunks })
  }
  db.transaction(() => {
    for (let last: Buffer = Buffer.alloc(0); ;) {
      const rows = selectPage.all(last) as { hash: Buffer; raw_size: number; codec: number; data: Buffer; created_at: number }[]
      if (!rows.length) break
      for (const row of rows) {
        const hex = row.hash.toString('hex')
        if (!manifests.has(hex)) ids.set(hex, Number(insertBlob.run(row.hash, KIND_DATA, row.raw_size, row.codec, row.created_at, row.data).lastInsertRowid))
      }
      last = rows[rows.length - 1].hash
    }
    const rewritten = new Map<string, number | null>()
    for (const hex of manifests) rewritten.set(hex, rewrite(hex))
    for (const row of logs) {
      const refs = REF_COLUMNS.map(column => {
        const hex = row[column]?.toString('hex')
        if (!hex) return null
        return (JSON_REF_COLUMNS.has(column) ? rewritten.get(hex) : ids.get(hex)) ?? null
      })
      update.run(...refs, row.id)
    }
    db.exec('DROP TABLE blobs_v1')
    db.exec('DROP TABLE IF EXISTS blob_edges')
  })()
  db.exec('VACUUM')
  console.log('[agghub] 日志块存储迁移完成')
}

if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'blobs_v1'").get()) migrateLegacyBlobs()
