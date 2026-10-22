#!/usr/bin/env node
// Check that the keeper settles a deadline order (deadline > 0): the settlement tx carries a header
// dep so the intent-lock can read the current epoch and confirm the order hasn't expired.
// Uses acct1-token → deployer-token (a direct pool), order owner = deployer, solver = acct1.
//   node scripts/verify-deadline-fill-testnet.mjs
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
const tokenIn = (await acct1.getRecommendedAddressObj()).script.hash()   // acct1-token (deployer holds it)
const tokenOut = me.script.hash()                                        // deployer-token (paid to owner)
const tokenOutType = ccc.Script.from({ codeHash: config.scripts.xudtScript.codeHash, hashType: config.scripts.xudtScript.hashType, args: tokenOut })
const W = (h) => client.waitTransaction(h, 0, 240_000)
const ok = (m) => console.log('   ok', m)
async function bal() { let a = 0n; for await (const c of client.findCells({ script: me.script, scriptType: 'lock', scriptSearchMode: 'exact', filter: { script: tokenOutType } })) { const d = c.outputData.slice(2); if (d.length >= 32) a += BigInt('0x' + d.slice(0, 32).match(/../g).reverse().join('')) } return a }

console.log('Deadline-order fill (header dep)\n')
const tip = await sdk.tipEpoch()
console.log(`[1] place async order with deadline = epoch ${tip + 20n} (tip ${tip} + 20)`)
const before = await bal()
const h1 = await sdk.swapAsync(deployer, { tokenIn, amountIn: 1000n, tokenOut, minAmountOut: 1n, deadlineEpochs: 20 })
await W(h1); ok(`order placed with a deadline: ${h1.slice(0, 14)}…`)

console.log('[2] keeper settles it (settlement tx carries the tip header dep)')
const { txHash, amountOut } = await sdk.settleIntent(acct1, { txHash: h1, index: 0 }, me.script)
await W(txHash); ok(`deadline order settled: paid owner ${amountOut} tokenOut (${txHash.slice(0, 14)}…)`)

const after = await bal()
if (after - before < amountOut) throw new Error(`owner not paid: +${after - before}, expected +${amountOut}`)
ok(`owner balance: +${after - before} tokenOut; intent-lock accepted the header-dep epoch check`)

console.log('\ndeadline-order fill verified on testnet: a deadline > 0 order settled with a header')
console.log('   dep, the intent-lock confirmed it had not expired, and the owner was paid.')
