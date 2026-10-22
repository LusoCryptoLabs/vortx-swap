#!/usr/bin/env node
// Check a nonzero VTX mint on testnet. Run >= 1 epoch (~4h) after staking LP into the
// mining pool (verify-mining-testnet.mjs leaves no position, so stake manually then wait, or keep
// a position staked). It reads the deployer's mining position, asserts a nonzero pending VTX has
// accrued, claims it (minting exactly `pending` VTX via the emission authority), and checks the
// deployer's VTX balance grew while the staked LP stayed put.
//   node scripts/verify-mining-claim-testnet.mjs
import { ccc } from '@ckb-ccc/core'
import { CellSwap } from '@cellswap/sdk'
import { getConfig } from '@cellswap/config'
import { readFileSync } from 'node:fs'

const CKB = '0x' + '0'.repeat(64)
const config = getConfig('testnet')
const client = new ccc.ClientPublicTestnet({ url: config.rpcUrl })
const deployer = new ccc.SignerCkbPrivateKey(client, readFileSync('.testnet-deployer.key', 'utf8').trim())
const acct2 = new ccc.SignerCkbPrivateKey(client, readFileSync('.testnet-acct2.key', 'utf8').trim())
const sdk = new CellSwap({ network: 'testnet', config })
const W = (h) => client.waitTransaction(h, 0, 240_000)
const ok = (m) => console.log('   ok', m)
const token = (await acct2.getRecommendedAddressObj()).script.hash()
const me = (await deployer.getRecommendedAddressObj()).script
sdk.governanceLockHash = me.hash()   // emissionLockScript needs G (on testnet, G is the deployer lock hash)

const balVtx = async () => {
  let t = 0n
  for await (const c of client.findCells({ script: me, scriptType: 'lock', scriptSearchMode: 'exact', filter: { script: sdk.vtxTypeScript() } })) {
    const d = c.outputData.startsWith('0x') ? c.outputData.slice(2) : c.outputData
    const b = d.slice(0, 32).match(/.{2}/g); if (b) t += BigInt('0x' + b.reverse().join(''))
  }
  return t
}

const pos = await sdk.getMiningPosition(deployer, CKB, token)
if (!pos) throw new Error('no mining position; stake LP via verify-mining-testnet.mjs (or manually) and wait >= 1 epoch')
console.log(`position: amount=${pos.amount} LP, pending=${pos.pending} VTX`)
if (pos.pending <= 0n) throw new Error('no VTX accrued yet; wait at least one full epoch (~4h) after staking, then re-run')

const before = await balVtx()
console.log('[claim] minting the accrued VTX (LP stays staked)')
const h = await sdk.claimMining(deployer, { tokenX: CKB, tokenY: token })
await W(h); ok(`claim settled on-chain: ${h.slice(0, 14)}…`)
const after = await sdk.getMiningPosition(deployer, CKB, token)
if (!after || after.amount !== pos.amount) throw new Error('staked LP changed across a claim (should be unchanged)')
ok(`staked LP unchanged at ${after.amount}; new pending=${after.pending} (reset toward 0)`)
const vtxAfter = await balVtx()
ok(`deployer VTX ${before} -> ${vtxAfter} (minted exactly the accrued pending)`)
if (vtxAfter <= before) throw new Error('VTX balance did not grow')

console.log('\nVTX mint verified on testnet: an epoch-accrued VTX reward was minted,')
console.log('   bounded on-chain to exactly the accrued pending, with the LP left staked.')
