// src/lib/history.ts
// Reconstruct a pool's price history without a subgraph by walking the chain of pool
// cells: every swap consumes the old info+reserve cells and creates new ones, so the
// pool's type script is a linked chain of transactions. We list them via the CKB
// indexer (get_transactions on the type script), then decode reserves at each step.
import { ccc } from '@ckb-ccc/core'
import { MIN_POOL_CAPACITY } from '@cellswap/types'
import { config } from './cellswap'
import { readU128LE } from './utils'

type Script = { codeHash: string; hashType: string; args: string }
const toRpc = (s: Script) => ({ code_hash: s.codeHash, hash_type: s.hashType, args: s.args })
const hashOf = (s: { codeHash?: string; code_hash?: string; hashType?: string; hash_type?: string; args: string }) =>
  ccc.Script.from({
    codeHash: (s.codeHash ?? s.code_hash) as `0x${string}`,
    hashType: (s.hashType ?? s.hash_type) as 'type',
    args: s.args as `0x${string}`,
  }).hash().toLowerCase()

let id = 0
async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: ++id, jsonrpc: '2.0', method, params }),
  })
  const json = await res.json()
  if (json.error) throw new Error(`${method}: ${json.error.message}`)
  return json.result as T
}

export interface PricePoint { time: number; price: number; reserveX: bigint; reserveY: bigint; txHash: string }

/** Walk the pool type script's tx history and decode reserves → spot-price time series.
 *  Best-effort: returns whatever it can decode; never throws. */
export async function fetchPoolHistory(opts: {
  poolType: Script
  poolLockCodeHash: string
  tokenXHash: string
  tokenYHash: string
  decimalsX: number
  decimalsY: number
  ckbNative: boolean
  limit?: number
}): Promise<PricePoint[]> {
  const node = config.rpcUrl
  const indexer = config.indexerUrl
  const out: PricePoint[] = []
  const infoArgs = opts.poolType.args.toLowerCase()
  const poolLockArgs = ccc.Script.from({
    codeHash: opts.poolType.codeHash as `0x${string}`,
    hashType: opts.poolType.hashType as 'type',
    args: opts.poolType.args as `0x${string}`,
  }).hash().toLowerCase()

  try {
    const searchKey = { script: toRpc(opts.poolType), script_type: 'type', group_by_transaction: true }
    // 'desc' = the most recent `limit` txns (then sorted asc below). Otherwise an active pool
    // with >limit txns would only ever show ancient history in both the feed and the chart.
    const page = await rpc<{ objects: { tx_hash: string; block_number: string }[] }>(
      indexer, 'get_transactions', [searchKey, 'desc', '0x' + (opts.limit ?? 80).toString(16)])
    const seen = new Set<string>()
    const txs = page.objects.filter(o => (seen.has(o.tx_hash) ? false : (seen.add(o.tx_hash), true)))

    // Dedup header lookups by block via an in-flight promise cache, so concurrent decodes that
    // land in the same block share one get_header_by_number instead of racing duplicate calls.
    const tsCache = new Map<string, Promise<number>>()
    const headerTs = (bn: string): Promise<number> => {
      let p = tsCache.get(bn)
      if (!p) { p = rpc<{ timestamp: string }>(node, 'get_header_by_number', [bn]).then(h => Number(BigInt(h.timestamp))); tsCache.set(bn, p) }
      return p
    }

    const decodeTx = async ({ tx_hash, block_number }: { tx_hash: string; block_number: string }): Promise<PricePoint | null> => {
      try {
        const r = await rpc<{ transaction: { outputs: any[]; outputs_data: string[] } }>(node, 'get_transaction', [tx_hash])
        const tx = r?.transaction
        if (!tx) return null
        const infoIdx = tx.outputs.findIndex((o: any) => o.type && o.type.args?.toLowerCase() === infoArgs)
        if (infoIdx < 0) return null
        const infoCap = BigInt(tx.outputs[infoIdx].capacity)

        let reserveX = 0n, reserveY = 0n
        if (opts.ckbNative) reserveX = infoCap - MIN_POOL_CAPACITY
        for (let i = 0; i < tx.outputs.length; i++) {
          const o = tx.outputs[i]
          if (!o.lock || o.lock.code_hash?.toLowerCase() !== opts.poolLockCodeHash.toLowerCase()) continue
          if (o.lock.args?.toLowerCase() !== poolLockArgs) continue
          const amt = readU128LE(tx.outputs_data[i] ?? '0x')
          const th = o.type ? hashOf(o.type) : ''
          if (th === opts.tokenYHash.toLowerCase()) reserveY = amt
          else if (!opts.ckbNative && th === opts.tokenXHash.toLowerCase()) reserveX = amt
        }
        if (reserveX <= 0n || reserveY <= 0n) return null
        const price = (Number(reserveY) / 10 ** opts.decimalsY) / (Number(reserveX) / 10 ** opts.decimalsX)
        const time = Math.floor((await headerTs(block_number)) / 1000)
        return { time, price, reserveX, reserveY, txHash: tx_hash }
      } catch { return null /* skip undecodable tx */ }
    }

    // Bounded concurrency: the per-tx fetches were sequential (~80 round-trips back-to-back).
    // Run a small pool of workers off a shared cursor so wall-clock ≈ total / CONCURRENCY.
    const CONCURRENCY = 8
    let cursor = 0
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, txs.length) }, async () => {
      while (cursor < txs.length) {
        const pt = await decodeTx(txs[cursor++])
        if (pt) out.push(pt)
      }
    }))
  } catch { /* indexer unavailable */ }

  out.sort((a, b) => a.time - b.time)
  const dedup: PricePoint[] = []
  for (const p of out) {
    if (dedup.length && dedup[dedup.length - 1].time === p.time) dedup[dedup.length - 1] = p
    else dedup.push(p)
  }
  return dedup
}
