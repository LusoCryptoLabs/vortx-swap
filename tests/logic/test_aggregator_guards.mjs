// Tests for batch dedup and rate limiting in the aggregator
let pass = 0, fail = 0
function test(n, fn) { try { fn(); console.log(`  ok ${n}`); pass++ } catch(e){ console.log(`  FAIL ${n}: ${e.message}`); fail++ } }
const assert = (c,m) => { if(!c) throw new Error(m ?? 'fail') }

console.log('\n=== Batch dedup (cross-count prevention) ===\n')

// Mirror groupByPool dedup logic
function groupByPool(otxs, pools) {
  const map = new Map()
  const seen = new Set()
  for (const otx of otxs) {
    const pool = pools.find(p => !p.paused && (
      (p.tokenX === otx.tokenIn && p.tokenY === otx.tokenOut) ||
      (p.tokenY === otx.tokenIn && p.tokenX === otx.tokenOut)))
    if (!pool) continue
    const key = `${otx.ownerLockHash}:${otx.tokenOut}`
    if (seen.has(key)) continue
    seen.add(key)
    const batch = map.get(pool) ?? []
    batch.push(otx); map.set(pool, batch)
  }
  return map
}

const pool = { paused: false, tokenX: '0xAAA', tokenY: '0xBBB' }
const pools = [pool]

test('two intents same (owner, tokenOut) → only one batched', () => {
  const otxs = [
    { ownerLockHash: '0xuser1', tokenIn: '0xAAA', tokenOut: '0xBBB', amountIn: 100n },
    { ownerLockHash: '0xuser1', tokenIn: '0xAAA', tokenOut: '0xBBB', amountIn: 200n }, // dup
  ]
  const batches = groupByPool(otxs, pools)
  assert(batches.get(pool).length === 1, 'duplicate must be deferred')
})

test('different owners same tokenOut → both batched', () => {
  const otxs = [
    { ownerLockHash: '0xuser1', tokenIn: '0xAAA', tokenOut: '0xBBB' },
    { ownerLockHash: '0xuser2', tokenIn: '0xAAA', tokenOut: '0xBBB' },
  ]
  assert(groupByPool(otxs, pools).get(pool).length === 2, 'distinct owners ok')
})

test('same owner different tokenOut → both batched', () => {
  const otxs = [
    { ownerLockHash: '0xuser1', tokenIn: '0xAAA', tokenOut: '0xBBB' },
    { ownerLockHash: '0xuser1', tokenIn: '0xBBB', tokenOut: '0xAAA' },
  ]
  assert(groupByPool(otxs, pools).get(pool).length === 2, 'distinct tokenOut ok')
})

test('deferred duplicate settles in a later tick', () => {
  // First tick batches 1; the duplicate remains in queue for next tick
  const otxs = [
    { ownerLockHash: '0xu', tokenIn: '0xAAA', tokenOut: '0xBBB' },
    { ownerLockHash: '0xu', tokenIn: '0xAAA', tokenOut: '0xBBB' },
  ]
  const batched = groupByPool(otxs, pools).get(pool)
  assert(batched.length === 1, 'one settles now')
  // Simulate next tick with the remaining one
  const remaining = otxs.filter(o => !batched.includes(o))
  assert(groupByPool(remaining, pools).get(pool).length === 1, 'remainder settles next')
})

console.log('\n=== Rate limiting ===\n')

const RL_WINDOW_MS = 60_000
const rlHits = new Map()
function rateLimited(key, max, now = Date.now()) {
  const hits = (rlHits.get(key) ?? []).filter(t => now - t < RL_WINDOW_MS)
  if (hits.length >= max) { rlHits.set(key, hits); return true }
  hits.push(now); rlHits.set(key, hits); return false
}

test('allows up to the limit', () => {
  rlHits.clear()
  for (let i = 0; i < 10; i++) assert(!rateLimited('pk:x', 10), `req ${i} should pass`)
})

test('blocks the (limit+1)th request', () => {
  rlHits.clear()
  for (let i = 0; i < 10; i++) rateLimited('pk:x', 10)
  assert(rateLimited('pk:x', 10), '11th must be blocked')
})

test('window slides, old hits expire', () => {
  rlHits.clear()
  const t0 = 1_000_000
  for (let i = 0; i < 10; i++) rateLimited('pk:y', 10, t0)
  assert(rateLimited('pk:y', 10, t0), 'blocked at t0')
  // 61s later, all old hits expired
  assert(!rateLimited('pk:y', 10, t0 + 61_000), 'allowed after window')
})

test('separate keys have separate limits', () => {
  rlHits.clear()
  for (let i = 0; i < 10; i++) rateLimited('ip:1.2.3.4', 30)
  assert(!rateLimited('ip:5.6.7.8', 30), 'different IP not affected')
})

console.log('\n=== clientIp(): trusted-hop-counted X-Forwarded-For ===\n')

// Mirrors security.ts's clientIp(): with TRUST_PROXY on, read `hops` positions in from the right
// of the XFF chain (the entry the first trusted proxy appended), never the leftmost, caller-supplied
// entry. Reading the leftmost entry would let anyone reset their own rate-limit bucket by sending a
// fake X-Forwarded-For, since each proxy hop appends rather than overwrites.
function clientIpFromChain(xffHeader, hops, socketRemote = '10.0.0.9') {
  if (!xffHeader) return socketRemote
  const chain = xffHeader.split(',').map(s => s.trim()).filter(Boolean)
  const idx = chain.length - Math.max(1, hops)
  return idx >= 0 && chain[idx] ? chain[idx] : socketRemote
}

test('single trusted hop (hops=1): takes the last entry, not the first', () => {
  assert(clientIpFromChain('203.0.113.7', 1) === '203.0.113.7', 'no forgery, one hop')
})

test('two trusted hops (this deployment): real client is 2nd-from-right, not leftmost', () => {
  // real IP added by the host nginx, then loopback added by the frontend container's nginx.
  const chain = '203.0.113.7, 127.0.0.1'
  assert(clientIpFromChain(chain, 2) === '203.0.113.7', 'must resolve to the real client')
})

test('SECURITY: forged leading entries cannot move the real IP off its position', () => {
  // An attacker prepending fake entries only grows the chain on the left; the two trusted-hop
  // appends still land at the same distance from the right, so the real IP is still found.
  // Leftmost-entry logic would return the attacker's forged value here.
  const forged = '9.9.9.9, 8.8.8.8, 203.0.113.7, 127.0.0.1'
  assert(clientIpFromChain(forged, 2) === '203.0.113.7', 'forged prefix must not be trusted')
  const oldBuggyLogic = forged.split(',')[0].trim()
  assert(oldBuggyLogic === '9.9.9.9', 'sanity: confirms the old code really did return the forged value')
})

test('malformed/too-short chain falls back to the raw socket address, never crashes', () => {
  assert(clientIpFromChain('127.0.0.1', 2) === '10.0.0.9', 'shorter than hops -> fallback')
})

console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`)
if (fail > 0) process.exit(1)
