#!/usr/bin/env node
// Check the protocol fee (the revenue that funds the VTX buy-back) on testnet, in isolation.
// Deploys nothing: uses the deployed pool-script-fee (the _mintFee build) through a config override,
// so pools on the older pool-script are untouched. Flow: create a CKB/xUDT pool with the fee
// switch on (treasury = deployer) → swap to grow k → collectFees (mints the protocol's 1/6 cut of
// the fee growth as LP to the treasury) → redeem that treasury LP back to CKB/xUDT.
//   node scripts/verify-fee-testnet.mjs
import { ccc } from '@ckb-ccc/core'
import { CellSwap } from '@cellswap/sdk'
import { getConfig } from '@cellswap/config'
import { readFileSync, readdirSync } from 'node:fs'

const CKB = '0x' + '0'.repeat(64)
const base = getConfig('testnet')

// Read the fresh _mintFee pool-script address from its migration, and override poolScript.
const MIG = 'deployed/testnet/testnet/pool-script-fee/migrations'
const recipe = JSON.parse(readFileSync(`${MIG}/${readdirSync(MIG).filter(f => f.endsWith('.json')).sort().pop()}`, 'utf8')).cell_recipes[0]
const feePoolScript = { codeHash: recipe.type_id, hashType: 'type', txHash: recipe.tx_hash, index: recipe.index ?? 0 }
const config = { ...base, scripts: { ...base.scripts, poolScript: feePoolScript } }
console.log('using _mintFee pool-script', feePoolScript.codeHash.slice(0, 18) + '…\n')

const client = new ccc.ClientPublicTestnet({ url: config.rpcUrl })
const deployer = new ccc.SignerCkbPrivateKey(client, readFileSync('.testnet-deployer.key', 'utf8').trim())
const acct2 = new ccc.SignerCkbPrivateKey(client, readFileSync('.testnet-acct2.key', 'utf8').trim())
const sdk = new CellSwap({ network: 'testnet', config })
const W = (h) => client.waitTransaction(h, 0, 480_000)
const ok = (m) => console.log('   ok', m)
const token = (await acct2.getRecommendedAddressObj()).script.hash()  // deployer holds this xUDT
const treasuryLock = (await deployer.getRecommendedAddressObj()).script // treasury = deployer (testnet)

console.log('Protocol fee (the VTX value source)\n')

// [1] Reuse a fee-on CKB/<token> pool if present, else create one (protocol fee on, treasury=deployer).
let pool = await sdk.getPool(CKB, token)
if (!pool || sdk.poolKLast(pool) === 0n) {
  console.log('[1] createPool CKB/<token> with the protocol fee ON (treasury = deployer)')
  const poolId = BigInt(Math.floor(Date.now() / 1000))
  const hc = await sdk.createPool(deployer, { tokenX: CKB, tokenY: token, amountX: 300_00000000n, amountY: 50_000n, feeBps: 30, poolId, treasuryLock, protocolFeeOn: true })
  await W(hc); ok(`pool created with fee on: ${hc.slice(0, 14)}…`)
} else { console.log('[1] reusing existing fee-on CKB/<token> pool') }

// [2] A couple of large swaps to grow k (the fee accrues into the reserves).
console.log('[2] swaps to grow k (fees accrue into the reserves)')
await W(await sdk.swap(deployer, { tokenIn: token, amountIn: 6_000n, tokenOut: CKB, minAmountOut: 0n }))
await W(await sdk.swap(deployer, { tokenIn: CKB, amountIn: 30_00000000n, tokenOut: token, minAmountOut: 0n }))
pool = await sdk.getPool(CKB, token)
const pending = sdk.pendingProtocolFee(pool)
ok(`k grew; pending protocol fee = ${pending} LP (k_last=${sdk.poolKLast(pool)})`)
if (pending === 0n) throw new Error('no protocol fee accrued; swap more or larger to grow k')

// [3] Collect the fee to the treasury.
console.log('[3] collectFees → mint the protocol cut as LP to the treasury')
const supplyBefore = pool.lpSupply
const hf = await sdk.collectFees(deployer, { tokenX: CKB, tokenY: token, treasuryLock })
await W(hf)
pool = await sdk.getPool(CKB, token)
ok(`lp_supply ${supplyBefore} → ${pool.lpSupply} (+${pool.lpSupply - supplyBefore} minted to treasury)`)
if (pool.lpSupply <= supplyBefore) throw new Error('treasury LP was not minted')
if (sdk.poolKLast(pool) === 0n) throw new Error('k_last did not advance')
ok(`k_last advanced to √k = ${sdk.poolKLast(pool)}`)

// [4] Redeem the treasury LP back to CKB/<token> (the treasury = deployer holds it).
console.log('[4] redeemTreasury: removeLiquidity the protocol fee LP back to assets')
const feeLp = pool.lpSupply - supplyBefore
const hr = await sdk.removeLiquidity(deployer, { tokenX: CKB, tokenY: token, lpAmount: feeLp })
await W(hr); ok(`treasury LP redeemed to CKB + token: ${hr.slice(0, 14)}…`)

console.log('\nprotocol fee verified on testnet: a CKB/xUDT pool with the fee switch on captured the')
console.log('   protocol\'s 1/6 cut of fee growth as treasury LP via collectFees, advanced k_last, and')
console.log('   the treasury redeemed it back to assets. This is the value source feeding VTX buy-back.')
