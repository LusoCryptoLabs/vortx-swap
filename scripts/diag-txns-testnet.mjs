#!/usr/bin/env node
// Diagnose the transaction feed: for every testnet pool, walk its type-script history,
// decode reserves at each step, classify (create/swap/add/remove), and print the counts.
// Tells us whether add/remove liquidity txns are present + correctly classified.
import { ccc } from '@ckb-ccc/core'
import { CellSwap } from '@cellswap/sdk'
import { getConfig } from '@cellswap/config'
const MIN_POOL_CAPACITY = 20_000_000_000n

const config = getConfig('testnet')
const sdk = new CellSwap({ network: 'testnet', config })
const node = config.rpcUrl, indexer = config.indexerUrl
let id = 0
const rpc = (url, m, p) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ++id, jsonrpc: '2.0', method: m, params: p }) }).then(r => r.json()).then(j => { if (j.error) throw new Error(j.error.message); return j.result })
const u128 = (h) => { h = (h.startsWith('0x') ? h.slice(2) : h).slice(0, 32); return h.length < 2 ? 0n : BigInt('0x' + h.match(/../g).reverse().join('')) }
const hashOf = (s) => ccc.Script.from({ codeHash: s.code_hash, hashType: s.hash_type, args: s.args }).hash().toLowerCase()

const pools = await sdk.getPools()
console.log(`Scanning ${pools.length} testnet pools for tx classification\n`)

for (const p of pools) {
  const t = p.cell.output.type
  const infoArgs = t.args.toLowerCase()
  const poolLockArgs = ccc.Script.from(t).hash().toLowerCase()
  const ckbNative = p.poolMode === 'CKB_XUDT'
  const searchKey = { script: { code_hash: t.codeHash, hash_type: t.hashType, args: t.args }, script_type: 'type', group_by_transaction: true }
  let page
  try { page = await rpc(indexer, 'get_transactions', [searchKey, 'asc', '0x' + (200).toString(16)]) } catch { continue }
  const seen = new Set()
  const txs = page.objects.filter(o => (seen.has(o.tx_hash) ? false : (seen.add(o.tx_hash), true)))

  const points = []
  for (const { tx_hash } of txs) {
    try {
      const r = await rpc(node, 'get_transaction', [tx_hash])
      const tx = r?.transaction; if (!tx) continue
      const infoIdx = tx.outputs.findIndex(o => o.type && o.type.args?.toLowerCase() === infoArgs)
      if (infoIdx < 0) continue
      let rx = 0n, ry = 0n
      if (ckbNative) rx = BigInt(tx.outputs[infoIdx].capacity) - MIN_POOL_CAPACITY
      for (let i = 0; i < tx.outputs.length; i++) {
        const o = tx.outputs[i]
        if (!o.lock || o.lock.code_hash?.toLowerCase() !== config.scripts.poolLock.codeHash.toLowerCase()) continue
        if (o.lock.args?.toLowerCase() !== poolLockArgs) continue
        const amt = u128(tx.outputs_data[i] ?? '0x')
        const th = o.type ? hashOf(o.type) : ''
        if (th === p.tokenY.toLowerCase()) ry = amt
        else if (!ckbNative && th === p.tokenX.toLowerCase()) rx = amt
      }
      if (rx <= 0n || ry <= 0n) continue
      points.push({ tx_hash, rx, ry })
    } catch { /* skip */ }
  }

  const kinds = { create: 0, swap: 0, add: 0, remove: 0 }
  for (let i = 0; i < points.length; i++) {
    if (i === 0) { kinds.create++; continue }
    const dx = points[i].rx - points[i - 1].rx, dy = points[i].ry - points[i - 1].ry
    kinds[dx > 0n && dy > 0n ? 'add' : dx < 0n && dy < 0n ? 'remove' : 'swap']++
  }
  const label = `${ckbNative ? 'CKB' : 'xUDT'}/#${p.poolId.toString().slice(0, 6)}`
  console.log(`${label.padEnd(16)} txs=${txs.length} decoded=${points.length}  create=${kinds.create} swap=${kinds.swap} add=${kinds.add} remove=${kinds.remove}`)
}
