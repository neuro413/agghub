import compression from 'compression'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import type { Request, RequestHandler, Response } from 'express'
import type { ServeStaticOptions } from 'serve-static'
import { getSettings } from '../db'

/** 显示 Key 明文的接口：响应里有密钥，压缩会引入 BREACH 风险 */
const KEY_REVEAL = /^\/api\/user\/keys\/\d+\/key$/

/** /v1、SSE、显示 Key 明文的接口一律不压缩 */
export function shouldCompressResponse(req: Request, res: Response): boolean {
  if (String(res.getHeader('Content-Type') ?? '').includes('text/event-stream')) return false
  if (KEY_REVEAL.test(req.path)) return false
  return compression.filter(req, res)
}

/** 运行时按设置生效：实例按 (level, br_quality, threshold) 缓存，改设置立即生效 */
export function responseCompression(): RequestHandler {
  let cached: { key: string; handler: RequestHandler } | undefined
  return (req, res, next) => {
    const s = getSettings()
    if (!s.response_compression_enabled || req.path.startsWith('/v1')) return next()
    const key = `${s.response_compression_level}:${s.response_compression_br_quality}:${s.response_compression_threshold}`
    if (cached?.key !== key) {
      cached = {
        key,
        handler: compression({
          level: s.response_compression_level, threshold: s.response_compression_threshold, filter: shouldCompressResponse,
          brotli: { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: s.response_compression_br_quality } },
        }),
      }
    }
    // br 质量为 0 表示只用 gzip：compression 默认优先 br，从协商里去掉它
    const accept = req.headers['accept-encoding']
    if (s.response_compression_br_quality === 0 && typeof accept === 'string') {
      req.headers['accept-encoding'] = accept.split(',').filter(part => part.split(';')[0].trim().toLowerCase() !== 'br').join(',')
    }
    cached.handler(req, res, next)
  }
}

function cacheControl(): string | null {
  const days = getSettings().static_assets_max_age_days
  return days > 0 ? `public, max-age=${days * 86_400}, immutable` : null
}

const ASSETS_SEGMENT = `${path.sep}assets${path.sep}`

/** express.static 的 setHeaders：/assets/ 下带哈希的文件加长缓存 */
export function staticOptions(): ServeStaticOptions {
  return {
    setHeaders(res, filePath) {
      const value = filePath.includes(ASSETS_SEGMENT) ? cacheControl() : null
      if (value) res.setHeader('Cache-Control', value)
    },
  }
}

const PRECOMPRESSED = [['br', '.br'], ['gzip', '.gz']] as const

/** 客户端是否接受该编码（q=0 视为拒绝） */
function accepts(header: string, encoding: string): boolean {
  return header.split(',').some(part => {
    const [name, ...params] = part.split(';').map(v => v.trim().toLowerCase())
    if (name !== encoding) return false
    const q = params.find(p => p.startsWith('q='))
    return !q || Number(q.slice(2)) > 0
  })
}

/** /assets 预压缩文件：按 Accept-Encoding 优先 br 再 gzip，命中时直接 sendFile */
export function precompressedAssets(assetsDir: string): RequestHandler {
  const root = path.resolve(assetsDir)
  // 只缓存原文件存在的路径，随机路径不会让缓存无限增长；构建产物带哈希，进程内有效
  const variants = new Map<string, Set<string>>()
  const lookup = (file: string): Set<string> | null => {
    const hit = variants.get(file)
    if (hit) return hit
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return null
    const found = new Set(PRECOMPRESSED.filter(([, ext]) => fs.statSync(file + ext, { throwIfNoEntry: false })?.isFile()).map(([, ext]) => ext))
    variants.set(file, found)
    return found
  }
  return (req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !getSettings().static_precompressed) return next()
    const accept = req.headers['accept-encoding']
    if (typeof accept !== 'string' || !accept) return next()
    let relative: string
    try { relative = decodeURIComponent(req.path) } catch { return next() }
    const file = path.resolve(root, '.' + relative)
    if (!file.startsWith(root + path.sep)) return next()
    const found = lookup(file)
    const match = found && PRECOMPRESSED.find(([encoding, ext]) => found.has(ext) && accepts(accept, encoding))
    if (!match) return next()
    // sendFile 在已有 Content-Type / Cache-Control 时不覆盖；compression 看到 Content-Encoding 会跳过
    res.type(path.extname(file))
    res.setHeader('Content-Encoding', match[0])
    res.append('Vary', 'Accept-Encoding')
    const value = cacheControl()
    if (value) res.setHeader('Cache-Control', value)
    // 读取失败且尚未发出响应时撤掉编码头，交给 express.static 返回原文件
    res.sendFile(file + match[1], { dotfiles: 'allow' }, error => {
      if (!error || res.headersSent) return
      res.removeHeader('Content-Encoding')
      next()
    })
  }
}
