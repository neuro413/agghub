// 点数 → $：比例来自 /status，启动时设置一次
let pointsPerUsd = 500000

export function setPointsPerUsd(value: number): void {
  if (value > 0) pointsPerUsd = value
}

/** 金额：≥1 保留 2 位，≥0.01 保留 4 位，更小的保留 6 位；负数（透支）显示 -$ */
export function usd(points: number | null | undefined): string {
  const value = (points ?? 0) / pointsPerUsd
  const abs = Math.abs(value)
  if (abs === 0) return '$0.00'
  const digits = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6
  const text = abs.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  if (Number(text.replace(/,/g, '')) === 0) return value < 0 ? '-<$0.000001' : '<$0.000001'
  return `${value < 0 ? '-' : ''}$${text}`
}

/** 每 Token 倍率 → 每百万 Token 的美元价格 */
export function perMillion(ratio: number): string {
  const value = (ratio * 1_000_000) / pointsPerUsd
  if (value === 0) return '免费'
  return `$${value >= 100 ? value.toFixed(0) : value >= 1 ? value.toFixed(2) : value.toFixed(4)}`
}

export function num(value: number | null | undefined): string {
  return (value ?? 0).toLocaleString('en-US')
}

const pad = (x: number) => String(x).padStart(2, '0')

export function dateTime(ts: number | null | undefined, seconds = true): string {
  if (!ts) return '-'
  const d = new Date(ts)
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  return seconds ? `${base}:${pad(d.getSeconds())}` : base
}

export function date(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 服务器同样按本地日期计日，门户与服务器同时区时一致 */
export function localDay(ts = Date.now()): string {
  return date(ts)
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前，超过 30 天显示日期 */
export function ago(ts: number | null | undefined): string {
  if (!ts) return '从未使用'
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return date(ts)
}

export function seconds(ms: number | null | undefined): string {
  if (ms == null) return '-'
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 1000).toFixed(2)} s`
}
