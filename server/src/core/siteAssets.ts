import type { RequestHandler } from 'express'
import { db } from '../db'

interface AssetSpec {
  name: string
  /** 公开访问地址；内网与公网端口都免鉴权提供，管理端可以直接预览 */
  path: string
  /** 解码后的大小上限 */
  maxBytes: number
  mimes: Set<string>
  typeError: string
  sizeError: string
}

/** 上传图标的公开地址 */
export const BRAND_ICON_PATH = '/api/user/brand-icon'
/** 解码后的图标大小上限 */
export const BRAND_ICON_MAX_BYTES = 512 * 1024
const BRAND_ICON: AssetSpec = {
  name: 'brand_icon', path: BRAND_ICON_PATH, maxBytes: BRAND_ICON_MAX_BYTES,
  mimes: new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon']),
  typeError: '图标须为 PNG / JPEG / GIF / WebP / SVG / ICO 图片',
  sizeError: `图标不能超过 ${BRAND_ICON_MAX_BYTES / 1024} KB`,
}

/** 上传背景图的公开地址 */
export const BACKGROUND_PATH = '/api/user/background'
export const BACKGROUND_MAX_BYTES = 5 * 1024 * 1024
const BACKGROUND: AssetSpec = {
  name: 'portal_background', path: BACKGROUND_PATH, maxBytes: BACKGROUND_MAX_BYTES,
  mimes: new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  typeError: '背景图须为 PNG / JPEG / GIF / WebP 图片',
  sizeError: `背景图不能超过 ${BACKGROUND_MAX_BYTES / 1024 / 1024} MB`,
}

const getStmt = db.prepare('SELECT mime, data FROM site_assets WHERE name = ?')
const putStmt = db.prepare(
  `INSERT INTO site_assets (name, mime, data, updated_at) VALUES (?, ?, ?, ?)
   ON CONFLICT(name) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at`,
)

/** 解析 data URI 存入站点资源，返回带版本号的访问地址；格式或大小不符时抛错 */
function saveAsset(spec: AssetSpec, dataUri: unknown, now: number): string {
  const match = typeof dataUri === 'string' ? /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUri) : null
  if (!match || !spec.mimes.has(match[1])) throw new Error(spec.typeError)
  const data = Buffer.from(match[2], 'base64')
  if (!data.length || data.length > spec.maxBytes) throw new Error(spec.sizeError)
  putStmt.run(spec.name, match[1], data, now)
  return `${spec.path}?v=${now}`
}

/** 地址带版本号，可以长期缓存；SVG 加沙箱 CSP，直接打开也不会执行脚本 */
function serveAsset(spec: AssetSpec): RequestHandler {
  return (_req, res) => {
    const row = getStmt.get(spec.name) as { mime: string; data: Buffer } | undefined
    if (!row) return res.status(404).end()
    res.setHeader('Content-Type', row.mime)
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.end(row.data)
  }
}

export const saveBrandIcon = (dataUri: unknown, now = Date.now()): string => saveAsset(BRAND_ICON, dataUri, now)
export const serveBrandIcon = serveAsset(BRAND_ICON)
export const saveBackground = (dataUri: unknown, now = Date.now()): string => saveAsset(BACKGROUND, dataUri, now)
export const serveBackground = serveAsset(BACKGROUND)
