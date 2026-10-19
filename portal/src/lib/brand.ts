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

/** 背景写成根元素上的 CSS 变量，与服务端 siteHtml 首屏注入的一致；未设置时去掉 data-bg，恢复纯白外观 */
function applyBackground(s: PortalStatus): void {
  const root = document.documentElement
  if (!s.background) {
    delete root.dataset.bg
    return
  }
  root.dataset.bg = ''
  root.style.setProperty('--pt-bg-image', `url("${s.background}")`)
  root.style.setProperty('--pt-panel-alpha', String(s.background_opacity / 100))
  root.style.setProperty('--pt-panel-blur', `${s.background_blur}px`)
  root.style.setProperty('--pt-bg-dim', String(s.background_dim / 100))
}

/** 标签页标题、图标和背景跟随站点设置；图标留空时去掉 favicon */
export function applyBranding(s: PortalStatus): void {
  applyBackground(s)
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
