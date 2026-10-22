// Persist a whitelist of display queries to localStorage with a BigInt-safe codec, so a cold load
// (hard refresh / new tab) paints last-known pools, price history, and protocol stats immediately
// while react-query revalidates in the background.
//
// Safety:
//  - Restored data is forced stale (updatedAt backdated) so every query revalidates on mount;
//    you never act on a snapshot without a live refetch confirming it.
//  - We persist display data only. Volatile/sensitive queries are excluded by not whitelisting
//    their key prefix: 'quote' (a stale quote must never seed a swap; it refetches the instant an
//    amount is typed) and the per-wallet queries (balances/positions/…; small benefit, account-bound).
//  - Pool data feeds tx construction, but it's revalidated before any swap could use it, and a
//    stale reserve cell fails the tx safely (same as the 12s poll race), so it's included for
//    the instant pool list.
import type { QueryClient } from '@tanstack/react-query'

// v2: the codec preserves Map/Set. The version in the key discards v1 snapshots, which stored
// them as {}.
const KEY = (network: string) => `cs:qcache:v2:${network}`
const MAX_AGE = 6 * 60 * 60 * 1000          // drop snapshots older than 6h (don't show ancient data)
const MAX_BYTES = 3_000_000                  // ~3MB cap, well under the localStorage quota
const PERSIST_PREFIXES = new Set([
  'pools', 'history', 'mining-pools', 'stake-stats', 'stake-pool',
  'registrations', 'locked-liq', 'tip-epoch', 'tokenmeta', 'tokenmeta-wallet',
])

// JSON can't carry bigint, Map, or Set; several queries hold all three (e.g. locked-liq is a
// Map<string, {…bigint…}>, registrations is a Map). Encode them so they round-trip exactly.
const BIG = '__b__', MAP = '__m__', SET = '__s__'
const replacer = (_k: string, v: unknown) => {
  if (typeof v === 'bigint') return { [BIG]: v.toString() }
  if (v instanceof Map) return { [MAP]: Array.from(v.entries()) }
  if (v instanceof Set) return { [SET]: Array.from(v.values()) }
  return v
}
// JSON.parse revives bottom-up, so nested bigints inside a Map's entries are already BigInt by the
// time we wrap them back into a Map.
const reviver = (_k: string, v: any) => {
  if (v && typeof v === 'object') {
    if (typeof v[BIG] === 'string') return BigInt(v[BIG])
    if (Array.isArray(v[MAP])) return new Map(v[MAP])
    if (Array.isArray(v[SET])) return new Set(v[SET])
  }
  return v
}

type Snapshot = { t: number; entries: { key: unknown[]; data: unknown }[] }

export function installQueryPersistence(qc: QueryClient, network: string) {
  // 1) Restore: seed the cache, backdated so it is stale and revalidates on first use.
  try {
    const raw = localStorage.getItem(KEY(network))
    if (raw) {
      const snap = JSON.parse(raw, reviver) as Snapshot
      if (snap && Date.now() - snap.t < MAX_AGE && Array.isArray(snap.entries)) {
        const staleAt = Math.min(snap.t, Date.now() - 60_000)   // always ≥60s old → mount refetch fires
        for (const e of snap.entries) {
          try { qc.setQueryData(e.key, e.data, { updatedAt: staleAt }) } catch { /* skip one bad entry */ }
        }
      }
    }
  } catch { /* corrupt/blocked storage: ignore, start cold */ }

  // 2) Persist on cache change, debounced so a burst of updates writes once.
  let timer: ReturnType<typeof setTimeout> | null = null
  const dump = () => {
    try {
      const entries: { key: unknown[]; data: unknown }[] = []
      for (const q of qc.getQueryCache().getAll()) {
        if (q.state.status !== 'success' || q.state.data === undefined) continue
        const k0 = Array.isArray(q.queryKey) ? String(q.queryKey[0]) : ''
        if (!PERSIST_PREFIXES.has(k0)) continue
        entries.push({ key: q.queryKey as unknown[], data: q.state.data })
      }
      const json = JSON.stringify({ t: Date.now(), entries } as Snapshot, replacer)
      if (json.length <= MAX_BYTES) localStorage.setItem(KEY(network), json)
    } catch { /* quota or unserializable value: skip this round */ }
  }
  qc.getQueryCache().subscribe(() => {
    if (timer) return
    timer = setTimeout(() => { timer = null; dump() }, 1500)
  })
}
