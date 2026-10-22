#!/usr/bin/env node
// Pre-check for the VTX genesis: create a Spore/Omiga "Unique cell" (the token-info cell JoyID,
// CKB Explorer and other DEXes read for decimals|name|symbol) on testnet. Creates one throwaway
// Unique cell with the deployer key, confirms the UniqueType contract accepts the args derivation
// (type-id[0:20]) and data layout, then reads it back and decodes it.
//   node scripts/verify-unique-cell-testnet.mjs
import { ccc } from '@ckb-ccc/core'
import { getConfig } from '@cellswap/config'
import { readFileSync } from 'node:fs'

const config = getConfig('testnet')
const client = new ccc.ClientPublicTestnet({ url: config.rpcUrl })
const deployer = new ccc.SignerCkbPrivateKey(client, readFileSync('.testnet-deployer.key', 'utf8').trim())
const me = (await deployer.getRecommendedAddressObj()).script
const W = (h) => client.waitTransaction(h, 0, 240_000)
const ok = (m) => console.log('   ok', m)

// Throwaway token-info (clearly a test, not VTX); checks the recipe only.
const info = { decimals: 8, name: 'Recipe Test', symbol: 'RTST' }

// data = decimals(1) || name_len(1) || name || symbol_len(1) || symbol   (matches lib/tokenMeta.decodeUnique)
const enc = (s) => [...Buffer.from(s, 'utf8')]
const nm = enc(info.name), sy = enc(info.symbol)
const data = '0x' + [info.decimals & 0xff, nm.length & 0xff, ...nm, sy.length & 0xff, ...sy]
  .map((b) => b.toString(16).padStart(2, '0')).join('')

const unique = await client.getKnownScript(ccc.KnownScript.UniqueType)
console.log(`UniqueType: ${unique.codeHash} (${unique.hashType}), ${unique.cellDeps.length} cellDep(s)`)

// Build with placeholder args; the real Unique args = type-id over (first input, this output's index),
// which we can only compute after completeInputsByCapacity fixes the inputs.
const tx = ccc.Transaction.from({
  outputs: [{ capacity: 14_400_000_000n, lock: me, type: { codeHash: unique.codeHash, hashType: unique.hashType, args: '0x' + '00'.repeat(20) } }],
  outputsData: [data],
})
await tx.addCellDepInfos(client, unique.cellDeps)   // wire the UniqueType code so its type script can run
await tx.completeInputsByCapacity(deployer)

const typeId = ccc.hashTypeId(tx.inputs[0], 0)       // 32-byte type-id over inputs[0] + output index 0
const uniqueArgs = '0x' + typeId.slice(2, 42)        // Unique args = first 20 bytes
tx.outputs[0].type = ccc.Script.from({ codeHash: unique.codeHash, hashType: unique.hashType, args: uniqueArgs })
console.log(`computed Unique args (type-id[0:20]): ${uniqueArgs}`)

await tx.completeFeeBy(deployer, 1000)
const hash = await deployer.sendTransaction(tx)
console.log(`submitted: ${hash}`)
await W(hash)
ok(`Unique cell confirmed on testnet: contract accepted the derivation. tx ${hash}`)

// Read it back from chain and decode with the same logic the app and wallets use.
function decodeUnique(hex) {
  const h = hex.slice(2); const b = h.match(/../g).map((x) => parseInt(x, 16))
  if (b.length < 3) return null
  const decimals = b[0]; let o = 1
  const nl = b[o++]; if (o + nl > b.length) return null
  const name = Buffer.from(b.slice(o, o + nl)).toString('utf8'); o += nl
  const sl = b[o++]; if (o + sl > b.length) return null
  const symbol = Buffer.from(b.slice(o, o + sl)).toString('utf8')
  if ((!symbol && !name) || decimals > 32) return null
  return { decimals, name, symbol }
}
let found = null
for await (const c of client.findCells({ script: { codeHash: unique.codeHash, hashType: unique.hashType, args: uniqueArgs }, scriptType: 'type', scriptSearchMode: 'exact' })) {
  found = decodeUnique(c.outputData); break
}
if (!found) throw new Error('created the cell but could not read it back')
ok(`decoded back: symbol="${found.symbol}" name="${found.name}" decimals=${found.decimals}`)
console.log(found.symbol === info.symbol && found.name === info.name && found.decimals === info.decimals
  ? '\nRecipe works: Unique-cell create + read round-trips. Safe to build the VTX genesis on this.'
  : '\nFAIL: round-trip mismatch; investigate before genesis.')
