import { useEffect, useId, useRef, useState, type MouseEvent } from 'react'

export interface LineSeries {
  name: string
  values: number[]
  /** CSS 颜色，建议传变量，如 var(--chart-1) */
  color: string
  /** 面积渐变起始透明度，缺省不画面积 */
  area?: number
}

/** 坐标轴取整：步长从 1 / 2 / 2.5 / 5 / 10 × 10ⁿ 里选 */
function niceScale(max: number, ticks: number): { step: number; max: number } {
  const raw = max / ticks
  const p = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * p >= raw) ?? 10) * p
  return { step, max: step * ticks }
}

/** 量容器宽度；组件卸载时断开观察，避免回调落到已卸载的组件上 */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let alive = true
    setWidth(el.clientWidth)
    const ro = new ResizeObserver((entries) => {
      if (!alive) return
      const w = Math.round(entries[0].contentRect.width)
      setWidth((prev) => (prev === w ? prev : w))
    })
    ro.observe(el)
    return () => {
      alive = false
      ro.disconnect()
    }
  }, [])
  return [ref, width] as const
}

const PAD = { l: 46, r: 12, t: 10, b: 26 }
const TICKS = 4

/** 折线图：按容器实际像素绘制（线宽、文字不随缩放变形），带网格、刻度和悬停读数 */
export function LineChart({
  series,
  labels,
  height = 220,
  format = (v: number) => String(v),
}: {
  series: LineSeries[]
  labels: string[]
  height?: number
  format?: (v: number) => string
}) {
  const uid = 'ah-lc-' + useId().replace(/[:]/g, '')
  const [ref, w] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const n = series[0]?.values.length ?? 0

  // 容器始终渲染（带 ref），否则数据晚到时量不到宽度
  if (!n) {
    return (
      <div ref={ref} className="ah-linechart ah-chart-empty" style={{ height }}>
        暂无数据
      </div>
    )
  }

  const h = height
  const innerW = Math.max(w - PAD.l - PAD.r, 1)
  const { step, max } = niceScale(Math.max(...series.flatMap((s) => s.values), 1), TICKS)
  const X = (i: number) => PAD.l + (n === 1 ? innerW / 2 : (innerW * i) / (n - 1))
  const Y = (v: number) => PAD.t + (h - PAD.t - PAD.b) * (1 - v / max)
  const path = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('')
  // X 轴标签按宽度抽稀，每个标签至少留 64px
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(innerW / 64))))
  const ticks = Array.from({ length: TICKS + 1 }, (_, k) => k * step)

  const onMove = (e: MouseEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    const i = n === 1 ? 0 : Math.round(((e.clientX - box.left) / box.width) * (n - 1))
    setHover(Math.max(0, Math.min(n - 1, i)))
  }

  const tipLeft = hover == null ? 0 : X(hover)
  const tipOnLeft = hover != null && tipLeft > w / 2

  return (
    <div ref={ref} className="ah-linechart" style={{ height: h }}>
      {w > 0 && (
        <svg width={w} height={h}>
          <defs>
            {series.map((s, k) =>
              s.area ? (
                <linearGradient key={k} id={`${uid}-${k}`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" style={{ stopColor: s.color, stopOpacity: s.area }} />
                  <stop offset="1" style={{ stopColor: s.color, stopOpacity: 0 }} />
                </linearGradient>
              ) : null,
            )}
          </defs>
          {ticks.map((v) => (
            <g key={v}>
              <line className="ah-c-grid" x1={PAD.l} x2={w - PAD.r} y1={Y(v)} y2={Y(v)} />
              <text className="ah-c-tick" x={PAD.l - 8} y={Y(v) + 4} textAnchor="end">
                {format(+v.toFixed(6))}
              </text>
            </g>
          ))}
          {labels.map((t, i) =>
            i % every === 0 ? (
              <text key={i} className="ah-c-tick" x={X(i)} y={h - 6} textAnchor="middle">
                {t}
              </text>
            ) : null,
          )}
          {series.map((s, k) => {
            const d = path(s.values)
            return (
              <g key={k}>
                {s.area ? <path d={`${d}L${X(n - 1)},${Y(0)}L${X(0)},${Y(0)}Z`} fill={`url(#${uid}-${k})`} /> : null}
                <path d={d} fill="none" style={{ stroke: s.color }} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
              </g>
            )
          })}
          {hover != null && (
            <g>
              <line className="ah-c-cursor" x1={X(hover)} x2={X(hover)} y1={PAD.t} y2={h - PAD.b} />
              {series.map((s, k) => (
                <circle key={k} className="ah-c-dot" r={4} cx={X(hover)} cy={Y(s.values[hover])} style={{ fill: s.color }} />
              ))}
            </g>
          )}
          <rect x={PAD.l} y={0} width={innerW} height={h} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
        </svg>
      )}
      {hover != null && (
        <div
          className="ah-chart-tip"
          style={tipOnLeft ? { right: w - tipLeft + 14, top: PAD.t } : { left: tipLeft + 14, top: PAD.t }}
        >
          <b>{labels[hover] ?? hover}</b>
          {series.map((s, k) => (
            <span key={k}>
              <i style={{ background: s.color }} />
              {s.name}
              <em>{format(s.values[hover])}</em>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
