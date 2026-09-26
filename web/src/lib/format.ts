export function fmtNum(n?: number): string {
  if (!n) return '0'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(n)
}

export function fmtTime(ts: number, seconds = false): string {
  const d = new Date(ts)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}${seconds ? ':' + p(d.getSeconds()) : ''}`
}

export function prettyJson(s: string | null): string {
  if (!s) return ''
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}

/** 删除 / 清空后当前页可能越界：退回最后一个合法页 */
export function clampOffset(offset: number, total: number, size: number): number {
  return Math.min(Math.max(0, offset), total > 0 ? Math.floor((total - 1) / size) * size : 0)
}
