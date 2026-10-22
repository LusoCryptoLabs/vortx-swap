import { readFileSync } from 'fs'
// Import the actual layout constants (single source of truth) instead of grepping source text, so a
// semantically wrong offset fails the suite and a harmless reformat does not. Rust stays a comment
// grep (can't import), which is what pins TS<->Rust parity.
import * as codec from '../../packages/codec/dist/index.js'

let passed = 0, failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ok ${name}`); passed++ }
  catch(e) { console.log(`  FAIL ${name}: ${e.message}`); failed++ }
}
function assert(cond, msg) { if (!cond) throw new Error(msg ?? 'fail') }
// Flexible pattern match: trims whitespace between tokens
function has(text, pattern) {
  // Replace multiple spaces with \s+ for flexible matching
  const regex = new RegExp(pattern.replace(/\s+/g, '\\s+'))
  return regex.test(text)
}
const P = (f) => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8')

const poolRust   = P('contracts/pool-script/src/main.rs')
const intentRust = P('contracts/intent-lock/src/main.rs')
const scanner    = P('packages/aggregator/src/scanner.ts')
const sdk        = P('packages/sdk/src/index.ts')
const router     = P('packages/router/src/index.ts')
const amm        = P('shared/amm-math/src/lib.rs')
const types      = P('packages/types/src/index.ts')
const builder    = P('packages/aggregator/src/builder.ts')
const cellUtils  = P('shared/cell-utils/src/lib.rs')

console.log('\n=== Pool Data Layout ===\n')

// Assert the shared codec constant equals the value and the Rust layout comment agrees.
function poolOffset(field, rustRange, off, codecKey) {
  test(`${field}: Rust=[${rustRange}], codec=${off}`, () => {
    assert(has(poolRust, `\\[${rustRange}\\]`), `Rust missing [${rustRange}] comment`)
    assert(codec[codecKey] === off, `codec.${codecKey} should be ${off}, got ${codec[codecKey]}`)
  })
}

poolOffset('tokenX',   '0..32',    0,   'POOL_TOKEN_X_OFF')
poolOffset('tokenY',   '32..64',   32,  'POOL_TOKEN_Y_OFF')
poolOffset('lpSupply', '64..80',   64,  'POOL_LP_SUPPLY_OFF')
poolOffset('feeBps',   '80..82',   80,  'POOL_FEE_BPS_OFF')
poolOffset('poolId',   '82..98',   82,  'POOL_ID_OFF')
poolOffset('cum_x',    '98..114',  98,  'POOL_CUM_PRICE_X_OFF')
poolOffset('cum_y',    '114..130', 114, 'POOL_CUM_PRICE_Y_OFF')

test('pool_mode=138, paused=139 (new custody layout, reserves removed)', () => {
  assert(codec.POOL_POOL_MODE_OFF === 138, 'codec pool_mode=138')
  assert(codec.POOL_PAUSED_OFF === 139, 'codec paused=139')
  assert(poolRust.includes('[138]') && poolRust.includes('[139]'), 'Rust mode/paused 138/139')
})
test('POOL_DATA_SIZE: 156-byte writers (k_last fee field) / 140-byte prefix-min readers', () => {
  // pool-script is the canonical writer: a 156-byte info cell that appends k_last at [140..156]
  // (the protocol-fee field). The reserves-removed prefix [0..140] is unchanged.
  assert(has(poolRust, 'POOL_DATA_SIZE: usize = 156'), 'Rust pool-script=156')
  assert(poolRust.includes('[140..156]'), 'Rust k_last field [140..156]')
  // The SDK writes the 156-byte layout but still reads pre-fee 140-byte pools (POOL_DATA_MIN),
  // so older 140-byte pools keep working.
  assert(has(sdk, 'POOL_DATA_SIZE = 156'), 'sdk writer=156')
  assert(has(sdk, 'POOL_DATA_MIN = 140'), 'sdk back-compat reader min=140')
  // Prefix-only readers (lp-token, scanner) keep 140 as a minimum-length guard: a 156-byte cell
  // satisfies `len < 140`, and they read only fields <=140, so they need not know about k_last.
  const lpTokenSrc = P('contracts/lp-token/src/main.rs')
  assert(has(lpTokenSrc, 'POOL_DATA_SIZE: usize = 140'), 'lp-token min=140')
  assert(!lpTokenSrc.includes('= 172'), 'lp-token has no stale 172')
  // The shared codec prefix size stays 140 (readers guard on it).
  assert(codec.POOL_DATA_SIZE === 140, 'codec prefix min=140')
})
test('reserves are NO LONGER in info data (custody redesign)', () => {
  assert(!poolRust.includes('reserve_x:          read_u128(data, 64)'), 'Rust info has no reserve_x read')
  assert(!sdk.includes('POOL_RESERVE_X_OFF'), 'sdk dropped POOL_RESERVE_X_OFF')
  assert(!scanner.includes('POOL_RESERVE_X_OFF'), 'scanner dropped POOL_RESERVE_X_OFF')
})

console.log('\n=== Builder Pool Update (epoch-only; reserves in cells) ===\n')

// The builder imports its offsets from @cellswap/codec, so assert the shared constants directly.
test('codec POOL_LP_SUPPLY_OFF=64', () => assert(codec.POOL_LP_SUPPLY_OFF === 64, 'lp=64'))
test('codec POOL_LAST_EPOCH_OFF=130', () => assert(codec.POOL_LAST_EPOCH_OFF === 130, 'epoch=130'))
test('builder no longer writes reserves into info data', () => assert(!builder.includes('POOL_RESERVE_X_OFF'), 'builder dropped reserve offset'))

console.log('\n=== Router Formula ===\n')

test('FEE_DENOMINATOR=10_000n', () => assert(router.includes('FEE_DENOMINATOR = 10_000n'), 'not found'))
test('numerator = amtIn*(BPS-fee)*rOut', () => assert(router.includes('amountIn * (FEE_DENOMINATOR - fee) * reserveOut'), 'not found'))
test('denominator = rIn*BPS + amtIn*(BPS-fee)', () => assert(router.includes('reserveIn * FEE_DENOMINATOR + amountIn * (FEE_DENOMINATOR - fee)'), 'not found'))
test('multi-hop: per-hop compound slippage sqrt(1-s)', () => assert(router.includes('1 - Math.sqrt(1 - slippage)'), 'not found'))
test('MIN_SWAP_AMOUNT guard', () => assert(router.includes('MIN_SWAP_AMOUNT'), 'not found'))

console.log('\n=== AMM Math Correctness ===\n')

test('MINIMUM_LIQUIDITY=1000', () => assert(amm.includes('pub const MINIMUM_LIQUIDITY: u128 = 1_000'), 'not found'))
test('first-deposit burns MINIMUM_LIQUIDITY', () => assert(amm.includes('(total - MINIMUM_LIQUIDITY, MINIMUM_LIQUIDITY)'), 'not found'))
test('U256 used for overflow-safe arithmetic', () => {
  assert(amm.includes('U256::from(amount_x) * U256::from(amount_y)'), 'not found')
})
test('invariant rejects violations', () => assert(amm.includes('return Err(AmmError::InvariantViolation)'), 'not found'))

console.log('\n=== Architecture Checks ===\n')

test('intent args total: 32+16+32+8+16+2=106', () => {
  assert(32+16+32+8+16+2 === 106, 'math check')
  assert(has(intentRust, 'TOTAL_ARGS_LEN: usize = 106'), 'Rust=106')
})
test('CKB_TYPE_HASH is 0x000...000', () => assert(types.includes("'0x' + '0'.repeat(64)"), 'not found'))
test('MIN_POOL_CAPACITY=40_000_000_000n (400 CKB), Rust and TS agree', () => {
  assert(types.includes('= 40_000_000_000n'), 'TS types = 400 CKB')
  assert(has(cellUtils, 'MIN_POOL_CAPACITY: u64 = 40_000_000_000'), 'Rust cell-utils = 400 CKB')
})
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`)
if (failed > 0) process.exit(1)
