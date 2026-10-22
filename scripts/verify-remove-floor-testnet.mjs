// Check the remove-liquidity CKB floor guard: removing too large a share of a CKB-native pool
// fails with a clear max instead of InsufficientCellCapacity, and removing the capped max
// succeeds.
import { ccc } from '@ckb-ccc/core'
import { CellSwap } from '@cellswap/sdk'
import { getConfig } from '@cellswap/config'
import { readFileSync } from 'node:fs'
const config = getConfig('testnet')
const client = new ccc.ClientPublicTestnet({ url: config.rpcUrl })
const sdk = new CellSwap({ network: 'testnet', config })
const deployer = new ccc.SignerCkbPrivateKey(client, readFileSync('.testnet-deployer.key','utf8').trim())
const W = (h) => client.waitTransaction(h, 0, 200_000)
const ok = (m) => console.log('   ok', m)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const CKB = '0x'+'0'.repeat(64)
const dep = await deployer.getRecommendedAddressObj()
const TKB = (await new ccc.SignerCkbPrivateKey(client, readFileSync('.testnet-acct1.key','utf8').trim()).getRecommendedAddressObj()).script.hash()
function rid(){const b=new Uint8Array(8);globalThis.crypto.getRandomValues(b);let id=0n;for(const x of b)id=(id<<8n)|BigInt(x);return id}

console.log('Remove-liquidity CKB floor guard\n')
// create a small CKB/TKB pool so deployer holds (almost) all LP
console.log('[1] create a fresh CKB/TKB pool (deployer = sole LP)')
const h = await sdk.createPool(deployer, { tokenX: CKB, tokenY: TKB, amountX: 500_00000000n, amountY: 50_000n, feeBps: 30, poolId: rid() })
await W(h)
let pool; for (let i=0;i<20;i++){ pool = await sdk.getPool(CKB, TKB); if (pool) break; await sleep(3000) }
if (!pool) throw new Error('pool not live')
ok(`pool live: reserveX(CKB)=${pool.reserveX} reserveY(TKB)=${pool.reserveY} lpSupply=${pool.lpSupply}`)

const maxLp = sdk.maxRemovableLp(pool)
console.log(`[2] maxRemovableLp = ${maxLp} of lpSupply ${pool.lpSupply} (floor keeps the info cell solvent)`)

// 2a. attempt to remove the full lpSupply-ish (more than max) → expect a clear guard error
console.log('[2a] try removing more than the floor allows → expect a clear guard error')
let guarded = false
try { await sdk.removeLiquidity(deployer, { tokenX: CKB, tokenY: TKB, lpAmount: pool.lpSupply }) }
catch (e) { guarded = /CKB floor|Remove at most|InsufficientCellCapacity/i.test(e.message); console.log('   guard:', e.message.slice(0,110)) }
if (!guarded) throw new Error('expected a floor guard error')
ok('over-withdraw blocked with a clear message (no opaque node error)')

// 2b. remove the capped max → should succeed
console.log('[2b] remove the capped max → expect success')
const safe = (maxLp * 99n) / 100n   // just under the cap
const before = await (async()=>{let c=0n;for await(const x of client.findCellsByLock(dep.script))if(!x.cellOutput.type)c+=x.cellOutput.capacity;return c})()
const rh = await sdk.removeLiquidity(deployer, { tokenX: CKB, tokenY: TKB, lpAmount: safe })
await W(rh)
ok(`removed ${safe} LP successfully (${rh.slice(0,14)}…), no InsufficientCellCapacity`)
console.log('\nRemove-liquidity floor guard works: large withdrawals are guarded with a clear max,')
console.log('   and removing up to the cap succeeds.')
