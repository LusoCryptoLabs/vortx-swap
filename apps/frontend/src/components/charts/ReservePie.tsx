import { useState } from 'react'
import { compact } from '../../lib/utils'

/** Custom, dependency-free donut (SVG): segments sized by CKB value, hover to highlight + read the
 *  value in the center. Themed via CSS vars. */
export function ReservePie({ data, height = 180 }: {
  data: { name: string; valueCkb: number }[]
  height?: number
}) {
  const [hover, setHover] = useState<number | null>(null)
  const colors = ['var(--primary)', 'var(--accent)', 'var(--warning)', 'var(--positive)', 'var(--negative)']
  const segs = data.filter(d => isFinite(d.valueCkb) && d.valueCkb > 0)
  const total = segs.reduce((a, d) => a + d.valueCkb, 0)
  if (total <= 0) return <div style={{ height }} className="grid place-items-center text-sm text-faint">No data</div>

  const R = 46, r = 31, cx = 50, cy = 50
  const pt = (ang: number, rad: number) => [cx + rad * Math.sin(ang), cy - rad * Math.cos(ang)]
  const centerName = hover != null ? segs[hover].name : 'TVL'
  const centerVal = hover != null ? segs[hover].valueCkb : total

  let acc = 0
  const arcs = segs.map((d, i) => {
    const frac = d.valueCkb / total
    const a0 = acc, a1 = acc + frac * 2 * Math.PI
    acc = a1
    const gap = segs.length > 1 ? 0.03 : 0
    const s0 = a0 + gap / 2, s1 = a1 - gap / 2
    const large = (s1 - s0) > Math.PI ? 1 : 0
    const [ox0, oy0] = pt(s0, R), [ox1, oy1] = pt(s1, R)
    const [ix1, iy1] = pt(s1, r), [ix0, iy0] = pt(s0, r)
    const path = `M${ox0} ${oy0} A${R} ${R} 0 ${large} 1 ${ox1} ${oy1} L${ix1} ${iy1} A${r} ${r} 0 ${large} 0 ${ix0} ${iy0} Z`
    return { path, color: colors[i % colors.length] }
  })

  return (
    <div className="relative mx-auto" style={{ height, width: height }}>
      <svg viewBox="0 0 100 100" className="h-full w-full">
        {segs.length === 1
          ? <circle cx={cx} cy={cy} r={(R + r) / 2} fill="none" stroke={arcs[0].color} strokeWidth={R - r} />
          : arcs.map((s, i) => (
              <path key={i} d={s.path} fill={s.color}
                opacity={hover == null || hover === i ? 1 : 0.35}
                onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
                className="cursor-pointer transition-opacity" />
            ))}
        <text x="50" y="47" textAnchor="middle" fontSize="6" fill="var(--faint)">{centerName}</text>
        <text x="50" y="57" textAnchor="middle" fontSize="8" fill="var(--foreground)" className="num">{compact(centerVal)}</text>
      </svg>
    </div>
  )
}
