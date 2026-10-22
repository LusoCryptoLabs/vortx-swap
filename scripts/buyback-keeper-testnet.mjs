#!/usr/bin/env node
// One cycle of the VTX buy-back-and-burn keeper. Uses the fee-on pool (through the pool-script-fee
// config override) whose treasury is the deployer. It (1) collects newly accrued protocol fee to the
// treasury, (2) redeems treasury LP to CKB, then spends that revenue per the buy-back policy. The
// team's share (at most 25%) splits two ways and the rest is burned:
//   (3) liquid CKB slice  → VTX_TEAM_CKB_BPS of the budget paid to VTX_TEAM_CKB_ADDR
//   (4) vested VTX slice  → VTX_TEAM_VEST_BPS of the budget bought as VTX and vested to a
//                           VTX_TEAM_LOCK timelock; the remaining bought VTX is burned.
// CKB_BPS + VEST_BPS must be <= 2500. The intended split is ⅓ CKB (833) / ⅔ VTX (1667). With both
// unset (0/0) the whole budget buys VTX and burns all of it.
//
// Steps 3-4 need VTX and a VTX/CKB pool. VTX is minted only by mining claims (epoch-gated): stake LP
// via /mining, wait at least 1 epoch, claim, then create a VTX/CKB pool (sdk.createPool with
// tokenY = sdk.vtxArgs()). Steps 1-2 (fee → treasury → redeem) run regardless.
//   node scripts/buyback-keeper-testnet.mjs
import { ccc } from '@ckb-ccc/core'
import { CellSwap } from '@cellswap/sdk'
import { getConfig } from '@cellswap/config'
import { readFileSync, readdirSync } from 'node:fs'

const CKB = '0x' + '0'.repeat(64)
const base = getConfig('testnet')
const MIG = 'deployed/testnet/testnet/pool-script-fee/migrations'
const recipe = JSON.parse(readFileSync(`${MIG}/${readdirSync(MIG).filter(f => f.endsWith('.json')).sort().pop()}`, 'utf8')).cell_recipes[0]
const config = { ...base, scripts: { ...base.scripts, poolScript: { codeHash: recipe.type_id, hashType: 'type', txHash: recipe.tx_hash, index: recipe.index ?? 0 } } }

const client = new ccc.ClientPublicTestnet({ url: config.rpcUrl })
const keeper = new ccc.SignerCkbPrivateKey(client, readFileSync('.testnet-deployer.key', 'utf8').trim())
const acct2 = new ccc.SignerCkbPrivateKey(client, readFileSync('.testnet-acct2.key', 'utf8').trim())
const sdk = new CellSwap({ network: 'testnet', config })
// VTX identity: the lock hash of the VTX issuer (a dedicated key; VTX was minted with a Unique
// token-info cell so wallets and explorers show it by name). This is the same fixed hash the frontend
// hardcodes in cellswap.ts, not the deployer's lock hash: the deployer only signs and pays for the
// buy+burn swap below and holds no authority over VTX's identity. A wrong value makes
// vtxArgs()/getPool() resolve to a different, unused VTX pool without any error.
sdk.governanceLockHash = '0x2b9f579fb54f6f23cc809c183dfb940eb4a7f97769803e607f77c6ed5bc55e21'
const W = (h) => client.waitTransaction(h, 0, 480_000)
const ok = (m) => console.log('   ok', m)
const token = (await acct2.getRecommendedAddressObj()).script.hash()
const treasuryLock = (await keeper.getRecommendedAddressObj()).script

console.log('VTX buy-back-and-burn keeper\n')

// [1] Collect any accrued protocol fee to the treasury.
const pool = await sdk.getPool(CKB, token)
const pending = pool ? sdk.pendingProtocolFee(pool) : 0n
if (pending > 0n) {
  console.log(`[1] collectFees (+${pending} treasury LP)`)
  await W(await sdk.collectFees(keeper, { tokenX: CKB, tokenY: token, treasuryLock })); ok('fee collected')
} else { console.log('[1] no new protocol fee to collect') }

// [2] Redeem a slice of the treasury LP to CKB (the buy-back budget).
const REDEEM = 2000n
try {
  console.log(`[2] redeem ${REDEEM} treasury LP -> CKB/token`)
  await W(await sdk.removeLiquidity(keeper, { tokenX: CKB, tokenY: token, lpAmount: REDEEM })); ok('redeemed to assets')
} catch (e) { console.log('   • redeem skipped:', e.message.slice(0, 80)) }

// [3+4] Spend the redeemed fee revenue per the buy-back policy. Requires a VTX/CKB pool.
//   VTX_TEAM_CKB_BPS     liquid CKB slice of this cycle's revenue, in bps
//   VTX_TEAM_VEST_BPS    vested VTX slice of this cycle's revenue, in bps (CKB + VEST <= 2500)
//   VTX_FEE_BUDGET_CKB   CKB of redeemed revenue to deploy this cycle (default 50)
//   VTX_TEAM_CKB_ADDR    team-treasury address for the liquid CKB slice
//   VTX_TEAM_LOCK        team owner lock hash for the vested VTX timelock
//   VTX_VEST_EPOCHS      epochs until a vested VTX tranche unlocks (default 180, about 30 days at ~4h/epoch)
const vtxPool = await sdk.getPool(CKB, sdk.vtxArgs())
if (!vtxPool) {
  console.log('\nNo VTX/CKB pool yet; steps 1-2 (fee → treasury → redeem) done. To finish the')
  console.log('   sink: mine VTX (stake LP on /mining, wait >= 1 epoch, claim), seed a VTX/CKB')
  console.log('   pool, then re-run; this keeper will then buy VTX and burn it.')
  process.exit(0)
}
// The team's share splits into a liquid CKB slice and a vested VTX slice; the remainder is burned.
// The two must sum to <= 2500, the cap on the total team-directed share.
const ckbBps  = Math.max(0, Math.round(Number(process.env.VTX_TEAM_CKB_BPS  ?? 0)))
const vestBps = Math.max(0, Math.round(Number(process.env.VTX_TEAM_VEST_BPS ?? 0)))
if (ckbBps + vestBps > 2500) {
  throw new Error(`team share ${ckbBps + vestBps}bps exceeds the 25% cap: VTX_TEAM_CKB_BPS + VTX_TEAM_VEST_BPS must be <= 2500`)
}
const feeBudget = BigInt(Math.round(Number(process.env.VTX_FEE_BUDGET_CKB ?? 50))) * 1_00000000n

// [3] Liquid CKB slice → team treasury (a key separate from the keeper/governance key).
let buyBudget = feeBudget
let paidCkbBps = 0
if (ckbBps > 0) {
  if (!process.env.VTX_TEAM_CKB_ADDR) throw new Error('VTX_TEAM_CKB_BPS > 0 requires VTX_TEAM_CKB_ADDR (the team-treasury address for the liquid CKB slice)')
  const teamLock = (await ccc.Address.fromString(process.env.VTX_TEAM_CKB_ADDR, client)).script
  // The team payment must not share a key with governance/keeper. Refuse otherwise.
  if (teamLock.hash() === treasuryLock.hash()) {
    throw new Error('VTX_TEAM_CKB_ADDR must be a treasury separate from the keeper/governance key. Refusing to pay the team CKB slice to the deployer.')
  }
  const teamCkb = feeBudget * BigInt(ckbBps) / 10000n
  console.log(`[3] team CKB slice: ${(ckbBps / 100).toFixed(2)}% of ${feeBudget / 1_00000000n} CKB = ${teamCkb / 1_00000000n} CKB → treasury (liquid)`)
  if (teamCkb < 61_00000000n) {
    console.log(`   • slice ${teamCkb / 1_00000000n} CKB is below the ~61 CKB cell floor; skipping this cycle so revenue accumulates`)
  } else {
    const ht = await sdk.payTeamCkb(keeper, { teamLock, ckbAmount: teamCkb }); await W(ht)
    ok(`team paid ${teamCkb / 1_00000000n} CKB → ${teamLock.hash().slice(0, 14)}… (${ht.slice(0, 14)}…)`)
    buyBudget = feeBudget - teamCkb
    paidCkbBps = ckbBps
  }
} else { console.log('[3] no CKB slice (VTX_TEAM_CKB_BPS=0)') }

// [4] Buy VTX with the rest, then vest the team's VTX slice and burn the remainder. The vest fraction
// is taken of the bought VTX, which represents (1 - paidCkbBps) of revenue, so vest
// VEST_BPS/(10000 - paidCkbBps) of it; the vested VTX's revenue share is then about VEST_BPS.
console.log(`[4] buyVtx (${buyBudget / 1_00000000n} CKB → VTX)`)
await W(await sdk.buyVtx(keeper, { ckbIn: buyBudget })); ok('bought VTX')
const vestFractionBps = vestBps === 0 ? 0 : Math.min(2500, Math.round(vestBps / (10000 - paidCkbBps) * 10000))
if (vestFractionBps > 0 && !process.env.VTX_TEAM_LOCK) {
  throw new Error('VTX_TEAM_VEST_BPS > 0 requires VTX_TEAM_LOCK (the team owner lock hash for the vested-VTX timelock)')
}
const teamLockHash = process.env.VTX_TEAM_LOCK || treasuryLock.hash()
const vestEpochs = BigInt(process.env.VTX_VEST_EPOCHS ?? 180)
console.log(`   sink: vest ${(vestFractionBps / 100).toFixed(2)}% of bought VTX (≈${(vestBps / 100).toFixed(2)}% of revenue) → team timelock, burn the rest`)
const hb = await sdk.sinkVtx(keeper, { teamSplitBps: vestFractionBps, teamLockHash, vestEpochs }); await W(hb)
ok(`VTX sunk: ${hb.slice(0, 14)}… (burn → ${sdk.burnLockScript().hash().slice(0, 14)}…${vestFractionBps > 0 ? `, vest → timelock(${teamLockHash.slice(0, 10)}…, +${vestEpochs} epochs)` : ''})`)

console.log('\nbuy-back cycle done: fees → treasury → redeemed →')
console.log(`   ${(ckbBps / 100).toFixed(2)}% team CKB (liquid) + ${(vestBps / 100).toFixed(2)}% team VTX (vested) + ${((10000 - ckbBps - vestBps) / 100).toFixed(2)}% VTX burned.`)
