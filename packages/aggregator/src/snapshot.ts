// Pool snapshot cache: a read-only display accelerator for the frontend.
//
// The frontend reconstructs the pool list live from raw cells (one info-cell scan + a reserve
// scan), which is slow on a cold load and repeated by every visitor. Here the aggregator runs
// `sdk.getPools()` once on a short interval and serves the pre-aggregated result, so the UI paints
// instantly. It is not authoritative: the client uses this only for the pool list display, and
// every quote / swap still builds from live on-chain state (sdk.quoteSwap/swap fetch pools
// themselves), so a stale or wrong snapshot can never cost a user funds. The contract and the
// user's minAmountOut enforce correctness regardless.
import type { CellSwap } from '@cellswap/sdk'

// bigint → JSON (reserves, capacities, lpSupply are bigint). Mirrors the frontend reviver.
const BIG = '__b__'
const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? { [BIG]: (v as bigint).toString() } : v)

let cache: { json: string; builtAt: number; count: number } | null = null
let building = false

/** Rebuild the cached pool snapshot from live chain state. Cheap to serve afterwards (pre-serialized). */
export async function refreshSnapshot(sdk: CellSwap): Promise<void> {
  if (building) return            // don't overlap a slow refresh with the next tick
  building = true
  try {
    const pools = await sdk.getPools()
    const builtAt = Date.now()
    cache = { json: JSON.stringify({ builtAt, count: pools.length, pools }, replacer), builtAt, count: pools.length }
  } finally {
    building = false
  }
}

/** The current snapshot (pre-serialized JSON + meta), or null if not built yet. */
export function poolsSnapshot(): { json: string; builtAt: number; count: number } | null {
  return cache
}
