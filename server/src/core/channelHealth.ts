import { db } from '../db'
import type { Settings } from '../types'

type BanSettings = Pick<Settings, 'auto_ban_threshold' | 'auto_ban_cooldown_minutes'>

const streaks = new Map<number, number>() // 连续命中熔断状态码次数
const halfOpen = new Set<number>() // 自动恢复后尚未成功过的渠道：再命中一次立即停用

/** 某次尝试命中熔断状态码（调用方已确认 auto_ban 开启）；返回 true 表示本次已把渠道自动停用 */
export function onBanSignal(channelId: number, settings: BanSettings, now = Date.now()): boolean {
  const count = (streaks.get(channelId) ?? 0) + 1
  streaks.set(channelId, count)
  if (count < Math.max(1, settings.auto_ban_threshold) && !halfOpen.has(channelId)) return false
  streaks.delete(channelId)
  halfOpen.delete(channelId)
  const until = settings.auto_ban_cooldown_minutes > 0 ? now + settings.auto_ban_cooldown_minutes * 60_000 : null
  db.prepare('UPDATE channels SET status = 2, ban_until = ?, updated_at = ? WHERE id = ?').run(until, now, channelId)
  return true
}

/** 某次尝试成功：清零该渠道的连续失败计数与半开标记 */
export function onAttemptSuccess(channelId: number): void {
  streaks.delete(channelId)
  halfOpen.delete(channelId)
}

/** 维护定时器每分钟调用：把 status=2 且 ban_until 已到期的渠道恢复为启用；返回恢复数量 */
export function recoverChannels(now = Date.now()): number {
  const ids = db.prepare('SELECT id FROM channels WHERE status = 2 AND ban_until IS NOT NULL AND ban_until <= ?').pluck().all(now) as number[]
  if (!ids.length) return 0
  const update = db.prepare('UPDATE channels SET status = 1, ban_until = NULL, updated_at = ? WHERE id = ?')
  db.transaction(() => { for (const id of ids) update.run(now, id) })()
  for (const id of ids) {
    halfOpen.add(id)
    streaks.delete(id)
  }
  return ids.length
}

/** 手动启停或删除渠道时调用：清除内存计数和半开标记 */
export function resetChannelHealth(channelId: number): void {
  streaks.delete(channelId)
  halfOpen.delete(channelId)
}
