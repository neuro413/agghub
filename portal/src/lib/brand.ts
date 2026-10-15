import type { PortalStatus } from '../types'

/** 图标是 http(s) 链接或上传地址时按图片显示，否则当作 emoji / 文字 */
export function isImageIcon(icon: string): boolean {
  return /^(https?:\/\/|\/)/i.test(icon)
}

function escapeXml(text: string): string {
  return text.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`)
}

/** emoji / 文字图标画成 SVG，字数越多字号越小 */
function textIcon(text: string): string {
  const size = Math.max(28, Math.min(90, Math.floor(120 / [...text].length)))
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text x='50' y='50' dominant-baseline='central' text-anchor='middle' font-size='${size}'>${escapeXml(text)}</text></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

/** 标签页标题和图标跟随站点设置；图标留空时去掉 favicon */
export function applyBranding(s: PortalStatus): void {
  document.title = s.site_title
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!s.brand_icon) {
    link?.remove()
    return
  }
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    document.head.appendChild(link)
  }
  link.href = isImageIcon(s.brand_icon) ? s.brand_icon : textIcon(s.brand_icon)
}
