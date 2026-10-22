// packages/aggregator/src/verify-otx.ts
//
// Verifies an OTXPayload before the aggregator accepts it into the queue.
// This is defense-in-depth: the cellswap-otx-lock enforces everything on-chain,
// but verifying here rejects garbage early and avoids wasting settlement attempts.
//
// Checks performed:
//   1. Structural: required fields present, witness/lockArgs well-formed
//   2. Pubkey: lockArgs is a valid 64-byte secp256r1 point
//   3. Commitment: the witness's intent matches the declared trade params
//   4. Signature: the WebAuthn assertion verifies against the committed hash
//      (re-runs JoyID's verifyNativeKeySignature math with the P-256 key)

import { webcrypto } from 'node:crypto'
import { createHash } from 'node:crypto'
import type { OTXPayload } from '@cellswap/sdk'

const { subtle } = webcrypto

const COMMIT_PERSONALIZATION = new Uint8Array([
  0x63, 0x6b, 0x62, 0x2d, 0x63, 0x73, 0x77, 0x70,
  0x2d, 0x6f, 0x74, 0x78, 0x63, 0x6f, 0x6d, 0x00,
])

export interface OtxVerifyResult { ok: boolean; reason?: string }

export async function verifyOtxPayload(p: OTXPayload): Promise<OtxVerifyResult> {
  // 1. Structural
  if (!p.inputCells?.length) return fail('no input cells')
  // lockArgs = scheme(1) || blake2b256(pubkey)(32) = 33 bytes
  if (!/^0x[0-9a-f]{66}$/i.test(p.lockArgs)) return fail('lockArgs not 33-byte hex')
  if (p.lockArgs.slice(2, 4) !== '01') return fail('unsupported scheme version')
  if (!p.witness?.startsWith('0x')) return fail('witness missing')
  if (p.amountIn <= 0n) return fail('amountIn must be positive')
  if (p.minAmountOut < 0n) return fail('minAmountOut negative')

  // 2. Decode witness: sig(64) || pubkey(64) || authLen(4) || auth || clientLen(4) || client || intent(120)
  //    intent = min(16) || token_out(32) || owner(32) || token_in(32) || deadline(8)
  const w = hexToBytes(p.witness.slice(2))
  if (w.length < 132) return fail('witness too short')
  const sigRaw    = w.slice(0, 64)
  const pubkey    = w.slice(64, 128)
  const authLen   = readU32LE(w, 128)
  const authEnd   = 132 + authLen
  if (w.length < authEnd + 4) return fail('witness truncated (auth)')
  const authData  = w.slice(132, authEnd)
  // Parity with the on-chain lock (main.rs UserNotPresent): authenticatorData is
  // rpIdHash(32) || flags(1) || signCount(4); require the user-present flag (bit 0).
  // A UP=0 assertion passes signature math but the lock rejects it, so drop it early.
  if (authData.length < 37 || (authData[32]! & 0x01) === 0) return fail('user-present flag not set')
  const clientLen = readU32LE(w, authEnd)
  const clientEnd = authEnd + 4 + clientLen
  if (w.length < clientEnd + 120) return fail('witness truncated (intent)')
  const clientData = w.slice(authEnd + 4, clientEnd)
  const intent     = w.slice(clientEnd, clientEnd + 120)

  // 2b. The revealed pubkey must hash to the committed lockArgs (quantum-at-rest binding)
  const pkHash = await ckbHashBytes(pubkey)
  const argsHash = p.lockArgs.slice(4)   // strip 0x + scheme byte
  if (toHex(pkHash) !== argsHash.toLowerCase()) return fail('pubkey does not match lockArgs hash')

  // 3. Intent in witness must match declared params
  const wMinOut   = readU128LE(intent, 0)
  const wTokenOut = '0x' + toHex(intent.slice(16, 48))
  const wOwner    = '0x' + toHex(intent.slice(48, 80))
  const wTokenIn  = '0x' + toHex(intent.slice(80, 112))
  const wDeadline = readU64LE(intent, 112)
  if (wMinOut !== p.minAmountOut) return fail('witness minAmountOut != declared')
  if (wTokenOut.toLowerCase() !== p.tokenOut.toLowerCase()) return fail('witness tokenOut != declared')
  if (wOwner.toLowerCase() !== p.ownerLockHash.toLowerCase()) return fail('witness ownerLockHash != declared')
  // The input token type must be the one the user committed to (not just any asset they hold)
  if (wTokenIn.toLowerCase() !== p.tokenInTypeHash.toLowerCase()) return fail('witness tokenIn != declared')
  if (wDeadline !== p.deadlineEpoch) return fail('witness deadlineEpoch != declared')

  // 4. Recompute commitment and verify the WebAuthn signature
  const first = p.inputCells[0]!
  const commitment = await computeCommitment({
    txHash: first.txHash, index: first.index,
    totalInputAmount: p.amountIn,
    minAmountOut: p.minAmountOut, tokenOut: p.tokenOut, ownerLockHash: p.ownerLockHash,
    tokenInTypeHash: p.tokenInTypeHash, deadlineEpoch: p.deadlineEpoch,
  })

  // clientDataJSON.challenge must equal base64url(commitment)
  let challenge: string
  try { challenge = JSON.parse(Buffer.from(clientData).toString()).challenge }
  catch { return fail('clientDataJSON unparseable') }
  if (challenge !== base64url(commitment)) return fail('challenge != commitment')

  // Verify ES256 signature: sha256(authData || sha256(clientData)) signed by pubkey
  // (pubkey comes from the witness, already bound to lockArgs via the hash check above)
  const clientHash = sha256(clientData)
  const sigBase = concat(authData, clientHash)
  try {
    const key = await subtle.importKey('jwk',
      { kty: 'EC', crv: 'P-256', x: base64url(pubkey.slice(0, 32)), y: base64url(pubkey.slice(32, 64)) },
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    const sigBuf  = sigRaw.slice().buffer
    const baseBuf = sigBase.slice().buffer
    const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sigBuf, baseBuf)
    if (!ok) return fail('WebAuthn signature invalid')
  } catch (e) {
    return fail(`signature verify error: ${(e as Error).message}`)
  }

  return { ok: true }
}

// ─── helpers ───────────────────────────────────────────────────────────────────

async function computeCommitment(i: {
  txHash: string; index: number; totalInputAmount: bigint
  minAmountOut: bigint; tokenOut: string; ownerLockHash: string
  tokenInTypeHash: string; deadlineEpoch: bigint
}): Promise<Uint8Array> {
  const { blake2b } = await import('@noble/hashes/blake2b')
  const h = blake2b.create({ personalization: COMMIT_PERSONALIZATION, dkLen: 32 })
  const op = concat(hexToBytes(i.txHash.slice(2)), u32le(i.index))  // 36 bytes
  h.update(op)
  h.update(u128le(i.totalInputAmount))
  h.update(u128le(i.minAmountOut))
  h.update(hexToBytes(i.tokenOut.slice(2)))
  h.update(hexToBytes(i.ownerLockHash.slice(2)))
  h.update(hexToBytes(i.tokenInTypeHash.slice(2)))
  h.update(u64le(i.deadlineEpoch))
  return h.digest()
}

const fail = (reason: string): OtxVerifyResult => ({ ok: false, reason })

// blake2b-256 with CKB's default-hash personalization (matches the Rust ckb_hash)
async function ckbHashBytes(data: Uint8Array): Promise<Uint8Array> {
  const { blake2b } = await import('@noble/hashes/blake2b')
  return blake2b.create({
    personalization: new Uint8Array([
      0x63,0x6b,0x62,0x2d,0x64,0x65,0x66,0x61,0x75,0x6c,0x74,0x2d,0x68,0x61,0x73,0x68,
    ]),
    dkLen: 32,
  }).update(data).digest()
}
const sha256 = (d: Uint8Array) => new Uint8Array(createHash('sha256').update(d).digest())
const base64url = (b: Uint8Array) => Buffer.from(b).toString('base64url')
function hexToBytes(h: string): Uint8Array {
  const r = new Uint8Array(h.length / 2)
  for (let i = 0; i < r.length; i++) r[i] = parseInt(h.slice(i*2, i*2+2), 16)
  return r
}
function toHex(b: Uint8Array): string { return Array.from(b).map(x => x.toString(16).padStart(2,'0')).join('') }
function readU32LE(b: Uint8Array, o: number): number { return b[o]! | (b[o+1]!<<8) | (b[o+2]!<<16) | (b[o+3]!*0x1000000) }
function readU128LE(b: Uint8Array, o: number): bigint {
  let v = 0n; for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(b[o+i]!); return v
}
function readU64LE(b: Uint8Array, o: number): bigint {
  let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o+i]!); return v
}
function u128le(v: bigint): Uint8Array { const b = new Uint8Array(16); let n=v; for(let i=0;i<16;i++){b[i]=Number(n&0xffn);n>>=8n} return b }
function u64le(v: bigint): Uint8Array { const b = new Uint8Array(8); let n=v; for(let i=0;i<8;i++){b[i]=Number(n&0xffn);n>>=8n} return b }
function u32le(v: number): Uint8Array { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b }
function concat(a: Uint8Array, b: Uint8Array): Uint8Array { const r = new Uint8Array(a.length+b.length); r.set(a); r.set(b, a.length); return r }
