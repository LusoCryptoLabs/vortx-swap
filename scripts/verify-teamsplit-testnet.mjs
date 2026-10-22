#!/usr/bin/env node
// Checks the buy-back team split. Buys VTX on the VTX/CKB pool, then sinkVtx(teamSplitBps=2000)
// vests 20% to a team-treasury timelock cell (unlocks at tip+5 epochs) and burns the other 80% to
// the unspendable lock. Verifies both legs landed exactly. The team share is funded from revenue,
// with no pre-mine and no contract change.
//   node scripts/verify-teamsplit-testnet.mjs
import { ccc } from '@ckb-ccc/core'
import { CellSwap } from '@cellswap/sdk'
import { getConfig } from '@cellswap/config'
import { readFileSync, readdirSync } from 'node:fs'

const CKB = '0x' + '0'.repeat(64)
const base = getConfig('testnet')
// The VTX/CKB + fee pools live under the fee pool-script; override poolScript so buyVtx finds them.
const MIG = 'deployed/testnet/testnet/pool-script-fee/migrations'
const recipe = JSON.parse(readFileSync(`${MIG}/${readdirSync(MIG).filter(f => f.endsWith('.json')).sort().pop()}`, 'utf8')).cell_recipes[0]
const config = { ...base, scripts: { ...base.scripts, poolScript: { codeHash: recipe.type_id, hashType: 'type', txHash: recipe.tx_hash, index: recipe.index ?? 0 } } }

const client = new ccc.ClientPublicTestnet({ url: base.rpcUrl })
const keeper = new ccc.SignerCkbPrivateKey(client, readFileSync('.testnet-deployer.key', 'utf8').trim())
const sdk = new CellSwap({ network: 'testnet', config })
const me = (await keeper.getRecommendedAddressObj()).script
sdk.governanceLockHash = me.hash()
const W = (h) => client.waitTransaction(h, 0, 480_000)
const vtx = sdk.vtxTypeScript()

const readU128 = (hex) => { const h = hex.startsWith('0x') ? hex.slice(2) : hex; const b = h.slice(0, 32).match(/.{2}/g); return b ? BigInt('0x' + b.reverse().join('')) : 0n }
const sumAt = async (lockScript, mode = 'exact') => {
  let t = 0n
  for await (const c of client.findCells({ script: lockScript, scriptType: 'lock', scriptSearchMode: mode, filter: { script: vtx } })) t += readU128(c.outputData)
  return t
}
// VTX held in team-treasury timelock cells = timelock-lock code, args prefixed by our owner hash.
const timelockPrefix = ccc.Script.from({ codeHash: config.scripts.timelockLock.codeHash, hashType: config.scripts.timelockLock.hashType, args: me.hash() })
const sumVested = () => sumAt(timelockPrefix, 'prefix')

console.log('Team-split check: buy VTX → sinkVtx(20% vest / 80% burn)\n')

console.log('[1] buyVtx (20 CKB -> VTX on the VTX/CKB pool)')
await W(await sdk.buyVtx(keeper, { ckbIn: 20_00000000n }))
const have = await sumAt(me)
if (have <= 0n) throw new Error('no VTX after buy')
console.log('   keeper VTX =', have.toString())

const burnBefore = await sumAt(sdk.burnLockScript())
const vestBefore = await sumVested()

console.log('[2] sinkVtx teamSplitBps=2000 (20% vest, 80% burn), vestEpochs=5')
await W(await sdk.sinkVtx(keeper, { teamSplitBps: 2000, teamLockHash: me.hash(), vestEpochs: 5n }))

const burnDelta = (await sumAt(sdk.burnLockScript())) - burnBefore
const vestDelta = (await sumVested()) - vestBefore
const expectVest = have * 2000n / 10000n
const expectBurn = have - expectVest
console.log(`   burned: +${burnDelta}  (expect ${expectBurn})`)
console.log(`   vested: +${vestDelta}  (expect ${expectVest})`)

let pass = true
if (burnDelta !== expectBurn) { console.error('   FAIL: burn amount mismatch'); pass = false }
if (vestDelta !== expectVest) { console.error('   FAIL: vest amount mismatch'); pass = false }
if (vestDelta <= 0n) { console.error('   FAIL: nothing vested (split did not route)'); pass = false }
if (pass) {
  console.log('\nteam split verified: 20% of the buy-back vested to a timelock treasury cell,')
  console.log('   80% burned. Revenue-funded team share, no pre-mine, no contract change.')
}
process.exit(pass ? 0 : 1)
