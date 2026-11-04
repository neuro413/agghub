import type { ProxyAgent } from 'undici'
import { getProxyAgent } from '../core/proxy'
import { activePortOf, isRunning, localUrl, reloadedWithin } from './core'
import { getPoolSettings } from './settings'
import { allNodes, isSubHealthy, recordLimit, recordNetworkFailure, recordSuccess } from './store'
import type { PoolNode } from './types'

export interface PoolFilter {
  include?: string | null
  exclude?: string | null
}

export interface FailDetail {
  message?: string
  status?: number
  retryAfterMs?: number
}

/** 一次节点租用：结束时必须 release */
export interface Lease {
  node: { id: number; name: string }
  url: string
  dispatcher: ProxyAgent
  /** 收到上游任何 HTTP 响应：节点是通的 */
  success(): void
  /** network = 网络层错误；limit = 上游 429/403 */
  fail(kind: 'network' | 'limit', detail?: FailDetail): void
  /** inFlight--，幂等 */
  release(): void
}

/** 逗号（含中文逗号）或换行分隔，转小写 */
export function splitKeywords(raw: string | null | undefined): string[] {
  return (raw ?? '').split(/[,，\n]/).map(s => s.trim().toLowerCase()).filter(Boolean)
}

function nameMatches(name: string, include: string[], exclude: string[]): boolean {
  const lower = name.toLowerCase()
  if (include.length && !include.some(k => lower.includes(k))) return false
  return !exclude.some(k => lower.includes(k))
}

function usable(node: PoolNode, now: number): boolean {
  return !node.disabled && !node.invalid_reason && !(node.cooldown_until && node.cooldown_until > now) && activePortOf(node.id) !== undefined
}

/** 选一个节点：健康优先，再挑并发少、最久没用过的（相当于轮询） */
export function acquireNode(filter: PoolFilter, excludeIds?: Set<number>): Lease | null {
  if (!isRunning()) return null
  const now = Date.now()
  const include = splitKeywords(filter.include)
  const exclude = splitKeywords(filter.exclude)
  let best: PoolNode | null = null
  let bestTier = 0
  for (const node of allNodes()) {
    if (excludeIds?.has(node.id) || !usable(node, now) || !nameMatches(node.name, include, exclude)) continue
    const tier = isSubHealthy(node) ? 2 : 1
    if (
      !best ||
      tier < bestTier ||
      (tier === bestTier && (node.inFlight < best.inFlight ||
        (node.inFlight === best.inFlight && (node.lastSelectedAt < best.lastSelectedAt ||
          (node.lastSelectedAt === best.lastSelectedAt && node.id < best.id)))))
    ) {
      best = node
      bestTier = tier
    }
  }
  if (!best) return null
  const node = best
  const port = activePortOf(node.id)!
  node.lastSelectedAt = now
  node.inFlight++
  const url = localUrl(port)
  let succeeded = false
  let failed = false
  let released = false
  return {
    node: { id: node.id, name: node.name },
    url,
    dispatcher: getProxyAgent(url),
    success() {
      if (succeeded || failed) return
      succeeded = true
      recordSuccess(node.id)
    },
    fail(kind, detail = {}) {
      if (failed) return
      failed = true
      if (kind === 'limit') {
        const cooldown = Math.max(getPoolSettings().limit_cooldown_seconds * 1000, detail.retryAfterMs ?? 0)
        recordLimit(node.id, detail.status ?? 429, cooldown)
      } else if (!reloadedWithin(3000)) {
        recordNetworkFailure(node.id, detail.message || '网络错误')
      }
    },
    release() {
      if (released) return
      released = true
      node.inFlight = Math.max(0, node.inFlight - 1)
    },
  }
}

/** 拿不到节点时的说明 */
export function noNodeMessage(): string {
  return isRunning() ? '代理池没有可用节点' : '代理池内核未运行'
}

/** 渠道弹窗提示：名称匹配的启用节点数 / 其中当前可用数 */
export function matchCount(filter: PoolFilter): { matched: number; available: number; running: boolean } {
  const now = Date.now()
  const include = splitKeywords(filter.include)
  const exclude = splitKeywords(filter.exclude)
  let matched = 0
  let available = 0
  for (const node of allNodes()) {
    if (node.disabled || node.invalid_reason || !nameMatches(node.name, include, exclude)) continue
    matched++
    if (usable(node, now)) available++
  }
  return { matched, available, running: isRunning() }
}
