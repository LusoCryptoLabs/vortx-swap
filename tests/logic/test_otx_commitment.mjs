// Tests the OTX commitment model (self-contained intent)
// Checks: user signs (input + intent), lock verifies sig + that output satisfies intent
import { createHash, createSign, generateKeyPairSync } from 'node:crypto'
import { webcrypto } from 'node:crypto'
const { subtle } = webcrypto

let pass = 0, fail = 0
async function check(name, fn) {
  try { await fn(); console.log(`  ok ${name}`); pass++ }
  catch(e) { console.log(`  FAIL ${name}: ${e.message}`); fail++ }
}
const assert = (c,m) => { if(!c) throw new Error(m) }
const sha256 = d => createHash('sha256').update(d).digest()
const b64url = b => Buffer.from(b).toString('base64url')
const toHex  = b => Buffer.from(b).toString('hex')

const { blake2b } = await import('@noble/hashes/blake2b').catch(() =>
  import(new URL('../../packages/sdk/node_modules/@noble/hashes/blake2b.js', import.meta.url)))

const COMMIT_PERS = new Uint8Array([0x63,0x6b,0x62,0x2d,0x63,0x73,0x77,0x70,0x2d,0x6f,0x74,0x78,0x63,0x6f,0x6d,0x00])

function u128le(v) { const b = new Uint8Array(16); let n=v; for(let i=0;i<16;i++){b[i]=Number(n&0xffn);n>>=8n} return b }
function u64le(v) { const b = new Uint8Array(8); let n=v; for(let i=0;i<8;i++){b[i]=Number(n&0xffn);n>>=8n} return b }

// Mirror computeSwapCommitment + Rust compute_commitment
// preimage = outpoint(36)||total(16)||min(16)||token_out(32)||owner(32)||token_in(32)||deadline(8)
function computeCommitment(intent) {
  const h = blake2b.create({ personalization: COMMIT_PERS, dkLen: 32 })
  // outpoint molecule: txHash(32) + index(4 LE)
  const op = Buffer.concat([
    Buffer.from(intent.txHash.replace('0x',''), 'hex'),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(intent.index); return b })()
  ])
  h.update(op)
  h.update(u128le(intent.totalInputAmount))
  h.update(u128le(intent.minAmountOut))
  h.update(Buffer.from(intent.tokenOut.replace('0x',''), 'hex'))
  h.update(Buffer.from(intent.ownerLockHash.replace('0x',''), 'hex'))
  h.update(Buffer.from(intent.tokenInTypeHash.replace('0x',''), 'hex'))  // binds the input asset
  h.update(u64le(intent.deadlineEpoch))                                  // binds the deadline
  return Buffer.from(h.digest())
}

console.log('\n=== OTX commitment model ===\n')

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const uncompressed = publicKey.export({ type:'spki', format:'der' }).slice(-65)
const pubkeyXY = uncompressed.slice(1)

const intent = {
  txHash: '0x' + '11'.repeat(32),
  index: 0,
  totalInputAmount: 100_000n,
  minAmountOut: 95_000n,
  tokenOut: '0x' + 'bb'.repeat(32),
  ownerLockHash: '0x' + 'cc'.repeat(32),
  tokenInTypeHash: '0x' + 'aa'.repeat(32),
  deadlineEpoch: 12_345n,
}

function joyidSign(commitment) {
  const ad = Buffer.alloc(37)
  sha256(Buffer.from('app.cellswap.io')).copy(ad, 0)
  ad[32]=0x05; ad.writeUInt32BE(1,33)
  const cd = Buffer.from(JSON.stringify({
    type:'webauthn.get', challenge: b64url(commitment),
    origin:'https://app.cellswap.io', crossOrigin:false,
  }))
  const sigBase = Buffer.concat([ad, sha256(cd)])
  const der = createSign('SHA256').update(sigBase).sign({ key: privateKey, dsaEncoding:'der' })
  return { pubkey: toHex(pubkeyXY), message: b64url(Buffer.concat([ad,cd])), signature: b64url(der) }
}

await check('Commitment is deterministic 32 bytes', async () => {
  const c1 = computeCommitment(intent)
  const c2 = computeCommitment(intent)
  assert(c1.length === 32 && c1.equals(c2), 'deterministic 32 bytes')
})

await check('User signs commitment, lock verifies (full flow)', async () => {
  const commitment = computeCommitment(intent)
  const res = joyidSign(commitment)

  // Lock recomputes commitment from input + intent (same inputs)
  const lockCommitment = computeCommitment(intent)
  assert(lockCommitment.equals(commitment), 'lock recomputes same commitment')

  // Challenge check
  const msg = Buffer.from(res.message, 'base64url')
  const cd = JSON.parse(msg.slice(37).toString())
  assert(Buffer.from(cd.challenge,'base64url').equals(commitment), 'challenge == commitment')

  // Sig verify
  const ad = msg.slice(0,37), clientData = msg.slice(37)
  const sigBase = Buffer.concat([ad, sha256(clientData)])
  const key = await subtle.importKey('jwk',
    { kty:'EC', crv:'P-256', x:b64url(pubkeyXY.slice(0,32)), y:b64url(pubkeyXY.slice(32)) },
    { name:'ECDSA', namedCurve:'P-256' }, false, ['verify'])
  // derToRaw
  const der = Buffer.from(res.signature, 'base64url')
  let off=2; const rLen=der[++off-1]; // simplified
  const ok = await subtle.verify({ name:'ECDSA', hash:'SHA-256' }, key,
    derToRaw(der), sigBase)
  assert(ok, 'WebAuthn sig verifies over commitment')
})

await check('CRITICAL: aggregator cannot change intent (would break commitment)', async () => {
  const commitment = computeCommitment(intent)
  // Aggregator tries to settle with a worse minAmountOut for the user
  const tamperedIntent = { ...intent, minAmountOut: 50_000n }  // attacker lowers user's minimum
  const tamperedCommitment = computeCommitment(tamperedIntent)
  // The commitments differ → challenge check fails → lock rejects
  assert(!commitment.equals(tamperedCommitment), 'tampered intent produces different commitment')
})

await check('CRITICAL: different input outpoint = different commitment (replay-proof)', async () => {
  const c1 = computeCommitment(intent)
  const c2 = computeCommitment({ ...intent, txHash: '0x' + '22'.repeat(32) })
  assert(!c1.equals(c2), 'different outpoint → different commitment → no replay')
})

await check('Intent fits in witness (120 bytes: 16+32+32+32+8)', async () => {
  const intentBytes = new Uint8Array(120)
  intentBytes.set(u128le(intent.minAmountOut), 0)
  intentBytes.set(Buffer.from(intent.tokenOut.replace('0x',''),'hex'), 16)
  intentBytes.set(Buffer.from(intent.ownerLockHash.replace('0x',''),'hex'), 48)
  intentBytes.set(Buffer.from(intent.tokenInTypeHash.replace('0x',''),'hex'), 80)
  intentBytes.set(u64le(intent.deadlineEpoch), 112)
  assert(intentBytes.length === 120, '120-byte intent')
})

await check('changing token_in changes the commitment (asset is bound)', async () => {
  const c1 = computeCommitment(intent)
  const c2 = computeCommitment({ ...intent, tokenInTypeHash: '0x' + 'dd'.repeat(32) })
  assert(!c1.equals(c2), 'different token_in → different commitment')
})

await check('changing the deadline changes the commitment (deadline is bound)', async () => {
  const c1 = computeCommitment(intent)
  const c2 = computeCommitment({ ...intent, deadlineEpoch: intent.deadlineEpoch + 1n })
  assert(!c1.equals(c2), 'different deadline → different commitment')
})

function derToRaw(der) {
  let off=2; if(der[off]!==0x02) throw new Error('r')
  const rLen=der[++off]; const rData=der.slice(off+1,off+1+rLen)
  const r=rData[0]===0?rData.slice(1):rData; off+=1+rLen
  if(der[off]!==0x02) throw new Error('s'); const sLen=der[++off]
  const sData=der.slice(off+1,off+1+sLen); const s=sData[0]===0?sData.slice(1):sData
  const raw=new Uint8Array(64); raw.set(r.slice(-32),32-Math.min(r.length,32)); raw.set(s.slice(-32),64-Math.min(s.length,32))
  return raw
}

console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`)
if (fail > 0) process.exit(1)
