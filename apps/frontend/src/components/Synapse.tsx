/* Ganglia signature visuals: the ambient synapse network + the Vortx brand whirl. */
import { useMemo } from 'react'

/** Faint background synapse network with traveling signal pulses (deterministic layout). */
export function SynapseField() {
  const { pts, links } = useMemo(() => {
    let s = 88
    const r = () => (s = (s * 9301 + 49297) % 233280) / 233280
    const arr: [number, number, number][] = []
    for (let i = 0; i < 26; i++) arr.push([r() * 100, r() * 100, 0.6 + r() * 1.6])
    const L: [typeof arr[number], typeof arr[number]][] = []
    for (let i = 0; i < arr.length; i++)
      for (let j = i + 1; j < arr.length; j++) {
        const dx = arr[i][0] - arr[j][0], dy = arr[i][1] - arr[j][1]
        if (Math.hypot(dx, dy) < 22) L.push([arr[i], arr[j]])
      }
    return { pts: arr, links: L }
  }, [])
  const pulses = links.filter((_, i) => i % 4 === 0).slice(0, 6)
  return (
    <svg className="synapse" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden>
      <g stroke="var(--primary)" strokeWidth=".08" opacity=".5">
        {links.map(([a, b], i) => <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />)}
      </g>
      {pts.map(([x, y, r], i) => <circle key={i} cx={x} cy={y} r={r * 0.18} fill="var(--accent)" opacity=".55" />)}
      {pulses.map(([a, b], i) => (
        <circle key={'p' + i} r=".5" className="pulse-dot" opacity="0">
          <animateMotion dur={`${5 + (i % 4)}s`} repeatCount="indefinite" begin={`${i * 0.9}s`} path={`M${a[0]} ${a[1]} L${b[0]} ${b[1]}`} />
          <animate attributeName="opacity" values="0;1;1;0" dur={`${5 + (i % 4)}s`} repeatCount="indefinite" begin={`${i * 0.9}s`} />
        </circle>
      ))}
    </svg>
  )
}

/** The Vortx brand glyph: a single inward synaptic whirl. `color` defaults to the foreground so it
 *  reads on any chip; pass a CSS color (e.g. var(--primary-foreground)) when set on a primary tile. */
export function BrandGlyph({ size = 28, color = 'currentColor', animate = true }: {
  size?: number; color?: string; animate?: boolean
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path className={animate ? 'gnode' : ''}
        d="M12 2.6 A9.4 9.4 0 0 1 21.4 12 A7.9 7.9 0 0 1 12 19.9 A6.4 6.4 0 0 1 5.6 12 A4.9 4.9 0 0 1 12 7.1 A3.1 3.1 0 0 1 15.1 12 A2.3 2.3 0 0 1 12 14.3"
        fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
