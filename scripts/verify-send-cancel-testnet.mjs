#!/usr/bin/env node
// Headless check of two UI actions:
//   A) sendToken (Wallet → Send): plain CKB + xUDT transfer (mirrors lib/transfer.sendToken)
//   B) cancelIntent (Positions → Cancel): create an async intent cell, then cancel it
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
const acct1A = await acct1.getRecommendedAddressObj()
const TKA = me.script.hash()      // deployer owns TKA
const TKB = acct1A.script.hash()
const CKB = '0x' + '0'.repeat(64)
const xudt = (args) => ccc.Script.from({ codeHash: config.scripts.xudtScript.codeHash, hashType: config.scripts.xudtScript.hashType, args })
const enc = (v) => { const b = new Uint8Array(16); let n = v; for (let i = 0; i < 16; i++) { b[i] = Number(n & 0xffn); n >>= 8n } return '0x' + [...b].map(x => x.toString(16).padStart(2, '0')).join('') }
const W = (h) => client.waitTransaction(h, 0, 200_000)
const ok = (m) => console.log('   ok', m)

async function ckbBal(script) { let c = 0n; for await (const x of client.findCellsByLock(script)) if (!x.cellOutput.type) c += x.cellOutput.capacity; return c }
async function udtBal(script, type) { let a = 0n; for await (const x of client.findCells({ script, scriptType: 'lock', scriptSearchMode: 'exact', filter: { script: type } })) { const d = x.outputData.slice(2); if (d.length >= 32) a += BigInt('0x' + d.slice(0, 32).match(/../g).reverse().join('')) } return a }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
// testnet indexer can lag a freshly-confirmed tx; poll until the change cell is indexed.
async function waitUdt(script, type, min) {
  for (let i = 0; i < 30; i++) { if (await udtBal(script, type) >= min) return; await sleep(3000) }
  throw new Error('timed out waiting for indexer to catch up')
}

// ── lib/transfer.sendToken, reimplemented for Node ──
async function sendToken(signer, toAddress, tokenArgs, amount) {
  const to = await ccc.Address.fromString(toAddress, client)
  if (tokenArgs === CKB) {
    const tx = ccc.Transaction.from({ outputs: [{ capacity: amount, lock: to.script }] })
    await tx.completeInputsByCapacity(signer); await tx.completeFeeBy(signer, 1000)
    return signer.sendTransaction(tx)
  }
  const type = xudt(tokenArgs)
  const tx = ccc.Transaction.from({ outputs: [{ capacity: 14_400_000_000n, lock: to.script, type }], outputsData: [enc(amount)] })
  await tx.addCellDepsOfKnownScripts(client, ccc.KnownScript.XUdt)
  await tx.completeInputsByUdt(signer, type); await tx.completeInputsByCapacity(signer); await tx.completeFeeBy(signer, 1000)
  return signer.sendTransaction(tx)
}

console.log('A) sendToken: CKB + xUDT transfer (Wallet → Send)\n')
const acct1Addr = acct1A.toString()
const ckbBefore = await ckbBal(acct1A.script)
const h1 = await sendToken(deployer, acct1Addr, CKB, 12_300_000_000n) // 123 CKB
await W(h1)
if (await ckbBal(acct1A.script) <= ckbBefore) throw new Error('CKB not received')
ok(`sent 123 CKB → acct1 (${h1.slice(0, 14)}…)`)

const tkaBefore = await udtBal(acct1A.script, xudt(TKA))
await waitUdt(me.script, xudt(TKA), 1_234n)  // wait for indexer after the CKB send
const h2 = await sendToken(deployer, acct1Addr, TKA, 1_234n)
await W(h2)
if (await udtBal(acct1A.script, xudt(TKA)) <= tkaBefore) throw new Error('TKA not received')
ok(`sent 1,234 TKA → acct1 (${h2.slice(0, 14)}…)`)

console.log('\nB) cancelIntent: create async intent, then cancel (Positions → Cancel)\n')
await waitUdt(me.script, xudt(TKA), 5_000n)  // let the indexer catch up after the TKA send
const h3 = await sdk.swapAsync(deployer, { tokenIn: TKA, amountIn: 5_000n, tokenOut: TKB, minAmountOut: 1n })
await W(h3); ok(`async intent created (${h3.slice(0, 14)}…)`)

// find the unspent intent-lock cell owned by deployer (owner = first 32 bytes of args)
const ownerHash = me.script.hash().toLowerCase()
let intentCell = null
for await (const cell of client.findCells({
  script: { codeHash: config.scripts.intentLock.codeHash, hashType: config.scripts.intentLock.hashType, args: ownerHash },
  scriptType: 'lock', scriptSearchMode: 'prefix',
})) { intentCell = cell; break }
if (!intentCell) throw new Error('intent cell not found after swapAsync')
ok(`found pending intent cell at ${intentCell.outPoint.txHash.slice(0, 14)}…`)

const tkaBeforeCancel = await udtBal(me.script, xudt(TKA))
const cell = { outPoint: intentCell.outPoint, output: intentCell.cellOutput, data: intentCell.outputData }
const h4 = await sdk.cancelIntent(deployer, cell)
await W(h4)
const tkaAfterCancel = await udtBal(me.script, xudt(TKA))
if (tkaAfterCancel <= tkaBeforeCancel) throw new Error('cancel did not return the locked TKA')
ok(`cancelled, got back ${tkaAfterCancel - tkaBeforeCancel} TKA (${h4.slice(0, 14)}…)`)

console.log('\nsendToken (CKB + xUDT) and cancelIntent both settled on testnet.')
