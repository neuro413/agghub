import zlib from 'node:zlib'
import type { Channel, CompressionAlgorithm, CompressionUnsupported, CompressStatus, Settings } from '../types'
import { parseAutoBanCodes } from './failover'

/** 上游请求体压缩：决策、异步压缩、请求级缓存、回退判定与「不支持」内存记忆 */

export const ZSTD_AVAILABLE = typeof zlib.zstdCompress === 'function'

const ALGORITHMS: CompressionAlgorithm[] = ['gzip', 'br', 'zstd']

/** 算法与参数；content-encoding 头的值与 algorithm 相同 */
export interface AlgorithmPlan {
  algorithm: CompressionAlgorithm
  /** 'gzip-1' / 'br-2' / 'zstd-2'，带窗口时为 'zstd-2 w23' */
  label: string
  level: number
  windowLog?: number
}

export interface CompressionInfo {
  encoding: string | null
  raw_bytes: number
  sent_bytes: number
  ms: number | null
  status: CompressStatus | null
  note: string | null
}

export interface EncodedBody {
  body: string | Buffer
  /** content-encoding 头的值；null 表示明文 */
  encoding: string | null
  algorithm: CompressionAlgorithm | null
  info: CompressionInfo
}

/** 按当前设置取算法参数；压缩测试直接用，不受阈值和记忆影响 */
export function algorithmPlan(algorithm: CompressionAlgorithm, settings: Settings): AlgorithmPlan {
  if (algorithm === 'gzip') {
    const level = settings.upstream_compression_gzip_level
    return { algorithm, label: `gzip-${level}`, level }
  }
  if (algorithm === 'br') {
    const level = settings.upstream_compression_br_quality
    return { algorithm, label: `br-${level}`, level }
  }
  const level = settings.upstream_compression_zstd_level
  const windowLog = settings.upstream_compression_zstd_window_log || undefined
  return { algorithm, label: windowLog ? `zstd-${level} w${windowLog}` : `zstd-${level}`, level, windowLog }
}

/** 决策：返回要用的算法与参数，或不压缩的原因（总开关关闭时 status 为 null） */
export function planCompression(
  channel: Pick<Channel, 'id' | 'request_compression'>, settings: Settings, rawBytes: number, now = Date.now(),
): AlgorithmPlan | { algorithm: null; status: CompressStatus | null } {
  if (!settings.upstream_compression_enabled) return { algorithm: null, status: null }
  if (channel.request_compression === 'off') return { algorithm: null, status: 'off' }
  const algorithm = channel.request_compression ?? settings.upstream_compression_default
  if (algorithm === 'zstd' && !ZSTD_AVAILABLE) return { algorithm: null, status: 'runtime_unsupported' }
  if (isUnsupported(channel.id, algorithm, now)) return { algorithm: null, status: 'channel_unsupported' }
  if (rawBytes < settings.upstream_compression_min_bytes) return { algorithm: null, status: 'below_min' }
  return algorithmPlan(algorithm, settings)
}

/** 回调版 zlib API，在 libuv 线程池执行，不占主线程 */
export function compressBody(body: string | Buffer, plan: AlgorithmPlan): Promise<Buffer> {
  const buf = typeof body === 'string' ? Buffer.from(body) : body
  const { constants } = zlib
  return new Promise((resolve, reject) => {
    const done = (error: Error | null, result: Buffer) => error ? reject(error) : resolve(result)
    if (plan.algorithm === 'gzip') zlib.gzip(buf, { level: plan.level }, done)
    else if (plan.algorithm === 'br') {
      zlib.brotliCompress(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: plan.level, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }, done)
    } else {
      const params: Record<number, number> = { [constants.ZSTD_c_compressionLevel]: plan.level }
      if (plan.windowLog) params[constants.ZSTD_c_windowLog] = plan.windowLog
      zlib.zstdCompress(buf, { params }, done)
    }
  })
}

export interface RequestCompressor {
  encode(channel: Pick<Channel, 'id' | 'request_compression'>, body: string, settings: Settings, now?: number): Promise<EncodedBody>
}

/** 请求级压缩器：重试、换渠道、多 key 竞速共用；同一算法只保留最近一份，body 相同则复用（并发调用拿到同一个 Promise） */
export function createRequestCompressor(): RequestCompressor {
  const cache = new Map<string, { body: string; result: Promise<Buffer> }>()
  return {
    async encode(channel, body, settings, now = Date.now()) {
      const raw = Buffer.byteLength(body)
      const plain = (status: CompressStatus | null, note: string | null = null): EncodedBody => ({
        body, encoding: null, algorithm: null, info: { encoding: null, raw_bytes: raw, sent_bytes: raw, ms: null, status, note },
      })
      const plan = planCompression(channel, settings, raw, now)
      if (!plan.algorithm) return plain(plan.status)
      let entry = cache.get(plan.label)
      // 首个调用者记录耗时，命中缓存的记 0
      let started: number | undefined
      if (entry?.body !== body) {
        started = performance.now()
        entry = { body, result: compressBody(body, plan) }
        cache.set(plan.label, entry)
      }
      try {
        const compressed = await entry.result
        const ms = started === undefined ? 0 : Math.round((performance.now() - started) * 100) / 100
        return {
          body: compressed, encoding: plan.algorithm, algorithm: plan.algorithm,
          info: { encoding: plan.label, raw_bytes: raw, sent_bytes: compressed.length, ms, status: 'compressed', note: null },
        }
      } catch (error) {
        return plain('compress_error', (error instanceof Error ? error.message : String(error)).slice(0, 300))
      }
    },
  }
}

let compiled: { source: string; regex: RegExp | null } | undefined

/** 是否属于「上游不认压缩」：状态码在列表中，且错误体前 2000 字符匹配正则（正则为空则只看状态码） */
export function isCompressionRejection(status: number, errorText: string, settings: Settings): boolean {
  if (!parseAutoBanCodes(settings.upstream_compression_fallback_codes).includes(status)) return false
  const source = settings.upstream_compression_fallback_pattern
  if (!source) return true
  if (compiled?.source !== source) {
    let regex: RegExp | null = null
    try { regex = new RegExp(source, 'i') } catch {}
    compiled = { source, regex }
  }
  return !!compiled.regex?.test(errorText.slice(0, 2000))
}

const unsupported = new Map<string, number | null>() // `${channelId}:${algorithm}` → 到期时间，null = 直到重启

export function markUnsupported(
  channelId: number, algorithm: CompressionAlgorithm, settings: Pick<Settings, 'upstream_compression_unsupported_minutes'>, now = Date.now(),
): void {
  const minutes = settings.upstream_compression_unsupported_minutes
  unsupported.set(`${channelId}:${algorithm}`, minutes > 0 ? now + minutes * 60_000 : null)
}

export function isUnsupported(channelId: number, algorithm: CompressionAlgorithm, now = Date.now()): boolean {
  const key = `${channelId}:${algorithm}`
  if (!unsupported.has(key)) return false
  const until = unsupported.get(key)!
  if (until !== null && until <= now) {
    unsupported.delete(key)
    return false
  }
  return true
}

export function unsupportedList(channelId: number, now = Date.now()): CompressionUnsupported[] {
  return ALGORITHMS.filter(algorithm => isUnsupported(channelId, algorithm, now))
    .map(algorithm => ({ algorithm, until: unsupported.get(`${channelId}:${algorithm}`)! }))
}

export function clearUnsupported(channelId: number): void {
  for (const algorithm of ALGORITHMS) unsupported.delete(`${channelId}:${algorithm}`)
}
