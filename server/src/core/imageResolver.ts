import type { Settings } from '../types'
import { parseDataUrl } from '../convert/ir'
import { CandidateError } from './failover'
import { getProxyAgent } from './proxy'

type ImageSettings = Pick<Settings, 'image_max_bytes' | 'proxy_url'>

/** Gemini 只接受内联图片：把远程图片下载成 data URL。任一失败整体失败，由 relay 切换渠道。 */
export async function resolveImageUrls(ir: any, settings: ImageSettings, signal: AbortSignal): Promise<void> {
  const parts: any[] = []
  for (const message of ir?.messages || []) {
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part?.type === 'image_url') parts.push(part)
    }
  }
  if (!parts.length) return
  const downloads = new Map<string, Promise<string>>()
  const resolve = (url: string) => {
    if (!downloads.has(url)) downloads.set(url, toDataUrl(url, settings, signal))
    return downloads.get(url)!
  }
  const urls = await Promise.all(parts.map(part => resolve(typeof part.image_url === 'string' ? part.image_url : part.image_url?.url || '')))
  parts.forEach((part, i) => {
    part.image_url = typeof part.image_url === 'string' ? urls[i] : { ...part.image_url, url: urls[i] }
  })
}

async function toDataUrl(url: string, settings: ImageSettings, signal: AbortSignal): Promise<string> {
  const max = settings.image_max_bytes
  if (url.startsWith('data:')) {
    const parsed = parseDataUrl(url)
    if (!parsed?.data) throw new CandidateError('图片 data URL 必须包含有效 base64')
    if (Buffer.byteLength(parsed.data, 'base64') > max) throw new CandidateError('data URL 图片超过单张大小限制')
    return url
  }
  if (!/^https?:\/\//i.test(url)) throw new CandidateError('图片地址无效')
  let response: Response
  try {
    response = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      dispatcher: settings.proxy_url ? getProxyAgent(settings.proxy_url) : undefined,
    } as RequestInit)
  } catch (error) {
    if (signal.aborted) throw signal.reason
    throw new CandidateError(`图片下载失败：${(error as Error).message}`)
  }
  if (!response.ok || Number(response.headers.get('content-length')) > max) {
    void response.body?.cancel().catch(() => {})
    throw new CandidateError(response.ok ? '图片 Content-Length 超过单张大小限制' : `图片下载返回 HTTP ${response.status}`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > max) throw new CandidateError('图片实际大小超过单张限制')
  if (!bytes.length) throw new CandidateError('图片下载返回空内容')
  const mime = response.headers.get('content-type')?.split(';')[0].trim() || 'image/jpeg'
  return `data:${mime};base64,${bytes.toString('base64')}`
}
