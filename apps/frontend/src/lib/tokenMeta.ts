// src/lib/tokenMeta.ts
// Resolve real xUDT names. xUDT cells carry no name; metadata lives in a separate on-chain
// "Unique cell" (decimals‖name‖symbol) created at issuance. Two sources, tried in order:
//   1. On-chain Unique cell: walk the token's type-script history to its mint tx, find the
//      Unique cell, decode it. Works in production with no backend (CKB RPC is browser-accessible).
//   2. CKB Explorer API: fallback (dev proxy / VITE_EXPLORER_PROXY); covers tokens whose
//      Unique cell we can't locate but the explorer has indexed.
import { ccc } from '@ckb-ccc/core'
import { NETWORK, config } from './cellswap'

export interface TokenMeta { symbol: string; name: string; decimals: number; icon?: string }

// "Unique Type" script code hashes (JoyID/Omiga/Spore ecosystem token-info cells).
const UNIQUE_CODE_HASHES = new Set([
  '0x8e341bcfec6393dcd41e635733ff2dca00a6af546949f70c57a706c0f344df8b', // testnet
  '0x2c8c11c985da60b0a330c61a85507416d6382c130ba67f0c47ab071e00aec628', // mainnet
].map(h => h.toLowerCase()))

const PROD_PROXY = (import.meta.env.VITE_EXPLORER_PROXY as string | undefined)?.replace(/\/$/, '')
const explorerBase = NETWORK === 'devnet'
  ? null
  : (import.meta.env.DEV ? '/__explorer' : (PROD_PROXY ?? null))

const cache = new Map<string, TokenMeta | null>()
const inflight = new Map<string, Promise<TokenMeta | null>>()

type XudtType = { codeHash: string; hashType: string; args: string }

let _id = 0
async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: ++_id, jsonrpc: '2.0', method, params }),
  })
  const json = await res.json()
  if (json.error) throw new Error(json.error.message)
  return json.result as T
}

function decodeUnique(hex: string): TokenMeta | null {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  const b = h.length >= 2 ? h.match(/../g)!.map(x => parseInt(x, 16)) : []
  // decimals(1) || name_len(1) || name || symbol_len(1) || symbol
  if (b.length < 3) return null
  const decimals = b[0]
  let off = 1
  const nameLen = b[off]; off += 1
  if (off + nameLen > b.length) return null
  const name = new TextDecoder().decode(new Uint8Array(b.slice(off, off + nameLen))); off += nameLen
  if (off >= b.length) return null
  const symLen = b[off]; off += 1
  if (off + symLen > b.length) return null
  const symbol = new TextDecoder().decode(new Uint8Array(b.slice(off, off + symLen)))
  if (!symbol && !name) return null
  if (decimals > 32) return null  // sanity: not a Unique cell
  return { symbol: symbol || name, name: name || symbol, decimals }
}

/** Find a token's Unique cell on-chain: type-script history → mint tx → Unique cell output. */
async function fetchOnChainMeta(xudt: XudtType): Promise<TokenMeta | null> {
  try {
    const search = { script: { code_hash: xudt.codeHash, hash_type: xudt.hashType, args: xudt.args }, script_type: 'type', group_by_transaction: true }
    const page = await rpc<{ objects: { tx_hash: string }[] }>(config.indexerUrl, 'get_transactions', [search, 'asc', '0x1'])
    const mintTx = page.objects[0]?.tx_hash
    if (!mintTx) return null
    const r = await rpc<{ transaction: { outputs: any[]; outputs_data: string[] } }>(config.rpcUrl, 'get_transaction', [mintTx])
    const tx = r?.transaction
    if (!tx) return null
    for (let i = 0; i < tx.outputs.length; i++) {
      const t = tx.outputs[i]?.type
      if (t && UNIQUE_CODE_HASHES.has((t.code_hash as string).toLowerCase())) {
        const meta = decodeUnique(tx.outputs_data[i] ?? '0x')
        if (meta) return meta
      }
    }
  } catch { /* RPC/decoding failed → fall through */ }
  return null
}

async function fetchExplorerMeta(typeHash: string): Promise<TokenMeta | null> {
  if (!explorerBase) return null
  try {
    const res = await fetch(`${explorerBase}/api/v1/udts/${typeHash}`, {
      headers: { Accept: 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json' },
    })
    if (!res.ok) return null
    const json = await res.json()
    const attr = Array.isArray(json?.data) ? json.data[0]?.attributes : json?.data?.attributes
    if (!attr) return null
    const symbol = (attr.symbol || '').trim()
    const name = (attr.full_name || '').trim()
    if (!symbol && !name) return null
    // Clamp explorer-supplied decimals to a sane range (the on-chain decoder already bounds this);
    // a NaN/huge value would otherwise garble displayed balances/prices for the token.
    const rawDec = attr.decimal !== '' && attr.decimal != null ? Number(attr.decimal) : 8
    const decimals = Number.isFinite(rawDec) ? Math.min(Math.max(0, Math.trunc(rawDec)), 18) : 8
    return { symbol: symbol || name, name: name || symbol, decimals, icon: attr.icon_file || undefined }
  } catch { return null }
}

// CKB Explorer logos are raw uploads (some are data URLs of several hundred KB, up to ~1MB).
// Cap what we'll render so a pathological blob can't bloat the page; sane logos still show.
const MAX_ICON_CHARS = 80_000
const iconCache = new Map<string, string | null>()
const iconInflight = new Map<string, Promise<string | null>>()

/** A token's logo from the CKB Explorer (icon_file), size-capped + cached. null if none/too big. */
export async function fetchTokenIcon(typeHash: string): Promise<string | null> {
  const k = typeHash.toLowerCase()
  if (iconCache.has(k)) return iconCache.get(k)!
  if (iconInflight.has(k)) return iconInflight.get(k)!
  const p = (async (): Promise<string | null> => {
    if (!explorerBase) return null
    try {
      const res = await fetch(`${explorerBase}/api/v1/udts/${k}`, {
        headers: { Accept: 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json' },
      })
      if (!res.ok) return null
      const json = await res.json()
      const attr = Array.isArray(json?.data) ? json.data[0]?.attributes : json?.data?.attributes
      const icon = attr?.icon_file
      return (typeof icon === 'string' && icon.length > 0 && icon.length <= MAX_ICON_CHARS) ? icon : null
    } catch { return null }
  })()
  iconInflight.set(k, p)
  const icon = await p
  iconCache.set(k, icon); iconInflight.delete(k)
  return icon
}

/** Resolve a token's real metadata. Pass the xUDT type script (so we can read on-chain). */
export async function fetchTokenMeta(xudt: XudtType): Promise<TokenMeta | null> {
  const typeHash = ccc.Script.from({ codeHash: xudt.codeHash as `0x${string}`, hashType: xudt.hashType as 'type', args: xudt.args as `0x${string}` }).hash().toLowerCase()
  if (cache.has(typeHash)) return cache.get(typeHash)!
  if (inflight.has(typeHash)) return inflight.get(typeHash)!
  const p = (async () => (await fetchOnChainMeta(xudt)) ?? (await fetchExplorerMeta(typeHash)))()
  inflight.set(typeHash, p)
  const meta = await p
  cache.set(typeHash, meta); inflight.delete(typeHash)
  return meta
}
