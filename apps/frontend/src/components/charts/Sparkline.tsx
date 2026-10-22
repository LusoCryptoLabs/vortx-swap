import { useId } from 'react'
import { smoothPath } from '../../lib/curve'

/** Tiny, dependency-free inline trend line (SVG): a monotone-cubic (Fritsch-Carlson) curve, shared
 *  with PriceChart, over a faint area, colored by net direction (last vs first). For dense table
 *  rows and mobile cards: no axes, no interaction. */
export function Sparkline({ data, width = 96, height = 30, positive }: {
  data: number[]
  width?: number
  height?: number
  /** Force the trend color; otherwise inferred from last-vs-first. */
  positive?: boolean
}) {
  const gid = useId().replace(/:/g, '')
  const pts = data.filter(n => isFinite(n) && n > 0)
  if (pts.length < 2) return <div style={{ width, height }} aria-hidden />

  const min = Math.min(...pts), max = Math.max(...pts)
  const span = max - min || Math.abs(max) || 1
  const up = positive ?? pts[pts.length - 1] >= pts[0]
  const color = up ? 'var(--positive)' : 'var(--negative)'
  const dx = width / (pts.length - 1)
  const xy = pts.map((v, i) => [i * dx, height - 2 - ((v - min) / span) * (height - 4)] as const)
  const line = smoothPath(xy)
  const area = `${line} L${width} ${height} L0 ${height} Z`

  return (
    <svg width={width} height={height} className="overflow-visible">
      <defs>
        <linearGradient id={`spk-${gid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#spk-${gid})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
