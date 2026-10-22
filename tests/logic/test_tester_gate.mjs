// Verifies the gated tester-access signature scheme (apply/login) and session tokens.
//
// Imports the real built modules (SDK + aggregator dist), the same way test_verify_otx.mjs does,
// so a regression in the built code fails this suite, not a mirrored copy.
//
// TestersDB (the SQLite-backed whitelist) is not exercised here: it needs better-sqlite3's native
// binding, which a dev environment may not have built (the aggregator's Docker image builds it with
// node-gyp, see packages/aggregator/Dockerfile). Its cap, idempotency and approve/reject/open/close
// logic can be exercised with scripts/admin-testers.mjs against a running aggregator. This suite
// covers everything that does not need the DB: the commitment/witness scheme and the session-token
// mint/verify/expiry/revocation logic.

import { createHash, createSign, createHmac, generateKeyPairSync } from 'node:crypto'

let pass = 0, fail = 0
async function check(n, fn) { try { await fn(); console.log(`  ok ${n}`); pass++ } catch (e) { console.log(`  FAIL ${n}: ${e.message}`); fail++ } }
const assert = (c, m) => { if (!c) throw new Error(m) }
const sha256 = d => new Uint8Array(createHash('sha256').update(d).digest())
const b64url = b => Buffer.from(b).toString('base64url')
const cat = (...a) => { const t = a.reduce((s, x) => s + x.length, 0); const r = new Uint8Array(t); let o = 0; for (const x of a) { r.set(x, o); o += x.length }; return r }
const tx = b => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('')

process.env.TESTER_SESSION_SECRET = 'test-secret-only-for-this-suite'

const {
  computeApplyCommitment, computeLoginCommitment, addressHashFromPubkey, encodeTesterWitness,
} = await import('../../packages/sdk/dist/index.js')
const { verifyTesterWitness } = await import('../../packages/aggregator/dist/verify-tester.js')
const { mintSession, requireTesterSession, OPERATOR_ADDRESS } = await import('../../packages/aggregator/dist/tester-session.js')

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const pubXY = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }).slice(-64))
const pubkeyHex = tx(pubXY)

/** Sign a commitment with a real ES256/WebAuthn-shaped assertion, encoded with the same
 *  encodeTesterWitness the frontend uses, so client and server share one wire format. */
function signCommitment(commitment, { userPresent = true } = {}) {
  const ad = Buffer.alloc(37)
  sha256(Buffer.from('cellswap-tester')).forEach((b, i) => { ad[i] = b })
  ad[32] = userPresent ? 5 : 4   // bit0 = user-present
  ad.writeUInt32BE(1, 33)
  const cd = Buffer.from(JSON.stringify({
    type: 'webauthn.get', challenge: b64url(commitment), origin: 'https://joyid.dev', crossOrigin: false,
  }))
  const sigBase = cat(ad, sha256(cd))
  const der = createSign('SHA256').update(sigBase).sign({ key: privateKey, dsaEncoding: 'der' })
  let off = 2
  if (der[off] !== 0x02) throw new Error('r tag')
  const rLen = der[off + 1]; let r = der.slice(off + 2, off + 2 + rLen); off = off + 2 + rLen
  if (der[off] !== 0x02) throw new Error('s tag')
  const sLen = der[off + 1]; let s = der.slice(off + 2, off + 2 + sLen)
  r = r[0] === 0 ? r.slice(1) : r; s = s[0] === 0 ? s.slice(1) : s
  const raw = new Uint8Array(64)
  raw.set(r.slice(-32), 32 - Math.min(r.length, 32))
  raw.set(s.slice(-32), 64 - Math.min(s.length, 32))
  return encodeTesterWitness(raw, pubXY, new Uint8Array(ad), new Uint8Array(cd))
}

console.log('\n=== Tester-access signature verification ===\n')

await check('accepts a valid apply signature', async () => {
  const timestampMs = Date.now()
  const email = 'tester@example.com'
  const commitment = await computeApplyCommitment({ pubkeyXY: pubXY, email, timestampMs: BigInt(timestampMs) })
  const witness = signCommitment(commitment)
  const r = await verifyTesterWitness(witness, { kind: 'apply', email, timestampMs: BigInt(timestampMs) })
  assert(r.ok, r.reason)
  assert(r.addressHash === await addressHashFromPubkey(pubkeyHex), 'addressHash mismatch')
})

await check('accepts a valid login signature', async () => {
  const timestampMs = Date.now()
  const commitment = await computeLoginCommitment({ pubkeyXY: pubXY, timestampMs: BigInt(timestampMs) })
  const witness = signCommitment(commitment)
  const r = await verifyTesterWitness(witness, { kind: 'login', timestampMs: BigInt(timestampMs) })
  assert(r.ok, r.reason)
})

await check('rejects a tampered email (breaks the apply commitment)', async () => {
  const timestampMs = Date.now()
  const commitment = await computeApplyCommitment({ pubkeyXY: pubXY, email: 'real@example.com', timestampMs: BigInt(timestampMs) })
  const witness = signCommitment(commitment)
  const r = await verifyTesterWitness(witness, { kind: 'apply', email: 'attacker@example.com', timestampMs: BigInt(timestampMs) })
  assert(!r.ok, 'should reject mismatched email')
})

await check('rejects a stale timestamp (outside the 5-minute freshness window)', async () => {
  const timestampMs = Date.now() - 10 * 60_000
  const commitment = await computeApplyCommitment({ pubkeyXY: pubXY, email: 'tester@example.com', timestampMs: BigInt(timestampMs) })
  const witness = signCommitment(commitment)
  const r = await verifyTesterWitness(witness, { kind: 'apply', email: 'tester@example.com', timestampMs: BigInt(timestampMs) })
  assert(!r.ok && /stale|future/i.test(r.reason), 'should reject: ' + r.reason)
})

await check('rejects a user-not-present (UP=0) assertion', async () => {
  const timestampMs = Date.now()
  const commitment = await computeLoginCommitment({ pubkeyXY: pubXY, timestampMs: BigInt(timestampMs) })
  const witness = signCommitment(commitment, { userPresent: false })
  const r = await verifyTesterWitness(witness, { kind: 'login', timestampMs: BigInt(timestampMs) })
  assert(!r.ok && /user-present/i.test(r.reason), 'should reject: ' + r.reason)
})

await check('cross-flow replay: an apply-signed commitment fails as a login signature', async () => {
  const timestampMs = Date.now()
  const email = 'tester@example.com'
  const applyCommitment = await computeApplyCommitment({ pubkeyXY: pubXY, email, timestampMs: BigInt(timestampMs) })
  const witness = signCommitment(applyCommitment)
  const r = await verifyTesterWitness(witness, { kind: 'login', timestampMs: BigInt(timestampMs) })
  assert(!r.ok, 'an apply signature must not verify as a login signature')
})

await check('cross-flow replay: a login-signed commitment fails as an apply signature', async () => {
  const timestampMs = Date.now()
  const loginCommitment = await computeLoginCommitment({ pubkeyXY: pubXY, timestampMs: BigInt(timestampMs) })
  const witness = signCommitment(loginCommitment)
  const r = await verifyTesterWitness(witness, { kind: 'apply', email: 'tester@example.com', timestampMs: BigInt(timestampMs) })
  assert(!r.ok, 'a login signature must not verify as an apply signature')
})

await check('cross-protocol replay: a tester witness (no intent tail) is rejected by the OTX verifier', async () => {
  const { verifyOtxPayload } = await import('../../packages/aggregator/dist/verify-otx.js')
  const timestampMs = Date.now()
  const commitment = await computeLoginCommitment({ pubkeyXY: pubXY, timestampMs: BigInt(timestampMs) })
  const witness = signCommitment(commitment)
  const fakeOtxPayload = {
    inputCells: [{ txHash: '0x' + '11'.repeat(32), index: 0 }],
    lockArgs: '0x01' + await addressHashFromPubkey(pubkeyHex),
    witness,
    tokenIn: '0x' + 'aa'.repeat(32), tokenInTypeHash: '0x' + 'aa'.repeat(32), amountIn: 100000n,
    tokenOut: '0x' + 'bb'.repeat(32), minAmountOut: 95000n, ownerLockHash: '0x' + 'cc'.repeat(32),
    deadlineEpoch: 12345n, ownerLock: { codeHash: '0x' + '00'.repeat(32), hashType: 'type', args: '0x' },
  }
  const r = await verifyOtxPayload(fakeOtxPayload)
  assert(!r.ok, 'a tester witness must not verify as an OTX payload')
})

console.log('\n=== Tester session tokens ===\n')

const fakeReq = token => ({ headers: token ? { authorization: `Bearer ${token}` } : {} })
const ADDR = 'deadbeef'.repeat(8)

await check('mint + verify round-trip for an approved, open tester', async () => {
  const { token } = mintSession(ADDR)
  const db = { isOpen: () => true, getByAddress: h => (h === ADDR ? { status: 'approved' } : null) }
  const r = requireTesterSession(fakeReq(token), db)
  assert(r.ok, r.reason)
  assert(r.addressHash === ADDR, 'addressHash mismatch')
})

await check('rejects when testing is closed, even with a still-valid token', async () => {
  const { token } = mintSession(ADDR)
  const db = { isOpen: () => false, getByAddress: () => ({ status: 'approved' }) }
  const r = requireTesterSession(fakeReq(token), db)
  assert(!r.ok && /not open/i.test(r.reason), 'should reject: ' + r.reason)
})

await check('live revocation: rejects a tester rejected AFTER the token was minted', async () => {
  const { token } = mintSession(ADDR)
  const db = { isOpen: () => true, getByAddress: () => ({ status: 'rejected' }) }
  const r = requireTesterSession(fakeReq(token), db)
  assert(!r.ok, 'should reject a revoked tester on their next request')
})

await check('rejects a tampered token', async () => {
  const { token } = mintSession(ADDR)
  const flipped = token.slice(-1) === 'A' ? 'B' : 'A'
  const tampered = token.slice(0, -1) + flipped
  const db = { isOpen: () => true, getByAddress: () => ({ status: 'approved' }) }
  const r = requireTesterSession(fakeReq(tampered), db)
  assert(!r.ok, 'should reject a tampered token')
})

await check('rejects an expired token', async () => {
  // Can't fast-forward Date.now(), so hand-build an already-expired token with the same HMAC
  // construction mintSession uses, to also cross-check that construction independently.
  const payload = `${ADDR}:${Date.now() - 1000}`
  const sig = createHmac('sha256', process.env.TESTER_SESSION_SECRET).update(payload).digest('base64url')
  const expired = `${Buffer.from(payload).toString('base64url')}.${sig}`
  const db = { isOpen: () => true, getByAddress: () => ({ status: 'approved' }) }
  const r = requireTesterSession(fakeReq(expired), db)
  assert(!r.ok, 'should reject an expired token')
})

await check('rejects a missing token', async () => {
  const db = { isOpen: () => true, getByAddress: () => ({ status: 'approved' }) }
  const r = requireTesterSession(fakeReq(undefined), db)
  assert(!r.ok, 'should reject a missing token')
})

await check('operator pass bypasses the open/approved checks (no DB consulted)', async () => {
  const { token } = mintSession(OPERATOR_ADDRESS)
  // Round closed and the DB throws if touched: checks that the operator path returns before either.
  const db = { isOpen: () => false, getByAddress: () => { throw new Error('DB must not be consulted for an operator pass') } }
  const r = requireTesterSession(fakeReq(token), db)
  assert(r.ok, r.reason)
  assert(r.addressHash === OPERATOR_ADDRESS, 'expected the operator identity')
})

await check('rejects a forged operator pass (right identity, wrong secret)', async () => {
  const payload = `${OPERATOR_ADDRESS}:${Date.now() + 60_000}`
  const sig = createHmac('sha256', 'not-the-real-secret').update(payload).digest('base64url')
  const forged = `${Buffer.from(payload).toString('base64url')}.${sig}`
  const db = { isOpen: () => false, getByAddress: () => null }
  const r = requireTesterSession(fakeReq(forged), db)
  assert(!r.ok, 'a forged operator pass must be rejected')
})

console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`)
if (fail > 0) process.exit(1)
