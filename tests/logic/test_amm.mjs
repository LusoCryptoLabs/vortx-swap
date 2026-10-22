// AMM math tests, mirroring Rust shared/amm-math
// Tests run in Node.js without any compile step

const BPS = 10_000n

function getAmountOut(amountIn, reserveIn, reserveOut, feeBps) {
  if (amountIn === 0n) throw new Error('ZeroInput')
  if (reserveIn === 0n || reserveOut === 0n) throw new Error('ZeroReserve')
  const fee = BigInt(feeBps)
  const num = amountIn * (BPS - fee) * reserveOut
  const den = reserveIn * BPS + amountIn * (BPS - fee)
  return num / den
}

function verifyInvariant(rx0, ry0, rx1, ry1, feeBps) {
  const fee = BigInt(feeBps)
  let deltaIn, deltaOut, rx, ry
  if (rx1 > rx0 && ry1 < ry0) {
    [deltaIn, deltaOut, rx, ry] = [rx1-rx0, ry0-ry1, rx0, ry0]
  } else if (ry1 > ry0 && rx1 < rx0) {
    [deltaIn, deltaOut, rx, ry] = [ry1-ry0, rx0-rx1, ry0, rx0]
  } else {
    return false // both same direction = violation
  }
  const dAfterFee = deltaIn * (BPS - fee) / BPS
  return (rx + dAfterFee) * (ry - deltaOut) >= rx * ry
}

function computeLpMint(amountX, amountY, reserveX, reserveY, lpSupply) {
  const MIN_LIQ = 1000n
  if (amountX === 0n || amountY === 0n) throw new Error('ZeroInput')
  if (lpSupply === 0n) {
    // integer sqrt
    let n = amountX * amountY
    if (n === 0n) return [0n, MIN_LIQ]
    let x = n; let y = (x + 1n) / 2n
    while (y < x) { x = y; y = (x + n / x) / 2n }
    const total = x
    if (total <= MIN_LIQ) throw new Error('InsufficientInitialLiquidity')
    return [total - MIN_LIQ, MIN_LIQ]
  }
  const fromX = amountX * lpSupply / reserveX
  const fromY = amountY * lpSupply / reserveY
  return [fromX < fromY ? fromX : fromY, 0n]
}

let passed = 0, failed = 0

function test(name, fn) {
  try { fn(); console.log(`  ok ${name}`); passed++ }
  catch(e) { console.log(`  FAIL ${name}: ${e.message}`); failed++ }
}

function assert(cond, msg) { if (!cond) throw new Error(msg ?? 'assertion failed') }
function assertThrows(fn, msg) {
  try { fn(); throw new Error('expected throw but got none') }
  catch(e) { if (e.message === 'expected throw but got none') throw e }
}

console.log('\n=== AMM Math Tests ===\n')

// Happy paths
test('basic swap gives positive output', () => {
  const out = getAmountOut(1000n, 10_000n, 10_000n, 30)
  assert(out > 900n && out < 1000n, `expected 900-1000, got ${out}`)
})

test('invariant holds after honest swap', () => {
  const rx=1_000_000n, ry=1_000_000n, amtIn=10_000n
  const out = getAmountOut(amtIn, rx, ry, 30)
  assert(verifyInvariant(rx, ry, rx+amtIn, ry-out, 30), 'invariant failed')
})

test('initial liquidity mint burns MIN_LIQUIDITY', () => {
  const [mint, burn] = computeLpMint(1_000_000n, 1_000_000n, 0n, 0n, 0n)
  assert(mint === 999_000n, `expected 999000 got ${mint}`)
  assert(burn === 1000n, `expected 1000 got ${burn}`)
})

test('subsequent LP no burn', () => {
  const [mint, burn] = computeLpMint(100_000n, 100_000n, 1_000_000n, 1_000_000n, 1_000_000n)
  assert(burn === 0n, 'expected no burn')
  assert(mint > 0n, 'expected positive mint')
})

// Attack vectors
test('zero input rejected', () => {
  assertThrows(() => getAmountOut(0n, 1000n, 1000n, 30))
})

test('zero reserve rejected', () => {
  assertThrows(() => getAmountOut(100n, 0n, 1000n, 30))
  assertThrows(() => getAmountOut(100n, 1000n, 0n, 30))
})

test('invariant violation detected (both reserves decrease)', () => {
  assert(!verifyInvariant(1000n, 1000n, 900n, 900n, 30), 'should reject')
})

test('invariant violation detected (cheat extra output)', () => {
  const out = getAmountOut(1000n, 1_000_000n, 1_000_000n, 30)
  assert(!verifyInvariant(1_000_000n, 1_000_000n, 1_001_000n, 1_000_000n-(out+100n), 30), 'should reject cheat')
})

test('fee bypass rejected (using no-fee output with fee setting)', () => {
  const noFeeOut = getAmountOut(1000n, 1_000_000n, 1_000_000n, 0)
  assert(!verifyInvariant(1_000_000n, 1_000_000n, 1_001_000n, 1_000_000n-noFeeOut, 30), 'should reject')
})

test('first LP dust attack blocked (1+1)', () => {
  assertThrows(() => computeLpMint(1n, 1n, 0n, 0n, 0n))
})

test('first LP 999+999 blocked (below MIN_LIQUIDITY)', () => {
  assertThrows(() => computeLpMint(999n, 999n, 0n, 0n, 0n))
})

test('large reserves no overflow (safe bigint)', () => {
  const max = (2n**127n)
  const out = getAmountOut(1_000_000n, max, max, 30)
  assert(out > 0n && out < max, 'should produce valid output')
})

test('rounding: tiny input on huge pool returns 0', () => {
  const out = getAmountOut(1n, 2n**127n, 2n**127n, 30)
  assert(out === 0n, `expected 0, got ${out}`)
})

// Fee tier correctness
test('stable(5bps) > standard(30bps) > exotic(100bps) output', () => {
  const amt = 10_000n, rx = 1_000_000n, ry = 1_000_000n
  const stable   = getAmountOut(amt, rx, ry, 5)
  const standard = getAmountOut(amt, rx, ry, 30)
  const exotic   = getAmountOut(amt, rx, ry, 100)
  assert(stable > standard && standard > exotic, `${stable}>${standard}>${exotic}`)
})

test('price impact increases with trade size', () => {
  const rx = 1_000_000n, ry = 1_000_000n
  const small = getAmountOut(  1_000n, rx, ry, 30)
  const large = getAmountOut(100_000n, rx, ry, 30)
  const sp = Number(small) / 1_000
  const lp = Number(large) / 100_000
  assert(lp < sp, 'larger trade should have worse price')
})

test('LP proportionality: double deposit = double tokens', () => {
  const [lp1] = computeLpMint(100_000n, 100_000n, 1_000_000n, 1_000_000n, 1_000_000n)
  const [lp2] = computeLpMint(200_000n, 200_000n, 1_000_000n, 1_000_000n, 1_000_000n)
  assert(lp2 === lp1 * 2n, `expected ${lp1*2n} got ${lp2}`)
})

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`)
if (failed > 0) process.exit(1)
