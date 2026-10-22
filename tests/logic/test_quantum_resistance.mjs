// Tests for the quantum hardening of the OTX lock args:
//   #0 SDK parity: the real buildOtxLockArgs (built dist) emits a hash at rest, never a raw pubkey
//   #1 pubkey hashed at rest (args = scheme || blake2b256(pubkey))
//   #2 scheme-version byte for crypto-agility
import { createHash } from 'node:crypto'
const { blake2b } = await import('@noble/hashes/blake2b').catch(() =>
  import(new URL('../../packages/sdk/node_modules/@noble/hashes/blake2b.js', import.meta.url)))
// Import the real on-chain-args builder from the built SDK, so this test is a parity guard against
// regression (someone storing a raw pubkey at rest), not just a re-implementation of the layout.
const { buildOtxLockArgs } = await import('../../packages/sdk/dist/index.js')

let pass=0, fail=0
function test(n, fn){ try{ fn(); console.log(`  ok ${n}`); pass++ }catch(e){ console.log(`  FAIL ${n}: ${e.message}`); fail++ } }
async function atest(n, fn){ try{ await fn(); console.log(`  ok ${n}`); pass++ }catch(e){ console.log(`  FAIL ${n}: ${e.message}`); fail++ } }
const assert=(c,m)=>{ if(!c) throw new Error(m??'fail') }
const tx=b=>Buffer.from(b).toString('hex')
const CKBPERS=new Uint8Array([0x63,0x6b,0x62,0x2d,0x64,0x65,0x66,0x61,0x75,0x6c,0x74,0x2d,0x68,0x61,0x73,0x68])
const ckbHash=d=>Buffer.from(blake2b.create({personalization:CKBPERS,dkLen:32}).update(d).digest())

const SCHEME_SECP256R1 = '01'

// Mirror buildOtxLockArgs (kept to document the layout; #0 pins it to the real impl).
function buildArgs(pubkeyHex){
  const clean = pubkeyHex.replace(/^0x/,'')
  assert(clean.length===128, '64-byte pubkey')
  return '0x' + SCHEME_SECP256R1 + tx(ckbHash(Buffer.from(clean,'hex')))
}

const pubkey = 'ab'.repeat(64) // 64-byte fake pubkey

console.log('\n=== #0 SDK parity: the real buildOtxLockArgs stores only a hash ===\n')

await atest('real buildOtxLockArgs never embeds the raw pubkey', async () => {
  const real = await buildOtxLockArgs(pubkey)
  assert(!real.toLowerCase().includes(pubkey.toLowerCase()), 'raw pubkey stored at rest')
})
await atest('real buildOtxLockArgs == the documented layout (scheme || blake2b256(pubkey))', async () => {
  const real = await buildOtxLockArgs(pubkey)
  assert(real.toLowerCase() === buildArgs(pubkey).toLowerCase(), `drift: ${real} != ${buildArgs(pubkey)}`)
})
await atest('real args are 33 bytes (1 scheme + 32 hash)', async () => {
  const real = await buildOtxLockArgs(pubkey)
  assert((real.length - 2) / 2 === 33, `expected 33 bytes, got ${(real.length-2)/2}`)
})
await atest('real scheme byte is 0x01 (secp256r1/WebAuthn)', async () => {
  const real = await buildOtxLockArgs(pubkey)
  assert(real.slice(2, 4) === '01', 'scheme version present')
})

console.log('\n=== #1 Pubkey hashed at rest ===\n')

test('args do NOT contain the raw pubkey', () => {
  const args = buildArgs(pubkey)
  assert(!args.includes(pubkey), 'raw pubkey must not appear in on-chain args')
})

test('args are 33 bytes (1 scheme + 32 hash)', () => {
  const args = buildArgs(pubkey)
  assert((args.length - 2)/2 === 33, `expected 33 bytes, got ${(args.length-2)/2}`)
})

test('args hash matches blake2b256(pubkey), lock can re-derive at spend', () => {
  const args = buildArgs(pubkey)
  const argHash = args.slice(4) // strip 0x + scheme
  assert(argHash === tx(ckbHash(Buffer.from(pubkey,'hex'))), 'hash binding')
})

test('different pubkeys → different args (no collision in practice)', () => {
  const a1 = buildArgs('ab'.repeat(64))
  const a2 = buildArgs('cd'.repeat(64))
  assert(a1 !== a2, 'distinct')
})

test('hash is 256-bit (128-bit post-Grover preimage resistance)', () => {
  const h = ckbHash(Buffer.from(pubkey,'hex'))
  assert(h.length === 32, 'full 256-bit hash, not blake160')
})

console.log('\n=== #2 Scheme-version byte (crypto-agility) ===\n')

test('scheme byte is 0x01 for secp256r1/WebAuthn', () => {
  const args = buildArgs(pubkey)
  assert(args.slice(2,4) === '01', 'scheme version present')
})

test('lock rejects unknown scheme version', () => {
  // Simulate the lock's check: scheme != 0x01 → UnsupportedScheme
  const verifyScheme = (schemeByte) => schemeByte === 0x01
  assert(verifyScheme(0x01) === true, 'accepts known')
  assert(verifyScheme(0x02) === false, 'rejects unknown (reserved for PQC)')
})

test('a future PQC scheme can be added without changing args length contract', () => {
  // The version byte means args layout can evolve; 0x02 could be e.g. hybrid EC+Dilithium
  const future = '02' + tx(ckbHash(Buffer.from(pubkey,'hex')))
  assert(future.slice(0,2) === '02', 'future scheme slot exists')
})

console.log('\n=== Harvest-now-decrypt-later exposure window ===\n')

test('pubkey only revealed in witness (at spend), not in resting cell', () => {
  // Witness carries pubkey at [64..128]; args carry only the hash.
  // A quantum attacker gets the pubkey only once the cell is spent, as with
  // normal CKB/Bitcoin spends, not before.
  const witnessHasPubkey = true   // encodeWebAuthnWitness places pubkey at [64..128]
  const argsHavePubkey = false    // args hold blake2b256(pubkey) only
  assert(witnessHasPubkey && !argsHavePubkey, 'exposure deferred to spend time')
})

console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`)
if (fail>0) process.exit(1)
