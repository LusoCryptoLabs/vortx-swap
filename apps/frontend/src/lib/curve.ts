// Shared line-smoothing so every price line in the app (the tiny Sparkline and the big PriceChart)
// is the same curve. Monotone-cubic (Fritsch-Carlson): a smooth curve that never overshoots between
// points, so sharp AMM price jumps are drawn without false wiggles.
export function smoothPath(pts: readonly (readonly [number, number])[]): string {
  const n = pts.length
  if (n < 2) return ''
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1])
  const dx: number[] = [], slope: number[] = []
  for (let i = 0; i < n - 1; i++) { const h = xs[i + 1] - xs[i]; dx.push(h); slope.push(h !== 0 ? (ys[i + 1] - ys[i]) / h : 0) }
  const m = new Array<number>(n)
  m[0] = slope[0]; m[n - 1] = slope[n - 2]
  for (let i = 1; i < n - 1; i++) m[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2
  // Fritsch-Carlson: clamp tangents so each segment stays monotone (no overshoot wobble).
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) { m[i] = 0; m[i + 1] = 0; continue }
    const a = m[i] / slope[i], b = m[i + 1] / slope[i], hyp = Math.hypot(a, b)
    if (hyp > 3) { const t = 3 / hyp; m[i] = t * a * slope[i]; m[i + 1] = t * b * slope[i] }
  }
  let d = `M${xs[0].toFixed(1)} ${ys[0].toFixed(1)}`
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i]
    d += ` C${(xs[i] + h / 3).toFixed(1)} ${(ys[i] + m[i] * h / 3).toFixed(1)} ${(xs[i + 1] - h / 3).toFixed(1)} ${(ys[i + 1] - m[i + 1] * h / 3).toFixed(1)} ${xs[i + 1].toFixed(1)} ${ys[i + 1].toFixed(1)}`
  }
  return d
}
