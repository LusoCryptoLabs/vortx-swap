#!/usr/bin/env node
// Check the limit-order auto-fill loop end-to-end on testnet.
//   - acct1 places a resting intent-lock order (sell TKB → TKC) via swapAsync.
//   - The keeper (deployer) calls sdk.settleIntent(outpoint, ownerLock), the same call the
//     aggregator fill loop makes, and the intent-lock validates on-chain that acct1 is paid.
//   - Asserts: (a) an unfillable order (minOut too high) is rejected as NOT_FILLABLE (it
//     rests, the keeper can't overpay), and (b) a fillable order settles and acct1 receives
//     >= minOut of TKC, with the intent cell consumed.
// Needs a direct TKB/TKC xUDT/xUDT pool (created here if absent).
import { ccc } from '@ckb-ccc/core'
import { CellSwap } from '@cellswap/sdk'
import { getConfig } from '@cellswap/config'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const config = getConfig('testnet')
const client = new ccc.ClientPublicTestnet({ url: config.rpcUrl })
const sdk = new CellSwap({ network: 'testnet', config })
const key = (f) => new ccc.SignerCkbPrivateKey(client, readFileSync(f, 'utf8').trim())
const deployer = key('.testnet-deployer.key')   // keeper / solver + pool creator
const acct1 = key('.testnet-acct1.key')          // TKB owner + order owner
if (!existsSync('.testnet-acct2.key')) { const b = new Uint8Array(32); globalThis.crypto.getRandomValues(b); writeFileSync('.testnet-acct2.key', '0x' + Buffer.from(b).toString('hex') + '\n') }
const acct2 = key('.testnet-acct2.key')          // TKC owner

const enc = (v) => { const b = new Uint8Array(16); let n = v; for (let i = 0; i < 16; i++) { b[i] = Number(n & 0xffn); n >>= 8n } return '0x' + [...b].map(x => x.toString(16).padStart(2, '0')).join('') }
const W = (h) => client.waitTransaction(h, 0, 200_000)
const ok = (m) => console.log('   ok', m)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const xudt = (args) => ccc.Script.from({ codeHash: config.scripts.xudtScript.codeHash, hashType: config.scripts.xudtScript.hashType, args })
async function udtBal(script, type) { let a = 0n; for await (const x of client.findCells({ script, scriptType: 'lock', scriptSearchMode: 'exact', filter: { script: type } })) { const d = x.outputData.slice(2); if (d.length >= 32) a += BigInt('0x' + d.slice(0, 32).match(/../g).reverse().join('')) } return a }
async function ckbBal(script) { let c = 0n; for await (const x of client.findCellsByLock(script)) if (!x.cellOutput.type) c += x.cellOutput.capacity; return c }
async function waitUdt(script, type, min) { for (let i = 0; i < 40; i++) { if (await udtBal(script, type) >= min) return; await sleep(3000) } throw new Error('indexer lag timeout (udt)') }
async function waitCkb(script, min) { for (let i = 0; i < 40; i++) { if (await ckbBal(script) >= min) return; await sleep(3000) } throw new Error('indexer lag timeout (ckb)') }
function rid() { const b = new Uint8Array(8); globalThis.crypto.getRandomValues(b); let id = 0n; for (const x of b) id = (id << 8n) | BigInt(x); return id }

const dep = await deployer.getRecommendedAddressObj()
const a1 = await acct1.getRecommendedAddressObj()
const a2 = await acct2.getRecommendedAddressObj()
const TKB = a1.script.hash()   // xUDT args = owner lock hash
const TKC = a2.script.hash()

console.log('Limit-order auto-fill: acct1 sells TKB → TKC, keeper (deployer) settles\n')

// 1. Make sure the parties hold what they need.
console.log('[1] fund + provision tokens')
if (await ckbBal(a1.script) < 800_00000000n) {
  const tx = ccc.Transaction.from({ outputs: [{ capacity: 1200_00000000n, lock: a1.script }] })
  await tx.completeInputsByCapacity(deployer); await tx.completeFeeBy(deployer, 1000)
  await W(await deployer.sendTransaction(tx)); await waitCkb(a1.script, 800_00000000n)
}
if (await ckbBal(a2.script) < 500_00000000n) {
  const tx = ccc.Transaction.from({ outputs: [{ capacity: 800_00000000n, lock: a2.script }] })
  await tx.completeInputsByCapacity(deployer); await tx.completeFeeBy(deployer, 1000)
  await W(await deployer.sendTransaction(tx)); await waitCkb(a2.script, 500_00000000n)
}
// acct2 issues TKC (owner-mode mint) to itself, then seeds deployer + the pool.
if (await udtBal(a2.script, xudt(TKC)) < 1_000_000n && await udtBal(dep.script, xudt(TKC)) < 300_000n) {
  const tx = ccc.Transaction.from({ outputs: [{ capacity: 200_00000000n, lock: a2.script, type: xudt(TKC) }], outputsData: [enc(5_000_000n)] })
  await tx.addCellDepsOfKnownScripts(client, ccc.KnownScript.XUdt)
  await tx.completeInputsByCapacity(acct2); await tx.completeFeeBy(acct2, 1000)
  await W(await acct2.sendTransaction(tx)); await waitUdt(a2.script, xudt(TKC), 1_000_000n)
}
// deployer needs TKC to create the direct TKB/TKC pool (it already holds TKB).
if (await udtBal(dep.script, xudt(TKC)) < 300_000n) {
  const amt = 400_000n
  const tx = ccc.Transaction.from({ outputs: [{ capacity: 144_00000000n, lock: dep.script, type: xudt(TKC) }], outputsData: [enc(amt)] })
  await tx.addCellDepsOfKnownScripts(client, ccc.KnownScript.XUdt)
  await tx.completeInputsByCapacity(acct2); await tx.completeFeeBy(acct2, 1000)
  await W(await acct2.sendTransaction(tx)); await waitUdt(dep.script, xudt(TKC), 300_000n)
}
// acct1 needs TKB to sell. acct1 is the TKB owner → mint to itself if short.
if (await udtBal(a1.script, xudt(TKB)) < 50_000n) {
  const tx = ccc.Transaction.from({ outputs: [{ capacity: 144_00000000n, lock: a1.script, type: xudt(TKB) }], outputsData: [enc(500_000n)] })
  await tx.addCellDepsOfKnownScripts(client, ccc.KnownScript.XUdt)
  await tx.completeInputsByCapacity(acct1); await tx.completeFeeBy(acct1, 1000)
  await W(await acct1.sendTransaction(tx)); await waitUdt(a1.script, xudt(TKB), 50_000n)
}
ok('parties provisioned (acct1: TKB+CKB, acct2: TKC, deployer: TKB+TKC)')

// 2. Ensure a direct TKB/TKC xUDT/xUDT pool exists.
console.log('[2] ensure direct TKB/TKC pool')
if (!(await sdk.getPool(TKB, TKC))) {
  const h = await sdk.createPool(deployer, { tokenX: TKB, tokenY: TKC, amountX: 200_000n, amountY: 200_000n, feeBps: 30, poolId: rid() })
  await W(h)
  for (let i = 0; i < 20 && !(await sdk.getPool(TKB, TKC)); i++) await sleep(3000)
}
const pool = await sdk.getPool(TKB, TKC)
if (!pool) throw new Error('TKB/TKC pool not live')
if (pool.poolMode !== 'XUDT_XUDT') throw new Error('expected an xUDT/xUDT pool')
ok(`direct TKB/TKC pool live (reserves ${pool.reserveX} / ${pool.reserveY})`)

// 3. Quote the sell so we can set a fillable vs un-fillable limit.
const amountIn = 5_000n
const q = await sdk.quoteSwap(TKB, amountIn, TKC, 0.02)
console.log(`[3] quote: ${amountIn} TKB → ~${q.amountOut} TKC at market`)

// 3a. Unfillable order: minOut far above market → keeper must reject as NOT_FILLABLE.
console.log('[3a] place an unfillable order (minOut 100× market) → expect NOT_FILLABLE')
const tooHigh = q.amountOut * 100n
const hHigh = await sdk.swapAsync(acct1, { tokenIn: TKB, amountIn, tokenOut: TKC, minAmountOut: tooHigh })
await W(hHigh)
const opHigh = { txHash: hHigh, index: 0 }
for (let i = 0; i < 20 && !(await client.getCellLive({ txHash: hHigh, index: 0n }, false)); i++) await sleep(3000)
let rejected = false
try { await sdk.settleIntent(deployer, opHigh, a1.script) }
catch (e) { rejected = e.message === 'NOT_FILLABLE'; if (!rejected) throw e }
if (!rejected) throw new Error('keeper wrongly settled an un-fillable order')
ok('un-fillable order correctly left resting (NOT_FILLABLE)')
// clean it up so it does not linger
await W(await sdk.cancelIntent(acct1, { outPoint: opHigh, output: (await client.getCellLive({ txHash: hHigh, index: 0n }, true)).cellOutput, data: (await client.getCellLive({ txHash: hHigh, index: 0n }, true)).outputData }))
ok('un-fillable order cancelled')

// 3b. Fillable order: minOut just below market → keeper settles, acct1 gets paid.
console.log('[3b] place a fillable order (minOut 95% of market) → keeper settles')
const minOut = (q.amountOut * 95n) / 100n
const hFill = await sdk.swapAsync(acct1, { tokenIn: TKB, amountIn, tokenOut: TKC, minAmountOut: minOut })
await W(hFill)
const opFill = { txHash: hFill, index: 0 }
for (let i = 0; i < 20 && !(await client.getCellLive({ txHash: hFill, index: 0n }, false)); i++) await sleep(3000)
ok(`order resting at outpoint ${hFill.slice(0, 12)}…:0 (minOut ${minOut} TKC)`)

const before = await udtBal(a1.script, xudt(TKC))
console.log('[4] keeper settles the resting order (sdk.settleIntent, what the fill loop calls)')
const { txHash, amountOut } = await sdk.settleIntent(deployer, opFill, a1.script)
await W(txHash)
if (amountOut < minOut) throw new Error(`paid ${amountOut} < minOut ${minOut}`)
await waitUdt(a1.script, xudt(TKC), before + minOut)
const after = await udtBal(a1.script, xudt(TKC))
if (after - before < minOut) throw new Error(`acct1 received ${after - before} < minOut ${minOut}`)
// intent cell must be consumed
const stillLive = await client.getCellLive({ txHash: hFill, index: 0n }, false)
if (stillLive) throw new Error('intent cell still live after settlement')
ok(`settled → acct1 received ${after - before} TKC (>= minOut ${minOut}); intent cell consumed (${txHash.slice(0, 14)}…)`)

console.log('\nLimit-order auto-fill works: resting order settled by the keeper, owner paid on-chain,')
console.log('   unfillable orders rejected (NOT_FILLABLE). This is what the')
console.log('   aggregator fill loop runs each tick.')
