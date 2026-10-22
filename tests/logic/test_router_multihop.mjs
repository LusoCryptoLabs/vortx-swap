// Verify the Router finds and quotes a 2-hop route A→B→C (pure logic, no chain).
import { Router } from '../../packages/router/dist/index.js'

let pass = 0, fail = 0
const ok = (n) => { console.log(`  ok ${n}`); pass++ }
const bad = (n, e) => { console.log(`  FAIL ${n}: ${e}`); fail++ }
const A = '0x' + 'aa'.repeat(32), B = '0x' + 'bb'.repeat(32), C = '0x' + 'cc'.repeat(32)
const mk = (x, y, rx, ry, fee = 30) => ({ paused: false, tokenX: x, tokenY: y, reserveX: rx, reserveY: ry, feeBps: fee })

console.log('\n=== Router multi-hop ===\n')

// Direct A/B and B/C pools; no direct A/C pool → must route A→B→C.
const router = new Router([mk(A, B, 1_000_000n, 1_000_000n), mk(B, C, 2_000_000n, 2_000_000n)])

try {
  const q = router.quote(A, C, 10_000n, 0.005)
  if (q.route.hops !== 2) throw new Error(`hops=${q.route.hops}, expected 2`)
  ok(`finds 2-hop route (path ${q.route.path.map(h => h.slice(0,4)).join('→')})`)
  if (q.amountOut <= 0n) throw new Error('non-positive output'); else ok(`positive output: ${q.amountOut}`)
  if (q.route.path[1] !== B) throw new Error('mid hop is not B'); else ok('middle hop = B')
  if (q.minAmountOut > q.amountOut) throw new Error('minOut > out'); else ok('minAmountOut ≤ amountOut')
  if (q.priceImpact <= 0) throw new Error('impact not compounded'); else ok(`compounded price impact: ${(q.priceImpact*100).toFixed(2)}%`)
} catch (e) { bad('2-hop quote', e.message) }

// Direct route still preferred when a direct pool exists.
try {
  const r2 = new Router([mk(A, B, 1_000_000n, 1_000_000n), mk(B, C, 2_000_000n, 2_000_000n), mk(A, C, 5_000_000n, 5_000_000n)])
  const q = r2.quote(A, C, 10_000n, 0.005)
  if (q.route.hops !== 1) throw new Error(`hops=${q.route.hops}, expected 1`); else ok('prefers the direct A/C pool when available')
} catch (e) { bad('direct-preferred', e.message) }

// No route when the pair is disconnected.
try {
  const r3 = new Router([mk(A, B, 1_000_000n, 1_000_000n)])
  r3.quote(A, C, 10_000n, 0.005); bad('no-route', 'should have thrown')
} catch { ok('throws when there is no route') }

console.log(`\nResults: ${pass} passed, ${fail} failed\n`)
process.exit(fail > 0 ? 1 : 0)
