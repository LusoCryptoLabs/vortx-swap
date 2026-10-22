#!/usr/bin/env node
// Check the full relay + fill loop over HTTP: acct1 places a fillable TKB→TKC order, POSTs it
// to the aggregator's /orders endpoint, and the script watches the running fill loop settle it
// on-chain (intent cell consumed + acct1 paid), with no direct settleIntent call from this script.
import { ccc } from '@ckb-ccc/core'
import { CellSwap } from '@cellswap/sdk'
import { getConfig } from '@cellswap/config'
import { readFileSync } from 'node:fs'

const AGG = process.env.AGG_URL ?? 'http://localhost:3012'
const config = getConfig('testnet')
const client = new ccc.ClientPublicTestnet({ url: config.rpcUrl })
const sdk = new CellSwap({ network: 'testnet', config })
const key = (f) => new ccc.SignerCkbPrivateKey(client, readFileSync(f, 'utf8').trim())
const acct1 = key('.testnet-acct1.key')
const acct2 = key('.testnet-acct2.key')
const W = (h) => client.waitTransaction(h, 0, 200_000)
const ok = (m) => console.log('   ok', m)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const xudt = (args) => ccc.Script.from({ codeHash: config.scripts.xudtScript.codeHash, hashType: config.scripts.xudtScript.hashType, args })
async function udtBal(script, type) { let a = 0n; for await (const x of client.findCells({ script, scriptType: 'lock', scriptSearchMode: 'exact', filter: { script: type } })) { const d = x.outputData.slice(2); if (d.length >= 32) a += BigInt('0x' + d.slice(0, 32).match(/../g).reverse().join('')) } return a }

const a1 = await acct1.getRecommendedAddressObj()
const a2 = await acct2.getRecommendedAddressObj()
const TKB = a1.script.hash(), TKC = a2.script.hash()

console.log(`Relay + fill loop over HTTP (${AGG})\n`)

const amountIn = 5_000n
const q = await sdk.quoteSwap(TKB, amountIn, TKC, 0.02)
const minOut = (q.amountOut * 90n) / 100n
console.log(`[1] place fillable order: ${amountIn} TKB → ~${q.amountOut} TKC, minOut ${minOut}`)
const h = await sdk.swapAsync(acct1, { tokenIn: TKB, amountIn, tokenOut: TKC, minAmountOut: minOut })
await W(h)
for (let i = 0; i < 20 && !(await client.getCellLive({ txHash: h, index: 0n }, false)); i++) await sleep(3000)
ok(`order resting at ${h.slice(0, 12)}…:0`)

console.log('[2] relay it to the keeper via POST /orders')
const s = a1.script
const res = await fetch(`${AGG}/orders`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ outPoint: { txHash: h, index: 0 }, ownerLock: { codeHash: s.codeHash, hashType: s.hashType, args: s.args } }),
})
const body = await res.json()
if (!res.ok || !body.ok) throw new Error('relay rejected: ' + JSON.stringify(body))
ok(`relayed (keeper now resting ${body.resting} order[s])`)

console.log('[3] wait for the fill loop to settle it on-chain…')
const before = await udtBal(a1.script, xudt(TKC))
let filled = false
for (let i = 0; i < 60; i++) {
  const live = await client.getCellLive({ txHash: h, index: 0n }, false)
  if (!live) { filled = true; break }
  await sleep(3000)
}
if (!filled) throw new Error('fill loop did not consume the order within ~3min')
for (let i = 0; i < 20 && (await udtBal(a1.script, xudt(TKC))) < before + minOut; i++) await sleep(3000)
const after = await udtBal(a1.script, xudt(TKC))
if (after - before < minOut) throw new Error(`acct1 received ${after - before} < minOut ${minOut}`)
ok(`fill loop settled it: acct1 received ${after - before} TKC (>= minOut ${minOut})`)

console.log('\nFull path works: UI-style relay → keeper fill loop → on-chain settlement, owner paid.')
