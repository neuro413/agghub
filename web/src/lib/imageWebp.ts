export interface WebpOptions {
  quality: number
  maxWidth: number
}

/** 浏览器端转 WebP：quality 为 50–95 的整数 */
export async function toWebp(file: File, { quality, maxWidth }: WebpOptions): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const canvas = document.createElement('canvas')
  try {
    const scale = maxWidth > 0 && bitmap.width > maxWidth ? maxWidth / bitmap.width : 1
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('图片转换失败')
    ctx.drawImage(bitmap, 0, 0, width, height)
  } finally {
    bitmap.close()
  }

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/webp', quality / 100)
  })
  if (!blob) throw new Error('图片转换失败')
  // 旧版 Safari 不支持 WebP 编码时会悄悄返回 PNG
  if (blob.type !== 'image/webp') throw new Error('当前浏览器不支持 WebP 编码')
  return blob
}

export interface WebpPrefs {
  enabled: boolean
  quality: number
  maxWidth: number
}

const WEBP_PREFS_KEY = 'agghub.background.webp'

export const DEFAULT_WEBP_PREFS: WebpPrefs = { enabled: true, quality: 85, maxWidth: 1920 }

export function loadWebpPrefs(): WebpPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(WEBP_PREFS_KEY) || '')
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_WEBP_PREFS }
    const { enabled, quality, maxWidth } = raw as Partial<WebpPrefs>
    return {
      enabled: typeof enabled === 'boolean' ? enabled : DEFAULT_WEBP_PREFS.enabled,
      quality:
        typeof quality === 'number' && Number.isFinite(quality)
          ? Math.min(95, Math.max(50, Math.round(quality)))
          : DEFAULT_WEBP_PREFS.quality,
      maxWidth:
        typeof maxWidth === 'number' && Number.isFinite(maxWidth)
          ? Math.max(0, Math.round(maxWidth))
          : DEFAULT_WEBP_PREFS.maxWidth,
    }
  } catch {
    return { ...DEFAULT_WEBP_PREFS }
  }
}

export function saveWebpPrefs(prefs: WebpPrefs): void {
  localStorage.setItem(WEBP_PREFS_KEY, JSON.stringify(prefs))
}
