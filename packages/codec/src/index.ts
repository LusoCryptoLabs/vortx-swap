// @cellswap/codec
//
// Shared little-endian byte-codec helpers and the on-chain data layout constants.
// These must match the Rust contract layouts (pool-script, intent-lock). Keeping a
// single copy here stops the offsets and helpers from drifting between the SDK, the
// aggregator, and the deploy/verify scripts.
//
// All offsets are byte offsets into a hex string without the 0x prefix (call stripHex first).

type Hex = `0x${string}`

// ─── Hex string readers (byte offsets, not hex-char offsets) ───────────────

export function stripHex(s: string): string {
  return s.startsWith('0x') ? s.slice(2) : s
}

export function byteLen(hex: string): number {
  return hex.length / 2
}

export function readU8(hex: string, byteOff: number): number {
  return parseInt(hex.slice(byteOff * 2, byteOff * 2 + 2), 16)
}

export function readU16LE(hex: string, byteOff: number): number {
  const b0 = parseInt(hex.slice(byteOff * 2, byteOff * 2 + 2), 16)
  const b1 = parseInt(hex.slice(byteOff * 2 + 2, byteOff * 2 + 4), 16)
  return b0 | (b1 << 8)
}

export function readU32LE(hex: string, byteOff: number): number {
  let result = 0
  for (let i = 0; i < 4; i++) {
    const byte = parseInt(hex.slice((byteOff + i) * 2, (byteOff + i) * 2 + 2), 16)
    result |= byte << (i * 8)
  }
  return result >>> 0
}

export function readU64LE(hex: string, byteOff: number): bigint {
  const bytes = hex.slice(byteOff * 2, byteOff * 2 + 16).match(/.{2}/g)
  if (!bytes) throw new Error('invalid hex')
  return BigInt('0x' + bytes.reverse().join(''))
}

export function readU128LE(hex: string, byteOff: number): bigint {
  const bytes = hex.slice(byteOff * 2, byteOff * 2 + 32).match(/.{2}/g)
  if (!bytes) throw new Error('invalid hex')
  return BigInt('0x' + bytes.reverse().join(''))
}

export function readBytes32(hex: string, byteOff: number): Hex {
  return ('0x' + hex.slice(byteOff * 2, byteOff * 2 + 64)) as Hex
}

// ─── Byte-buffer writers ────────────────────────────────────────────────────

export function writeU128LE(buf: Uint8Array, val: bigint, off: number): void {
  let v = val
  for (let i = 0; i < 16; i++) { buf[off + i] = Number(v & 0xffn); v >>= 8n }
}

export function writeU64LE(buf: Uint8Array, val: bigint, off: number): void {
  let v = val
  for (let i = 0; i < 8; i++) { buf[off + i] = Number(v & 0xffn); v >>= 8n }
}

export function writeU16LE(buf: Uint8Array, val: number, off: number): void {
  buf[off] = val & 0xff
  buf[off + 1] = (val >> 8) & 0xff
}

export function copyHexInto(buf: Uint8Array, hex: string, off: number): void {
  const clean = stripHex(hex)
  for (let i = 0; i < clean.length / 2; i++) {
    buf[off + i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
}

// ─── Conversions ────────────────────────────────────────────────────────────
// hexToUint8Array assumes clean hex (no 0x). Callers strip first.

export function hexToUint8Array(hex: string): Uint8Array {
  const r = new Uint8Array(hex.length / 2)
  for (let i = 0; i < r.length; i++) r[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return r
}

export function uint8ArrayToHex(arr: Uint8Array): string {
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('')
}

export function encodeU128LE(v: bigint): Hex {
  const b = new Uint8Array(16)
  writeU128LE(b, v, 0)
  return ('0x' + uint8ArrayToHex(b)) as Hex
}

// ─── Pool info-cell layout (must match contracts/pool-script PoolData) ─────
// Field offsets are stable across pool-script versions. Newer pools append a
// protocol-fee k_last field, so each consumer keeps its own size view.

export const POOL_TOKEN_X_OFF     = 0
export const POOL_TOKEN_Y_OFF     = 32
export const POOL_LP_SUPPLY_OFF   = 64
export const POOL_FEE_BPS_OFF     = 80
export const POOL_ID_OFF          = 82
export const POOL_CUM_PRICE_X_OFF = 98
export const POOL_CUM_PRICE_Y_OFF = 114
export const POOL_LAST_EPOCH_OFF  = 130
export const POOL_POOL_MODE_OFF   = 138
export const POOL_PAUSED_OFF      = 139
/** Base (pre-protocol-fee) info-cell size. Newer pools append a 16-byte k_last field. */
export const POOL_DATA_SIZE       = 140

// ─── Intent data layout (must match contracts intent IntentData) ───────────

export const INTENT_TYPE_OFF       = 0
export const INTENT_TOKEN_IN_OFF   = 1
export const INTENT_AMOUNT_IN_OFF  = 33
export const INTENT_TOKEN_OUT_OFF  = 49
export const INTENT_MIN_OUT_OFF    = 81
export const INTENT_DEADLINE_OFF   = 97
export const INTENT_OWNER_OFF      = 105
export const INTENT_POOL_OFF       = 137
export const INTENT_SOLVER_FEE_OFF = 169
export const INTENT_DATA_SIZE      = 171
