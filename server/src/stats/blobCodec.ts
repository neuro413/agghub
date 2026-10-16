import zlib from 'node:zlib'

export const CODEC_RAW = 0
export const CODEC_ZSTD = 1
export const CODEC_GZIP = 2
const COMPRESS_MIN = 256
const z = zlib as any
export const hasZstd = typeof z.zstdCompressSync === 'function' && typeof z.zstdDecompressSync === 'function'

export function compress(buf: Buffer): { codec: number; data: Buffer } {
  if (buf.length < COMPRESS_MIN) return { codec: CODEC_RAW, data: buf }
  const codec = hasZstd ? CODEC_ZSTD : CODEC_GZIP
  const data: Buffer = hasZstd
    ? z.zstdCompressSync(buf, { params: { [z.constants.ZSTD_c_compressionLevel]: 3 } })
    : zlib.gzipSync(buf, { level: 6 })
  return data.length < buf.length ? { codec, data } : { codec: CODEC_RAW, data: buf }
}

/** 与 compress 同语义，但把压缩交给 zlib 线程池，避免阻塞主线程 */
export function compressAsync(buf: Buffer): Promise<{ codec: number; data: Buffer }> {
  if (buf.length < COMPRESS_MIN) return Promise.resolve({ codec: CODEC_RAW, data: buf })
  const codec = hasZstd ? CODEC_ZSTD : CODEC_GZIP
  return new Promise((resolve, reject) => {
    const done = (error: Error | null, data: Buffer) => {
      if (error) return reject(error)
      resolve(data.length < buf.length ? { codec, data } : { codec: CODEC_RAW, data: buf })
    }
    if (hasZstd) z.zstdCompress(buf, { params: { [z.constants.ZSTD_c_compressionLevel]: 3 } }, done)
    else zlib.gzip(buf, { level: 6 }, done)
  })
}

/** 冷包压缩交给 zlib 线程池，避免在 SQLite 事务和网关主线程内执行。 */
export function compressPack(buf: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    z.zstdCompress(buf, { params: {
      [z.constants.ZSTD_c_compressionLevel]: 6,
      [z.constants.ZSTD_c_enableLongDistanceMatching]: 0,
      [z.constants.ZSTD_c_windowLog]: 24,
    } }, (error: Error | null, data: Buffer) => error ? reject(error) : resolve(data))
  })
}

function outputOptions(rawSize?: number): { maxOutputLength?: number } {
  if (rawSize === undefined) return {}
  if (!Number.isSafeInteger(rawSize) || rawSize < 0) throw new Error('日志块原始长度无效')
  return { maxOutputLength: Math.max(1, rawSize) }
}

function checkSize(buf: Buffer, rawSize?: number): Buffer {
  if (rawSize !== undefined && buf.length !== rawSize) throw new Error('日志块解压长度不匹配')
  return buf
}

export function decompress(codec: number, data: Buffer, rawSize?: number): Buffer {
  const options = outputOptions(rawSize)
  switch (codec) {
    case CODEC_RAW: return checkSize(data, rawSize)
    case CODEC_ZSTD:
      if (!hasZstd) throw new Error('当前 Node 不支持 zstd，无法解压日志正文')
      return checkSize(z.zstdDecompressSync(data, options), rawSize)
    case CODEC_GZIP: return checkSize(zlib.gunzipSync(data, options), rawSize)
    default: throw new Error(`未知 blob 编码 ${codec}`)
  }
}

export async function decompressAsync(codec: number, data: Buffer, rawSize: number): Promise<Buffer> {
  const options = outputOptions(rawSize)
  if (codec === CODEC_RAW) return checkSize(data, rawSize)
  if (codec === CODEC_ZSTD && !hasZstd) throw new Error('当前 Node 不支持 zstd，无法解压日志正文')
  if (codec !== CODEC_ZSTD && codec !== CODEC_GZIP) throw new Error(`未知 blob 编码 ${codec}`)
  const decode = codec === CODEC_ZSTD ? z.zstdDecompress : zlib.gunzip
  const buf = await new Promise<Buffer>((resolve, reject) => {
    decode(data, options, (error: Error | null, result: Buffer) => error ? reject(error) : resolve(result))
  })
  return checkSize(buf, rawSize)
}

/** 独立存放的压缩文本：首字节为编码，其后为数据；兼容旧明文。 */
export function compressText(text: string): Buffer {
  const { codec, data } = compress(Buffer.from(text, 'utf8'))
  return Buffer.concat([Buffer.from([codec]), data])
}

export function decompressText(value: Buffer | string): string {
  return typeof value === 'string' ? value : decompress(value[0], value.subarray(1)).toString('utf8')
}
