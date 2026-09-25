import type { Settings } from '../types'
import { DEFAULT_SETTINGS } from '../config'
import { CandidateError } from './failover'
import { abortable, settleCleanup } from './requestLifecycle'
import { readBytes } from './bodyReader'
import { BoundedCapture } from './capture'
import { Semaphore } from './semaphore'
import { validateImageTarget, type ImageLookup } from './imagePolicy'
import { pinnedImageTransport, type ImageTransport } from './imageTransport'

type ImageSettings = Pick<Settings, 'image_max_bytes' | 'image_total_max_bytes' | 'image_max_count' | 'image_download_concurrency' | 'image_allowed_hosts'>
export interface ImageOptions {
  signal?: AbortSignal
  settings?: ImageSettings
  lookup?: ImageLookup
  transport?: ImageTransport
  onBytes?: () => void
}
export const imageDownloads = new Semaphore(8)
const defaults: ImageSettings = {
  image_max_bytes: Number(DEFAULT_SETTINGS.image_max_bytes), image_total_max_bytes: Number(DEFAULT_SETTINGS.image_total_max_bytes),
  image_max_count: Number(DEFAULT_SETTINGS.image_max_count), image_download_concurrency: Number(DEFAULT_SETTINGS.image_download_concurrency), image_allowed_hosts: [],
}
const mimeByExtension: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', pdf: 'application/pdf' }
function guessedMime(url: URL): string { return mimeByExtension[url.pathname.split('.').pop()?.toLowerCase() || ''] || 'image/jpeg' }

function dataImageSize(url: string): number {
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s.exec(url)
  if (!match) throw new CandidateError('图片 data URL 必须包含有效 base64')
  const data = match[2].replace(/\s/g, '')
  if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 === 1 || (data.includes('=') && data.length % 4 !== 0)) throw new CandidateError('图片 base64 无效')
  return Buffer.byteLength(data, 'base64')
}

/** 全部下载成功才替换工作副本，任何失败都保留完整原输入，供备用渠道使用。 */
export async function resolveImageUrls(ir: any, proxyUrl?: string, options: ImageOptions = {}): Promise<void> {
  const settings = options.settings ?? defaults
  const references: { part: any; url: string }[] = []
  for (const message of ir?.messages || []) {
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part?.type !== 'image_url') continue
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
      if (typeof url !== 'string' || !url) throw new CandidateError('图片地址为空或类型无效')
      references.push({ part, url })
    }
  }
  if (!references.length) return
  if (references.length > settings.image_max_count) throw new CandidateError(`图片数量超过 ${settings.image_max_count} 张限制`)
  const controller = new AbortController()
  const parent = options.signal
  const stop = () => controller.abort(parent?.reason)
  parent?.addEventListener('abort', stop, { once: true })
  if (parent?.aborted) stop()
  const results = new Map<string, string>()
  const urls = [...new Set(references.map(ref => ref.url))]
  let totalBytes = 0
  const account = (bytes: number) => {
    totalBytes += bytes
    if (totalBytes > settings.image_total_max_bytes) throw new CandidateError(`图片总大小超过 ${settings.image_total_max_bytes} 字节限制`)
  }

  const download = async (initial: string): Promise<string> => {
    const release = await imageDownloads.acquire(controller.signal)
    const local = new AbortController()
    const stopLocal = () => local.abort(controller.signal.reason)
    controller.signal.addEventListener('abort', stopLocal, { once: true })
    if (controller.signal.aborted) stopLocal()
    const timer = setTimeout(() => local.abort(new CandidateError('图片下载超过 15 秒时限')), 15_000)
    try {
      let current = initial
      for (let redirects = 0; redirects <= 3; redirects++) {
        local.signal.throwIfAborted()
        const target = await validateImageTarget(current, settings.image_allowed_hosts, local.signal, options.lookup)
        const transport = await abortable((options.transport ?? pinnedImageTransport)({ ...target, proxyUrl, signal: local.signal }), local.signal, late => { void late.dispose().catch(() => {}) })
        const { response } = transport
        try {
          local.signal.throwIfAborted()
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location')
            if (!location || redirects === 3) throw new CandidateError('图片重定向缺少目标或超过 3 次限制')
            try { current = new URL(location, target.url).href } catch { throw new CandidateError('图片重定向目标无效') }
            continue
          }
          if (!response.ok) throw new CandidateError(`图片下载返回 HTTP ${response.status}`)
          const length = Number(response.headers.get('content-length'))
          if (Number.isFinite(length) && length > settings.image_max_bytes) throw new CandidateError('图片 Content-Length 超过单张大小限制')
          if (!response.body) throw new CandidateError('图片下载没有响应体')
          // 保留二进制，不经 UTF-8 解码；按实际收到的（解压后）字节执行预算。
          const capture = new BoundedCapture(true, settings.image_max_bytes)
          let size = 0
          for await (const bytes of readBytes(response.body, { signal: local.signal, onBytes: options.onBytes })) {
            size += bytes.byteLength
            account(bytes.byteLength)
            if (size > settings.image_max_bytes) throw new CandidateError('图片实际大小超过单张限制')
            capture.append(bytes)
          }
          if (!size) throw new CandidateError('图片下载返回空内容')
          const mime = response.headers.get('content-type')?.split(';')[0]?.trim() || guessedMime(target.url)
          if (!/^[\w.+-]+\/[\w.+-]+$/.test(mime)) throw new CandidateError('图片媒体类型无效')
          return `data:${mime};base64,${capture.buffer()!.toString('base64')}`
        } finally {
          if (response.body && !response.body.locked) await settleCleanup(response.body.cancel().catch(() => {}))
          await settleCleanup(transport.dispose())
        }
      }
      throw new CandidateError('图片重定向次数超限')
    } finally {
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', stopLocal)
      local.abort()
      release()
    }
  }

  let cursor = 0
  const worker = async () => {
    while (cursor < urls.length) {
      const index = cursor++
      const url = urls[index]
      controller.signal.throwIfAborted()
      try {
        if (url.startsWith('data:')) {
          const size = dataImageSize(url)
          if (size > settings.image_max_bytes) throw new CandidateError('data URL 图片超过单张大小限制')
          account(size)
          results.set(url, url)
        } else results.set(url, await download(url))
      } catch (error) {
        const safe = parent?.aborted ? parent.reason : error instanceof CandidateError ? new CandidateError(`第 ${index + 1} 张图片处理失败：${error.message}`) : new CandidateError(`第 ${index + 1} 张图片下载或解析失败`)
        controller.abort(safe)
        throw safe
      }
    }
  }
  try {
    const settled = await Promise.allSettled(Array.from({ length: Math.min(settings.image_download_concurrency, urls.length) }, worker))
    const failed = settled.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw controller.signal.reason ?? failed.reason
    controller.signal.throwIfAborted()
    for (const { part, url } of references) {
      if (typeof part.image_url === 'string') part.image_url = results.get(url)!
      else part.image_url = { ...part.image_url, url: results.get(url)! }
    }
  } finally {
    parent?.removeEventListener('abort', stop)
    controller.abort()
  }
}
