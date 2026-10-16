import type { Settings } from '../types'
import { parseDataUrl } from '../convert/ir'
import { CandidateError } from './failover'
import { getProxyAgent } from './proxy'
import { assertPublicUrl, getSafeAgent } from './ssrf'

type ImageSettings = Pick<Settings, 'image_max_bytes' | 'proxy_url'>

export interface ImageOptions {
  /** 公网调用方：启用 SSRF 防护（拒绝内网地址、手动校验重定向） */
  restrictPrivate?: boolean
}

/** 单张图片解压后允许的最大字节数，仅在 settings 未提供单张上限时兜底 */
const MAX_IMAGE_BYTES_FALLBACK = 20 << 20
/** 单请求最多下载多少张图片 */
const MAX_IMAGES_PER_REQUEST = 16
/** 单请求图片解压后的总字节上限 */
const MAX_IMAGE_TOTAL_BYTES = 64 << 20
/** 单请求图片下载的并发上限，避免多张大图同时驻留内存 */
const MAX_IMAGE_CONCURRENCY = 4

/** 请求级共享的字节计数器：同一请求内所有图片解压后累计 */
interface ByteCounter {
  bytes: number
}

/** Gemini 只接受内联图片：把远程图片下载成 data URL。任一失败整体失败，由 relay 切换渠道。 */
export async function resolveImageUrls(ir: any, settings: ImageSettings, signal: AbortSignal, options: ImageOptions = {}): Promise<void> {
  const parts: any[] = []
  for (const message of ir?.messages || []) {
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part?.type === 'image_url') parts.push(part)
    }
  }
  if (!parts.length) return
  const urlOf = (part: any): string => typeof part.image_url === 'string' ? part.image_url : part.image_url?.url || ''
  // 只限制真正需要下载的远程地址；内联 data URL 已在请求体里，同一地址只下载一次
  const remote = new Set(parts.map(urlOf).filter(url => !url.startsWith('data:')))
  if (remote.size > MAX_IMAGES_PER_REQUEST) throw new CandidateError(`单次请求最多包含 ${MAX_IMAGES_PER_REQUEST} 张远程图片`)
  const total: ByteCounter = { bytes: 0 }
  const downloads = new Map<string, Promise<string>>()
  const resolve = (url: string) => {
    if (!downloads.has(url)) downloads.set(url, toDataUrl(url, settings, signal, options.restrictPrivate === true, total))
    return downloads.get(url)!
  }
  const urls = await mapWithConcurrency(parts, MAX_IMAGE_CONCURRENCY, part => resolve(urlOf(part)))
  parts.forEach((part, i) => {
    part.image_url = typeof part.image_url === 'string' ? urls[i] : { ...part.image_url, url: urls[i] }
  })
}

/** 简单的并发闸门：最多同时进行 limit 个下载任务，失败时整体抛出 */
async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const run = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await worker(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  return results
}

/** 流式读取响应体，按解压后的累计字节封顶，避免一次性读入内存 */
async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<Buffer> {
  if (!body) throw new CandidateError('图片下载返回空内容')
  const reader = body.getReader()
  const parts: Buffer[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value.byteLength) continue
      size += value.byteLength
      // 必须按解压后的字节判断：Content-Length 是压缩前的长度，gzip 可放大三个数量级
      if (size > max) {
        await reader.cancel().catch(() => {})
        throw new CandidateError('图片实际大小超过单张限制')
      }
      parts.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(parts, size)
}

/** 状态码、类型、大小校验并转 data URL（内网 / 公网两条下载路径共用） */
async function finalize(response: Response, max: number, total: ByteCounter): Promise<string> {
  if (!response.ok) {
    void response.body?.cancel().catch(() => {})
    throw new CandidateError(`图片下载返回 HTTP ${response.status}`)
  }
  // Content-Length 只是压缩后长度的快速预检，命中能提前失败，但不能作为唯一依据
  if (Number(response.headers.get('content-length')) > max) {
    void response.body?.cancel().catch(() => {})
    throw new CandidateError('图片 Content-Length 超过单张大小限制')
  }
  const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || ''
  if (!mime.startsWith('image/')) {
    void response.body?.cancel().catch(() => {})
    throw new CandidateError('图片地址返回的不是图片')
  }
  const bytes = await readCapped(response.body, max)
  if (!bytes.length) throw new CandidateError('图片下载返回空内容')
  total.bytes += bytes.length
  if (total.bytes > MAX_IMAGE_TOTAL_BYTES) throw new CandidateError('单次请求图片总大小超过限制')
  return `data:${mime};base64,${bytes.toString('base64')}`
}

/** 公网模式：逐跳校验 SSRF，手动跟随最多 3 次重定向 */
async function downloadRestricted(url: string, settings: ImageSettings, signal: AbortSignal, max: number, total: ByteCounter): Promise<string> {
  let current: URL
  try {
    current = new URL(url)
  } catch {
    throw new CandidateError('图片地址无效')
  }
  for (let hop = 0; hop < 4; hop++) {
    await assertPublicUrl(current)
    let response: Response
    try {
      response = await fetch(current, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        redirect: 'manual',
        headers: { 'accept-encoding': 'identity' },
        dispatcher: settings.proxy_url ? getProxyAgent(settings.proxy_url) : getSafeAgent(),
      } as RequestInit)
    } catch (error) {
      if (signal.aborted) throw signal.reason
      throw new CandidateError('图片下载失败')
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      if (location) {
        void response.body?.cancel().catch(() => {})
        try {
          current = new URL(location, current)
        } catch {
          throw new CandidateError('图片地址无效')
        }
        continue
      }
    }
    return finalize(response, max, total)
  }
  throw new CandidateError('图片重定向次数过多')
}

async function toDataUrl(url: string, settings: ImageSettings, signal: AbortSignal, restrictPrivate: boolean, total: ByteCounter): Promise<string> {
  const max = settings.image_max_bytes || MAX_IMAGE_BYTES_FALLBACK
  if (url.startsWith('data:')) {
    const parsed = parseDataUrl(url)
    if (!parsed?.data) throw new CandidateError('图片 data URL 必须包含有效 base64')
    if (Buffer.byteLength(parsed.data, 'base64') > max) throw new CandidateError('data URL 图片超过单张大小限制')
    return url
  }
  if (!/^https?:\/\//i.test(url)) throw new CandidateError('图片地址无效')
  if (restrictPrivate) return downloadRestricted(url, settings, signal, max, total)
  let response: Response
  try {
    response = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      headers: { 'accept-encoding': 'identity' },
      dispatcher: settings.proxy_url ? getProxyAgent(settings.proxy_url) : undefined,
    } as RequestInit)
  } catch (error) {
    if (signal.aborted) throw signal.reason
    throw new CandidateError(`图片下载失败：${(error as Error).message}`)
  }
  return finalize(response, max, total)
}
