#!/usr/bin/env node
// Check that the keeper can settle a limit order with no direct pool by routing tokenIn → CKB →
// tokenOut. Uses acct2-token → deployer-token: both have CKB pools, but there's no direct
// xUDT/xUDT pool between them. The order owner (deployer, who holds acct2-token) is paid
// deployer-token; acct1 is the solver.
//   node scripts/verify-routed-fill-testnet.mjs
import { ccc } from '@ckb-ccc/core'
import { CellSwap } from '@cellswap/sdk'
import { getConfig } from '@cellswap/config'
import { readFileSync } from 'node:fs'

const config = getConfig('testnet')
const client = new ccc.ClientPublicTestnet({ url: config.rpcUrl })
const deployer = new ccc.SignerCkbPrivateKey(client, readFileSync('.testnet-deployer.key', 'utf8').trim())
const acct1 = new ccc.SignerCkbPrivateKey(client, readFileSync('.testnet-acct1.key', 'utf8').trim())
const acct2 = new ccc.SignerCkbPrivateKey(client, readFileSync('.testnet-acct2.key', 'utf8').trim())
const sdk = new CellSwap({ network: 'testnet', config })

const CKB = '0x' + '0'.repeat(64)
const me = await deployer.getRecommendedAddressObj()
const tokenIn = (await acct2.getRecommendedAddressObj()).script.hash()   // acct2-token (deployer holds it)
const tokenOut = me.script.hash()                                        // deployer-token (paid to owner)
const tokenOutType = ccc.Script.from({ codeHash: config.scripts.xudtScript.codeHash, hashType: config.scripts.xudtScript.hashType, args: tokenOut })
const W = (h) => client.waitTransaction(h, 0, 240_000)
const ok = (m) => console.log('   ok', m)
async function bal(typeScript) {
  let amt = 0n
  for await (const c of client.findCells({ script: me.script, scriptType: 'lock', scriptSearchMode: 'exact', filter: { script: typeScript } })) {
    const d = c.outputData.slice(2); if (d.length >= 32) amt += BigInt('0x' + d.slice(0, 32).match(/../g).reverse().join(''))
  }
  return amt
}

console.log('Routed limit-order fill: acct2-token → CKB → deployer-token\n')

if (await sdk.getPool(tokenIn, tokenOut)) throw new Error('a direct pool exists; pick a pair without one to exercise routing')
ok('no direct pool for the pair (routing required)')
if (!(await sdk.getPool(CKB, tokenIn)) || !(await sdk.getPool(CKB, tokenOut))) throw new Error('both legs need a CKB pool')
ok('CKB/tokenIn and CKB/tokenOut pools both exist')

const amountIn = 5000n
console.log(`[1] place async order: sell ${amountIn} tokenIn for tokenOut (minOut 1)`)
const before = await bal(tokenOutType)
const h1 = await sdk.swapAsync(deployer, { tokenIn, amountIn, tokenOut, minAmountOut: 1n })
await W(h1); ok(`order placed: ${h1.slice(0, 14)}… (intent at index 0)`)

console.log('[2] keeper settles it by ROUTING (acct1 is the solver)')
const { txHash, amountOut } = await sdk.settleIntent(acct1, { txHash: h1, index: 0 }, me.script)
await W(txHash); ok(`routed settlement: paid owner ${amountOut} tokenOut (${txHash.slice(0, 14)}…)`)

const after = await bal(tokenOutType)
if (after - before < amountOut) throw new Error(`owner not paid: balance +${after - before}, expected +${amountOut}`)
ok(`owner balance: +${after - before} tokenOut (routed tokenIn → CKB → tokenOut)`)

console.log('\nrouted limit-order fill verified on testnet: an order with no direct pool settled')
console.log('   via tokenIn → CKB → tokenOut, and the owner was paid tokenOut on-chain.')
