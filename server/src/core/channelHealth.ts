import { setChannelStatus } from '../db'
import type { Settings } from '../types'

// 【签名桩】由「安全加固」任务实现；导出名称和参数类型不得修改，relay.ts / 渠道路由 / 维护定时器已按此调用。
// 当前桩保持旧行为：命中即停用、不自动恢复。

type BanSettings = Pick<Settings, 'auto_ban_threshold' | 'auto_ban_cooldown_minutes'>

/** 某次尝试命中熔断状态码（调用方已确认 auto_ban 开启）；返回 true 表示本次已把渠道自动停用 */
export function onBanSignal(channelId: number, _settings: BanSettings, _now = Date.now()): boolean {
  setChannelStatus(channelId, 2)
  return true
}

/** 某次尝试成功：清零该渠道的连续失败计数与半开标记 */
export function onAttemptSuccess(_channelId: number): void {}

/** 维护定时器每分钟调用：把 status=2 且 ban_until 已到期的渠道恢复为启用；返回恢复数量 */
export function recoverChannels(_now = Date.now()): number {
  return 0
}

/** 手动启停或删除渠道时调用：清除内存计数和半开标记 */
export function resetChannelHealth(_channelId: number): void {}
