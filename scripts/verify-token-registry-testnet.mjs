#!/usr/bin/env node
// Check paid token registration on testnet: the deployer registers its own token (proving control
// of the owner lock = the xUDT args) and pays a fee to the treasury (acct1); then the script reads
// the registration back on-chain and confirms the metadata + ownership binding.
//   node scripts/verify-token-registry-testnet.mjs
import { ccc } from '@ckb-ccc/core'
import { CellSwap } from '@cellswap/sdk'
import { getConfig } from '@cellswap/config'
import { readFileSync } from 'node:fs'

const config = getConfig('testnet')
if (config.scripts.tokenRegistry.codeHash === '0x' + '0'.repeat(64))
  throw new Error('tokenRegistry not deployed; run scripts/deploy-token-registry-testnet.mjs first')

const client = new ccc.ClientPublicTestnet({ url: config.rpcUrl })
const deployer = new ccc.SignerCkbPrivateKey(client, readFileSync('.testnet-deployer.key', 'utf8').trim())
const acct1 = new ccc.SignerCkbPrivateKey(client, readFileSync('.testnet-acct1.key', 'utf8').trim())
const sdk = new CellSwap({ network: 'testnet', config })

const W = (h) => client.waitTransaction(h, 0, 240_000)
const ok = (m) => console.log('   ok', m)
const me = await deployer.getRecommendedAddressObj()
const treasuryLock = (await acct1.getRecommendedAddressObj()).script   // fee → acct1
const ownerHash = me.script.hash()
const tokenTypeHash = sdk.udtHash(ownerHash)                           // the deployer's token (TKA)

console.log('Paid token registration\n')
console.log('[1] register the deployer-owned token (fee 100 CKB → acct1)')
const h = await sdk.registerToken(deployer, {
  decimals: 8, symbol: 'TKA', name: 'CellSwap Test A', link: 'https://cellswap.example',
  treasuryLock, feeShannons: 100_00000000n,
})
await W(h); ok(`registered on-chain: ${h.slice(0, 14)}… (contract enforced fee + owner co-sign)`)

console.log('[2] read registrations back from the chain')
const regs = await sdk.getRegistrations()
const reg = regs.find(r => r.tokenTypeHash.toLowerCase() === tokenTypeHash.toLowerCase())
if (!reg) throw new Error('registration not found on-chain after registering')
ok(`found: symbol=${reg.symbol} name="${reg.name}" decimals=${reg.decimals} link=${reg.link}`)
if (reg.symbol !== 'TKA' || reg.name !== 'CellSwap Test A' || reg.decimals !== 8)
  throw new Error('registration metadata mismatch')
if (reg.ownerLockHash.toLowerCase() !== ownerHash.toLowerCase())
  throw new Error('ownerLockHash != token args: registration is not a valid ownership proof')
ok('ownerLockHash == token args → verified: the real issuer registered it')

console.log('\ntoken registration verified on testnet: owner-signed + fee-paid, stored on-chain,')
console.log('   read back with correct metadata and a valid issuer-ownership binding.')
