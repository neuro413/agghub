export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true }
  } catch {}
  // 内网 HTTP 页面不是安全上下文，没有 Clipboard API，降级到 execCommand
  const active = document.activeElement as HTMLElement | null
  const textarea = document.createElement('textarea')
  textarea.value = text
  Object.assign(textarea.style, { position: 'fixed', top: '0', left: '-9999px' })
  document.body.append(textarea)
  try { textarea.select(); return document.execCommand('copy') } catch { return false }
  finally {
    textarea.remove()
    active?.focus({ preventScroll: true })
  }
}
