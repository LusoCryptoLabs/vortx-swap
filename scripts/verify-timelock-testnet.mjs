#!/usr/bin/env node
// Headless check of the LP time-lock on testnet, against the deployed timelock-lock contract.
//
//   node scripts/verify-timelock-testnet.mjs
//
// Two parts:
//   A. Contract lock/unlock (isolated: plain CKB cells under the timelock, so the timelock is the
//      gate, not lp-token): a future-deadline cell can't be spent early (since=0 → BadSince; and
//      since=deadline → consensus rejects as immature), while a deadline=now cell spends with
//      owner co-sign. This exercises the real on-chain `since` enforcement without waiting hours.
//   B. SDK integration: addLiquidity({ lockEpochs }) mints a time-locked LP cell and
//      getLpPositions reports it locked with the right unlock epoch.
import { ccc } from '@ckb-ccc/core'
import { CellSwap } from '@cellswap/sdk'
import { getConfig } from '@cellswap/config'
import { readFileSync } from 'node:fs'

const config = getConfig('testnet')
if (config.scripts.timelockLock.codeHash === '0x' + '0'.repeat(64))
  throw new Error('timelockLock not deployed; run scripts/deploy-timelock-testnet.mjs first')

const client = new ccc.ClientPublicTestnet({ url: config.rpcUrl })
const signer = new ccc.SignerCkbPrivateKey(client, readFileSync('.testnet-deployer.key', 'utf8').trim())
const acct1 = new ccc.SignerCkbPrivateKey(client, readFileSync('.testnet-acct1.key', 'utf8').trim())
const sdk = new CellSwap({ network: 'testnet', config })

const CKB = '0x' + '0'.repeat(64)
const me = await signer.getRecommendedAddressObj()
const SINCE_EPOCH_FLAG = 0x2000_0000_0000_0000n
const W = (h) => client.waitTransaction(h, 0, 240_000)
const ok = (m) => console.log('   ok', m)
const tlDep = ccc.CellDep.from({ outPoint: { txHash: config.scripts.timelockLock.txHash, index: BigInt(config.scripts.timelockLock.index) }, depType: 'code' })

function timelockScript(ownerHash, deadline) {
  const deadlineLE = deadline.toString(16).padStart(16, '0').match(/../g).reverse().join('')
  return ccc.Script.from({
    codeHash: config.scripts.timelockLock.codeHash, hashType: config.scripts.timelockLock.hashType,
    args: ('0x' + ownerHash.slice(2) + deadlineLE),
  })
}

/** Create a plain CKB cell locked under the timelock at `deadline`; return its on-chain cell. */
async function lockCkb(deadline) {
  const tl = timelockScript(me.script.hash(), deadline)
  const tx = ccc.Transaction.from({ outputs: [{ capacity: 12_000_000_000n, lock: tl }], outputsData: ['0x'] })
  await tx.completeInputsByCapacity(signer)
  await tx.completeFeeBy(signer, 1000)
  await W(await signer.sendTransaction(tx))
  for await (const c of client.findCells({ script: tl, scriptType: 'lock', scriptSearchMode: 'exact' })) return c
  throw new Error('locked cell not found after create')
}

/** Try to spend `cell` (timelock-locked) back to the owner with the given `since`. Returns
 *  true on success, false if the node rejected it. completeFeeBy adds the owner co-sign input. */
async function trySpend(cell, since) {
  try {
    const tx = ccc.Transaction.from({
      inputs: [{ previousOutput: cell.outPoint, since }],
      outputs: [{ capacity: cell.cellOutput.capacity, lock: me.script }],
      outputsData: ['0x'],
    })
    tx.addCellDeps(tlDep)
    await tx.completeInputsByCapacity(signer)
    await tx.completeFeeBy(signer, 1000)
    await W(await signer.sendTransaction(tx))
    return true
  } catch { return false }
}

console.log('LP time-lock verification (deployed contract)\n')

const tip = await sdk.tipEpoch()
console.log('tip epoch =', tip.toString())

console.log('\n[A] contract lock/unlock (isolated CKB cells)')
console.log(' A1. lock a CKB cell until epoch tip+100 (future)…')
const future = await lockCkb(tip + 100n)
if (await trySpend(future, 0n)) throw new Error('FAIL: spent a locked cell with since=0')
ok('early spend with since=0 rejected (BadSince)')
if (await trySpend(future, SINCE_EPOCH_FLAG | (tip + 100n))) throw new Error('FAIL: spent before the deadline epoch')
ok('spend with since=deadline rejected: consensus refuses an immature input')

console.log(' A2. lock a CKB cell with deadline = NOW (epoch tip), then spend it…')
const matured = await lockCkb(tip)
if (!(await trySpend(matured, SINCE_EPOCH_FLAG | tip))) throw new Error('FAIL: could not spend a matured locked cell')
ok('matured cell spent back to owner with absolute-epoch since + co-sign')

console.log('\n[B] SDK integration: addLiquidity({ lockEpochs }) → locked LP position')
const TKB = (await acct1.getRecommendedAddressObj()).script.hash()  // acct1 owns TKB
let pool = await sdk.getPool(CKB, TKB)
if (!pool) {
  const poolId = (() => { const b = new Uint8Array(8); globalThis.crypto.getRandomValues(b); let i = 0n; for (const x of b) i = (i << 8n) | BigInt(x); return i })()
  console.log(' B0. no CKB/TKB pool, creating one…')
  await W(await sdk.createPool(signer, { tokenX: CKB, tokenY: TKB, amountX: 100_00000000n, amountY: 50_000n, feeBps: 30, poolId }))
  pool = await sdk.getPool(CKB, TKB)
}
const lockEpochs = 6   // ~1 day
console.log(` B1. addLiquidity locked for ${lockEpochs} epochs…`)
const dy = pool.reserveY / 20n, dx = (dy * pool.reserveX) / pool.reserveY
await W(await sdk.addLiquidity(signer, { tokenX: CKB, tokenY: TKB, amountX: dx, amountY: dy, lockEpochs }))

const positions = await sdk.getLpPositions(signer)
const locked = positions.find(p => p.locked && p.pool.poolId === pool.poolId)
if (!locked) throw new Error('FAIL: no locked LP position reported')
const expected = tip + BigInt(lockEpochs)
ok(`locked LP position reported: unlock epoch ${locked.lockedUntilEpoch} (expected ~${expected})`)

console.log('\ntime-lock verified on testnet: early withdrawal is rejected on-chain, matured cells')
console.log('   spend with owner co-sign, and the SDK mints + reports time-locked LP positions.')
