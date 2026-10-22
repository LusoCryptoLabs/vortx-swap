#!/usr/bin/env node
// Headless check that the UI's liquidity calls settle on testnet. Mirrors what LiquidityModal
// does: sdk.createPool (fresh pair, random poolId), sdk.addLiquidity, then sdk.removeLiquidity.
// Uses a CKB/TKB pair (the e2e creates CKB/TKA and TKA/TKB, not CKB/TKB).
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
const acct1A = await acct1.getRecommendedAddressObj()
const TKB = acct1A.script.hash() // xUDT identity = owner lock hash (acct1 owns TKB)

function randomPoolId() { // same as the UI
  const b = new Uint8Array(8); globalThis.crypto.getRandomValues(b)
  let id = 0n; for (const x of b) id = (id << 8n) | BigInt(x); return id
}
const lpScript = (pool) => ccc.Script.from({
  codeHash: config.scripts.lpTokenScript.codeHash, hashType: config.scripts.lpTokenScript.hashType,
  args: ccc.Script.from(pool.cell.output.type).hash(),
})
async function udtBal(script, type) {
  let amt = 0n
  for await (const c of client.findCells({ script, scriptType: 'lock', scriptSearchMode: 'exact', filter: { script: type } })) {
    const d = c.outputData.slice(2); if (d.length >= 32) amt += BigInt('0x' + d.slice(0, 32).match(/../g).reverse().join(''))
  }
  return amt
}
const ok = (m) => console.log('   ok', m)
const W = (h) => client.waitTransaction(h, 0, 200_000)

console.log('CKB/TKB liquidity verification (mirrors LiquidityModal)\n')

const poolId = randomPoolId()
console.log('[1] createPool CKB/TKB  poolId =', poolId.toString())
// CKB-native floor: the contract reads reserveCKB = capacity minus MIN_POOL_CAPACITY (400 CKB).
// createPool parks amountX above that floor (capacity = amountX + 400 CKB), so any positive amountX
// clears the info cell's occupied minimum. Use 300 CKB.
const h1 = await sdk.createPool(signer, { tokenX: CKB, tokenY: TKB, amountX: 300_00000000n, amountY: 150_000n, feeBps: 30, poolId })
await W(h1); ok(`created: ${h1.slice(0, 14)}…`)

let pool = await sdk.getPool(CKB, TKB)
if (!pool) throw new Error('pool not discoverable after create')
ok(`discoverable: reserveCKB=${pool.reserveX} reserveTKB=${pool.reserveY} mode=${pool.poolMode}`)

console.log('[2] addLiquidity (+10 CKB matched)')
const before = pool.reserveX
const dy = pool.reserveY / 10n
const dx = (dy * pool.reserveX) / pool.reserveY
const h2 = await sdk.addLiquidity(signer, { tokenX: CKB, tokenY: TKB, amountX: dx, amountY: dy })
await W(h2)
pool = await sdk.getPool(CKB, TKB)
if (pool.reserveX <= before) throw new Error('reserves did not grow')
ok(`added: reserveCKB ${before} → ${pool.reserveX} (${h2.slice(0, 14)}…)`)

console.log('[3] removeLiquidity (burn 1/4 of LP)')
const lpBal = await udtBal(me.script, lpScript(pool))
const tkbBefore = await udtBal(me.script, ccc.Script.from({ codeHash: config.scripts.xudtScript.codeHash, hashType: config.scripts.xudtScript.hashType, args: TKB }))
const h3 = await sdk.removeLiquidity(signer, { tokenX: CKB, tokenY: TKB, lpAmount: lpBal / 4n })
await W(h3)
const tkbAfter = await udtBal(me.script, ccc.Script.from({ codeHash: config.scripts.xudtScript.codeHash, hashType: config.scripts.xudtScript.hashType, args: TKB }))
if (tkbAfter <= tkbBefore) throw new Error('did not receive TKB back')
ok(`removed: got back ${tkbAfter - tkbBefore} TKB (${h3.slice(0, 14)}…)`)

console.log('\ncreate + add + remove all settled on testnet; the UI liquidity flow works.')
