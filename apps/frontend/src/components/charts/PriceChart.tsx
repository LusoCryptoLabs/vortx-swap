import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import type { PricePoint } from '../../lib/history'
import { fmtPrice } from '../../lib/utils'
import { smoothPath } from '../../lib/curve'

/** Dependency-free price chart (SVG): a single brand-colored smooth curve (the shared
 *  monotone-cubic curve, so it matches the sparklines) over a faint area fill, with sparse
 *  right-axis price labels, a static current-price marker, and a touch/hover crosshair tooltip.
 *  One draw-in animation on mount. Themed via CSS vars. */
export function PriceChart({ points, height = 260 }: { points: PricePoint[]; height?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  const gid = useId().replace(/:/g, '')
  const reduce = useReducedMotion()

  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(() => setW(ref.current!.clientWidth))
    ro.observe(ref.current)
    setW(ref.current.clientWidth)
    return () => ro.disconnect()
  }, [])

  const pad = { top: 16, right: 58, bottom: 22, left: 12 }
  const innerW = Math.max(0, w - pad.left - pad.right)
  const innerH = Math.max(0, height - pad.top - pad.bottom)

  const geom = useMemo(() => {
    if (points.length < 2 || innerW <= 0) return null
    const ts = points.map(p => p.time), vs = points.map(p => p.price)
    const tMin = ts[0], tMax = ts[ts.length - 1]
    const lo = Math.min(...vs), hi = Math.max(...vs)
    // Prices are multiplicative; when they span more than ~1.5 orders of magnitude a linear axis
    // collapses the whole series into a cliff + a flat ramp (drained/degenerate pools). Switch to
    // log10 so the curve keeps its shape and the ticks stay distinct.
    const useLog = vs.every(v => v > 0) && hi / lo > 30
    const tf = (v: number) => useLog ? Math.log10(v) : v
    const inv = (t: number) => useLog ? 10 ** t : t
    let tLo = tf(lo), tHi = tf(hi)
    if (tLo === tHi) { const e = Math.abs(tLo) || 1; tLo -= e * 0.001 + 0.001; tHi += e * 0.001 + 0.001 }
    const padV = (tHi - tLo) * 0.14
    tLo -= padV; tHi += padV
    const x = (t: number) => pad.left + (tMax === tMin ? 0.5 : (t - tMin) / (tMax - tMin)) * innerW
    const y = (v: number) => pad.top + (1 - (tf(v) - tLo) / (tHi - tLo)) * innerH
    const xy = points.map(p => [x(p.time), y(p.price)] as const)
    // An AMM pool price only changes AT a swap; between swaps it holds flat. So instead of a diagonal
    // interpolation that makes idle gaps look like gradual drift, build a hold-then-step path: keep the
    // last price steady across the gap, then move it (up on buys, down on sells) with a short smooth
    // transition that lands on the trade. Dense feeds collapse to a near-continuous smooth line; quiet
    // pools stay flat and step only at real trades. `xy` (real points) still drives hover + markers.
    const TRANSITION_PX = 14
    const held: [number, number][] = [[xy[0][0], xy[0][1]]]
    for (let i = 1; i < xy.length; i++) {
      const prevY = xy[i - 1][1]
      const gap = xy[i][0] - xy[i - 1][0]
      const w = Math.min(TRANSITION_PX, gap * 0.9)
      if (w < gap) held.push([xy[i][0] - w, prevY])   // flat hold at the previous price across the idle gap
      held.push([xy[i][0], xy[i][1]])                  // then the trade moves it to the new price
    }
    const line = smoothPath(held)
    const baseY = pad.top + innerH
    const area = `${line} L${xy[xy.length - 1][0].toFixed(1)} ${baseY} L${xy[0][0].toFixed(1)} ${baseY} Z`
    const yTicks = Array.from({ length: 3 }, (_, i) => inv(tLo + ((tHi - tLo) * i) / 2))
    const span = tMax - tMin
    const nx = span < 3 * 86400 ? 2 : 3                     // short span -> 2 ticks, avoids dup dates
    const xTicks = Array.from({ length: nx }, (_, i) => tMin + ((tMax - tMin) * i) / (nx - 1))
    return { x, y, xy, line, area, vMin: lo, vMax: hi, useLog, tMin, tMax, yTicks, xTicks, span, baseY }
  }, [points, innerW, innerH, w, height])

  function onMove(e: React.PointerEvent) {
    if (!geom || !ref.current) return
    const mx = e.clientX - ref.current.getBoundingClientRect().left
    let best = 0, bestD = Infinity
    for (let i = 0; i < geom.xy.length; i++) { const d = Math.abs(geom.xy[i][0] - mx); if (d < bestD) { bestD = d; best = i } }
    setHover(best)
  }

  const timeLabel = (t: number) => {
    const d = new Date(t * 1000)
    if (!geom) return ''
    if (geom.span < 2 * 86400) return d.toLocaleString('en', { month: 'short', day: 'numeric', hour: 'numeric' })
    if (geom.span < 330 * 86400) return d.toLocaleDateString('en', { month: 'short', day: 'numeric' })
    return d.toLocaleDateString('en', { month: 'short', year: '2-digit' })
  }

  const last = geom?.xy[geom.xy.length - 1]
  const lastPrice = points.length ? points[points.length - 1].price : 0
  const cur = hover != null && geom ? geom.xy[hover] : last

  return (
    <div ref={ref} className="relative w-full select-none" style={{ height }}>
      {geom?.useLog && (
        <span className="pointer-events-none absolute right-0 top-0 z-10 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-faint"
          title="Log scale: this pair's price spans several orders of magnitude, so a linear axis would hide the shape.">log</span>
      )}
      {geom && w > 0 && (
        <svg width={w} height={height} className="overflow-visible">
          <defs>
            {/* Area fill under the curve, fading out at the baseline. */}
            <linearGradient id={`area-${gid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.16" />
              <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Sparse right-axis price labels only, no gridlines. */}
          {geom.yTicks.map((v, i) => (
            <text key={i} x={w - pad.right + 10} y={geom.y(v) + 3} fontSize="10" fill="var(--faint)" className="num">{fmtPrice(v, 4)}</text>
          ))}
          {geom.xTicks.map((t, i) => (
            <text key={i} x={geom.x(t)} y={height - 5} fontSize="10" fill="var(--faint)"
              textAnchor={i === 0 ? 'start' : i === geom.xTicks.length - 1 ? 'end' : 'middle'} className="num">{timeLabel(t)}</text>
          ))}

          {/* Area fades up, line draws left to right once on mount (skipped under reduced-motion). */}
          <motion.path
            d={geom.area} fill={`url(#area-${gid})`}
            initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4, delay: 0.1 }}
          />
          <motion.path
            d={geom.line} fill="none" stroke="var(--primary)" strokeWidth="2"
            vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round"
            initial={reduce ? false : { pathLength: 0, opacity: 0 }} animate={{ pathLength: 1, opacity: 1 }}
            transition={{ pathLength: { duration: 0.5, ease: 'easeInOut' }, opacity: { duration: 0.2 } }}
          />

          {/* current-price guide pill on the right axis */}
          {last && (
            <g className="pointer-events-none">
              <rect x={w - pad.right + 4} y={last[1] - 9} width={pad.right - 8} height="18" rx="4" fill="var(--primary)" opacity="0.14" />
              <text x={w - pad.right + 10} y={last[1] + 3} fontSize="10" fill="var(--primary)" className="num font-medium">{fmtPrice(lastPrice, 4)}</text>
            </g>
          )}

          {/* static current-price marker (or the hovered point), no looping pulse */}
          {cur && (
            <g>
              {hover != null && (
                <line x1={cur[0]} y1={pad.top} x2={cur[0]} y2={pad.top + innerH} stroke="var(--primary)" strokeWidth="1" strokeDasharray="3 4" opacity="0.5" />
              )}
              <circle cx={cur[0]} cy={cur[1]} r="6" fill="var(--primary)" opacity="0.18" />
              <circle cx={cur[0]} cy={cur[1]} r="3.5" fill="var(--primary)" stroke="var(--background)" strokeWidth="1.5" />
            </g>
          )}

          <rect
            x={pad.left} y={pad.top} width={innerW} height={innerH} fill="transparent"
            style={{ touchAction: 'pan-y' }}
            onPointerMove={onMove} onPointerDown={onMove}
            onPointerUp={() => setHover(null)} onPointerLeave={() => setHover(null)}
          />
        </svg>
      )}

      {geom && hover != null && points[hover] && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-xs shadow-lg"
          style={{ left: Math.min(Math.max(geom.xy[hover][0], 54), w - 54), top: 0 }}
        >
          <div className="num font-medium">{fmtPrice(points[hover].price, 6)}</div>
          <div className="num text-faint">{new Date(points[hover].time * 1000).toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
        </div>
      )}
    </div>
  )
}
