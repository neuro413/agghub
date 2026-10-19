import fs from 'node:fs'
import path from 'node:path'
import type { RequestHandler } from 'express'
import { PORTAL_DIST } from '../config'
import { getSettings } from '../db'
import { validBackground } from './settingsValidation'
import type { Settings } from '../types'

const INDEX_PATH = path.join(PORTAL_DIST, 'index.html')
/** 模板里 link 标签跨行，href 的 data URI 还带 ">"，必须让 href 值整体跳过 */
const ICON_LINK_RE = /<link\b[^>]*\brel=["']icon["'][^>]*?\bhref="[^"]*"[^>]*>/i

let cached: string | null | undefined

/** 门户 index.html 只在首次请求时读取；读不到返回 null，由调用方回退到静态文件 */
function template(): string | null {
  if (cached !== undefined) return cached
  try {
    cached = fs.readFileSync(INDEX_PATH, 'utf8')
  } catch {
    cached = null
  }
  return cached
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function escapeXml(text: string): string {
  return text.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`)
}

/** emoji / 文字图标画成 SVG，与前端 lib/brand.ts 的 textIcon 保持一致 */
function textIcon(text: string): string {
  const size = Math.max(28, Math.min(90, Math.floor(120 / [...text].length)))
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text x='50' y='50' dominant-baseline='central' text-anchor='middle' font-size='${size}'>${escapeXml(text)}</text></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

/** 与前端 isImageIcon 一致：http(s) 链接或站内路径按图片地址用，其余当作 emoji / 文字 */
function iconHref(icon: string): string | null {
  if (!icon) return null
  return /^(https?:\/\/|\/)/i.test(icon) ? icon : textIcon(icon)
}

/** 背景图与面板参数写成 CSS 变量，与前端 lib/brand.ts 的 applyBackground 保持一致；地址经校验不含引号、括号与尖括号 */
function backgroundStyle(s: Settings): string {
  if (!s.portal_background || !validBackground(s.portal_background)) return ''
  return `<style id="pt-background">:root{--pt-bg-image:url("${s.portal_background}");--pt-panel-alpha:${s.portal_background_opacity / 100};`
    + `--pt-panel-blur:${s.portal_background_blur}px;--pt-bg-dim:${s.portal_background_dim / 100}}</style>`
}

/**
 * 把站点标题、图标和背景直接写进首屏 HTML。
 * 浏览器解析 <head> 时就能拿到品牌，避免先闪一下静态默认标题、🍊 与白底。
 */
export function renderPortalHtml(): string | null {
  let html = template()
  if (html === null) return null
  const s = getSettings()

  const title = `<title>${escapeHtml(s.portal_site_title)}</title>`
  html = /<title>[\s\S]*?<\/title>/i.test(html)
    ? html.replace(/<title>[\s\S]*?<\/title>/i, () => title)
    : html.replace(/<\/head>/i, () => `${title}</head>`)

  const href = iconHref(s.portal_brand_icon)
  const link = href === null ? '' : `<link rel="icon" href="${escapeHtml(href)}" />`
  html = ICON_LINK_RE.test(html)
    ? html.replace(ICON_LINK_RE, () => link)
    : link
      ? html.replace(/<\/head>/i, () => `${link}</head>`)
      : html

  const style = backgroundStyle(s)
  if (style) html = html.replace(/<html\b/i, '<html data-bg').replace(/<\/head>/i, () => `${style}</head>`)
  return html
}

/** 门户页面入口：注入失败时交给后续静态中间件处理 */
export const sendPortalHtml: RequestHandler = (_req, res, next) => {
  const html = renderPortalHtml()
  if (html === null) return next()
  // 设置改动后立即生效，同时避免反代缓存旧页面
  res.setHeader('Cache-Control', 'no-cache')
  res.type('html').send(html)
}
