// @cellswap/sdk: factory registry and multisig pause authority.
//
// factory-script already gates pause/unpause on a `pause_authority` lock hash
// (FactoryData bytes [48..80]) and delegates to whatever lock that hash names,
// so making the authority a multisig is a matter of pointing it at a CKB
// secp256k1-multisig lock hash. This module computes that lock hash and encodes
// the FactoryData cell, so the pause authority (and, by the same token, the
// Type-ID upgrade owner) can be an M-of-N multisig before mainnet.

import { ccc } from '@ckb-ccc/core'

// CKB secp256k1-blake160 multisig lock: same `type` code hash on testnet and mainnet.
// https://github.com/nervosnetwork/ckb-system-scripts
export const SECP256K1_MULTISIG_CODE_HASH =
  '0x5c5069eb0857efc65e1bca0c07df34c31663b3622fd3876c876320fc9634e2a8'

/** blake160 (first 20 bytes of ckbhash) as a 0x hex string. */
function blake160(bytes: Uint8Array): `0x${string}` {
  return (ccc.hashCkb(bytes).slice(0, 42)) as `0x${string}`
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * Compute the CKB secp256k1-multisig lock script (and its lock hash) for an M-of-N set.
 *
 * @param signerBlake160s  each signer's 20-byte blake160 pubkey hash (== their standard
 *                         secp256k1-blake160 lock args), as 0x hex.
 * @param threshold        M: signatures required.
 * @param requireFirstN    R: the first R signers are mandatory (default 0).
 * @param codeHash         multisig lock code hash (default the canonical CKB one).
 *
 * The multisig "script" hashed into the args is: S(0x00) || R || M || N || (blake160 * N).
 * lock.args = blake160(that). The returned `lockHash` is what goes in FactoryData[48..80].
 */
export function computeMultisigAuthority(params: {
  signerBlake160s: string[]
  threshold: number
  requireFirstN?: number
  codeHash?: `0x${string}`
}): { script: ccc.Script; lockHash: `0x${string}`; multisigArgs: `0x${string}` } {
  const { signerBlake160s, threshold } = params
  const requireFirstN = params.requireFirstN ?? 0
  const n = signerBlake160s.length
  if (n === 0 || n > 255) throw new Error('multisig: need 1..255 signers')
  if (threshold < 1 || threshold > n) throw new Error('multisig: threshold must be 1..N')
  if (requireFirstN < 0 || requireFirstN > threshold) throw new Error('multisig: requireFirstN must be 0..M')

  const header = new Uint8Array([0x00, requireFirstN, threshold, n])
  const body = signerBlake160s.flatMap(h => Array.from(hexToBytes(h)))
  for (const h of signerBlake160s) {
    if (hexToBytes(h).length !== 20) throw new Error('multisig: each signer must be a 20-byte blake160')
  }
  const multisigScript = new Uint8Array([...header, ...body])
  const args = blake160(multisigScript)

  const script = ccc.Script.from({
    codeHash: params.codeHash ?? (SECP256K1_MULTISIG_CODE_HASH as `0x${string}`),
    hashType: 'type',
    args,
  })
  return { script, lockHash: script.hash() as `0x${string}`, multisigArgs: args }
}

// FactoryData layout (must match contracts/factory-script/src/main.rs):
//   [0..16]   next_pool_id      u128 LE
//   [16..48]  pool_script_hash  bytes32
//   [48..80]  pause_authority   lock_hash bytes32   ← set this to a multisig lock hash
//   [80]      global_paused     u8
//   [81..]    pool entries (90 bytes each)
export const FACTORY_HEADER = 81

/** Encode the FactoryData header for a fresh factory cell with a (multisig) pause authority. */
export function encodeFactoryData(params: {
  poolScriptHash: `0x${string}`
  pauseAuthorityLockHash: `0x${string}`
  nextPoolId?: bigint
  paused?: boolean
}): `0x${string}` {
  const buf = new Uint8Array(FACTORY_HEADER)
  // next_pool_id u128 LE
  let id = params.nextPoolId ?? 0n
  for (let i = 0; i < 16; i++) { buf[i] = Number(id & 0xffn); id >>= 8n }
  buf.set(hexToBytes(params.poolScriptHash), 16)
  buf.set(hexToBytes(params.pauseAuthorityLockHash), 48)
  buf[80] = params.paused ? 1 : 0
  return ('0x' + Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`
}
