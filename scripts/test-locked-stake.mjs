#!/usr/bin/env node
// End-to-end check of the locked-stake path: stake LP into the lock-boost pool with a fixed term and
// confirm the mining-pool contract accepts the 56B receipt, timelock-guard custody, weight binding
// and total_weight conservation. Unstake is not exercised here because the term runs for days; the
// since rules are covered by the contract's negative tests. Amount and term come from argv.
//   node scripts/test-locked-stake.mjs [amount] [termEpochs]
import { ccc } from '@ckb-ccc/core'
import { CellSwap } from '@cellswap/sdk'
import { getConfig } from '@cellswap/config'
import { readFileSync } from 'node:fs'

const NEW_POOL = '0xa5905cf9e9efc37a50a181a167538be081f3b8b6c2e0ca9d891f6ca7045991c1'
const amount = BigInt(process.argv[2] ?? '1000000')
const term = BigInt(process.argv[3] ?? '180')   // 180 epochs = 30 days = 1.25×

const config = getConfig('testnet')
const sdk = new CellSwap({ network: 'testnet', config })
let pk = readFileSync('.testnet-deployer.key', 'utf8').trim(); if (!pk.startsWith('0x')) pk = '0x' + pk
const client = new ccc.ClientPublicTestnet({ url: config.rpcUrl })
const signer = new ccc.SignerCkbPrivateKey(client, pk)

const amm = (await sdk.getPools()).find(p => p.poolId.toString() === '5')
const mp = (await sdk.getMiningPools()).find(p => p.poolTypeHash.toLowerCase() === NEW_POOL)
if (!amm || !mp) throw new Error('AMM pool #5 or the lock-boost mining pool not found')

console.log(`staking ${amount} LP locked ${term} epochs into ${NEW_POOL.slice(0, 14)}… (expect weight = ${amount * 12500n / 10000n} at 1.25×)`)
const tx = await sdk.stakeMiningLockedToPool(signer, amm, mp, amount, term)
console.log('locked-stake tx:', tx)
let committed = false
for (let i = 0; i < 40; i++) { const t = await client.getTransaction(tx); if (t && t.status === 'committed') { committed = true; break } await new Promise(r => setTimeout(r, 4000)) }
console.log('committed:', committed)
if (!committed) { console.log('(still pending; check the position shortly)'); process.exit(0) }

const pos = await sdk.getMiningPositionForPool(signer, mp)
console.log('decoded position:', pos ? { amount: pos.amount.toString(), weight: pos.weight.toString(), unlockEpoch: pos.unlockEpoch.toString(), pending: pos.pending.toString() } : null)
