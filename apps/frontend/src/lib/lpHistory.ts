// src/lib/lpHistory.ts
// Reconstruct which transactions were the connected user's LP add/remove events by listing the
// txs that touched their LP cells (under both their plain lock and the timelock lock). We only
// need the tx-hash set here: the exact token amounts come from the pool's own reconstructed
// history (deriveTxns reserve deltas), joined on these hashes in the hook. No subgraph, no backend.
import { config } from './cellswap'

type RpcScript = { code_hash: string; hash_type: string; args: string }

let _id = 0
async function getTransactions(searchKey: any, limit = 200): Promise<string[]> {
  const res = await fetch(config.indexerUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: ++_id, jsonrpc: '2.0', method: 'get_transactions', params: [searchKey, 'desc', '0x' + limit.toString(16)] }),
  })
  const json = await res.json()
  if (json.error || !json.result) return []
  const seen = new Set<string>()
  for (const o of json.result.objects ?? []) seen.add(o.tx_hash)
  return [...seen]
}

/** Set of tx hashes where the user's LP cells appear, both plain owner-locked and time-locked. */
export async function fetchUserLpTxHashes(opts: {
  userLock: RpcScript
  lpScript: RpcScript          // lp-token type (args empty → any pool)
  timelock?: RpcScript | null  // timelock lock with args = owner lock hash (prefix), or null if not deployed
}): Promise<Set<string>> {
  const filter = { script: opts.lpScript, script_type: 'type' }
  const queries: Promise<string[]>[] = [
    getTransactions({ script: opts.userLock, script_type: 'lock', script_search_mode: 'exact', filter }),
  ]
  if (opts.timelock) {
    queries.push(getTransactions({ script: opts.timelock, script_type: 'lock', script_search_mode: 'prefix', filter }))
  }
  const all = await Promise.all(queries)
  return new Set(all.flat())
}
