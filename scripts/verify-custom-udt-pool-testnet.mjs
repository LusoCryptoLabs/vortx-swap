#!/usr/bin/env node
// On-chain check of the non-standard UDT pool path.
//
// The SDK supports tokens whose UDT type script is not the configured standard xUDT (USDI, RUSD,
// ccBTC): registerUdt(args, codeHash, hashType, dep) records the token's own code-cell dep, and
// addCustomUdtDeps() attaches it to every built tx (swap / create / add / remove / OTX / stake /
// mine). verify-custom-udt.mjs only checks the type hash offline; this script creates and swaps a
// custom-UDT pool on-chain.
//
// It uses `always-success` as the custom token's type script. Its code hash differs from the
// standard xUDT, so it exercises the custom-code-hash and custom-dep path. It does not model a token
// with freeze, blacklist or rebase rules; that behavior is outside the dep wiring checked here. A
// swap that moves the custom token can only settle if its code cell was attached as a cellDep;
// otherwise CKB-VM cannot resolve the type script and the tx fails verification. So a settled swap
// shows the dep wiring works on-chain.
import { ccc } from '@ckb-ccc/core'
import { CellSwap } from '@cellswap/sdk'
import { getConfig } from '@cellswap/config'
import { readFileSync } from 'node:fs'

const config = getConfig('testnet')
const client = new ccc.ClientPublicTestnet({ url: config.rpcUrl })
const signer = new ccc.SignerCkbPrivateKey(client, readFileSync('.testnet-deployer.key', 'utf8').trim())
const sdk = new CellSwap({ network: 'testnet', config })

const CKB = '0x' + '0'.repeat(64)
const me = await signer.getRecommendedAddressObj()
const ok = (m) => console.log('   ok', m)
const W = (h) => client.waitTransaction(h, 0, 220_000)

const encodeU128LE = (n) => '0x' + n.toString(16).padStart(32, '0').match(/../g).reverse().join('')
async function udtBal(lock, type) {
  let amt = 0n
  for await (const c of client.findCells({ script: lock, scriptType: 'lock', scriptSearchMode: 'exact', filter: { script: type } })) {
    const d = c.outputData.slice(2); if (d.length >= 32) amt += BigInt('0x' + d.slice(0, 32).match(/../g).reverse().join(''))
  }
  return amt
}
function randomHex(bytes) {
  const b = new Uint8Array(bytes); globalThis.crypto.getRandomValues(b)
  return '0x' + [...b].map(x => x.toString(16).padStart(2, '0')).join('')
}
function randomPoolId() {
  const b = new Uint8Array(8); globalThis.crypto.getRandomValues(b)
  let id = 0n; for (const x of b) id = (id << 8n) | BigInt(x); return id
}

console.log('Custom (non-standard) UDT pool verification on testnet\n')
const bal = await client.getBalance([me.script])
console.log('   deployer lock:', me.script.hash().slice(0, 18) + '…', 'free CKB =', (bal / 100000000n).toString())

// ---- A fresh custom token: type = always-success (non-xUDT code hash), unique args per run -------
const as = config.scripts.alwaysSuccess
const CUSTOM_ARGS = randomHex(8)                 // always-success ignores args; unique => fresh pair
sdk.registerUdt(CUSTOM_ARGS, as.codeHash, as.hashType, { txHash: as.txHash, index: as.index })
const customType = sdk.udtScript(CUSTOM_ARGS)
const customHash = sdk.udtHash(CUSTOM_ARGS)
const asDep = ccc.CellDep.from({ outPoint: { txHash: as.txHash, index: BigInt(as.index) }, depType: 'code' })
console.log('   custom token: code', as.codeHash.slice(0, 14) + '… (not standard xUDT', config.scripts.xudtScript.codeHash.slice(0, 10) + '…)')
console.log('   custom type hash:', customHash.slice(0, 18) + '…\n')

// ---- [1] Mint the custom token (always-success type validates any output) -----------------------
const MINT = 1_000_000n
console.log('[1] mint', MINT.toString(), 'custom token to deployer')
const mintTx = ccc.Transaction.from({
  outputs: [{ lock: me.script, type: customType, capacity: 150_00000000n }],
  outputsData: [encodeU128LE(MINT)],
})
mintTx.addCellDeps(asDep)                          // the type script must resolve at mint time too
await mintTx.completeInputsByCapacity(signer)
await mintTx.completeFeeBy(signer)
const hMint = await signer.sendTransaction(mintTx)
await W(hMint)
const minted = await udtBal(me.script, customType)
if (minted < MINT) throw new Error(`mint failed: balance ${minted} < ${MINT}`)
ok(`minted: balance=${minted} (${hMint.slice(0, 14)}…)`)

// ---- [2] createPool CKB / custom (CKB-native; uses the custom-UDT dep on the reserve output) -----
const poolId = randomPoolId()
console.log('\n[2] createPool CKB / custom  poolId =', poolId.toString())
const hCreate = await sdk.createPool(signer, { tokenX: CKB, tokenY: CUSTOM_ARGS, amountX: 300_00000000n, amountY: 200_000n, feeBps: 30, poolId })
await W(hCreate)
let pool = await sdk.getPool(CKB, CUSTOM_ARGS)
if (!pool) throw new Error('pool not discoverable after create')
ok(`created: reserveCKB=${pool.reserveX} reserveCustom=${pool.reserveY} mode=${pool.poolMode} (${hCreate.slice(0, 14)}…)`)

// ---- [3] swap CKB -> custom (custom token is an output: dep inferred + attached) -----------------
console.log('\n[3] swap 30 CKB -> custom')
const before3 = await udtBal(me.script, customType)
const hSwap1 = await sdk.swap(signer, { tokenIn: CKB, amountIn: 30_00000000n, tokenOut: CUSTOM_ARGS, minAmountOut: 1n, slippage: 0.05 })
await W(hSwap1)
const after3 = await udtBal(me.script, customType)
if (after3 <= before3) throw new Error('did not receive custom token from swap')
pool = await sdk.getPool(CKB, CUSTOM_ARGS)
ok(`swapped: received ${after3 - before3} custom; reserveCKB=${pool.reserveX} reserveCustom=${pool.reserveY} (${hSwap1.slice(0, 14)}…)`)

// ---- [4] swap custom -> CKB (custom token is an input; pool reserve output still carries it) -----
console.log('\n[4] swap 10,000 custom -> CKB')
const hSwap2 = await sdk.swap(signer, { tokenIn: CUSTOM_ARGS, amountIn: 10_000n, tokenOut: CKB, minAmountOut: 0n, slippage: 0.05 })
await W(hSwap2)
pool = await sdk.getPool(CKB, CUSTOM_ARGS)
ok(`swapped back: reserveCKB=${pool.reserveX} reserveCustom=${pool.reserveY} (${hSwap2.slice(0, 14)}…)`)

console.log('\nNon-standard UDT pool create + both-direction swaps settled on testnet.')
console.log('   The always-success code cell resolved as a cellDep on every tx (else the type script')
console.log('   would not load and these txs would fail verification), so the custom-UDT dep wiring works.')
console.log('\n   txs:', { mint: hMint, create: hCreate, swapInto: hSwap1, swapBack: hSwap2 })
