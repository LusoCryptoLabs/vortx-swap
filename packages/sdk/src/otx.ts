// packages/sdk/src/otx.ts
// Verified against JoyID SDK source: @joyid/ckb/src/verify.ts
//
// JoyID signChallenge() actual response formats (from verifyNativeKeySignature source):
//   pubkey:    hex string, 64 bytes (x‖y, no 0x prefix, no 04 prefix)
//   message:   base64url(authenticatorData[37 bytes] || clientDataJSON)
//   signature: base64url(DER-encoded secp256r1 signature)
//   challenge: original string passed to signChallenge()
//
// Signing math (from verifyNativeKeySignature, line by line):
//   msg           = base64url_decode(message)
//   authData      = msg[0:37]
//   clientData    = msg[37:]
//   clientHash    = sha256(clientData)
//   signatureBase = authData || clientHash
//   verify:  ECDSA P-256 SHA-256 over signatureBase using derToIEEE(sig)
//   ≡ verify_prehash(sha256(signatureBase), raw_sig, pubkey)

import { ccc } from '@ckb-ccc/core'
import type { TxHash, TypeHash } from '@cellswap/types'
import { DEFAULT_FEE_RATE } from '@cellswap/types'

// Personalization for the commitment hash; must match Rust COMMIT_PERSONALIZATION
const COMMIT_PERSONALIZATION = new Uint8Array([
  0x63, 0x6b, 0x62, 0x2d, 0x63, 0x73, 0x77, 0x70,  // "ckb-cswp"
  0x2d, 0x6f, 0x74, 0x78, 0x63, 0x6f, 0x6d, 0x00,  // "-otxcom\x00"
])

// JoyID authenticatorData = 37 bytes (32 rpIdHash + 1 flags + 4 signCount)
const JOYID_AUTH_DATA_LEN = 37

// ─── JoyID API types (from @joyid/ckb source) ─────────────────────────────────

export interface JoyIDSignResponse {
  pubkey:    string   // 64-byte hex x‖y (no 0x, no 04 prefix)
  challenge: string
  message:   string   // base64url(authenticatorData || clientDataJSON)
  signature: string   // base64url(DER signature)
  alg:       number
  keyType:   'main_key' | 'sub_key' | 'main_session_key' | 'sub_session_key'
  attestation?: string
}

export interface JoyIDConnectResponse {
  address: string; ethAddress: string; pubkey: string; keyType: string
}

// ─── Swap intent ──────────────────────────────────────────────────────────────

export interface SwapIntent {
  firstInputTxHash: TxHash    // outpoint of first input cell (uniquely IDs the spend)
  firstInputIndex:  number
  totalInputAmount: bigint    // sum of input xUDT amounts under the OTX lock
  minAmountOut:     bigint
  tokenOut:         TypeHash  // 32-byte type hash
  ownerLockHash:    TypeHash  // 32-byte lock hash where output must go
  tokenInTypeHash:  TypeHash  // 32-byte type hash of the input token (binds the asset spent)
  deadlineEpoch:    bigint    // u64 epoch after which settlement is rejected; 0 = no deadline
}

/**
 * The payload a user submits to the aggregator after signing.
 * Contains everything needed to assemble their cell into a settlement tx.
 */
export interface OTXPayload {
  // Input cells under cellswap-otx-lock (the user's funds being swapped)
  inputCells:   Array<{ txHash: TxHash; index: number }>
  lockArgs:     `0x${string}`   // cellswap-otx-lock args = scheme(1) || blake2b256(pubkey)(32) = 33 bytes
  witness:      `0x${string}`   // WebAuthn assertion + intent, for WitnessArgs.lock
  // Trade parameters (must match what was committed in the witness intent)
  tokenIn:      TypeHash      // xUDT args of the input token (used to locate cells)
  tokenInTypeHash: TypeHash   // 32-byte type hash of the input token, committed on-chain
  amountIn:     bigint
  tokenOut:     TypeHash
  minAmountOut: bigint
  ownerLockHash: TypeHash
  deadlineEpoch: bigint       // committed deadline epoch; 0 = none
  ownerLock:    { codeHash: `0x${string}`; hashType: 'type' | 'data' | 'data1'; args: `0x${string}` }  // full owner lock (hashes to ownerLockHash)
}

/**
 * Compute the commitment the user signs for an OTX swap.
 * Must match compute_commitment() in contracts/cellswap-otx-lock/src/main.rs.
 *
 * commitment = blake2b_personal(
 *   first_input_outpoint(36) || total_input_amount(16 LE) || min_amount_out(16 LE)
 *   || token_out(32) || owner_lock_hash(32) || token_in(32) || deadline_epoch(8 LE)
 * )
 *
 * Pass the returned Uint8Array to signChallenge() as the challenge.
 */
export async function computeSwapCommitment(intent: SwapIntent): Promise<Uint8Array> {
  // The cellswap-otx-lock rejects a zero minimum on-chain (it would let the inputs be consumed
  // for nothing). Fail fast here with a clear message instead of a late on-chain ZeroMinOut.
  if (intent.minAmountOut <= 0n) {
    throw new Error('OTX swap needs a positive minimum out (minAmountOut must be > 0)')
  }
  const { blake2b } = await import('@noble/hashes/blake2b')
  const h = blake2b.create({ personalization: COMMIT_PERSONALIZATION, dkLen: 32 })

  // OutPoint molecule = txHash(32) || index(4 LE) = 36 bytes
  h.update(ccc.OutPoint.from({
    txHash: intent.firstInputTxHash as `0x${string}`,
    index:  BigInt(intent.firstInputIndex),
  }).toBytes())
  h.update(u128le(intent.totalInputAmount))
  h.update(u128le(intent.minAmountOut))
  h.update(hexToBytes(strip0x(intent.tokenOut)))
  h.update(hexToBytes(strip0x(intent.ownerLockHash)))
  h.update(hexToBytes(strip0x(intent.tokenInTypeHash)))  // bind which token is spent
  h.update(u64le(intent.deadlineEpoch))                  // bind the deadline

  return h.digest()
}

// ─── Parse JoyID response ─────────────────────────────────────────────────────

/**
 * Parse a JoyID signChallenge() response into an OTX witness + lock args.
 * The intent must be the same one used to compute the commitment.
 *
 * Usage:
 * ```typescript
 * import { signChallenge } from '@joyid/ckb'
 * const commitment = await computeSwapCommitment(intent)
 * const res = await signChallenge(commitment, address)   // pass Uint8Array
 * const { witness, lockArgs } = parseJoyIDOtxResponse(res, intent)
 * ```
 */
export async function parseJoyIDOtxResponse(res: JoyIDSignResponse, intent: SwapIntent): Promise<{
  witness:  `0x${string}`
  lockArgs: `0x${string}`
  pubkeyXY: Uint8Array
}> {
  const msgBytes = base64urlDecode(res.message)
  if (msgBytes.length <= JOYID_AUTH_DATA_LEN) {
    throw new Error(`JoyID message too short: ${msgBytes.length} <= ${JOYID_AUTH_DATA_LEN}`)
  }
  const authData   = msgBytes.slice(0, JOYID_AUTH_DATA_LEN)
  const clientData = msgBytes.slice(JOYID_AUTH_DATA_LEN)

  const sigDer = base64urlDecode(res.signature)
  const sigRaw = derToRaw(sigDer)

  const pubkeyHex = res.pubkey.startsWith('0x') ? res.pubkey.slice(2) : res.pubkey
  if (pubkeyHex.length !== 128) {
    throw new Error(`Invalid JoyID pubkey: expected 128 hex chars, got ${pubkeyHex.length}`)
  }
  const pubkeyXY = hexToBytes(pubkeyHex)

  // Encode intent (120 bytes):
  //   min_amount_out(16) || token_out(32) || owner_lock_hash(32) || token_in(32) || deadline(8)
  const intentBytes = new Uint8Array(120)
  intentBytes.set(u128le(intent.minAmountOut), 0)
  intentBytes.set(hexToBytes(strip0x(intent.tokenOut)), 16)
  intentBytes.set(hexToBytes(strip0x(intent.ownerLockHash)), 48)
  intentBytes.set(hexToBytes(strip0x(intent.tokenInTypeHash)), 80)
  intentBytes.set(u64le(intent.deadlineEpoch), 112)

  return {
    witness:  encodeWebAuthnWitness(sigRaw, pubkeyXY, authData, clientData, intentBytes),
    lockArgs: await buildOtxLockArgs(pubkeyHex),   // version || blake2b256(pubkey)
    pubkeyXY,
  }
}

// ─── Lock args builder ────────────────────────────────────────────────────────

/**
 * Build cellswap-otx-lock args from a JoyID pubkey string.
 * lockArgs = scheme_version(1 byte = 0x01) || blake2b256(pubkey)(32 bytes).
 * The raw pubkey is not placed on-chain at rest (quantum harvest-now resistance);
 * it is revealed only in the witness at spend time.
 */
export async function buildOtxLockArgs(joyidPubkey: string): Promise<`0x${string}`> {
  const clean = joyidPubkey.startsWith('0x') ? joyidPubkey.slice(2) : joyidPubkey
  if (clean.length !== 128) throw new Error(`Expected 64-byte pubkey, got ${clean.length / 2} bytes`)
  const hash = await ckbHash(hexToBytes(clean))   // blake2b256, ckb-default-hash
  return ('0x01' + toHex(hash)) as `0x${string}`  // 0x01 = SCHEME_SECP256R1_WEBAUTHN
}

/** blake2b-256 with CKB's default-hash personalization (matches the Rust ckb_hash). */
async function ckbHash(data: Uint8Array): Promise<Uint8Array> {
  const { blake2b } = await import('@noble/hashes/blake2b')
  return blake2b.create({
    personalization: new Uint8Array([
      0x63,0x6b,0x62,0x2d,0x64,0x65,0x66,0x61,0x75,0x6c,0x74,0x2d,0x68,0x61,0x73,0x68, // "ckb-default-hash"
    ]),
    dkLen: 32,
  }).update(data).digest()
}

// ─── Witness encoding ─────────────────────────────────────────────────────────

/**
 * Encode WebAuthn assertion + intent into WitnessArgs.lock bytes.
 * Format: sig(64) || pubkey(64) || auth_len(4) || auth_data || client_len(4) || client_data || intent(120)
 * The pubkey is revealed here (not in args) for quantum harvest-now resistance.
 */
export function encodeWebAuthnWitness(
  sig:        Uint8Array,
  pubkey:     Uint8Array,   // 64 bytes x‖y
  authData:   Uint8Array,
  clientData: Uint8Array,
  intent:     Uint8Array,   // 120 bytes: min(16)+token_out(32)+owner(32)+token_in(32)+deadline(8)
): `0x${string}` {
  const buf = new Uint8Array(64 + 64 + 4 + authData.length + 4 + clientData.length + intent.length)
  let off = 0
  buf.set(sig.slice(0, 64), off);    off += 64
  buf.set(pubkey.slice(0, 64), off); off += 64
  new DataView(buf.buffer).setUint32(off, authData.length, true);   off += 4
  buf.set(authData, off);  off += authData.length
  new DataView(buf.buffer).setUint32(off, clientData.length, true); off += 4
  buf.set(clientData, off); off += clientData.length
  buf.set(intent, off)
  return ('0x' + toHex(buf)) as `0x${string}`
}

// ─── Migration ────────────────────────────────────────────────────────────────

/**
 * One-time migration: move user's xUDT from JoyID address to CellSwap OTX address.
 * After this, all swaps use Cobuild OTX signing.
 *
 * User calls connect() to get pubkey, then this builds the migration tx.
 * The migration tx is signed normally with JoyID (not OTX signing).
 */
export async function buildMigrationTx(
  signer:        ccc.Signer,
  tokenType:     ccc.Script,
  amount:        bigint,
  otxLockArgs:   `0x${string}`,
  otxCodeHash:   `0x${string}`,
): Promise<ccc.Transaction> {
  const otxLock = ccc.Script.from({ codeHash: otxCodeHash, hashType: 'type', args: otxLockArgs })
  const owner = (await signer.getRecommendedAddressObj()).script

  // Minimum CKB a live cell needs = its occupied bytes (1 byte = 1 CKB). The OTX lock args
  // (0x01 ‖ blake2b256(pubkey) = 33 bytes) make this larger than a plain xUDT cell, so it is
  // sized from the real scripts; a hardcoded 144 CKB underflows and fails verification.
  const argLen = (s: string) => BigInt((s.startsWith('0x') ? s.length - 2 : s.length) / 2)
  const cellMin = (lockArgs: string) =>
    (8n + 32n + 1n + argLen(lockArgs) + 32n + 1n + argLen(tokenType.args) + 16n) * 100_000_000n

  // Collect the owner's xUDT cells totalling >= amount. Without this the tx has 0 xUDT input
  // but `amount` xUDT output, so the xUDT type script rejects (Outputs[0].Type validation).
  const xIns: { previousOutput: ccc.OutPointLike }[] = []
  let collected = 0n
  for await (const cell of signer.client.findCells({
    script: owner, scriptType: 'lock', scriptSearchMode: 'exact', filter: { script: tokenType },
  } as any)) {
    xIns.push({ previousOutput: cell.outPoint })
    const d = (cell.outputData as string).slice(2)
    if (d.length >= 32) collected += BigInt('0x' + d.slice(0, 32).match(/../g)!.reverse().join(''))
    if (collected >= amount) break
  }
  if (collected < amount) throw new Error(`Not enough token to migrate: have ${collected}, need ${amount}`)

  const outputs: ccc.CellOutputLike[] = [{ capacity: cellMin(otxLock.args), lock: otxLock, type: tokenType }]
  const outputsData: `0x${string}`[] = [encodeU128LE(amount)]
  const change = collected - amount
  if (change > 0n) {   // return the xUDT surplus to the owner so token in == token out
    outputs.push({ capacity: cellMin(owner.args), lock: owner, type: tokenType })
    outputsData.push(encodeU128LE(change))
  }

  const tx = ccc.Transaction.from({ inputs: xIns, outputs, outputsData })
  await tx.addCellDepsOfKnownScripts(signer.client, ccc.KnownScript.XUdt)
  await tx.completeInputsByCapacity(signer)
  await tx.completeFeeBy(signer, DEFAULT_FEE_RATE)
  return tx
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function base64urlDecode(s: string): Uint8Array {
  // Works in both browser (atob) and Node.js (Buffer)
  const padded = s.replace(/-/g, '+').replace(/_/g, '/')
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - padded.length % 4)
  const b64 = padded + pad
  // Use globalThis for cross-env compatibility
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const NodeBuffer = (globalThis as any).Buffer
  if (NodeBuffer) {
    return new Uint8Array(NodeBuffer.from(b64, 'base64') as Uint8Array)
  }
  const binStr = (globalThis as any).atob(b64) as string
  return new Uint8Array(Array.from(binStr, (c: string) => c.charCodeAt(0)))
}

/**
 * DER → raw r‖s (64 bytes)
 * Mirrors JoyID's derToIEEE() from @joyid/ckb/src/utils.ts
 */
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

function strip0x(s: string): string {
  return s.startsWith('0x') ? s.slice(2) : s
}

function u128le(v: bigint): Uint8Array {
  const b = new Uint8Array(16)
  let n = v; for (let i = 0; i < 16; i++) { b[i] = Number(n & 0xffn); n >>= 8n }
  return b
}

function u64le(v: bigint): Uint8Array {
  const b = new Uint8Array(8)
  let n = v; for (let i = 0; i < 8; i++) { b[i] = Number(n & 0xffn); n >>= 8n }
  return b
}

function encodeU128LE(v: bigint): `0x${string}` {
  const b = new Uint8Array(16)
  let n = v; for (let i = 0; i < 16; i++) { b[i] = Number(n & 0xffn); n >>= 8n }
  return ('0x' + toHex(b)) as `0x${string}`
}
