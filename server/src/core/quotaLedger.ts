import type { BillingAccount } from './billing'

/** 进程内在途预扣；重启清零，与既有的内存限流一致 */
const reserved = new Map<string, number>()

const ledgerKey = (account: BillingAccount): string => account.type === 'user' ? `u${account.id}` : `k${account.id}`

export function reservedPoints(account: BillingAccount): number {
  return reserved.get(ledgerKey(account)) ?? 0
}

/** 预扣一定点数，返回释放函数（幂等） */
export function reserveQuota(account: BillingAccount, points: number): () => void {
  const key = ledgerKey(account)
  reserved.set(key, (reserved.get(key) ?? 0) + points)
  let released = false
  return () => {
    if (released) return
    released = true
    const left = (reserved.get(key) ?? 0) - points
    if (left > 0) reserved.set(key, left)
    else reserved.delete(key)
  }
}

/** 测试用 */
export function resetQuotaLedger(): void {
  reserved.clear()
}
