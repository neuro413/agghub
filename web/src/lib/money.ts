import type { Settings } from '../types'

// 金额显示：内部仍按整数点数存储，按设置里的换算比例和符号显示，与门户口径一致；App 启动时读取一次设置
let pointsPerUnit = 500000
let symbol = '$'

export function setMoneyConfig(s: Pick<Settings, 'portal_points_per_usd' | 'currency_symbol'>): void {
  if (s.portal_points_per_usd > 0) pointsPerUnit = s.portal_points_per_usd
  if (s.currency_symbol) symbol = s.currency_symbol
}

export function currencySymbol(): string {
  return symbol
}

/** 去掉浮点尾巴和多余的 0，用作输入框文本 */
export function trimNum(n: number, digits = 6): string {
  return String(Number(n.toFixed(digits)))
}

/** 点数 → 金额 */
export function toAmount(points: number): number {
  return points / pointsPerUnit
}

/** 金额 → 整数点数 */
export function toPoints(amount: number): number {
  return Math.round(amount * pointsPerUnit)
}

/** 点数 → 金额输入框文本 */
export function amountText(points: number): string {
  return trimNum(toAmount(points))
}

/** 每 Token 倍率 → 每百万 Token 价格 */
export function ratioToPrice(ratio: number): number {
  return (ratio * 1_000_000) / pointsPerUnit
}

/** 每百万 Token 价格 → 每 Token 倍率 */
export function priceToRatio(price: number): number {
  return (price * pointsPerUnit) / 1_000_000
}

/** 金额：≥1 保留 2 位，≥0.01 保留 4 位，更小的保留 6 位；负数（透支）显示在符号前 */
export function money(points: number | null | undefined): string {
  const value = toAmount(points ?? 0)
  const abs = Math.abs(value)
  if (abs === 0) return `${symbol}0.00`
  const digits = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6
  const text = abs.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  if (Number(text.replace(/,/g, '')) === 0) return `${value < 0 ? '-' : ''}<${symbol}0.000001`
  return `${value < 0 ? '-' : ''}${symbol}${text}`
}
