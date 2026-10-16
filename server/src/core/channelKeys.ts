import { createHash } from 'node:crypto'
import { db } from '../db'
import type { Channel, ChannelKeyStatus, Settings } from '../types'
import { UpstreamError, extractUpstreamMessage } from './failover'

type KeySettings = Pick<Settings, 'auto_ban_threshold' | 'auto_ban_cooldown_minutes'>
type KeyChannel = Pick<Channel, 'id' | 'api_key' | 'key_mode'>

interface KeyStateRow {
  fingerprint: string
  until: number | null
  status_code: number | null
  message: string | null
}

const selectStates = db.prepare('SELECT fingerprint, until, status_code, message FROM channel_key_states WHERE channel_id = ?')
const hasState = db.prepare('SELECT 1 FROM channel_key_states WHERE channel_id = ? AND fingerprint = ?').pluck()
const upsertState = db.prepare(
  `INSERT INTO channel_key_states (channel_id, fingerprint, until, status_code, message, updated_at) VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT(channel_id, fingerprint) DO UPDATE SET until = excluded.until, status_code = excluded.status_code, message = excluded.message, updated_at = excluded.updated_at`,
)
const deleteState = db.prepare('DELETE FROM channel_key_states WHERE channel_id = ? AND fingerprint = ?')

const streaks = new Map<string, number>() // `${channelId}:${fingerprint}` → 连续命中熔断状态码次数
const cursors = new Map<number, number>() // 并发模式的轮转游标

/** 渠道的 key 列表：多 key 模式按行拆分并去重，单 key 模式整串原样使用 */
export function channelKeys(channel: Pick<Channel, 'api_key' | 'key_mode'>): string[] {
  if (!channel.key_mode) return [channel.api_key]
  return [...new Set(channel.api_key.split(/\r?\n/).map(k => k.trim()).filter(Boolean))]
}

export function keyFingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

export function maskKey(key: string): string {
  return key.length <= 10 ? `${key.slice(0, 2)}…` : `${key.slice(0, 6)}…${key.slice(-4)}`
}

/** 日志里记录的 key：序号 + 脱敏值；单 key 渠道返回 null */
export function keyLabel(channel: Pick<Channel, 'api_key' | 'key_mode'>, key: string): string | null {
  if (!channel.key_mode) return null
  return `#${channelKeys(channel).indexOf(key) + 1} ${maskKey(key)}`
}

function blocked(row: KeyStateRow, now: number): boolean {
  return row.until == null || row.until > now
}

/** 当前可用的 key（保持列表顺序）：去掉熔断中的和 exclude 里本次请求已失效的 */
export function availableKeys(channel: KeyChannel, exclude?: Set<string>, now = Date.now()): string[] {
  const keys = channelKeys(channel)
  if (!channel.key_mode) return keys
  const rows = selectStates.all(channel.id) as KeyStateRow[]
  const banned = new Set(rows.filter(r => blocked(r, now)).map(r => r.fingerprint))
  return keys.filter(k => !exclude?.has(k) && !banned.has(keyFingerprint(k)))
}

/** 并发模式：从轮转游标处按列表顺序取 n 个可用 key，游标移到最后取到的 key 之后 */
export function pickRaceKeys(channel: KeyChannel, usable: string[], n: number): string[] {
  const keys = channelKeys(channel)
  const start = (cursors.get(channel.id) ?? 0) % Math.max(1, keys.length)
  const picked: string[] = []
  let next = start
  for (let i = 0; i < keys.length && picked.length < n; i++) {
    const index = (start + i) % keys.length
    if (!usable.includes(keys[index])) continue
    picked.push(keys[index])
    next = index + 1
  }
  cursors.set(channel.id, next)
  return picked
}

/**
 * 多 key 渠道的某个 key 请求失败；返回 true 表示 key 失效，本次请求应换下一个 key。
 * 命中熔断状态码：连续达到阈值后熔断，时长跟随全局自动恢复分钟数（0 = 需手动恢复）；
 * 熔断过、恢复后尚未成功的 key（记录仍在）再命中一次立即熔断。
 * 429 / 402：立即冷却，时长优先取 Retry-After，否则用渠道的冷却秒数。
 */
export function onKeyFailure(channel: Pick<Channel, 'id' | 'key_mode' | 'key_cooldown_seconds'>, key: string, error: unknown, autoBanCodes: number[], settings: KeySettings, now = Date.now()): boolean {
  if (!channel.key_mode || !(error instanceof UpstreamError)) return false
  const fingerprint = keyFingerprint(key)
  const id = `${channel.id}:${fingerprint}`
  let until: number | null
  if (autoBanCodes.includes(error.status)) {
    const count = (streaks.get(id) ?? 0) + 1
    streaks.set(id, count)
    if (count < Math.max(1, settings.auto_ban_threshold) && !hasState.get(channel.id, fingerprint)) return true
    until = settings.auto_ban_cooldown_minutes > 0 ? now + settings.auto_ban_cooldown_minutes * 60_000 : null
  } else if (error.status === 429 || error.status === 402) {
    until = now + Math.max(1000, error.retryAfterMs ?? channel.key_cooldown_seconds * 1000)
  } else {
    return false
  }
  streaks.delete(id)
  upsertState.run(channel.id, fingerprint, until, error.status, extractUpstreamMessage(error.body).slice(0, 300), now)
  return true
}

/** 某个 key 请求成功：清零连续失败计数，删除残留的熔断记录 */
export function onKeySuccess(channel: Pick<Channel, 'id' | 'key_mode'>, key: string): void {
  if (!channel.key_mode) return
  const fingerprint = keyFingerprint(key)
  streaks.delete(`${channel.id}:${fingerprint}`)
  if (hasState.get(channel.id, fingerprint)) deleteState.run(channel.id, fingerprint)
}

/** 管理端展示用的 key 状态列表 */
export function keyStatuses(channel: KeyChannel, now = Date.now()): ChannelKeyStatus[] {
  if (!channel.key_mode) return []
  const rows = new Map((selectStates.all(channel.id) as KeyStateRow[]).map(r => [r.fingerprint, r]))
  return channelKeys(channel).map((key, index) => {
    const fingerprint = keyFingerprint(key)
    const row = rows.get(fingerprint)
    const state = !row || !blocked(row, now) ? 'ok' : row.until == null ? 'banned' : 'cooldown'
    return {
      index, fingerprint, masked: maskKey(key), state,
      until: state === 'cooldown' ? row!.until : null,
      status_code: state === 'ok' ? null : row!.status_code,
      message: state === 'ok' ? null : row!.message,
    }
  })
}

/** 渠道列表徽标用：key 总数与当前可用数；单 key 渠道返回 null */
export function keyCounts(channel: KeyChannel): { total: number; available: number } | null {
  if (!channel.key_mode) return null
  return { total: channelKeys(channel).length, available: availableKeys(channel).length }
}

/** 手动重置：指定 fingerprint 只重置一个 key，否则重置整个渠道 */
export function resetKeyStates(channelId: number, fingerprint?: string): void {
  if (fingerprint) {
    deleteState.run(channelId, fingerprint)
    streaks.delete(`${channelId}:${fingerprint}`)
    return
  }
  db.prepare('DELETE FROM channel_key_states WHERE channel_id = ?').run(channelId)
  for (const id of streaks.keys()) if (id.startsWith(`${channelId}:`)) streaks.delete(id)
  cursors.delete(channelId)
}

/** 保存渠道后清理已不在 key 列表里的状态；关闭多 key 模式时全部清除 */
export function pruneKeyStates(channel: KeyChannel): void {
  if (!channel.key_mode) return resetKeyStates(channel.id)
  const keep = new Set(channelKeys(channel).map(keyFingerprint))
  for (const row of selectStates.all(channel.id) as KeyStateRow[]) {
    if (!keep.has(row.fingerprint)) resetKeyStates(channel.id, row.fingerprint)
  }
}
