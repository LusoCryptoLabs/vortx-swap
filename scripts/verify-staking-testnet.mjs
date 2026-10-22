#!/usr/bin/env node
// Check xUDT staking on testnet: the receipt + custody model, under which positions can only be
// created or moved by the pool type script (a lock-only design would not enforce that).
// Exercises every immediate on-chain op through the stake-pool + stake-guard scripts:
//   genesis (createStakePool) → fund (add reward reserve) → stake (position created under pool
//   supervision) → read position back → partial unstake → full unstake (principal returned).
// Reward accrual is epoch-granular (~4h/epoch on testnet) and is covered by the Rust
// conservation tests; a nonzero on-chain claim needs at least 1 epoch, so run
// scripts/verify-staking-claim-testnet.mjs after staking + waiting an epoch.
//   node scripts/verify-staking-testnet.mjs
import { ccc } from '@ckb-ccc/core'
import { CellSwap } from '@cellswap/sdk'
import { getConfig } from '@cellswap/config'
import { readFileSync } from 'node:fs'

const config = getConfig('testnet')
if (config.scripts.stakePool.codeHash === '0x' + '0'.repeat(64) ||
    config.scripts.stakeGuard.codeHash === '0x' + '0'.repeat(64))
  throw new Error('staking not deployed; run scripts/deploy-staking-testnet.mjs first')

const client = new ccc.ClientPublicTestnet({ url: config.rpcUrl })
const deployer = new ccc.SignerCkbPrivateKey(client, readFileSync('.testnet-deployer.key', 'utf8').trim())
const acct2 = new ccc.SignerCkbPrivateKey(client, readFileSync('.testnet-acct2.key', 'utf8').trim())
const sdk = new CellSwap({ network: 'testnet', config })

const W = (h) => client.waitTransaction(h, 0, 240_000)
const ok = (m) => console.log('   ok', m)

// Stake token = acct2's xUDT (its args = acct2's lock hash); the deployer holds a balance of it.
const stakeToken = (await acct2.getRecommendedAddressObj()).script.hash()
const tokenScript = sdk.udtScript(stakeToken)
const me = (await deployer.getRecommendedAddressObj()).script

const balOf = async (lock) => {
  let total = 0n
  for await (const c of client.findCells({ script: lock, scriptType: 'lock', scriptSearchMode: 'exact', filter: { script: tokenScript } })) {
    const d = c.outputData.startsWith('0x') ? c.outputData.slice(2) : c.outputData
    const b = d.slice(0, 32).match(/.{2}/g); if (b) total += BigInt('0x' + b.reverse().join(''))
  }
  return total
}

console.log('Secure xUDT staking (receipt + custody)\n')
const startBal = await balOf(me)
console.log(`[0] deployer holds ${startBal} of the stake token`)
if (startBal < 100_000n) throw new Error('deployer needs >= 100000 of the stake token to run this proof')

// [1] Genesis: reuse an existing pool for this token if present, else create one.
let pool = await sdk.getStakePool(stakeToken)
if (!pool) {
  console.log('[1] createStakePool: 500 CKB initial reward reserve, 2000 bps/epoch emission')
  const h = await sdk.createStakePool(deployer, { stakeToken, emissionBps: 2000, initialRewardCkb: 500_00000000n })
  await W(h); ok(`genesis on-chain: ${h.slice(0, 14)}…`)
  pool = await sdk.getStakePool(stakeToken)
} else {
  console.log('[1] reusing existing staking pool for this token')
}
if (!pool) throw new Error('pool not found after genesis')
ok(`pool: total=${pool.total} reserve=${pool.reserve / 100000000n} CKB emission=${pool.emissionBps}bps`)

// [2] Fund: anyone can top up the reward reserve.
console.log('[2] fundStakePool(+100 CKB): permissionless reward top-up')
const reserveBefore = (await sdk.getStakeStats()).rewardReserve
const hf = await sdk.fundStakePool(deployer, 100_00000000n)
await W(hf); const reserveAfter = (await sdk.getStakeStats()).rewardReserve
ok(`reserve ${reserveBefore / 100000000n} → ${reserveAfter / 100000000n} CKB (+100)`)
if (reserveAfter !== reserveBefore + 100_00000000n) throw new Error('fund did not add exactly 100 CKB to the reserve')

// [3] Stake: a fresh position is created under the pool's supervision.
const STAKE = 100_000n
console.log(`[3] stake(${STAKE}): receipt + custody created (guard forces pool validation)`)
const hs = await sdk.stake(deployer, { token: stakeToken, amount: STAKE })
await W(hs)
const pos = await sdk.getStakePosition(deployer)
if (!pos || pos.amount !== STAKE) throw new Error(`position not created (got ${pos?.amount})`)
ok(`position on-chain: amount=${pos.amount} pending=${pos.pending} (0 within the same epoch)`)
const afterStakeBal = await balOf(me)
if (afterStakeBal !== startBal - STAKE) throw new Error(`stake-token balance should drop by ${STAKE}`)
ok(`stake-token custodied: balance ${startBal} → ${afterStakeBal}`)
const poolAfterStake = await sdk.getStakePool(stakeToken)
if (poolAfterStake.total !== pool.total + STAKE) throw new Error('pool total_staked did not increase by the stake')
ok(`pool total_staked → ${poolAfterStake.total}`)

// [4] Partial unstake: position shrinks, principal partially returned.
console.log('[4] unstake(40000): partial withdrawal')
const hu = await sdk.unstake(deployer, { amount: 40_000n })
await W(hu)
const pos2 = await sdk.getStakePosition(deployer)
if (!pos2 || pos2.amount !== 60_000n) throw new Error(`partial unstake wrong remaining (${pos2?.amount})`)
ok(`remaining position: ${pos2.amount}`)

// [5] Full unstake: position closed, all principal returned.
console.log('[5] unstake(60000): close the position')
const hu2 = await sdk.unstake(deployer, { amount: 60_000n })
await W(hu2)
const pos3 = await sdk.getStakePosition(deployer)
if (pos3) throw new Error('position should be closed after full unstake')
const endBal = await balOf(me)
ok(`position closed; stake-token balance restored to ${endBal}`)
if (endBal !== startBal) throw new Error(`principal not fully returned: ${endBal} != ${startBal}`)

console.log('\nstaking verified on testnet: genesis, fund, stake, partial + full unstake all')
console.log('   settled through stake-pool + stake-guard. Positions can only be created or moved')
console.log('   under the pool type script. Reward accrual is epoch-granular: run')
console.log('   verify-staking-claim-testnet.mjs at least 1 epoch after staking for a claim.')
