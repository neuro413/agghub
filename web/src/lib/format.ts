export function fmtNum(n?: number): string {
  if (!n) return '0'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(n)
}

export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
  return n + ' B'
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

/** 时长：小于 1 秒显示 420ms，否则显示 8.4s */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export type RateTone = 'ok' | 'warn' | 'err' | 'none'

/** 成功率档位（百分数）：≥95 ok，80–94 warn，<80 err；null 表示没有请求 */
export function rateTone(rate: number | null | undefined): RateTone {
  if (rate == null) return 'none'
  return rate >= 95 ? 'ok' : rate >= 80 ? 'warn' : 'err'
}

/** 成功率百分数（取整）；没有请求时为 null，不显示成 100% */
export function successRate(success: number | undefined, total: number | undefined): number | null {
  if (!total) return null
  return Math.round(((success || 0) / total) * 100)
}
