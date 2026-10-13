import type { ApiKey } from '../types'

// 内存限流：RPM 滑动窗口 + 并发计数，重启清零（额度在数据库里，不受影响）

export type Admission =
  | { ok: true; release: () => void }
  | { ok: false; reason: 'rpm' | 'concurrency'; retryAfterSeconds: number }

const WINDOW_MS = 60_000
/** keyId → 最近 60 秒内被放行请求的时间戳（升序） */
const windows = new Map<number, number[]>()
/** keyId → 进行中的请求数 */
const active = new Map<number, number>()

/**
 * 生成接口进入时调用：先查 RPM（滑动 60 秒窗口），再占并发名额。
 * 成功返回 release，调用方在响应关闭时调用一次（重复调用必须无副作用）。
 * rpm / concurrency 为 null 表示不限。
 */
export function admitRequest(key: ApiKey, now = Date.now()): Admission {
  if (key.rpm != null) {
    const kept = (windows.get(key.id) ?? []).filter(t => t > now - WINDOW_MS)
    if (kept.length) windows.set(key.id, kept)
    else windows.delete(key.id)
    if (kept.length >= key.rpm) {
      // 最早一条过期后即可再放行
      const retryAfterSeconds = Math.max(1, Math.ceil((kept[0] + WINDOW_MS - now) / 1000))
      return { ok: false, reason: 'rpm', retryAfterSeconds }
    }
  }
  if (key.concurrency != null && (active.get(key.id) ?? 0) >= key.concurrency) {
    return { ok: false, reason: 'concurrency', retryAfterSeconds: 1 }
  }
  // 两项都通过后才记录；被拒绝的请求不占名额
  if (key.rpm != null) {
    const stamps = windows.get(key.id) ?? []
    stamps.push(now)
    windows.set(key.id, stamps)
  }
  active.set(key.id, (active.get(key.id) ?? 0) + 1)
  let released = false
  const release = () => {
    if (released) return
    released = true
    const remaining = (active.get(key.id) ?? 1) - 1
    if (remaining > 0) active.set(key.id, remaining)
    else active.delete(key.id)
  }
  return { ok: true, release }
}

/** 清空全部计数（测试用） */
export function resetLimiter(): void {
  windows.clear()
  active.clear()
}
