#!/usr/bin/env node
// Phase-1 recon for the recognized-VTX genesis: (1) generate a fresh dedicated VTX-issuer key
// (idempotent, does not overwrite), (2) read the live state we need to pick the genesis path:
// deployer CKB balance, live CKB/xUDT pools + reserves, and the deployer's LP holdings.
//   node scripts/genesis-vtx-recon.mjs
import { ccc } from '@ckb-ccc/core'
import { CellSwap } from '@cellswap/sdk'
import { getConfig } from '@cellswap/config'
import { randomBytes } from 'node:crypto'
import { existsSync, writeFileSync, readFileSync } from 'node:fs'

const CKB = '0x' + '0'.repeat(64)
const config = getConfig('testnet')
const client = new ccc.ClientPublicTestnet({ url: config.rpcUrl })
const sdk = new CellSwap({ network: 'testnet', config })
const deployer = new ccc.SignerCkbPrivateKey(client, readFileSync('.testnet-deployer.key', 'utf8').trim())

// ── 1. Fresh issuer key (idempotent) ──────────────────────────────────────
const KEY_PATH = '.testnet-vtx-issuer.key'
if (!existsSync(KEY_PATH)) {
  writeFileSync(KEY_PATH, '0x' + randomBytes(32).toString('hex'))
  console.log(`generated new issuer key → ${KEY_PATH}`)
} else {
  console.log(`issuer key already exists → ${KEY_PATH} (reusing)`)
}
const issuer = new ccc.SignerCkbPrivateKey(client, readFileSync(KEY_PATH, 'utf8').trim())
const issuerScript = (await issuer.getRecommendedAddressObj()).script
const issuerAddr = await issuer.getRecommendedAddress()
const G2 = issuerScript.hash()
console.log(`issuer address: ${issuerAddr}`)
console.log(`issuer G' (lock hash) = ${G2}`)

// New VTX identity under G'
sdk.governanceLockHash = G2
console.log(`→ new VTX args  = ${sdk.vtxArgs()}`)
console.log(`→ new VTX type  = ${sdk.vtxTypeHash()}`)

// ── 2. Balances ───────────────────────────────────────────────────────────
const bal = async (s) => { let t = 0n; for await (const c of client.findCells({ script: s, scriptType: 'lock', scriptSearchMode: 'exact', filter: { scriptLenRange: [0, 1] } })) t += c.cellOutput.capacity; return t }
const dep = (await deployer.getRecommendedAddressObj()).script
console.log(`\ndeployer free CKB ≈ ${(Number(await bal(dep)) / 1e8).toLocaleString()} CKB`)
console.log(`issuer   free CKB ≈ ${(Number(await bal(issuerScript)) / 1e8).toLocaleString()} CKB`)

// ── 3. Live CKB/xUDT pools (candidates for the genesis mining pair) ─────────
const pools = await sdk.getPools()
const ckbPools = pools.filter(p => p.poolMode === 'CKB_XUDT')
console.log(`\nlive CKB/xUDT pools (${ckbPools.length}):`)
for (const p of ckbPools) {
  const tokHash = p.tokenX === sdk.udtHash(CKB) ? p.tokenY : p.tokenX
  console.log(`  poolId ${p.poolId}  token ${tokHash.slice(0, 18)}…  reserveCKB ${(Number(p.poolMode === 'CKB_XUDT' ? (p.tokenX === sdk.udtHash(CKB) ? p.reserveX : p.reserveY) : 0n) / 1e8).toFixed(0)}  lpSupply ${p.lpSupply}`)
}

// ── 4. Deployer LP holdings (could be staked directly, skipping swap+addLiq) ─
const lp = await sdk.getLpPositions(deployer)
console.log(`\ndeployer LP positions (${lp.length}):`)
for (const x of lp) console.log(`  poolId ${x.pool.poolId}  lp ${x.lpAmount}  locked ${x.locked ?? false}`)
console.log('\nrecon done.')
