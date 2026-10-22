// Fast pool list from the aggregator's pre-aggregated snapshot (GET /pools), with an on-chain
// fallback. This is a display accelerator only. Quotes and swaps still build from live chain
// state inside the SDK, so a stale, absent or wrong snapshot can never cost a user funds.
import { AGGREGATOR_URL } from './cellswap'
import type { Pool } from '@cellswap/sdk'

const BIG = '__b__'
const reviver = (_k: string, v: any) => (v && typeof v === 'object' && typeof v[BIG] === 'string' ? BigInt(v[BIG]) : v)

const MAX_AGE_MS = 60_000      // ignore a snapshot the server hasn't refreshed in a while
const DOWN_MS    = 60_000      // after a failure, skip the endpoint for this long (no per-poll stalls)
let downUntil = 0

/** Try the aggregator's pool snapshot. Returns Pool[] on a fresh hit, else null (→ caller falls
 *  back to the live on-chain scan). Self-disables for DOWN_MS after any failure so a missing
 *  aggregator never adds latency to every poll. */
export async function fetchPoolsSnapshot(timeoutMs = 1200): Promise<Pool[] | null> {
  if (Date.now() < downUntil) return null
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetch(`${AGGREGATOR_URL}/pools`, { signal: ctrl.signal }).finally(() => clearTimeout(timer))
    if (!res.ok) { downUntil = Date.now() + DOWN_MS; return null }
    const parsed = JSON.parse(await res.text(), reviver) as { builtAt?: number; pools?: Pool[] }
    if (!Array.isArray(parsed?.pools)) { downUntil = Date.now() + DOWN_MS; return null }
    if (!parsed.builtAt || Date.now() - parsed.builtAt > MAX_AGE_MS) return null   // stale server cache → go live
    downUntil = 0
    return parsed.pools
  } catch {
    downUntil = Date.now() + DOWN_MS
    return null
  }
}
