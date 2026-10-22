#!/usr/bin/env node
// Check liquidity mining on testnet: stake a CKB/xUDT pool's LP, mine VTX. Exercises the
// immediate on-chain ops: ensure a CKB/xUDT pool + LP, governance genesis of a mining pool (which
// checks on-chain that the LP belongs to a CKB/xUDT pool), seed the emission authority, stake LP,
// read the position, unstake. Reward accrual is epoch-granular (~4h/epoch); a VTX claim runs via
// verify-mining-claim-testnet.mjs at least 1 epoch after staking.
//   node scripts/verify-mining-testnet.mjs
import { ccc } from '@ckb-ccc/core'
import { CellSwap } from '@cellswap/sdk'
import { getConfig } from '@cellswap/config'
import { readFileSync } from 'node:fs'

const CKB = '0x' + '0'.repeat(64)
const config = getConfig('testnet')
if (!new CellSwap({ network: 'testnet', config }).miningEnabled())
  throw new Error('mining not deployed; run scripts/deploy-mining-testnet.mjs first')

const client = new ccc.ClientPublicTestnet({ url: config.rpcUrl })
const deployer = new ccc.SignerCkbPrivateKey(client, readFileSync('.testnet-deployer.key', 'utf8').trim())
const acct2 = new ccc.SignerCkbPrivateKey(client, readFileSync('.testnet-acct2.key', 'utf8').trim())
const sdk = new CellSwap({ network: 'testnet', config })
const W = (h) => client.waitTransaction(h, 0, 240_000)
const ok = (m) => console.log('   ok', m)

const token = (await acct2.getRecommendedAddressObj()).script.hash() // acct2's xUDT; the deployer holds it
const me = (await deployer.getRecommendedAddressObj()).script
sdk.governanceLockHash = me.hash()   // emissionLockScript needs G (on testnet, G is the deployer lock hash)

console.log('Liquidity mining (stake CKB/xUDT LP -> earn VTX)\n')

// [1] Ensure a CKB/xUDT pool exists for CKB/<token>, and the deployer holds LP.
let pool = await sdk.getPool(CKB, token)
if (!pool) {
  console.log('[1] createPool CKB/<token> (300 CKB + 50000 token)')
  const h = await sdk.createPool(deployer, { tokenX: CKB, tokenY: token, amountX: 300_00000000n, amountY: 50_000n, feeBps: 30, poolId: BigInt(Math.floor(Date.now() / 1000)) })
  await W(h); ok(`pool created: ${h.slice(0, 14)}…`)
} else {
  console.log('[1] reusing existing CKB/<token> pool')
}
const lpOf = async () => (await sdk.getLpPositions(deployer)).find(p => p.pool.poolMode === 'CKB_XUDT' && (p.pool.tokenY === sdk.udtHash(token) || p.pool.tokenX === sdk.udtHash(token)))
let lp = await lpOf()
if (!lp || lp.lpAmount < 10_000n) {
  console.log('[1b] addLiquidity (200 CKB + token) to mint LP to the deployer')
  const h = await sdk.addLiquidity(deployer, { tokenX: CKB, tokenY: token, amountX: 200_00000000n, amountY: 40_000n })
  await W(h); lp = await lpOf()
}
if (!lp || lp.lpAmount < 10_000n) throw new Error(`deployer needs >= 10000 LP of this pool (has ${lp?.lpAmount ?? 0})`)
pool = lp.pool
ok(`deployer holds ${lp.lpAmount} LP of the CKB/<token> pool`)

// [2] Seed the emission authority cell (governance, one-time).
console.log('[2] setupEmissionAuthority (governance seeds the VTX mint authority cell)')
if (!(await client.findCells({ script: sdk.emissionLockScript(), scriptType: 'lock', scriptSearchMode: 'exact' }).next()).value) {
  const h = await sdk.setupEmissionAuthority(deployer); await W(h); ok(`authority cell created: ${h.slice(0, 14)}…`)
} else { ok('authority cell already present') }

// [3] Genesis: create the mining pool (verifies on-chain the LP is a CKB/xUDT pool's).
let mp = await sdk.getMiningPool(CKB, token)
if (!mp) {
  console.log('[3] createMiningPool (authority co-sign + on-chain CKB/xUDT LP check), 1000 VTX/epoch')
  const h = await sdk.createMiningPool(deployer, { tokenX: CKB, tokenY: token, emissionPerEpoch: 1000n })
  await W(h); ok(`mining pool genesis on-chain: ${h.slice(0, 14)}…`)
  mp = await sdk.getMiningPool(CKB, token)
} else { console.log('[3] reusing existing mining pool') }
if (!mp) throw new Error('mining pool not found after genesis')
ok(`mining pool: stakeToken=${mp.stakeToken.slice(0, 14)}… emission=${mp.emissionPerEpoch}/epoch total=${mp.total}`)

// [4] Stake LP.
const STAKE = 10_000n
console.log(`[4] stakeMining(${STAKE} LP): receipt + LP custody created under the pool`)
const hs = await sdk.stakeMining(deployer, { tokenX: CKB, tokenY: token, amount: STAKE })
await W(hs)
const pos = await sdk.getMiningPosition(deployer, CKB, token)
if (!pos || pos.amount !== STAKE) throw new Error(`position not created (got ${pos?.amount})`)
ok(`position on-chain: amount=${pos.amount} LP, pending=${pos.pending} VTX (0 within the same epoch)`)
const mp2 = await sdk.getMiningPool(CKB, token)
if (mp2.total !== mp.total + STAKE) throw new Error('mining total did not increase by the stake')
ok(`mining total_staked -> ${mp2.total}`)

// [5] Unstake LP (no reward yet within the same epoch).
console.log('[5] unstakeMining(10000): withdraw the LP back')
const hu = await sdk.unstakeMining(deployer, { tokenX: CKB, tokenY: token, amount: STAKE })
await W(hu)
const pos2 = await sdk.getMiningPosition(deployer, CKB, token)
if (pos2) throw new Error('position should be closed after full unstake')
ok('position closed; LP returned to the deployer')

console.log('\nliquidity mining verified on testnet: governance genesis (with the on-chain CKB/xUDT')
console.log('   LP check), emission-authority setup, stake LP, and unstake all settled')
console.log('   through mining-pool + stake-guard. VTX accrues per epoch; run')
console.log('   verify-mining-claim-testnet.mjs at least 1 epoch after staking for a VTX mint.')
