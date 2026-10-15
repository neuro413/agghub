import type { RequestHandler } from 'express'
import { db } from '../db'

const BRAND_ICON = 'brand_icon'
/** 上传图标的公开地址；内网与公网端口都免鉴权提供，管理端可以直接预览 */
export const BRAND_ICON_PATH = '/api/user/brand-icon'
/** 解码后的图标大小上限 */
export const BRAND_ICON_MAX_BYTES = 512 * 1024
const MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon'])

const getStmt = db.prepare('SELECT mime, data FROM site_assets WHERE name = ?')
const putStmt = db.prepare(
  `INSERT INTO site_assets (name, mime, data, updated_at) VALUES (?, ?, ?, ?)
   ON CONFLICT(name) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at`,
)

/** 解析 data URI 存为品牌图标，返回带版本号的访问地址；格式或大小不符时抛错 */
export function saveBrandIcon(dataUri: unknown, now = Date.now()): string {
  const match = typeof dataUri === 'string' ? /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUri) : null
  if (!match || !MIMES.has(match[1])) throw new Error('图标须为 PNG / JPEG / GIF / WebP / SVG / ICO 图片')
  const data = Buffer.from(match[2], 'base64')
  if (!data.length || data.length > BRAND_ICON_MAX_BYTES) throw new Error(`图标不能超过 ${BRAND_ICON_MAX_BYTES / 1024} KB`)
  putStmt.run(BRAND_ICON, match[1], data, now)
  return `${BRAND_ICON_PATH}?v=${now}`
}

/** 地址带版本号，可以长期缓存；SVG 加沙箱 CSP，直接打开也不会执行脚本 */
export const serveBrandIcon: RequestHandler = (_req, res) => {
  const row = getStmt.get(BRAND_ICON) as { mime: string; data: Buffer } | undefined
  if (!row) return res.status(404).end()
  res.setHeader('Content-Type', row.mime)
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.end(row.data)
}
