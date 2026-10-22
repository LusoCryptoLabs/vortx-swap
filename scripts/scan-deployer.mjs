#!/usr/bin/env node
// Read-only: derive the testnet deployer address from .testnet-deployer.key and inventory every
// live cell it locks, separating freely spendable capacity from capacity occupied by deployed
// code cells, and flagging code cells not referenced by the current TESTNET_SCRIPTS config
// (orphaned old deploys whose capacity can be reclaimed by consuming them).
import { ccc } from '@ckb-ccc/core'
import { readFileSync } from 'node:fs'

const RPC = 'https://testnet.ckb.dev/rpc'
let pk = readFileSync('.testnet-deployer.key', 'utf8').trim()
if (!pk.startsWith('0x')) pk = '0x' + pk

const client = new ccc.ClientPublicTestnet({ url: RPC })
const signer = new ccc.SignerCkbPrivateKey(client, pk)
const addr = await signer.getRecommendedAddress()
const { script: lock } = await signer.getRecommendedAddressObj()

// txHashes currently referenced by TESTNET_SCRIPTS (so we can tell live vs orphaned code cells)
const cfg = readFileSync('packages/config/src/index.ts', 'utf8')
const referenced = new Set([...cfg.matchAll(/txHash:\s*'(0x[0-9a-fA-F]{64})'/g)].map(m => m[1].toLowerCase()))

const S = 100_000_000n // shannons per CKB
const fmt = n => (Number(n / 10_000n) / 10_000).toLocaleString('en-US') + ' CKB'

const ELF = '7f454c46' // RISC-V ELF magic → a deployed contract binary (code cell)
let total = 0n, free = 0n
const freeCells = [], codeCells = [], tokenCells = [], otherCells = []
for await (const cell of client.findCells({
  script: { codeHash: lock.codeHash, hashType: lock.hashType, args: lock.args },
  scriptType: 'lock', scriptSearchMode: 'exact',
})) {
  const cap = BigInt(cell.cellOutput.capacity)
  total += cap
  const data = cell.outputData || '0x'
  const hasType = !!cell.cellOutput.type
  const bytes = (data.length - 2) / 2
  const rec = { cap, tx: cell.outPoint.txHash.toLowerCase(), idx: Number(cell.outPoint.index), bytes,
                live: referenced.has(cell.outPoint.txHash.toLowerCase()),
                typeCode: cell.cellOutput.type ? cell.cellOutput.type.codeHash : null,
                dataHead: data.slice(0, 34) }
  if (!hasType && bytes === 0) { free += cap; freeCells.push(rec) }
  else if (data.slice(2, 10) === ELF) codeCells.push(rec)          // contract binary
  else if (hasType && bytes === 16) tokenCells.push(rec)           // xUDT u128 amount: a real token balance
  else otherCells.push(rec)                                        // unclassified (don't auto-reclaim)
}

console.log('\n════════════════════════════════════════════════════════════')
console.log('DEPLOYER ADDRESS (testnet, fund this):')
console.log('  ' + addr)
console.log('  lock.args (blake160):', lock.args)
console.log('════════════════════════════════════════════════════════════')
const sum = arr => arr.reduce((s, c) => s + c.cap, 0n)
const nCells = freeCells.length + codeCells.length + tokenCells.length + otherCells.length
console.log('Total held    :', fmt(total), `(${nCells} cells)`)
console.log('Freely spend  :', fmt(free), `(${freeCells.length} plain cells)`)
console.log('Contract bins :', fmt(sum(codeCells)), `(${codeCells.length} ELF code cells)`)
console.log('xUDT balances :', fmt(sum(tokenCells)), `(${tokenCells.length} token cells, do not consume)`)
console.log('Other         :', fmt(sum(otherCells)), `(${otherCells.length} unclassified, leave alone)`)

const orphans = codeCells.filter(c => !c.live)
const reclaimable = sum(orphans)
console.log('\n── Contract code cells (ELF binaries) ──')
for (const c of codeCells.sort((a, b) => Number(b.cap - a.cap))) {
  console.log(`  ${c.live ? 'LIVE   ' : 'ORPHAN '} ${fmt(c.cap).padStart(14)}  ${c.bytes}B  ${c.tx}:${c.idx}`)
}
console.log('\n── Reclaimable = orphaned ELF code cells not referenced by config ──')
console.log('  count:', orphans.length, ' capacity:', fmt(reclaimable))
console.log('\n>>> Self-fundable from (free + reclaimable code orphans):', fmt(free + reclaimable))

// List the ambiguous "other" bucket so nothing is swept blind: consuming a cell a deployed script
// depends on breaks that script.
console.log('\n── "Other" cells: type codeHash + data head (identify before touching) ──')
const byType = new Map()
for (const c of otherCells) byType.set(c.typeCode || 'no-type', (byType.get(c.typeCode || 'no-type') || { n: 0, cap: 0n }))
for (const c of otherCells.sort((a, b) => Number(b.cap - a.cap)).slice(0, 12)) {
  console.log(`  ${fmt(c.cap).padStart(12)}  ${String(c.bytes).padStart(5)}B  type=${(c.typeCode || 'none').slice(0, 18)}  data=${(c.dataHead || '').slice(0, 26)}  ${c.tx.slice(0, 12)}:${c.idx}`)
}
