#!/usr/bin/env node
// Phase 2 of the recognized-VTX genesis (run after genesis-vtx-phase1.mjs). Polls until the staked
// epoch has ticked, then: (1) the genesis claim, the first VTX mint together with its Unique cell
// (decimals|name|symbol, which JoyID, the explorer and other DEXes read), (2) seed a CKB/VTX pool so
// it is tradeable.
// Idempotent: skips work already on-chain. Prints the frontend cutover values at the end.
//   node scripts/genesis-vtx-phase2.mjs
import { ccc } from '@ckb-ccc/core'
import { CellSwap } from '@cellswap/sdk'
import { getConfig } from '@cellswap/config'
import { readFileSync } from 'node:fs'

const CKB = '0x' + '0'.repeat(64)
const TOKEN_INFO = { decimals: 8, name: 'Vortx Token', symbol: 'VTX' }
const config = getConfig('testnet')
const client = new ccc.ClientPublicTestnet({ url: config.rpcUrl })
const sdk = new CellSwap({ network: 'testnet', config })
const deployer = new ccc.SignerCkbPrivateKey(client, readFileSync('.testnet-deployer.key', 'utf8').trim())
const W = (h) => client.waitTransaction(h, 0, 240_000)
const ok = (m) => console.log('   ok', m)

const st = JSON.parse(readFileSync('.genesis-vtx-state.json', 'utf8'))
sdk.governanceLockHash = st.G2
const vtxType = sdk.vtxTypeHash()
const vtxArgs = sdk.vtxArgs()
if (vtxType !== st.vtxType) throw new Error('state/SDK VTX mismatch: wrong issuer key?')
console.log(`new VTX type=${vtxType} args=${vtxArgs}`)

const balVtx = async (lock) => { let t = 0n; for await (const c of client.findCells({ script: lock, scriptType: 'lock', scriptSearchMode: 'exact', filter: { script: sdk.vtxTypeScript() } })) { const d = c.outputData.slice(2); const b = d.slice(0, 32).match(/../g); if (b) t += BigInt('0x' + b.reverse().join('')) } return t }
const me = (await deployer.getRecommendedAddressObj()).script

// ── idempotency: a CKB/VTX pool already => genesis fully done ───────────────
const haveVtxPool = (await sdk.getPools()).some(p => p.poolMode === 'CKB_XUDT' && (p.tokenX === vtxType || p.tokenY === vtxType))
if (haveVtxPool) { console.log('CKB/VTX pool already exists; genesis already complete.'); process.exit(0) }

// ── wait for the epoch to tick so reward accrues ───────────────────────────
const epoch = async () => Number((await client.getTipHeader()).epoch[0])
let e = await epoch()
while (e <= st.stakeEpoch) {
  console.log(`epoch ${e} <= stake epoch ${st.stakeEpoch}, waiting (recheck in 3 min)…`)
  await new Promise(r => setTimeout(r, 180_000))
  e = await epoch()
}
ok(`epoch ${e} > stake epoch ${st.stakeEpoch}, reward has accrued`)

// ── genesis claim with the Unique cell (skip if already minted) ─────────────
let bal = await balVtx(me)
if (bal === 0n) {
  const mp = (await sdk.getMiningPools()).find(p => p.poolTypeHash === st.poolTypeHash)
  if (!mp) throw new Error('mining pool not found')
  const h = await sdk.claimMiningFromPool(deployer, mp, TOKEN_INFO)
  await W(h)
  ok(`genesis mint + Unique cell: ${h}`)
  bal = await balVtx(me)
} else ok(`VTX already minted (${bal}), skipping claim`)
console.log(`deployer VTX balance: ${bal} (= ${Number(bal) / 1e8} VTX)`)
if (bal === 0n) throw new Error('no VTX minted')

// ── verify the Unique cell is live + decodes ───────────────────────────────
const unique = await client.getKnownScript(ccc.KnownScript.UniqueType)
let meta = null
for await (const c of client.findCells({ script: { codeHash: unique.codeHash, hashType: unique.hashType, args: '0x' }, scriptType: 'type', scriptSearchMode: 'prefix', filter: { script: me } })) {
  const d = c.outputData.slice(2); const b = d.match(/../g).map(x => parseInt(x, 16))
  if (b.length < 3) continue
  const dec = b[0]; let o = 1; const nl = b[o++]; const name = Buffer.from(b.slice(o, o + nl)).toString('utf8'); o += nl
  const sl = b[o++]; const sym = Buffer.from(b.slice(o, o + sl)).toString('utf8')
  if (sym === TOKEN_INFO.symbol) { meta = { dec, name, sym }; break }
}
if (meta) ok(`Unique cell live: "${meta.sym}" / "${meta.name}" / ${meta.dec} dec (wallets and explorers can now read VTX metadata)`)
else console.log('   warning: Unique cell not found by scan yet (indexer lag); it is in the claim tx regardless')

// ── seed a CKB/VTX pool so VTX is tradeable (half the minted VTX, price ~5 CKB/VTX) ─
const seedVtx = bal / 2n
const seedCkb = seedVtx * 5n   // both 8-dec → 5 CKB per VTX
console.log(`seeding CKB/VTX pool: ${Number(seedCkb) / 1e8} CKB + ${Number(seedVtx) / 1e8} VTX…`)
const ph = await sdk.createPool(deployer, { tokenX: CKB, tokenY: vtxArgs, amountX: seedCkb, amountY: seedVtx, feeBps: 30 })
await W(ph)
ok(`CKB/VTX pool seeded: ${ph}`)

console.log('\n──────── FRONTEND CUTOVER VALUES ────────')
console.log(`governance authority G' (cellswap.ts): ${st.G2}`)
console.log(`VTX xUDT args (tokens.ts):             ${vtxArgs}`)
console.log(`VTX type hash:                         ${vtxType}`)
console.log('\nPhase 2 complete: VTX minted with metadata, Unique cell live, CKB/VTX pool seeded.')
console.log('Next: apply the cutover to the frontend, then submit VTX to CKB Explorer.')
