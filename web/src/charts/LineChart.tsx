import { useId } from 'react'

function smoothPath(pts: [number, number][]): string {
  if (pts.length === 0) return ''
  if (pts.length === 1) return `M ${pts[0][0]} ${pts[0][1]}`
  let d = `M ${pts[0][0]} ${pts[0][1]}`
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[i + 1]
    const cx = (x0 + x1) / 2
    d += ` C ${cx} ${y0}, ${cx} ${y1}, ${x1} ${y1}`
  }
  return d
}

export function LineChart({ data, height = 168 }: { data: number[]; height?: number }) {
  const gid = 'ah-lg-' + useId().replace(/[:]/g, '')
  const w = 640
  const h = height
  const pad = 12
  if (!data.length) {
    return (
      <div className="ah-muted ah-mini" style={{ padding: '46px 0', textAlign: 'center' }}>
        暂无数据
      </div>
    )
  }
  const max = Math.max(...data, 1)
  const n = data.length
  const innerW = w - pad * 2
  const innerH = h - pad * 2 - 4
  const pts: [number, number][] = data.map((v, i) => [
    pad + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW),
    h - pad - (v / max) * innerH,
  ])
  const line = smoothPath(pts)
  const area = `${line} L ${pts[n - 1][0]} ${h - pad} L ${pts[0][0]} ${h - pad} Z`

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ display: 'block', height: 'auto', overflow: 'visible' }}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ff8a3d" stopOpacity="0.32" />
          <stop offset="100%" stopColor="#ff8a3d" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke="#ff7a33" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      {pts.map((p, i) => (
        <circle key={i} cx={p[0]} cy={p[1]} r="3.4" fill="#fff" stroke="#ff7a33" strokeWidth="2.2" />
      ))}
    </svg>
  )
}
