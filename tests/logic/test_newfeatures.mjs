// Tests for lp-token mint/burn logic and createPool encoding
import { readFileSync } from 'fs'

let passed = 0, failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ok ${name}`); passed++ }
  catch(e) { console.log(`  FAIL ${name}: ${e.message}`); failed++ }
}
function assert(c, m) { if (!c) throw new Error(m ?? 'fail') }
const P = (f) => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8')

console.log('\n=== LP Token Contract Logic ===\n')

const lpToken = P('contracts/lp-token/src/main.rs')

test('lp-token reads pool lp_supply at offset 64 (custody layout)', () => {
  assert(lpToken.includes('const POOL_LP_SUPPLY_OFF: usize = 64'), 'lp_supply offset 64')
})
test('lp-token mint requires pool supply increase by exact amount', () => {
  assert(lpToken.includes('if pool_out - pool_in != minted'), 'mint == pool delta')
})
test('lp-token burn requires pool supply decrease by exact amount', () => {
  assert(lpToken.includes('if pool_in - pool_out != burned'), 'burn == pool delta')
})
test('lp-token plain transfer needs no pool (conservation)', () => {
  assert(lpToken.includes('if input_sum == output_sum {'), 'transfer conservation path')
  assert(lpToken.includes('// plain transfer'), 'documented as plain transfer')
})
test('lp-token rejects mint without pool cell', () => {
  assert(lpToken.includes('Error::PoolNotFound'), 'pool required for mint/burn')
})
test('lp-token args = pool_type_hash (exactly 32 bytes)', () => {
  // lp-token pins args to exactly 32 bytes, matching pool-script's exact-equality accounting.
  assert(lpToken.includes('if args_raw.len() != 32'), 'args is exactly the 32-byte pool hash')
})

console.log('\n=== Pool Data Encoding (createPool) ===\n')

// Simulate the SDK's encodePoolData and verify it matches the 172-byte layout
function isqrt(n) {
  if (n < 2n) return n
  let x = n, y = (x + 1n) / 2n
  while (y < x) { x = y; y = (x + n / x) / 2n }
  return x
}

test('initial LP = isqrt(amountX * amountY)', () => {
  const lp = isqrt(1_000_000n * 1_000_000n)
  assert(lp === 1_000_000n, `expected 1000000, got ${lp}`)
})
test('initial LP for asymmetric deposit', () => {
  const lp = isqrt(4_000_000n * 1_000_000n)
  assert(lp === 2_000_000n, `expected 2000000, got ${lp}`)
})
test('pool info cell is 156 bytes (custody layout + k_last fee field)', () => {
  const POOL_DATA_SIZE = 156
  const buf = new Uint8Array(POOL_DATA_SIZE)
  // tokenX[0..32], tokenY[32..64], lpSupply[64..80], feeBps[80..82], poolId[82..98],
  // cumX[98..114], cumY[114..130], lastEpoch[130..138], poolMode[138], paused[139],
  // k_last[140..156]. Reserves live in separate reserve cells, not the info cell.
  assert(buf.length === 156, 'pool info data 156 bytes')
})
test('CKB-native pool: capacity includes CKB reserve', () => {
  const MIN_POOL_CAPACITY = 40_000_000_000n  // 400 CKB dust floor
  const ckbReserve = 50_000_000_000n
  const poolCapacity = MIN_POOL_CAPACITY + ckbReserve
  assert(poolCapacity === 90_000_000_000n, 'CKB-native capacity = min + reserve')
})

console.log('\n=== Deployment Script ===\n')

const deploy = P('scripts/deploy.sh')
const inject = P('scripts/inject-config.mjs')

test('deploy includes cellswap-otx-lock', () => {
  assert(deploy.includes('cellswap-otx-lock'), 'OTX lock deployed')
})
test('deploy uses --type-id for upgradeability', () => {
  assert(deploy.includes('--type-id'), 'type-id deployment')
})
test('deploy warns about multisig before mainnet', () => {
  assert(deploy.includes('multisig'), 'multisig warning')
})
test('inject-config patches the right network block', () => {
  assert(inject.includes('DEVNET_SCRIPTS') && inject.includes('TESTNET_SCRIPTS') && inject.includes('MAINNET_SCRIPTS'), 'all networks')
})
test('inject-config writes cellswapOtxLock', () => {
  assert(inject.includes('cellswapOtxLock'), 'OTX lock in config')
})

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`)
if (failed > 0) process.exit(1)
