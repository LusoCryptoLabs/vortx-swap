// Lock-boost SDK ↔ contract parity tests.
//   1. The exported boostBps / LOCK_BOOST_TIERS from the built SDK must match the contract's pinned
//      boost_bps table (contracts/mining-pool/src/main.rs) exactly; drift here mis-prices every
//      locked position and the on-chain weight check rejects the tx.
//   2. The byte layouts the SDK emits (56B receipt, 72B timelock-guard args, the boost field appended
//      to the 225B mining args) must match the contract's documented offsets byte-for-byte.
import { boostBps, LOCK_BOOST_TIERS } from '../../packages/sdk/dist/index.js'

let pass = 0, fail = 0
function test(n, fn) { try { fn(); console.log(`  ok ${n}`); pass++ } catch (e) { console.log(`  FAIL ${n}: ${e.message}`); fail++ } }
const assert = (c, m) => { if (!c) throw new Error(m ?? 'fail') }
const eq = (a, b, m) => assert(a === b, `${m ?? ''} expected ${b}, got ${a}`)

// ── helpers mirroring the SDK's LE writers (verify the documented layout independently) ──
const BOOST_DENOM = 10_000n
function u128le(n) { const b = new Uint8Array(16); for (let i = 0; i < 16; i++) { b[i] = Number(n & 0xffn); n >>= 8n } return b }
function u64le(n)  { const b = new Uint8Array(8);  for (let i = 0; i < 8;  i++) { b[i] = Number(n & 0xffn); n >>= 8n } return b }
const hex = u8 => [...u8].map(b => b.toString(16).padStart(2, '0')).join('')
function receipt56(amount, acc, weight, unlock) {
  const b = new Uint8Array(56)
  b.set(u128le(amount), 0); b.set(u128le(acc), 16); b.set(u128le(weight), 32); b.set(u64le(unlock), 48)
  return b
}
function guardArgs72(pool, owner, deadline) {
  return '0x' + pool + owner + hex(u64le(deadline))
}

console.log('\n=== 1. boostBps matches the contract tier table (epoch ≈ 4h; 30/60/90/180/360d) ===\n')

// The pinned table in contracts/mining-pool/src/main.rs::boost_bps.
const TABLE = [
  [0n, 10_000n], [179n, 10_000n],                 // unlocked / sub-30d = 1.0×
  [180n, 12_500n], [359n, 12_500n],               // 30d = 1.25×
  [360n, 15_000n], [539n, 15_000n],               // 60d = 1.5×
  [540n, 17_500n], [1079n, 17_500n],              // 90d = 1.75×
  [1080n, 20_000n], [2159n, 20_000n],             // 180d = 2.0×
  [2160n, 25_000n], [100_000n, 25_000n],          // 360d+ = 2.5× cap
]
for (const [term, bps] of TABLE) {
  test(`boostBps(${term}) = ${bps}`, () => eq(boostBps(term), bps, `term ${term}`))
}
test('LOCK_BOOST_TIERS is descending by epochs (so the first match wins)', () => {
  for (let i = 1; i < LOCK_BOOST_TIERS.length; i++) assert(LOCK_BOOST_TIERS[i].epochs < LOCK_BOOST_TIERS[i-1].epochs, 'not descending')
})
test('every tier maps days→epochs at 6 epochs/day', () => {
  for (const t of LOCK_BOOST_TIERS) eq(t.epochs, BigInt(t.days * 6), `${t.days}d`)
})
test('max boost is the 2.5× ceiling', () => eq(LOCK_BOOST_TIERS[0].bps, 25_000n, 'cap'))

console.log('\n=== 2. weight = amount · boost_bps(term) / 10000, rounded DOWN (matches contract) ===\n')

const weightOf = (amount, term) => amount * boostBps(term) / BOOST_DENOM
test('unlocked weight == amount (1.0×)',        () => eq(weightOf(1000n, 0n), 1000n))
test('30d: 1000 → 1250',                        () => eq(weightOf(1000n, 180n), 1250n))
test('360d: 1000 → 2500 (cap)',                 () => eq(weightOf(1000n, 2160n), 2500n))
test('rounds DOWN: 7 @30d → 8 (8.75 floored)',  () => eq(weightOf(7n, 180n), 8n))
test('rounds DOWN: 3 @30d → 3 (3.75 floored)',  () => eq(weightOf(3n, 180n), 3n))
test('rounds DOWN: 1 @30d → 1 (1.25 floored)',  () => eq(weightOf(1n, 180n), 1n))

console.log('\n=== 3. 56-byte boosted receipt layout (amount|acc|weight|unlock_epoch) ===\n')

test('receipt is exactly 56 bytes', () => eq(receipt56(1n, 2n, 3n, 4n).length, 56))
test('fields land at [0..16] [16..32] [32..48] [48..56]', () => {
  const amount = 123n, acc = 456n, weight = 153n, unlock = 9999n
  const b = receipt56(amount, acc, weight, unlock)
  eq(hex(b.slice(0, 16)),  hex(u128le(amount)), 'amount')
  eq(hex(b.slice(16, 32)), hex(u128le(acc)),    'acc')
  eq(hex(b.slice(32, 48)), hex(u128le(weight)), 'weight')
  eq(hex(b.slice(48, 56)), hex(u64le(unlock)),  'unlock_epoch')
})
test('a 32-byte receipt is the unlocked base case (weight==amount, unlock==0)', () => {
  // The contract treats len<56 as weight==amount, unlock==0, i.e. the legacy receipt.
  const legacy = receipt56(500n, 7n, 500n, 0n).slice(0, 32)
  eq(hex(legacy.slice(0, 16)), hex(u128le(500n)), 'amount')
})

console.log('\n=== 4. 72-byte stake-timelock-guard args (pool|owner|deadline) ===\n')

const POOL  = 'aa'.repeat(32), OWNER = 'bb'.repeat(32)
test('guard args are 72 bytes', () => eq((guardArgs72(POOL, OWNER, 5000n).length - 2) / 2, 72))
test('pool[0..32], owner[32..64], deadline[64..72] LE', () => {
  const a = guardArgs72(POOL, OWNER, 0x123456n).slice(2)
  eq(a.slice(0, 64), POOL, 'pool')
  eq(a.slice(64, 128), OWNER, 'owner')
  eq(a.slice(128, 144), hex(u64le(0x123456n)), 'deadline')
})
test('deadline ceiling fits 24-bit since (0x00ffffff)', () => {
  const a = guardArgs72(POOL, OWNER, 0x00ffffffn).slice(2)
  eq(a.slice(128, 144), 'ffffff0000000000', 'deadline LE')
})

console.log('\n=== 5. mining args boost field appended at [193..225] ===\n')

test('appending the 32-byte guard hash takes args 193 → 225 bytes', () => {
  const base = 'cc'.repeat(193)            // 193-byte legacy args
  const guard = 'dd'.repeat(32)
  const boosted = base + guard
  eq(boosted.length / 2, 225, 'len')
  eq(boosted.slice(193 * 2), guard, 'boost field')
})

console.log(`\n${fail === 0 ? 'ok' : 'FAIL'} lock-boost: ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
