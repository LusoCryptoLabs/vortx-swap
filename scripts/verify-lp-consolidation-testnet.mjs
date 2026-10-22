#!/usr/bin/env node
// Checks that addLiquidity consolidates LP cells: after multiple unlocked deposits to the same
// pool, the provider holds exactly one LP cell (not one per deposit), and removeLiquidity still
// burns the combined balance.  node scripts/verify-lp-consolidation-testnet.mjs
import { ccc } from '@ckb-ccc/core'
import { CellSwap } from '@cellswap/sdk'
import { getConfig } from '@cellswap/config'
import { readFileSync } from 'node:fs'

const config = getConfig('testnet')
const client = new ccc.ClientPublicTestnet({ url: config.rpcUrl })
const signer = new ccc.SignerCkbPrivateKey(client, readFileSync('.testnet-deployer.key', 'utf8').trim())
const acct1 = new ccc.SignerCkbPrivateKey(client, readFileSync('.testnet-acct1.key', 'utf8').trim())
const sdk = new CellSwap({ network: 'testnet', config })

const CKB = '0x' + '0'.repeat(64)
const me = await signer.getRecommendedAddressObj()
const TKB = (await acct1.getRecommendedAddressObj()).script.hash()
const W = (h) => client.waitTransaction(h, 0, 240_000)
const ok = (m) => console.log('   ok', m)
const lpScript = (pool) => ccc.Script.from({
  codeHash: config.scripts.lpTokenScript.codeHash, hashType: config.scripts.lpTokenScript.hashType,
  args: ccc.Script.from(pool.cell.output.type).hash(),
})
async function lpCells(pool) {
  let count = 0, total = 0n
  for await (const c of client.findCells({ script: me.script, scriptType: 'lock', scriptSearchMode: 'exact', filter: { script: lpScript(pool) } })) {
    count++; const d = c.outputData.slice(2); if (d.length >= 32) total += BigInt('0x' + d.slice(0, 32).match(/../g).reverse().join(''))
  }
  return { count, total }
}
const randomPoolId = () => { const b = new Uint8Array(8); globalThis.crypto.getRandomValues(b); let i = 0n; for (const x of b) i = (i << 8n) | BigInt(x); return i }

console.log('LP consolidation verification\n')
console.log('[1] createPool CKB/TKB')
await W(await sdk.createPool(signer, { tokenX: CKB, tokenY: TKB, amountX: 100_00000000n, amountY: 50_000n, feeBps: 30, poolId: randomPoolId() }))
let pool = await sdk.getPool(CKB, TKB)
let c = await lpCells(pool); ok(`after create: ${c.count} LP cell(s), total ${c.total}`)
if (c.count !== 1) throw new Error(`expected 1 LP cell after create, got ${c.count}`)

for (const n of [2, 3]) {
  console.log(`[${n}] addLiquidity (unlocked): should consolidate, not add a cell`)
  const dy = pool.reserveY / 10n, dx = (dy * pool.reserveX) / pool.reserveY
  await W(await sdk.addLiquidity(signer, { tokenX: CKB, tokenY: TKB, amountX: dx, amountY: dy }))
  pool = await sdk.getPool(CKB, TKB)
  c = await lpCells(pool)
  ok(`after add #${n - 1}: ${c.count} LP cell(s), total ${c.total}`)
  if (c.count !== 1) throw new Error(`expected 1 consolidated LP cell, got ${c.count}`)
}

console.log('[4] removeLiquidity from the consolidated balance (within the CKB floor)')
const maxLp = sdk.maxRemovableLp(pool)
const burn = c.total / 10n < maxLp ? c.total / 10n : maxLp
await W(await sdk.removeLiquidity(signer, { tokenX: CKB, tokenY: TKB, lpAmount: burn }))
pool = await sdk.getPool(CKB, TKB)
const after = await lpCells(pool)
ok(`after remove: ${after.count} LP cell(s), total ${after.total}`)
if (after.total >= c.total) throw new Error('LP balance did not shrink after remove')

console.log('\nconsolidation works: multiple unlocked deposits keep one LP cell, remove burns it.')
