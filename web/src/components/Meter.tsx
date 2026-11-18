import type { RateTone } from '../lib/format'

/** 3px 细进度条；value 为 0–100 */
export function Meter({ value, tone }: { value: number; tone: RateTone }) {
  const w = Math.max(0, Math.min(100, value))
  return (
    <span className="ah-meter">
      <i className={tone === 'none' ? '' : tone} style={{ width: `${Math.max(w, w > 0 ? 3 : 0)}%` }} />
    </span>
  )
}
