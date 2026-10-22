// packages/aggregator/src/verify-tester.ts
//
// Verifies a tester apply/login signature before the aggregator trusts it. Adapted from
// verify-otx.ts's WebAuthn/ES256 verification, minus the 120-byte OTX trade-intent tail; see
// tester-auth.ts in @cellswap/sdk for why that tail doesn't apply here.
//
// Checks performed:
//   1. Freshness: the signed timestamp is within a 5-minute window of server time
//   2. Structural: witness well-formed
//   3. WebAuthn user-present flag set (parity with the on-chain OTX lock's own check)
//   4. Commitment: recomputed from the declared flow + params matches the signed challenge
//   5. Signature: the WebAuthn assertion verifies against that challenge, using the pubkey
//      revealed in the witness. Unlike OTX, there's no pre-existing on-chain lock cell whose args
//      the pubkey must match: the pubkey itself (hashed) is the tester identity, derived fresh
//      by the caller via addressHashFromPubkey.

import { webcrypto, createHash } from 'node:crypto'
import { decodeTesterWitness, computeApplyCommitment, computeLoginCommitment, addressHashFromPubkey } from '@cellswap/sdk'

const { subtle } = webcrypto

const FRESHNESS_WINDOW_MS = 5 * 60_000

export interface TesterVerifyResult {
  ok: boolean
  reason?: string
  addressHash?: string
  pubkeyHex?: string
}

export type TesterFlow =
  | { kind: 'apply'; email: string; timestampMs: bigint }
  | { kind: 'login'; timestampMs: bigint }

export async function verifyTesterWitness(witnessHex: string, flow: TesterFlow): Promise<TesterVerifyResult> {
  const now = BigInt(Date.now())
  const delta = flow.timestampMs > now ? flow.timestampMs - now : now - flow.timestampMs
  if (delta > BigInt(FRESHNESS_WINDOW_MS)) return fail('stale or future timestamp')

  let decoded
  try { decoded = decodeTesterWitness(witnessHex) }
  catch (e) { return fail((e as Error).message) }
  const { sig, pubkey, authData, clientData } = decoded

  // Parity with the on-chain OTX lock's own check: authenticatorData = rpIdHash(32) || flags(1) ||
  // signCount(4); require the user-present flag (bit 0). A UP=0 assertion passes signature math
  // but should never be trusted as an intentional user action.
  if (authData.length < 37 || (authData[32]! & 0x01) === 0) return fail('user-present flag not set')

  const commitment = flow.kind === 'apply'
    ? await computeApplyCommitment({ pubkeyXY: pubkey, email: flow.email, timestampMs: flow.timestampMs })
    : await computeLoginCommitment({ pubkeyXY: pubkey, timestampMs: flow.timestampMs })

  let challenge: string
  try { challenge = JSON.parse(Buffer.from(clientData).toString()).challenge }
  catch { return fail('clientDataJSON unparseable') }
  if (challenge !== base64url(commitment)) return fail('challenge != commitment')

  const clientHash = sha256(clientData)
  const sigBase = concat(authData, clientHash)
  try {
    const key = await subtle.importKey('jwk',
      { kty: 'EC', crv: 'P-256', x: base64url(pubkey.slice(0, 32)), y: base64url(pubkey.slice(32, 64)) },
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    const sigBuf  = sig.slice().buffer
    const baseBuf = sigBase.slice().buffer
    const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sigBuf, baseBuf)
    if (!ok) return fail('WebAuthn signature invalid')
  } catch (e) {
    return fail(`signature verify error: ${(e as Error).message}`)
  }

  const pubkeyHex = toHex(pubkey)
  return { ok: true, addressHash: await addressHashFromPubkey(pubkeyHex), pubkeyHex }
}

const fail = (reason: string): TesterVerifyResult => ({ ok: false, reason })
const sha256 = (d: Uint8Array) => new Uint8Array(createHash('sha256').update(d).digest())
const base64url = (b: Uint8Array) => Buffer.from(b).toString('base64url')
function toHex(b: Uint8Array): string { return Array.from(b).map(x => x.toString(16).padStart(2,'0')).join('') }
function concat(a: Uint8Array, b: Uint8Array): Uint8Array { const r = new Uint8Array(a.length+b.length); r.set(a); r.set(b, a.length); return r }
