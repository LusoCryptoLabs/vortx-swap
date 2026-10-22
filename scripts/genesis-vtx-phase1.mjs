#!/usr/bin/env node
// Phase 1 of the recognized-VTX genesis (run after genesis-vtx-recon.mjs created the issuer key):
//   1. fund the issuer (authority G') from the deployer
//   2. set up the emission authority under G'  → defines the VTX identity
//   3. create a CKB/xUDT mining pool under G'   (issuer co-signs as authority)
//   4. deployer stakes its existing LP into that pool
// Then wait at least 1 epoch and run genesis-vtx-phase2.mjs (the first mint + Unique cell).
//   node scripts/genesis-vtx-phase1.mjs
import { ccc } from '@ckb-ccc/core'
import { CellSwap } from '@cellswap/sdk'
import { getConfig } from '@cellswap/config'
import { readFileSync, writeFileSync } from 'node:fs'

const CKB = '0x' + '0'.repeat(64)
const POOL_ID = 13206n                       // genesis mining pair (deployer holds 100% of its LP)
const EMISSION = 100_000_000_000n            // 1000 VTX (8 dec) per epoch → visible genesis mint
const config = getConfig('testnet')
const client = new ccc.ClientPublicTestnet({ url: config.rpcUrl })
const sdk = new CellSwap({ network: 'testnet', config })
const deployer = new ccc.SignerCkbPrivateKey(client, readFileSync('.testnet-deployer.key', 'utf8').trim())
const issuer = new ccc.SignerCkbPrivateKey(client, readFileSync('.testnet-vtx-issuer.key', 'utf8').trim())
const W = (h) => client.waitTransaction(h, 0, 240_000)
const ok = (m) => console.log('   ok', m)

const issuerScript = (await issuer.getRecommendedAddressObj()).script
const G2 = issuerScript.hash()
sdk.governanceLockHash = G2                  // ← the VTX identity derives from this
console.log(`issuer G' = ${G2}`)
console.log(`new VTX args = ${sdk.vtxArgs()}`)
console.log(`new VTX type = ${sdk.vtxTypeHash()}`)

// 0. quick free-CKB check on the issuer
const freeCkb = async (s) => { let t = 0n; for await (const c of client.findCells({ script: s, scriptType: 'lock', scriptSearchMode: 'exact', filter: { scriptLenRange: [0, 1] } })) t += c.cellOutput.capacity; return t }

// 1. fund the issuer (authority needs CKB for the emission-auth + mining-pool cells + fees)
let ibal = await freeCkb(issuerScript)
if (ibal < 1_000_00000000n) {
  console.log('funding issuer 5,000 CKB from deployer…')
  const tx = ccc.Transaction.from({ outputs: [{ capacity: 5_000_00000000n, lock: issuerScript }], outputsData: ['0x'] })
  await tx.completeInputsByCapacity(deployer)
  await tx.completeFeeBy(deployer, 1000)
  const h = await deployer.sendTransaction(tx); await W(h)
  ok(`issuer funded: ${h}`)
} else ok(`issuer already funded (${(Number(ibal) / 1e8).toFixed(0)} CKB)`)

// 2. emission authority under G'
const ea = await sdk.setupEmissionAuthority(issuer); await W(ea)
ok(`emission authority set up: ${ea}`)

// 3. resolve the genesis pool + create the mining pool under G'
const pools = await sdk.getPools()
const pool = pools.find(p => p.poolId === POOL_ID)
if (!pool) throw new Error(`pool ${POOL_ID} not found`)
const infoTypeHash = ccc.Script.from(pool.cell.output.type).hash()
const lpHash = ccc.Script.from({ codeHash: config.scripts.lpTokenScript.codeHash, hashType: config.scripts.lpTokenScript.hashType, args: infoTypeHash }).hash()
const mh = await sdk.createMiningPoolFromPool(issuer, pool, { emissionPerEpoch: EMISSION }); await W(mh)
ok(`mining pool created under G': ${mh}`)

// identify the freshly-created mining pool by its genesis tx's output[0] type hash (deterministic)
const gtx = await client.getTransaction(mh)
const poolTypeHash = ccc.Script.from(gtx.transaction.outputs[0].type).hash()
console.log(`mining poolTypeHash = ${poolTypeHash}`)

// 4. deployer stakes its LP for this pair (retry for indexer lag finding the new mining pool)
let mp = null
for (let i = 0; i < 12 && !mp; i++) {
  const mps = await sdk.getMiningPools()
  mp = mps.find(p => p.poolTypeHash === poolTypeHash) ?? null
  if (!mp) await new Promise(r => setTimeout(r, 4000))
}
if (!mp) throw new Error('new mining pool not indexed yet; re-run, it exists on-chain')

const lp = (await sdk.getLpPositions(deployer)).find(p => p.pool.poolId === POOL_ID)
if (!lp || lp.lpAmount <= 0n) throw new Error('deployer holds no LP for the genesis pair')
console.log(`deployer staking ${lp.lpAmount} LP…`)
const sh = await sdk.stakeMiningToPool(deployer, pool, mp, lp.lpAmount); await W(sh)
ok(`deployer staked ${lp.lpAmount} LP: ${sh}`)

const tip = await client.getTipHeader()
const stakeEpoch = Number(tip.epoch[0])
const state = {
  poolId: POOL_ID.toString(), poolTypeHash, lpHash, infoTypeHash,
  vtxArgs: sdk.vtxArgs(), vtxType: sdk.vtxTypeHash(), G2,
  emission: EMISSION.toString(), stakeEpoch,
}
writeFileSync('.genesis-vtx-state.json', JSON.stringify(state, null, 2))
console.log(`\nstaked at epoch ${stakeEpoch}. Phase 2 (first mint + Unique cell) needs epoch > ${stakeEpoch}.`)
console.log('state → .genesis-vtx-state.json')
console.log('Phase 1 complete.')
