import crypto from 'node:crypto'
import { db } from '../db'
import { localDay } from './billing'

export interface CheckinStatus {
  checked_in_today: boolean
  total_checkins: number
  total_points: number
  month_points: number
  /** 所查月份的签到记录，按日期升序 */
  records: { day: string; points: number }[]
}

export type CheckinResult = { ok: true; day: string; points: number } | { ok: false; message: string }

const insertStmt = db.prepare('INSERT OR IGNORE INTO user_checkins (user_id, day, points, created_at) VALUES (?, ?, ?, ?)')
const rewardStmt = db.prepare('UPDATE users SET quota = quota + ? WHERE id = ?')

/** 奖励在 [min, max] 内均匀随机 */
function rollReward(min: number, max: number): number {
  return max > min ? crypto.randomInt(min, max + 1) : min
}

/** 签到并发放奖励；同一天重复签到由主键拦下 */
export function checkin(userId: number, range: { min: number; max: number }, now = Date.now()): CheckinResult {
  const day = localDay(now)
  const points = rollReward(range.min, range.max)
  return db.transaction((): CheckinResult => {
    if (!insertStmt.run(userId, day, points, now).changes) return { ok: false, message: '今日已签到' }
    rewardStmt.run(points, userId)
    return { ok: true, day, points }
  })()
}

/** month 为 YYYY-MM，不合法时取当前月 */
export function checkinStatus(userId: number, month: string | undefined, now = Date.now()): CheckinStatus {
  const today = localDay(now)
  const prefix = month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : today.slice(0, 7)
  const totals = db
    .prepare('SELECT COUNT(*) AS count, COALESCE(SUM(points), 0) AS points FROM user_checkins WHERE user_id = ?')
    .get(userId) as { count: number; points: number }
  const records = db
    .prepare('SELECT day, points FROM user_checkins WHERE user_id = ? AND day LIKE ? ORDER BY day ASC')
    .all(userId, `${prefix}-%`) as { day: string; points: number }[]
  const checkedToday = !!db.prepare('SELECT 1 FROM user_checkins WHERE user_id = ? AND day = ?').get(userId, today)
  return {
    checked_in_today: checkedToday,
    total_checkins: totals.count,
    total_points: totals.points,
    month_points: records.reduce((sum, r) => sum + r.points, 0),
    records,
  }
}
