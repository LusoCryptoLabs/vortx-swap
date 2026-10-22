#!/usr/bin/env node
// Check multi-hop execution: a swap with no direct pool routes through CKB in one atomic tx.
// Setup: a 3rd token TKC (new owner acct2) + a CKB/TKC pool. Then deployer (holds TKB) swaps
// TKB → TKC, which has no direct pool → must route TKB → CKB → TKC.
import { ccc } from '@ckb-ccc/core'
import { CellSwap } from '@cellswap/sdk'
import { getConfig } from '@cellswap/config'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const config = getConfig('testnet')
const client = new ccc.ClientPublicTestnet({ url: config.rpcUrl })
const sdk = new CellSwap({ network: 'testnet', config })
const key = (f) => new ccc.SignerCkbPrivateKey(client, readFileSync(f, 'utf8').trim())
const deployer = key('.testnet-deployer.key')
const acct1 = key('.testnet-acct1.key')

// acct2: a fresh owner so TKC is a distinct xUDT identity
if (!existsSync('.testnet-acct2.key')) {
  const b = new Uint8Array(32); globalThis.crypto.getRandomValues(b)
  writeFileSync('.testnet-acct2.key', '0x' + Buffer.from(b).toString('hex') + '\n')
}
const acct2 = key('.testnet-acct2.key')

const CKB = '0x' + '0'.repeat(64)
const enc = (v) => { const b = new Uint8Array(16); let n = v; for (let i = 0; i < 16; i++) { b[i] = Number(n & 0xffn); n >>= 8n } return '0x' + [...b].map(x => x.toString(16).padStart(2, '0')).join('') }
const W = (h) => client.waitTransaction(h, 0, 200_000)
const ok = (m) => console.log('   ok', m)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const xudt = (args) => ccc.Script.from({ codeHash: config.scripts.xudtScript.codeHash, hashType: config.scripts.xudtScript.hashType, args })
async function udtBal(script, type) { let a = 0n; for await (const x of client.findCells({ script, scriptType: 'lock', scriptSearchMode: 'exact', filter: { script: type } })) { const d = x.outputData.slice(2); if (d.length >= 32) a += BigInt('0x' + d.slice(0, 32).match(/../g).reverse().join('')) } return a }
async function ckbBal(script) { let c = 0n; for await (const x of client.findCellsByLock(script)) if (!x.cellOutput.type) c += x.cellOutput.capacity; return c }
async function waitUdt(script, type, min) { for (let i = 0; i < 40; i++) { if (await udtBal(script, type) >= min) return; await sleep(3000) } throw new Error('indexer lag timeout') }
async function waitCkb(script, min) { for (let i = 0; i < 40; i++) { if (await ckbBal(script) >= min) return; await sleep(3000) } throw new Error('indexer lag timeout (ckb)') }

const me = await deployer.getRecommendedAddressObj()
const a2 = await acct2.getRecommendedAddressObj()
const TKB = (await acct1.getRecommendedAddressObj()).script.hash()
const TKC = a2.script.hash()
function rid() { const b = new Uint8Array(8); globalThis.crypto.getRandomValues(b); let id = 0n; for (const x of b) id = (id << 8n) | BigInt(x); return id }

console.log('Multi-hop routing: TKB → CKB → TKC (no direct TKB/TKC pool)\n')

// 1. fund acct2 + issue TKC
console.log('[1] fund acct2 + issue TKC')
if (await ckbBal(a2.script) < 1500_00000000n) {
  const tx = ccc.Transaction.from({ outputs: [{ capacity: 2000_00000000n, lock: a2.script }] })
  await tx.completeInputsByCapacity(deployer); await tx.completeFeeBy(deployer, 1000)
  await W(await deployer.sendTransaction(tx)); await waitCkb(a2.script, 1500_00000000n)
}
ok('acct2 funded')
if (await udtBal(a2.script, xudt(TKC)) < 100_000n) {
  const tx = ccc.Transaction.from({ outputs: [{ capacity: 144_00000000n, lock: a2.script, type: xudt(TKC) }], outputsData: [enc(1_000_000n)] })
  await tx.addCellDepsOfKnownScripts(client, ccc.KnownScript.XUdt)
  await tx.completeInputsByCapacity(acct2); await tx.completeFeeBy(acct2, 1000)
  await W(await acct2.sendTransaction(tx)); await waitUdt(a2.script, xudt(TKC), 100_000n)
}
ok('TKC issued')

// 2. acct2 creates a CKB/TKC pool (gives TKC a CKB market), unless one already exists
console.log('[2] create CKB/TKC pool')
if (!(await sdk.getPool(CKB, TKC))) {
  const h = await sdk.createPool(acct2, { tokenX: CKB, tokenY: TKC, amountX: 200_00000000n, amountY: 50_000n, feeBps: 30, poolId: rid() })
  await W(h)
  for (let i = 0; i < 20 && !(await sdk.getPool(CKB, TKC)); i++) await sleep(3000)
}
ok('CKB/TKC pool live')

// sanity: there must be no direct TKB/TKC pool, but both have CKB pools
if (await sdk.getPool(TKB, TKC)) throw new Error('unexpected direct TKB/TKC pool exists; test invalid')
if (!(await sdk.getPool(CKB, TKB)) || !(await sdk.getPool(CKB, TKC))) throw new Error('missing CKB legs')
ok('confirmed: no direct TKB/TKC pool; both have CKB pools')

// 3. deployer swaps TKB → TKC (routes via CKB)
console.log('[3] swap TKB → TKC (auto-routed via CKB)')
await waitUdt(me.script, xudt(TKB), 5_000n)
const before = await udtBal(me.script, xudt(TKC))
const q = await sdk.quoteSwap(TKB, 5_000n, TKC, 0.02)
console.log('   quote hops:', q.route.hops, 'amountOut:', q.amountOut.toString(), 'path:', q.route.path.map(p => p === CKB ? 'CKB' : p.slice(0, 8)).join(' → '))
const h = await sdk.swap(deployer, { tokenIn: TKB, amountIn: 5_000n, tokenOut: TKC, minAmountOut: 1n })
await W(h)
await waitUdt(me.script, xudt(TKC), before + 1n)
const after = await udtBal(me.script, xudt(TKC))
if (after <= before) throw new Error('did not receive TKC')
ok(`routed swap settled: received ${after - before} TKC in one tx (${h.slice(0, 14)}…)`)
console.log('\nMulti-hop routing works: TKB → CKB → TKC executed atomically, no direct pool needed.')
