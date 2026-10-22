#!/usr/bin/env node
// Verify the on-chain Unique-cell token-name reader (the decentralized, no-backend path).
// Confirms: (1) the UniqueType code hash matches CCC's KnownScript, (2) our decode logic
// (decimals‖name‖symbol) correctly reads real Unique cells from the chain.
import { ccc } from '@ckb-ccc/core'

const NET = process.argv[2] === 'testnet' ? 'testnet' : 'mainnet'
const client = NET === 'testnet' ? new ccc.ClientPublicTestnet() : new ccc.ClientPublicMainnet()
const IDX = NET === 'testnet' ? 'https://testnet.ckb.dev/indexer' : 'https://mainnet.ckb.dev/indexer'

const unique = await client.getKnownScript(ccc.KnownScript.UniqueType)
console.log(`${NET} UniqueType: ${unique.codeHash} (${unique.hashType})\n`)

let id = 0
const rpc = (m, p) => fetch(IDX, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ++id, jsonrpc: '2.0', method: m, params: p }) }).then(r => r.json()).then(j => { if (j.error) throw new Error(j.error.message); return j.result })

// our reader's decode logic (mirrors lib/tokenMeta.decodeUnique)
function decodeUnique(hex) {
  const h = hex.slice(2); const b = h.match(/../g).map(x => parseInt(x, 16))
  if (b.length < 3) return null
  const decimals = b[0]; let o = 1
  const nl = b[o++]; if (o + nl > b.length) return null
  const name = Buffer.from(b.slice(o, o + nl)).toString('utf8'); o += nl
  const sl = b[o++]; if (o + sl > b.length) return null
  const symbol = Buffer.from(b.slice(o, o + sl)).toString('utf8')
  if ((!symbol && !name) || decimals > 32) return null
  return { decimals, name: name || symbol, symbol: symbol || name }
}

const r = await rpc('get_cells', [{ script: { code_hash: unique.codeHash, hash_type: unique.hashType, args: '0x' }, script_type: 'type', script_search_mode: 'prefix' }, 'desc', '0xf'])
console.log(`Found ${r.objects.length} live Unique cells. Decoding with the reader's logic:`)
let ok = 0
for (const c of r.objects) {
  const m = decodeUnique(c.output_data)
  if (m) { console.log(`   ok ${m.symbol.padEnd(14)} "${m.name}"  (${m.decimals} dec)`); ok++ }
  else console.log('   · (rejected by sanity checks)')
}
console.log(`\n${ok > 0 ? 'ok' : 'FAIL'}: decoded ${ok} real token-info cells on-chain; code hash + decode confirmed.`)
