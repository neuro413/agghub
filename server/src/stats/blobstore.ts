/** 内容寻址块存储：日志正文切块去重并压缩；冷块再按时间顺序打包，整包用长窗口 zstd 压缩。 */
import { createHash } from 'node:crypto'
import { setImmediate as yieldTurn } from 'node:timers/promises'
import { db } from '../db'
import { CODEC_ZSTD, compress, compressAsync, compressPack, decompress, decompressAsync, hasZstd } from './blobCodec'
export { compressText, decompressText } from './blobCodec'
const CHUNK_MIN = 128
const STRING_CHUNK_MIN = 64
const KIND_DATA = 0
const KIND_MANIFEST = 1
// 打包：相邻请求的正文高度相似（同一文件反复读取、上游回显的系统提示词与工具定义等），
// 整包压缩能消掉逐块压缩看不到的跨块重复。只打包超过 PACK_MIN_AGE 的冷块，凑不满最小包的尾部放满一天再打。
const PACK_MIN_AGE = 3_600_000
const PACK_FLUSH_AGE = 86_400_000
const PACK_TARGET_RAW = 16 << 20
// manifest 单独成包：相邻几轮的 manifest 只差末尾几项，拼在一起才压得掉；包更小，GC 和详情读取每次只解压几 MiB
const PACK_LIMITS: Record<number, { target: number; min: number }> = {
  [KIND_MANIFEST]: { target: 4 << 20, min: 1 << 20 },
  [KIND_DATA]: { target: PACK_TARGET_RAW, min: 4 << 20 },
}
const PACK_CACHE_MAX = 64 << 20
const PACK_CACHE_IDLE = 60_000
const PACK_MAX_BLOCKS = 1024
const READ_BATCH_SIZE = 200

// 旧布局（哈希主键、正文内嵌在 blobs 行里）不再自动迁移，需停服后用独立脚本转换
const blobColumns = db.prepare("SELECT name FROM pragma_table_info('blobs')").pluck().all() as string[]
if (blobColumns.length && (!blobColumns.includes('id') || blobColumns.includes('data'))) {
  throw new Error('日志块表仍是旧版布局，当前版本不再自动迁移；请停服后先转换数据库')
}

db.exec(`
CREATE TABLE IF NOT EXISTS blobs (
  id          INTEGER PRIMARY KEY,
  hash        BLOB    NOT NULL,
  kind        INTEGER NOT NULL DEFAULT 0,
  raw_size    INTEGER NOT NULL,
  codec       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  pack_id     INTEGER,
  pack_offset INTEGER,
  UNIQUE(kind, hash)
);
-- 散块正文单独成表：打包时整行删除，页面能整页释放；留在元数据行里置空只会留下回收不掉的页内空洞
CREATE TABLE IF NOT EXISTS blob_data (
  id   INTEGER PRIMARY KEY,
  data BLOB    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blobs_pack ON blobs(pack_id) WHERE pack_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_blobs_loose ON blobs(kind, created_at) WHERE pack_id IS NULL;
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

const BLOB_SELECT = 'SELECT b.id, b.hash, b.kind, b.raw_size, b.codec, b.pack_id, b.pack_offset, d.data FROM blobs b LEFT JOIN blob_data d ON d.id = b.id'
const selectId = db.prepare('SELECT id FROM blobs WHERE kind = ? AND hash = ?').pluck()
const insertBlob = db.prepare('INSERT INTO blobs (hash, kind, raw_size, codec, created_at) VALUES (?, ?, ?, ?, ?)')
const insertData = db.prepare('INSERT INTO blob_data (id, data) VALUES (?, ?)')
const selectBlob = db.prepare(`${BLOB_SELECT} WHERE b.id = ?`)
const selectPack = db.prepare('SELECT raw_size, codec, data FROM blob_packs WHERE id = ?')
const insertPack = db.prepare('INSERT INTO blob_packs (codec, raw_size, created_at, data) VALUES (?, ?, ?, ?)')
const deletePack = db.prepare('DELETE FROM blob_packs WHERE id = ?')
const selectLoose = db.prepare(
  `SELECT id, raw_size, created_at FROM blobs WHERE pack_id IS NULL AND kind = ?
   AND created_at < ? AND raw_size <= ? ORDER BY created_at, id LIMIT ?`,
)
const selectPacked = db.prepare('SELECT id, hash, kind, raw_size, codec, pack_id, pack_offset FROM blobs WHERE pack_id = ? ORDER BY pack_offset')
const setPacked = db.prepare('UPDATE blobs SET pack_id = ?, pack_offset = ? WHERE id = ?')
const deleteData = db.prepare('DELETE FROM blob_data WHERE id = ?')

const insertLoose = db.transaction((hash: Buffer, kind: number, rawSize: number, codec: number, data: Buffer): number => {
  const id = Number(insertBlob.run(hash, kind, rawSize, codec, Date.now()).lastInsertRowid)
  insertData.run(id, data)
  return id
})

export function putBlob(text: string, kind = KIND_DATA): number {
  const buf = Buffer.from(text, 'utf8')
  const hash = createHash('sha256').update(buf).digest()
  const existing = selectId.get(kind, hash) as number | undefined
  if (existing !== undefined) return existing
  const { codec, data } = compress(buf)
  return insertLoose(hash, kind, buf.length, codec, data)
}

// 异步写日志时，块先于日志行落库；这期间引用它的只有内存里的 id，GC 必须同样视为存活，
// 否则新插入的块、或去重命中的孤儿旧块会在日志行写入前被回收，留下悬空引用
const pinnedBlobs = new Map<number, number>()

/** 一次异步写入持有的块 id，写完（无论成败）交给 releaseBlobs */
export type BlobPins = number[]

function pinBlob(pins: BlobPins, id: number): number {
  pinnedBlobs.set(id, (pinnedBlobs.get(id) ?? 0) + 1)
  pins.push(id)
  return id
}

export function releaseBlobs(pins: BlobPins): void {
  for (const id of pins) {
    const left = (pinnedBlobs.get(id) ?? 1) - 1
    if (left > 0) pinnedBlobs.set(id, left)
    else pinnedBlobs.delete(id)
  }
  pins.length = 0
}

/** 存储代次；清空日志后递增，异步写入据此判断已拿到的块 id 是否失效 */
export function blobEpoch(): number {
  return storageEpoch
}

/** 异步写块：压缩在线程池执行，拿到的 id 记入 pins */
export async function putBlobAsync(text: string, pins: BlobPins, kind = KIND_DATA): Promise<number> {
  const buf = Buffer.from(text, 'utf8')
  const hash = createHash('sha256').update(buf).digest()
  const existing = selectId.get(kind, hash) as number | undefined
  if (existing !== undefined) return pinBlob(pins, existing)
  const { codec, data } = await compressAsync(buf)
  // 压缩期间可能已有相同内容写入，复用即可
  const id = (selectId.get(kind, hash) as number | undefined) ?? insertLoose(hash, kind, buf.length, codec, data)
  return pinBlob(pins, id)
}

type BlobRow = { id: number; hash: Buffer; kind: number; raw_size: number; codec: number; pack_id: number | null; pack_offset: number | null; data?: Buffer | null }
type PackRow = { raw_size: number; codec: number; data: Buffer }

function packSlice(buf: Buffer, offset: number | null, size: number): Buffer {
  if (!Number.isSafeInteger(offset) || offset! < 0 || !Number.isSafeInteger(size) || size < 0 || offset! + size > buf.length) {
    throw new Error('日志块包偏移或长度无效')
  }
  return buf.subarray(offset!, offset! + size)
}

function readBlob(row: BlobRow): string {
  if (row.pack_id != null) return packSlice(loadPack(row.pack_id), row.pack_offset, row.raw_size).toString('utf8')
  if (!row.data) throw new Error(`日志块正文缺失: ${row.id}`)
  return decompress(row.codec, row.data, row.raw_size).toString('utf8')
}

export function getBlob(id: number | null | undefined): string | null {
  if (id == null) return null
  const row = selectBlob.get(id) as BlobRow | undefined
  return row ? readBlob(row) : null
}

// 解压后的包按 LRU 缓存：一条长会话的历史消息分布在多个包里，逐条还原时避免反复解压；闲置一分钟后释放
const packCache = new Map<number, Buffer>()
let packCacheBytes = 0
let packCacheTimer: NodeJS.Timeout | undefined

function clearPackCache(): void {
  clearTimeout(packCacheTimer)
  packCacheTimer = undefined
  packCache.clear()
  packCacheBytes = 0
}

export function getPackCacheUsage(): { bytes: number; packs: number; limit: number } {
  return { bytes: packCacheBytes, packs: packCache.size, limit: PACK_CACHE_MAX }
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
  const row = selectPack.get(id) as PackRow | undefined
  if (!row) throw new Error(`日志块包缺失: ${id}`)
  buf = decompress(row.codec, row.data, row.raw_size)
  // 兼容旧版本产生的超大包，但不让单包突破常驻缓存预算。
  if (buf.length > PACK_CACHE_MAX) return buf
  for (const [key, value] of packCache) {
    if (packCacheBytes + buf.length <= PACK_CACHE_MAX) break
    packCache.delete(key)
    packCacheBytes -= value.length
  }
  packCache.set(id, buf)
  packCacheBytes += buf.length
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

/** 按切块规则拆出骨架与子块正文；非对象或不能无损往返的正文返回 null，整段存储 */
function splitJsonBody(text: string): { skeleton: any; parts: [(string | number)[], string][] } | null {
  let obj: any
  try { obj = JSON.parse(text) } catch {}
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || JSON.stringify(obj) !== text) return null
  const skeleton: any = Object.create(null)
  const parts: [(string | number)[], string][] = []
  for (const key of Object.keys(obj)) {
    const value = obj[key]
    if (ARRAY_KEYS.includes(key) && Array.isArray(value)) {
      skeleton[key] = value.map((item, i) => {
        const text = JSON.stringify(item)
        if (text !== undefined && text.length >= CHUNK_MIN) { parts.push([[key, i], text]); return null }
        return item
      })
    } else if (STRING_KEYS.includes(key) && typeof value === 'string' && value.length >= STRING_CHUNK_MIN) {
      skeleton[key] = null
      parts.push([[key], JSON.stringify(value)])
    } else skeleton[key] = value
  }
  return { skeleton, parts }
}

/** JSON 请求/响应体：把 messages 等大数组逐项切块，多轮对话重复的历史消息只存一份 */
export function putJsonBody(text: string): number {
  const split = splitJsonBody(text)
  if (!split) return putManifest({ v: 2, raw: putBlob(text) })
  return putManifest({ v: 2, s: split.skeleton, c: split.parts.map(([path, part]) => [path, putBlob(part)]) })
}

/** putJsonBody 的异步版本：切块规则相同，子块与 manifest 都在线程池压缩，逐块执行以免占满线程池 */
export async function putJsonBodyAsync(text: string, pins: BlobPins): Promise<number> {
  const split = splitJsonBody(text)
  if (!split) return putBlobAsync(JSON.stringify({ v: 2, raw: await putBlobAsync(text, pins) }), pins, KIND_MANIFEST)
  const chunks: [(string | number)[], number][] = []
  for (const [path, part] of split.parts) chunks.push([path, await putBlobAsync(part, pins)])
  const manifest: Manifest = { v: 2, s: split.skeleton, c: chunks }
  return putBlobAsync(JSON.stringify(manifest), pins, KIND_MANIFEST)
}

/** 缓存只活在一次详情还原中，不跨事务或 GC；共享历史消息只查库、解压和解析一次。 */
export function createBlobReader(ids: (number | null | undefined)[] = []) {
  const rows = new Map<number, BlobRow | undefined>()
  const texts = new Map<number, string | null>()
  const parsed = new Map<number, any>()
  const prefetch = (refs: (number | null | undefined)[]) => {
    const missing = [...new Set(refs.filter((id): id is number => id != null && !rows.has(id)))]
    for (let i = 0; i < missing.length; i += READ_BATCH_SIZE) {
      const batch = missing.slice(i, i + READ_BATCH_SIZE)
      for (const id of batch) rows.set(id, undefined)
      const found = db.prepare(`${BLOB_SELECT} WHERE b.id IN (${batch.map(() => '?').join(',')})`).all(...batch) as BlobRow[]
      for (const row of found) rows.set(row.id, row)
    }
  }
  const read = (id: number | null | undefined): string | null => {
    if (id == null) return null
    if (texts.has(id)) return texts.get(id)!
    prefetch([id])
    const row = rows.get(id)
    const text = row ? readBlob(row) : null
    texts.set(id, text)
    return text
  }
  const json = (id: number | null | undefined): string | null => {
    const text = read(id)
    if (text === null) return null
    const manifest = JSON.parse(text) as Manifest
    if ('raw' in manifest) return read(manifest.raw)
    prefetch(manifest.c.map(([, child]) => child))
    const root = manifest.s
    for (const [path, child] of manifest.c) {
      if (!parsed.has(child)) {
        const part = read(child)
        if (part === null) throw new Error(`日志块缺失: ${child}`)
        parsed.set(child, JSON.parse(part))
      }
      const parent = path.length === 2 ? root[path[0]] : root
      parent[path[path.length - 1]] = parsed.get(child)
    }
    return JSON.stringify(root)
  }
  prefetch(ids)
  return { getBlob: read, getJsonBody: json }
}

export function getJsonBody(id: number | null | undefined): string | null {
  return createBlobReader([id]).getJsonBody(id)
}

const REF_COLUMNS = [
  'request_headers_ref', 'request_body_ref', 'response_body_ref',
  'preprocessed_body_ref', 'thinking_inject_ref', 'upstream_response_body_ref',
]
const JSON_REF_COLUMNS = new Set(['request_body_ref', 'response_body_ref', 'preprocessed_body_ref'])

/** 标记和回收保持同一事务，避免异步维护期间新日志引用的块被误删。 */
export function gcBlobs(): number {
  return db.transaction(() => {
    db.exec('CREATE TEMP TABLE IF NOT EXISTS live_blobs (id INTEGER PRIMARY KEY)')
    db.exec('CREATE TEMP TABLE IF NOT EXISTS live_manifests (id INTEGER PRIMARY KEY)')
    db.exec('DELETE FROM live_blobs; DELETE FROM live_manifests')
    for (const column of REF_COLUMNS) {
      db.exec(`INSERT OR IGNORE INTO live_blobs SELECT ${column} FROM request_logs WHERE ${column} IS NOT NULL`)
      // 通过引用字段识别 manifest，也保护旧版本已发生 kind 混用的记录。
      if (JSON_REF_COLUMNS.has(column)) db.exec(`INSERT OR IGNORE INTO live_manifests SELECT ${column} FROM request_logs WHERE ${column} IS NOT NULL`)
    }
    // 异步写入中、日志行尚未落库的块同样存活；manifest 按块表里的实际 kind 识别
    const markPinned = db.prepare('INSERT OR IGNORE INTO live_blobs (id) VALUES (?)')
    const markPinnedManifest = db.prepare(`INSERT OR IGNORE INTO live_manifests SELECT id FROM blobs WHERE id = ? AND kind = ${KIND_MANIFEST}`)
    for (const id of pinnedBlobs.keys()) {
      markPinned.run(id)
      markPinnedManifest.run(id)
    }
    // manifest 按 id 顺序读取，和打包顺序一致，每个 manifest 包只需解压一次
    const manifests = db.prepare('SELECT id FROM live_manifests WHERE id > ? ORDER BY id LIMIT ?').pluck()
    const mark = db.prepare('INSERT OR IGNORE INTO live_blobs (id) VALUES (?)')
    for (let last = 0; ;) {
      const ids = manifests.all(last, READ_BATCH_SIZE) as number[]
      if (!ids.length) break
      const children = new Set<number>()
      for (const id of ids) for (const child of manifestChildren(id)) children.add(child)
      for (const child of children) mark.run(child)
      last = ids[ids.length - 1]
    }
    const result = db.prepare('DELETE FROM blobs WHERE id NOT IN (SELECT id FROM live_blobs)').run()
    db.exec('DELETE FROM blob_data WHERE id NOT IN (SELECT id FROM live_blobs)')
    db.exec('DELETE FROM live_blobs; DELETE FROM live_manifests')
    const empty = db.prepare('DELETE FROM blob_packs WHERE NOT EXISTS (SELECT 1 FROM blobs WHERE pack_id = blob_packs.id)').run()
    if (empty.changes) clearPackCache()
    return result.changes
  })()
}

let storageEpoch = 0
let packing: Promise<number> | undefined
const selectIdentity = db.prepare('SELECT hash, kind, pack_id, pack_offset, raw_size FROM blobs WHERE id = ?')
const commitPack = db.transaction((group: BlobRow[], rawSize: number, data: Buffer, epoch: number): boolean => {
  if (epoch !== storageEpoch) return false
  for (const blob of group) {
    const current = selectIdentity.get(blob.id) as BlobRow | undefined
    if (!current || !current.hash.equals(blob.hash) || current.kind !== blob.kind || current.raw_size !== blob.raw_size
      || current.pack_id !== blob.pack_id || current.pack_offset !== blob.pack_offset) return false
  }
  const id = Number(insertPack.run(CODEC_ZSTD, rawSize, Date.now(), data).lastInsertRowid)
  let offset = 0
  for (const blob of group) {
    setPacked.run(id, offset, blob.id)
    deleteData.run(blob.id)
    offset += blob.raw_size
  }
  return true
})

function takeGroup<T extends { raw_size: number }>(rows: T[], target: number): T[] {
  const group: T[] = []
  let size = 0
  for (const row of rows) {
    if (group.length >= PACK_MAX_BLOCKS || size + row.raw_size > target) break
    group.push(row)
    size += row.raw_size
  }
  return group
}

/** 失效数据过半的包直接重写有效片段，不经过单块压缩、写库、再解压的中间阶段。 */
async function compactPacks(maxPacks: number, deadline: number, epoch: number): Promise<number> {
  const sparse = db.prepare(`SELECT p.id, MIN(b.kind) AS kind FROM blob_packs p JOIN blobs b ON b.pack_id = p.id
    GROUP BY p.id HAVING SUM(b.raw_size) * 2 < p.raw_size AND MIN(b.raw_size) <= ?
    ORDER BY p.id LIMIT ?`).all(PACK_TARGET_RAW, maxPacks) as { id: number; kind: number }[]
  let written = 0
  for (const { id, kind } of sparse) {
    if (epoch !== storageEpoch || Date.now() >= deadline) break
    const pack = selectPack.get(id) as PackRow | undefined
    if (!pack) continue
    const raw = await decompressAsync(pack.codec, pack.data, pack.raw_size)
    if (epoch !== storageEpoch) break
    const target = (PACK_LIMITS[kind] ?? PACK_LIMITS[KIND_DATA]).target
    const candidates = (selectPacked.all(id) as BlobRow[]).filter(row => row.raw_size <= target)
    for (let start = 0; start < candidates.length;) {
      if (written >= maxPacks || epoch !== storageEpoch || Date.now() >= deadline) return written
      const group = takeGroup(candidates.slice(start), target)
      const data = Buffer.concat(group.map(row => packSlice(raw, row.pack_offset, row.raw_size)))
      const compressed = await compressPack(data)
      if (!commitPack(group, data.length, compressed, epoch)) return written
      written++
      start += group.length
      if (!db.prepare('SELECT 1 FROM blobs WHERE pack_id = ? LIMIT 1').get(id)) {
        deletePack.run(id)
        clearPackCache()
      }
      await yieldTurn()
    }
  }
  return written
}

export interface PackOptions { maxPacks?: number; maxMs?: number }

async function runPacking(now: number, options: PackOptions): Promise<number> {
  if (!hasZstd) return 0
  const maxPacks = Math.max(0, Math.floor(options.maxPacks ?? Number.MAX_SAFE_INTEGER))
  const deadline = Date.now() + (options.maxMs ?? Infinity)
  const epoch = storageEpoch
  let written = 0
  const more = () => written < maxPacks && epoch === storageEpoch && Date.now() < deadline
  // 普通正文与 manifest 分开成包，互不稀释；超大单块继续单独压缩存放，候选元数据也分批读取。
  for (const kind of [KIND_MANIFEST, KIND_DATA]) {
    const { target, min } = PACK_LIMITS[kind]
    while (more()) {
      const candidates = selectLoose.all(kind, now - PACK_MIN_AGE, target, PACK_MAX_BLOCKS + 1) as { id: number; raw_size: number; created_at: number }[]
      if (!candidates.length) break
      const selected = takeGroup(candidates, target)
      const size = selected.reduce((sum, row) => sum + row.raw_size, 0)
      if (size < min && selected.length === candidates.length && selected[0].created_at > now - PACK_FLUSH_AGE) break
      const group = selected.map(({ id }) => selectBlob.get(id) as BlobRow)
      const parts: Buffer[] = []
      for (let i = 0; i < group.length; i++) {
        const row = group[i]
        if (!row.data) throw new Error(`日志块正文缺失: ${row.id}`)
        parts.push(await decompressAsync(row.codec, row.data, row.raw_size))
        if (i % 32 === 31) await yieldTurn()
        if (epoch !== storageEpoch) return written
      }
      const raw = Buffer.concat(parts, size)
      const data = await compressPack(raw)
      if (!commitPack(group, raw.length, data, epoch)) return written
      written++
      await yieldTurn()
    }
  }
  if (more()) written += await compactPacks(maxPacks - written, deadline, epoch)
  return written
}

/** 冷块维护单飞运行，异步压缩后用短事务提交；清空日志或引用变化时丢弃过期结果。 */
export function packBlobs(now = Date.now(), options: PackOptions = {}): Promise<number> {
  if (!packing) packing = runPacking(now, options).finally(() => { packing = undefined })
  return packing
}

/** 清空全部块与包（清空日志用，需在外层事务内调用） */
export function clearBlobs(): void {
  storageEpoch++
  db.exec('DELETE FROM blobs')
  db.exec('DELETE FROM blob_data')
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
