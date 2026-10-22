// packages/sdk/src/tester-auth.ts
//
// Shared byte-packing for the gated tester-access flow (apply to test / log in once approved).
// Reuses the same JoyID WebAuthn/secp256r1 passkey signing as OTX (see otx.ts), but without the
// 120-byte trade-intent tail OTX needs: that tail exists only so the on-chain Rust lock can
// independently see the declared trade fields. A login/apply signature has exactly one consumer
// (the aggregator's own HTTP handler, which already has the cleartext request body), so there is
// nothing for a tail to re-assert.
//
// Both the frontend (building the signed request) and the aggregator (verifying it) import this
// module, so the two sides can never silently diverge on byte order the way otx.ts's commitment
// packing and verify-otx.ts's independent copy of it can.
//
// Two distinct blake2b personalization tags (separate from OTX's) mean an apply signature, a
// login signature, and an OTX trade signature can never be replayed as one another even if every
// other field happened to collide.

import type { JoyIDSignResponse } from './otx.js'

function personalization(tag: string): Uint8Array {
  const bytes = new TextEncoder().encode(tag)
  if (bytes.length > 16) throw new Error(`personalization tag too long: ${tag}`)
  const out = new Uint8Array(16)
  out.set(bytes)
  return out
}

const APPLY_PERSONALIZATION = personalization('ckb-cswp-apply')
const LOGIN_PERSONALIZATION = personalization('ckb-cswp-login')

// JoyID authenticatorData is always 37 bytes (32 rpIdHash + 1 flags + 4 signCount); see otx.ts.
const JOYID_AUTH_DATA_LEN = 37

// ─── Commitments ───────────────────────────────────────────────────────────────

/** commitment = blake2b_personal("apply", pubkey(64) || blake2b256(lowercased+trimmed email)(32) || timestampMs(u64 LE)) */
export async function computeApplyCommitment(params: {
  pubkeyXY: Uint8Array; email: string; timestampMs: bigint
}): Promise<Uint8Array> {
  const { blake2b } = await import('@noble/hashes/blake2b')
  const emailHash = await ckbHash(new TextEncoder().encode(params.email.trim().toLowerCase()))
  const h = blake2b.create({ personalization: APPLY_PERSONALIZATION, dkLen: 32 })
  h.update(params.pubkeyXY.slice(0, 64))
  h.update(emailHash)
  h.update(u64le(params.timestampMs))
  return h.digest()
}

/** commitment = blake2b_personal("login", pubkey(64) || timestampMs(u64 LE)) */
export async function computeLoginCommitment(params: {
  pubkeyXY: Uint8Array; timestampMs: bigint
}): Promise<Uint8Array> {
  const { blake2b } = await import('@noble/hashes/blake2b')
  const h = blake2b.create({ personalization: LOGIN_PERSONALIZATION, dkLen: 32 })
  h.update(params.pubkeyXY.slice(0, 64))
  h.update(u64le(params.timestampMs))
  return h.digest()
}

/** Tester identity = blake2b256(pubkey), ckb-default-hash personalization, hex (no 0x). Deterministic
 *  from the JoyID pubkey alone: the same hash already embedded in that user's OTX lock args
 *  (buildOtxLockArgs), just without the scheme-byte prefix. */
export async function addressHashFromPubkey(pubkeyHex: string): Promise<string> {
  const clean = pubkeyHex.startsWith('0x') ? pubkeyHex.slice(2) : pubkeyHex
  if (clean.length !== 128) throw new Error(`Expected 64-byte pubkey, got ${clean.length / 2} bytes`)
  const hash = await ckbHash(hexToBytes(clean))
  return toHex(hash)
}

async function ckbHash(data: Uint8Array): Promise<Uint8Array> {
  const { blake2b } = await import('@noble/hashes/blake2b')
  return blake2b.create({
    personalization: new Uint8Array([
      0x63,0x6b,0x62,0x2d,0x64,0x65,0x66,0x61,0x75,0x6c,0x74,0x2d,0x68,0x61,0x73,0x68, // "ckb-default-hash"
    ]),
    dkLen: 32,
  }).update(data).digest()
}

// ─── Witness wire format ───────────────────────────────────────────────────────
// sig(64) || pubkey(64) || authLen(u32 LE) || authData || clientLen(u32 LE) || clientDataJSON
// (the OTX format minus its 120-byte intent tail)

export function encodeTesterWitness(
  sig: Uint8Array, pubkey: Uint8Array, authData: Uint8Array, clientData: Uint8Array,
): `0x${string}` {
  const buf = new Uint8Array(64 + 64 + 4 + authData.length + 4 + clientData.length)
  let off = 0
  buf.set(sig.slice(0, 64), off);    off += 64
  buf.set(pubkey.slice(0, 64), off); off += 64
  new DataView(buf.buffer).setUint32(off, authData.length, true); off += 4
  buf.set(authData, off); off += authData.length
  new DataView(buf.buffer).setUint32(off, clientData.length, true); off += 4
  buf.set(clientData, off)
  return ('0x' + toHex(buf)) as `0x${string}`
}

export interface DecodedTesterWitness {
  sig: Uint8Array; pubkey: Uint8Array; authData: Uint8Array; clientData: Uint8Array
}

export function decodeTesterWitness(witnessHex: string): DecodedTesterWitness {
  const w = hexToBytes(witnessHex)
  if (w.length < 132) throw new Error('witness too short')
  const sig = w.slice(0, 64)
  const pubkey = w.slice(64, 128)
  const authLen = readU32LE(w, 128)
  const authEnd = 132 + authLen
  if (w.length < authEnd + 4) throw new Error('witness truncated (auth)')
  const authData = w.slice(132, authEnd)
  const clientLen = readU32LE(w, authEnd)
  const clientEnd = authEnd + 4 + clientLen
  if (w.length < clientEnd) throw new Error('witness truncated (client)')
  const clientData = w.slice(authEnd + 4, clientEnd)
  return { sig, pubkey, authData, clientData }
}

/**
 * Parse a raw JoyID signChallenge() response into a tester witness. Frontend-only helper: takes
 * the same response shape OTX's parseJoyIDOtxResponse does, but skips the intent-tail encoding.
 */
export async function parseJoyIDTesterResponse(res: JoyIDSignResponse): Promise<{
  witness: `0x${string}`; pubkeyXY: Uint8Array; addressHash: string
}> {
  const msgBytes = base64urlDecode(res.message)
  if (msgBytes.length <= JOYID_AUTH_DATA_LEN) {
    throw new Error(`JoyID message too short: ${msgBytes.length} <= ${JOYID_AUTH_DATA_LEN}`)
  }
  const authData   = msgBytes.slice(0, JOYID_AUTH_DATA_LEN)
  const clientData = msgBytes.slice(JOYID_AUTH_DATA_LEN)
  const sigRaw = derToRaw(base64urlDecode(res.signature))

  const pubkeyHex = res.pubkey.startsWith('0x') ? res.pubkey.slice(2) : res.pubkey
  if (pubkeyHex.length !== 128) throw new Error(`Invalid JoyID pubkey: expected 128 hex chars, got ${pubkeyHex.length}`)
  const pubkeyXY = hexToBytes(pubkeyHex)

  return {
    witness: encodeTesterWitness(sigRaw, pubkeyXY, authData, clientData),
    pubkeyXY,
    addressHash: await addressHashFromPubkey(pubkeyHex),
  }
}

// ─── Helpers (small and self-contained, following the per-module duplication convention in
// otx.ts / verify-otx.ts rather than a shared-helpers module) ───────────

function base64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/')
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - padded.length % 4)
  const b64 = padded + pad
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const NodeBuffer = (globalThis as any).Buffer
  if (NodeBuffer) return new Uint8Array(NodeBuffer.from(b64, 'base64') as Uint8Array)
  const binStr = (globalThis as any).atob(b64) as string
  return new Uint8Array(Array.from(binStr, (c: string) => c.charCodeAt(0)))
}

/** DER → raw r‖s (64 bytes). Mirrors JoyID's derToIEEE() from @joyid/ckb/src/utils.ts. */
function derToRaw(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30) throw new Error('Not DER')
  let off = 2
  if (der[off] !== 0x02) throw new Error('Expected r tag')
  const rLen  = der[++off]!
  const rData = der.slice(off+1, off+1+rLen)
  const r     = rData[0] === 0x00 ? rData.slice(1) : rData
  off += 1 + rLen
  if (der[off] !== 0x02) throw new Error('Expected s tag')
  const sLen  = der[++off]!
  const sData = der.slice(off+1, off+1+sLen)
  const s     = sData[0] === 0x00 ? sData.slice(1) : sData
  const raw   = new Uint8Array(64)
  raw.set(r.slice(-32), 32 - Math.min(r.length, 32))
  raw.set(s.slice(-32), 64 - Math.min(s.length, 32))
  return raw
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  const r = new Uint8Array(h.length / 2)
  for (let i = 0; i < r.length; i++) r[i] = parseInt(h.slice(i*2, i*2+2), 16)
  return r
}

function toHex(b: Uint8Array): string {
  return Array.from(b).map(x => x.toString(16).padStart(2,'0')).join('')
}

function readU32LE(b: Uint8Array, o: number): number {
  return b[o]! | (b[o+1]!<<8) | (b[o+2]!<<16) | (b[o+3]!*0x1000000)
}

function u64le(v: bigint): Uint8Array {
  const b = new Uint8Array(8)
  let n = v; for (let i = 0; i < 8; i++) { b[i] = Number(n & 0xffn); n >>= 8n }
  return b
}
