#!/usr/bin/env node
// Demonstrates single-UTXO pool-cell contention.
// Fires N swaps at the same pool concurrently. Each builds a tx consuming the same pool
// info-cell outpoint, so at most one can be accepted per block; the rest are rejected
// (dead/unknown cell). This is the inherent throughput limit of the cell model.
//
// Run after scripts/e2e/run.mjs has created the A/B pool (same chain, no reset needed):
//   NETWORK=devnet DEPLOYER_PRIVATE_KEY=0x6109… CCC_SCRIPTS_JSON=./devnet-ccc-scripts.json \
//     node scripts/e2e/concurrency.mjs

import { ccc } from '@ckb-ccc/core'
import { CellSwap } from '@cellswap/sdk'
import { getConfig } from '@cellswap/config'
import { readFileSync } from 'node:fs'

const NETWORK = process.env.NETWORK ?? 'devnet'
const KEY0 = process.env.DEPLOYER_PRIVATE_KEY
// offckb well-known devnet account #1 (publicly documented, pre-funded, shared by every offckb user).
// Devnet-only: never fund this key on testnet/mainnet, and do not copy this practice for real keys.
const KEY1 = '0x9f315d5a9618a39fdc487c7a67a8581d40b045bd7a42d83648ca80ef3b2cb4a1'  // acct#1 (TOKEN_B owner)
const N = Number(process.env.N ?? 5)

const config = getConfig(NETWORK)
const knownScripts = process.env.CCC_SCRIPTS_JSON ? JSON.parse(readFileSync(process.env.CCC_SCRIPTS_JSON, 'utf8')) : undefined
const client = new ccc.ClientPublicTestnet({ url: config.rpcUrl, ...(knownScripts ? { scripts: knownScripts } : {}) })
const signer = new ccc.SignerCkbPrivateKey(client, KEY0)
const signerB = new ccc.SignerCkbPrivateKey(client, KEY1)
const sdk = new CellSwap({ network: NETWORK, config })

// Token identifiers = the owners' lock hashes (TOKEN_A owned by acct#0, TOKEN_B by acct#1).
const aArgs = ccc.hashCkb((await signer.getRecommendedAddressObj()).script.toBytes())
const bArgs = ccc.hashCkb((await signerB.getRecommendedAddressObj()).script.toBytes())

const pool = await sdk.getPool(aArgs, bArgs)
if (!pool) { console.error('No A/B pool; run scripts/e2e/run.mjs first on this chain.'); process.exit(1) }
console.log(`\n=== Concurrency test: ${N} simultaneous A→B swaps on one pool ===`)
console.log(`Pool cell: ${pool.cell.outPoint.txHash.slice(0,18)}…:${pool.cell.outPoint.index}  reserves ${pool.reserveX}/${pool.reserveY}\n`)

// Fire N swaps at once; they all target the current pool cell.
const results = await Promise.allSettled(
  Array.from({ length: N }, (_, i) =>
    sdk.swap(signer, { tokenIn: aArgs, amountIn: 1_000n + BigInt(i), tokenOut: bArgs, minAmountOut: 1n })),
)

let ok = 0, contended = 0, other = 0
for (const [i, r] of results.entries()) {
  if (r.status === 'fulfilled') { ok++; console.log(`  swap #${i}: accepted  ${r.value.slice(0,18)}…`) }
  else {
    const m = String(r.reason?.message ?? r.reason)
    // All of these arise from N txs racing for the same pool cell: RBF rejection (same
    // input cell), or the others verifying against now-stale state once #0 consumed it.
    const isContention = /dead|unknown|conflict|already|resolve|out of date|not found|spent|RBF|FailedToVerify|Verification failed|ValidationFailure/i.test(m)
    if (isContention) { contended++; console.log(`  swap #${i}: rejected (cell contention)`) }
    else { other++; console.log(`  swap #${i}: unexpected: ${m.slice(0, 90)}`) }
  }
}

console.log(`\n${ok} accepted, ${contended} rejected by contention, ${other} other.`)
console.log(ok <= 1
  ? '→ Confirms the bottleneck: at most one swap per pool per block; the rest must retry.\n'
  : `→ ${ok} landed (some inputs were independent); the pool cell still serializes per block.\n`)
process.exit(0)
