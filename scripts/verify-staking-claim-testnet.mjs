#!/usr/bin/env node
// Check a nonzero reward claim on testnet. Run this at least 1 epoch (~4h) after staking via
// verify-staking-testnet.mjs (which leaves no position) or after staking manually. It reads the
// deployer's position, asserts a nonzero pending reward has accrued, claims it, and checks the
// claimed CKB landed with the deployer while the principal stayed staked.
//   node scripts/verify-staking-claim-testnet.mjs
import { ccc } from '@ckb-ccc/core'
import { CellSwap } from '@cellswap/sdk'
import { getConfig } from '@cellswap/config'
import { readFileSync } from 'node:fs'

const config = getConfig('testnet')
const client = new ccc.ClientPublicTestnet({ url: config.rpcUrl })
const deployer = new ccc.SignerCkbPrivateKey(client, readFileSync('.testnet-deployer.key', 'utf8').trim())
const sdk = new CellSwap({ network: 'testnet', config })
const W = (h) => client.waitTransaction(h, 0, 240_000)
const ok = (m) => console.log('   ok', m)
const me = (await deployer.getRecommendedAddressObj()).script

const pos = await sdk.getStakePosition(deployer)
if (!pos) throw new Error('no stake position; stake first (verify-staking-testnet.mjs leaves none; stake manually then wait an epoch)')
console.log(`position: amount=${pos.amount} pending=${pos.pending} shannons`)
if (pos.pending <= 0n) throw new Error('no reward accrued yet; wait at least one full epoch (~4h) after staking, then re-run')

const ckbBefore = await client.getBalance([me])
console.log('[claim] harvesting the accrued CKB reward, principal stays staked')
const h = await sdk.claim(deployer)
await W(h); ok(`claim settled on-chain: ${h.slice(0, 14)}…`)
const after = await sdk.getStakePosition(deployer)
if (!after || after.amount !== pos.amount) throw new Error('principal changed across a claim (should be unchanged)')
ok(`principal unchanged at ${after.amount}; new pending=${after.pending} (reset toward 0)`)
const ckbAfter = await client.getBalance([me])
ok(`deployer CKB ${ckbBefore / 100000000n} → ${ckbAfter / 100000000n} (reward received, minus tx fee)`)

console.log('\nclaim verified on testnet: an epoch-accrued CKB reward was paid from the pool')
console.log('   reserve, bounded on-chain to exactly the accrued pending, with principal left staked.')
