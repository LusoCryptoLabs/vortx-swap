#!/usr/bin/env node
// Headless check of cancelIntent (Positions → Cancel): create an async intent-lock cell via
// swapAsync, then cancel it and confirm the locked tokenIn returns to the owner.
// (sendToken is covered by verify-send-cancel-testnet.mjs.)
import { ccc } from '@ckb-ccc/core'
import { CellSwap } from '@cellswap/sdk'
import { getConfig } from '@cellswap/config'
import { readFileSync } from 'node:fs'

const config = getConfig('testnet')
const client = new ccc.ClientPublicTestnet({ url: config.rpcUrl })
const deployer = new ccc.SignerCkbPrivateKey(client, readFileSync('.testnet-deployer.key', 'utf8').trim())
const acct1 = new ccc.SignerCkbPrivateKey(client, readFileSync('.testnet-acct1.key', 'utf8').trim())
const sdk = new CellSwap({ network: 'testnet', config })

const me = await deployer.getRecommendedAddressObj()
const TKA = me.script.hash()
const TKB = (await acct1.getRecommendedAddressObj()).script.hash()
const xudt = (args) => ccc.Script.from({ codeHash: config.scripts.xudtScript.codeHash, hashType: config.scripts.xudtScript.hashType, args })
const W = (h) => client.waitTransaction(h, 0, 200_000)
const ok = (m) => console.log('   ok', m)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function udtBal(script, type) { let a = 0n; for await (const x of client.findCells({ script, scriptType: 'lock', scriptSearchMode: 'exact', filter: { script: type } })) { const d = x.outputData.slice(2); if (d.length >= 32) a += BigInt('0x' + d.slice(0, 32).match(/../g).reverse().join('')) } return a }
async function waitUdt(script, type, min) { for (let i = 0; i < 40; i++) { if (await udtBal(script, type) >= min) return; await sleep(3000) } throw new Error('indexer lag timeout') }

// The deployer holds TKB (TKA moved to acct1 in earlier runs), so lock TKB.
console.log('cancelIntent: create async intent (lock TKB), then cancel\n')
await waitUdt(me.script, xudt(TKB), 5_000n)
const h3 = await sdk.swapAsync(deployer, { tokenIn: TKB, amountIn: 5_000n, tokenOut: TKA, minAmountOut: 1n })
await W(h3); ok(`async intent created (${h3.slice(0, 14)}…)`)

// find the unspent intent-lock cell owned by deployer (owner = first 32 bytes of lock args)
const ownerHash = me.script.hash().toLowerCase()
let intentCell = null
for (let i = 0; i < 20 && !intentCell; i++) {
  for await (const cell of client.findCells({
    script: { codeHash: config.scripts.intentLock.codeHash, hashType: config.scripts.intentLock.hashType, args: ownerHash },
    scriptType: 'lock', scriptSearchMode: 'prefix',
  })) { intentCell = cell; break }
  if (!intentCell) await sleep(3000)
}
if (!intentCell) throw new Error('intent cell not found after swapAsync')
ok(`found pending intent cell ${intentCell.outPoint.txHash.slice(0, 14)}…[${intentCell.outPoint.index}]`)

const before = await udtBal(me.script, xudt(TKB))
const cell = { outPoint: intentCell.outPoint, output: intentCell.cellOutput, data: intentCell.outputData }
const h4 = await sdk.cancelIntent(deployer, cell)
await W(h4)
await waitUdt(me.script, xudt(TKB), before + 1n)
const after = await udtBal(me.script, xudt(TKB))
if (after <= before) throw new Error('cancel did not return the locked TKB')
ok(`cancelled, got back ${after - before} TKB (${h4.slice(0, 14)}…)`)
console.log('\ncancelIntent settled on testnet: pending order funds returned to owner.')
