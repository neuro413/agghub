import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { useSession } from '../session'
import { localDay, usd } from '../lib/format'
import type { CheckinInfo } from '../types'
import { useToast } from '../components/Toast'
import { Button, IconBadge, Skeleton } from '../components/ui'
import { IconCalendarCheck, IconChevronLeft, IconChevronRight, IconSparkles } from '../components/Icons'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** 月历格子：前后补齐到整周，非本月日期置灰 */
function monthCells(month: string): { day: string; date: number; inMonth: boolean }[] {
  const [y, m] = month.split('-').map(Number)
  const first = new Date(y, m - 1, 1)
  const start = new Date(y, m - 1, 1 - first.getDay())
  const total = Math.ceil((first.getDay() + new Date(y, m, 0).getDate()) / 7) * 7
  return Array.from({ length: total }, (_, i) => {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
    return { day: localDay(d.getTime()), date: d.getDate(), inMonth: d.getMonth() === m - 1 }
  })
}

/** 每日签到卡（复刻 new-api 个人页的签到日历） */
export function CheckinCard() {
  const toast = useToast()
  const { refreshUser } = useSession()
  const today = localDay()
  const [month, setMonth] = useState(today.slice(0, 7))
  const [info, setInfo] = useState<CheckinInfo | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await api.checkinInfo(month, signal)
      if (!signal?.aborted) setInfo(data)
    } catch (e) {
      if (!signal?.aborted) toast('error', (e as Error).message)
    }
  }, [month, toast])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const checkin = async () => {
    setBusy(true)
    try {
      const result = await api.checkin()
      toast('success', `签到成功，获得 ${usd(result.points)}`)
      setMonth(today.slice(0, 7))
      await Promise.all([load(), refreshUser()])
    } catch (e) {
      toast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const records = new Map(info?.records.map(r => [r.day, r.points]))
  const todayPoints = info?.checked_in_today && month === today.slice(0, 7) ? records.get(today) : undefined
  const [year, mon] = month.split('-')

  return (
    <section className="pt-card pt-checkin">
      <div className="pt-checkin-head">
        <IconBadge size="lg" tone="neutral"><IconCalendarCheck size={20} /></IconBadge>
        <div className="pt-checkin-intro">
          <div className="pt-checkin-title">
            每日签到
            {info?.checked_in_today && <span className="pt-checked-tag"><IconSparkles size={12} />今日已签到</span>}
          </div>
          <p className="pt-checkin-sub">
            {info?.checked_in_today
              ? todayPoints != null ? `今日获得 ${usd(todayPoints)}` : '今日已签到，明天再来'
              : `每天签到一次，随机获得 ${usd(info?.min_points ?? 0)} ~ ${usd(info?.max_points ?? 0)} 额度`}
          </p>
        </div>
        <Button size="sm" onClick={checkin} loading={busy} disabled={!info || info.checked_in_today}>
          {info?.checked_in_today ? '已签到' : '立即签到'}
        </Button>
      </div>

      <div className="pt-checkin-stats">
        <div><div className="v">{info?.total_checkins ?? '-'}</div><div className="k">累计签到</div></div>
        <div><div className="v mono">{info ? usd(info.month_points) : '-'}</div><div className="k">本月获得</div></div>
        <div><div className="v mono">{info ? usd(info.total_points) : '-'}</div><div className="k">累计获得</div></div>
      </div>

      <div className="pt-calendar">
        <div className="pt-calendar-head">
          <h4>{year} 年 {Number(mon)} 月</h4>
          <div style={{ display: 'flex', gap: 2 }}>
            <Button variant="ghost" size="icon-sm" onClick={() => setMonth(m => shiftMonth(m, -1))} aria-label="上个月"><IconChevronLeft size={14} /></Button>
            <Button variant="ghost" size="icon-sm" onClick={() => setMonth(m => shiftMonth(m, 1))} disabled={month >= today.slice(0, 7)} aria-label="下个月"><IconChevronRight size={14} /></Button>
          </div>
        </div>
        {info ? (
          <div className="pt-calendar-grid">
            {WEEKDAYS.map(w => <div key={w} className="pt-calendar-week">{w}</div>)}
            {monthCells(month).map(cell => {
              const points = records.get(cell.day)
              const cls = ['pt-calendar-day', cell.day === today && 'is-today', !cell.inMonth && 'is-outside', points != null && 'is-checked'].filter(Boolean).join(' ')
              return (
                <div key={cell.day} className={cls} title={points != null ? `+${usd(points)}` : undefined}>
                  {cell.date}
                  {points != null && <span className="pt-calendar-dot" />}
                </div>
              )
            })}
          </div>
        ) : (
          <Skeleton height={240} />
        )}
        <div className="pt-calendar-tip">每天只能签到一次，按服务器日期 0 点刷新</div>
      </div>
    </section>
  )
}
