#!/usr/bin/env node
// Check the paid token registration: acct2 registers its own token, and the tx pays the configured
// platform fee (5,000 CKB) to the platform treasury lock. Verifies by re-reading the committed tx's
// outputs for a cell of exactly feeShannons locked by config.registry.treasury.
//   node scripts/verify-registry-fee-testnet.mjs
import { ccc } from '@ckb-ccc/core'
import { CellSwap } from '@cellswap/sdk'
import { getConfig } from '@cellswap/config'
import { readFileSync } from 'node:fs'

const config = getConfig('testnet')
const client = new ccc.ClientPublicTestnet({ url: config.rpcUrl })
const acct2 = new ccc.SignerCkbPrivateKey(client, readFileSync('.testnet-acct2.key', 'utf8').trim())
const sdk = new CellSwap({ network: 'testnet', config })
const W = (h) => client.waitTransaction(h, 0, 240_000)
const ok = (m) => console.log('   ok', m)

const reg = config.registry
if (!reg) throw new Error('config.registry not set')
const treasuryHash = ccc.Script.from(reg.treasury).hash()
const me = (await acct2.getRecommendedAddressObj()).script
const token = me.hash() // acct2's xUDT identity = its own lock hash

console.log(`Paid registration: fee=${Number(reg.feeShannons) / 1e8} CKB → treasury ${treasuryHash.slice(0, 14)}…\n`)

const before = (await sdk.getRegistrations()).find(r => r.tokenTypeHash.toLowerCase() === sdk.udtHash(token).toLowerCase())
if (before) { console.log('acct2 token already registered; does an update still pay the fee? (create-only fee). Proceeding to verify fee output.') }

console.log('[1] registerToken (acct2 registers its own token and pays the platform fee)')
const h = await sdk.registerToken(acct2, { decimals: 8, symbol: 'TKB', name: 'Test Token B', link: 'https://vortx.example' })
await W(h); ok(`registered: ${h.slice(0, 14)}…`)

console.log('[2] inspect the committed tx outputs for the fee → treasury')
const tx = await client.getTransaction(h)
const outs = tx.transaction.outputs
let found = null
for (const o of outs) {
  if (o.lock.hash().toLowerCase() === treasuryHash.toLowerCase() && o.capacity === reg.feeShannons) { found = o; break }
}
if (!found) throw new Error(`no ${Number(reg.feeShannons) / 1e8}-CKB output to the treasury lock found in ${h}`)
ok(`fee output present: ${Number(found.capacity) / 1e8} CKB → treasury lock ${treasuryHash.slice(0, 14)}…`)

console.log('[3] registration is discoverable + self-consistent (badge-valid)')
const after = (await sdk.getRegistrations()).find(r => r.tokenTypeHash.toLowerCase() === sdk.udtHash(token).toLowerCase())
if (!after) throw new Error('registration not found after register')
if (after.ownerLockHash.toLowerCase() !== me.hash().toLowerCase()) throw new Error('registration ownerLockHash mismatch')
ok(`registered: ${after.symbol} (${after.name}), owner-consistent, badge valid`)

console.log('\npaid token registration verified on testnet: the 5,000 CKB platform fee landed at the')
console.log('   treasury lock, and the registration is discoverable + badge-valid.')
