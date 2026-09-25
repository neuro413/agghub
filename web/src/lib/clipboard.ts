export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true }
  } catch {}
  const active = document.activeElement as HTMLElement | null
  const selection = window.getSelection()
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : []
  const inputSelection = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? [active.selectionStart, active.selectionEnd] : null
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('aria-label', '待复制内容')
  Object.assign(textarea.style, { position: 'fixed', top: '0', left: '-9999px' })
  document.body.append(textarea)
  try { textarea.select(); return document.execCommand('copy') } catch { return false }
  finally {
    textarea.remove()
    active?.focus({ preventScroll: true })
    if (selection) { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range) }
    if (inputSelection && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) {
      try { active.setSelectionRange(inputSelection[0], inputSelection[1]) } catch {}
    }
  }
}
