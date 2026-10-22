#!/usr/bin/env node
// Create one lock-boost-enabled mining pool on testnet (225-byte args, guard hash at [193..225]).
// Genesis is signed by the VTX issuer key, the governance authority emission-lock checks.
//   node scripts/create-lockboost-pool.mjs                 # read-only: list CKB/xUDT pools + mining state
//   node scripts/create-lockboost-pool.mjs --create [poolId] [emissionPerEpoch]
// Picks (or takes) a CKB/xUDT pool without an existing mining pool so it does not duplicate a pair.
import { ccc } from '@ckb-ccc/core'
import { CellSwap } from '@cellswap/sdk'
import { getConfig } from '@cellswap/config'
import { readFileSync } from 'node:fs'

const config = getConfig('testnet')
const sdk = new CellSwap({ network: 'testnet', config })

const lpHashOf = (pool) => ccc.Script.from({
  codeHash: config.scripts.lpTokenScript.codeHash,
  hashType: config.scripts.lpTokenScript.hashType,
  args: ccc.Script.from(pool.cell.output.type).hash(),
}).hash()

const amm = await sdk.getPools()
const ckb = amm.filter(p => p.poolMode === 'CKB_XUDT')
const mining = await sdk.getMiningPools()
const minedLp = new Set(mining.map(m => m.stakeToken.toLowerCase()))

console.log(`\nlock-boost guard configured: ${sdk.lockBoostEnabled()}  (stakeTimelockGuard ${config.scripts.stakeTimelockGuard?.codeHash?.slice(0, 14)}…)`)
console.log(`\nCKB/xUDT AMM pools: ${ckb.length}   existing mining pools: ${mining.length}\n`)
const rows = ckb.map(p => ({ p, lp: lpHashOf(p), mined: minedLp.has(lpHashOf(p).toLowerCase()) }))
for (const r of rows) {
  console.log(`  pool #${r.p.poolId}  ${r.p.tokenX.slice(0, 10)}/${r.p.tokenY.slice(0, 10)}  lpSupply=${r.p.lpSupply}  miningPool=${r.mined ? 'YES' : 'no'}  lp=${r.lp.slice(0, 14)}…`)
}
console.log('\nexisting mining emissions:', mining.map(m => m.emissionPerEpoch.toString()).join(', '))

const argv = process.argv.slice(2)
if (!argv.includes('--create')) {
  console.log('\n(read-only) re-run with --create [poolId] [emissionPerEpoch] to genesis a lock-boost pool.')
  process.exit(0)
}

if (!sdk.lockBoostEnabled()) throw new Error('lock-boost guard not configured in this build of @cellswap/config')

// Choose the target AMM pool: explicit poolId arg, else the first CKB/xUDT pool with no mining pool.
const wantId = argv.find(a => /^\d+$/.test(a))
const emissionArg = argv.filter(a => /^\d+$/.test(a))[wantId ? 1 : 0]
let target = wantId ? rows.find(r => r.p.poolId.toString() === wantId) : rows.find(r => !r.mined)
if (!target) throw new Error(wantId ? `pool #${wantId} not found / not CKB/xUDT` : 'every CKB/xUDT pool already has a mining pool; pass an explicit poolId to duplicate')
const emission = emissionArg ? BigInt(emissionArg) : 1_000_000_000n

// Governance: the reward token (mining args[32..64]) is derived from governanceLockHash via
// emission-lock. The VTX in use (type 0xaf380887…, args 0x0f783011…) is governed by the issuer key
// (.testnet-vtx-issuer.key), not the deployer, whose lock hash derives a different, unused VTX.
// Genesis must be signed by that authority, so it is signed with the issuer key.
const RECOGNIZED_VTX = '0xaf38088785ffefd50b00f7fd1bbb8eaf834e6fef7cecba3061a1eee7d590ccaf'
const pk0 = readFileSync('.testnet-vtx-issuer.key', 'utf8').trim()
const pk = pk0.startsWith('0x') ? pk0 : '0x' + pk0
const client = new ccc.ClientPublicTestnet({ url: config.rpcUrl })
const signer = new ccc.SignerCkbPrivateKey(client, pk)
sdk.governanceLockHash = (await signer.getRecommendedAddressObj()).script.hash()

// Safety: refuse to create a pool that would mint the wrong token.
if (sdk.vtxTypeHash().toLowerCase() !== RECOGNIZED_VTX) {
  throw new Error(`reward token mismatch: would mint ${sdk.vtxTypeHash()}, expected recognized VTX ${RECOGNIZED_VTX}`)
}

console.log(`\n[create] lock-boost mining pool for AMM pool #${target.p.poolId} (${target.p.tokenX.slice(0,10)}/${target.p.tokenY.slice(0,10)})`)
console.log(`         governance=${sdk.governanceLockHash.slice(0,14)}…  reward=recognized VTX  emission=${emission}/epoch`)
const tx = await sdk.createMiningPoolFromPool(signer, target.p, { emissionPerEpoch: emission })
console.log(`mining-pool genesis tx: ${tx}`)
console.log('   stake token (LP):', target.lp)
