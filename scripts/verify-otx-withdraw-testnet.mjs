#!/usr/bin/env node
// Check OTX withdrawal end-to-end on testnet: migrate a token into the OTX lock, then
// withdraw it back to the wallet via a self-contained spend (no aggregator, no pool).
// The cellswap-otx-lock verifies the WebAuthn signature + owner-payout on-chain. Uses a
// simulated P-256 passkey (the browser uses JoyID signChallenge instead); the tx building,
// witness placement and contract validation are otherwise identical to lib/joyid.withdrawFromOtx.
import { ccc } from '@ckb-ccc/core'
import { CellSwap, buildOtxLockArgs, computeSwapCommitment, parseJoyIDOtxResponse } from '@cellswap/sdk'
import { getConfig } from '@cellswap/config'
import { readFileSync } from 'node:fs'
import { generateKeyPairSync, createHash, createSign } from 'node:crypto'

const config = getConfig('testnet')
const client = new ccc.ClientPublicTestnet({ url: config.rpcUrl })
const sdk = new CellSwap({ network: 'testnet', config })
const acct1 = new ccc.SignerCkbPrivateKey(client, readFileSync('.testnet-acct1.key', 'utf8').trim())
const me = await acct1.getRecommendedAddressObj()
const TKB = me.script.hash()                         // acct1 is the TKB owner (owner-mode mint)
const xudt = (args) => ccc.Script.from({ codeHash: config.scripts.xudtScript.codeHash, hashType: config.scripts.xudtScript.hashType, args })
const enc = (v) => { const b = new Uint8Array(16); let n = v; for (let i = 0; i < 16; i++) { b[i] = Number(n & 0xffn); n >>= 8n } return '0x' + [...b].map(x => x.toString(16).padStart(2, '0')).join('') }
const W = (h) => client.waitTransaction(h, 0, 200_000)
const ok = (m) => console.log('   ok', m)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function udtBal(script, type) { let a = 0n; for await (const x of client.findCells({ script, scriptType: 'lock', scriptSearchMode: 'exact', filter: { script: type } })) { const d = x.outputData.slice(2); if (d.length >= 32) a += BigInt('0x' + d.slice(0, 32).match(/../g).reverse().join('')) } return a }
async function waitUdt(script, type, min) { for (let i = 0; i < 40; i++) { if (await udtBal(script, type) >= min) return; await sleep(3000) } throw new Error('indexer lag') }

// simulated JoyID (matches scripts/e2e/run.mjs)
function makeSimJoyID() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const pubkeyXY = publicKey.export({ type: 'spki', format: 'der' }).slice(-64)
  return {
    pubkeyHex: Buffer.from(pubkeyXY).toString('hex'),
    sign(commitment) {
      const ad = Buffer.alloc(37)
      createHash('sha256').update(Buffer.from('app.cellswap.io')).digest().copy(ad, 0)
      ad[32] = 0x05; ad.writeUInt32BE(1, 33)
      const cd = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: Buffer.from(commitment).toString('base64url'), origin: 'https://app.cellswap.io', crossOrigin: false }))
      const sigBase = Buffer.concat([ad, createHash('sha256').update(cd).digest()])
      const der = createSign('SHA256').update(sigBase).sign({ key: privateKey, dsaEncoding: 'der' })
      return { pubkey: Buffer.from(pubkeyXY).toString('hex'), challenge: '', message: Buffer.concat([ad, cd]).toString('base64url'), signature: Buffer.from(der).toString('base64url'), alg: -7, keyType: 'main_key' }
    },
  }
}

console.log('OTX withdrawal: migrate TKB → OTX lock, then withdraw it back to the wallet\n')
const joyid = makeSimJoyID()
const lockArgs = await buildOtxLockArgs(joyid.pubkeyHex)
const otxLock = ccc.Script.from({ codeHash: config.scripts.cellswapOtxLock.codeHash, hashType: config.scripts.cellswapOtxLock.hashType, args: lockArgs })
const AMT = 100n

// 1. migrate: acct1 owner-mode mints 100 TKB straight into an OTX-lock cell (155 CKB).
console.log('[1] migrate 100 TKB into the OTX lock')
const migTx = ccc.Transaction.from({ outputs: [{ capacity: 155_00000000n, lock: otxLock, type: xudt(TKB) }], outputsData: [enc(AMT)] })
await migTx.addCellDepsOfKnownScripts(client, ccc.KnownScript.XUdt)
await migTx.completeInputsByCapacity(acct1); await migTx.completeFeeBy(acct1, 1000)
const migHash = await acct1.sendTransaction(migTx); await W(migHash)
for (let i = 0; i < 20 && (await udtBal(otxLock, xudt(TKB))) < AMT; i++) await sleep(3000)
ok(`migrated: OTX lock now holds ${await udtBal(otxLock, xudt(TKB))} TKB`)

// 2. withdraw: collect the OTX cell, sign the intent (token_out = TKB to owner), settle.
console.log('[2] withdraw back to the wallet (self-contained spend)')
const inputs = []
let collected = 0n
for await (const cell of client.findCells({ script: otxLock, scriptType: 'lock', scriptSearchMode: 'exact', filter: { script: xudt(TKB) } })) {
  inputs.push({ previousOutput: { txHash: cell.outPoint.txHash, index: Number(cell.outPoint.index) } })
  const d = cell.outputData.slice(2); if (d.length >= 32) collected += BigInt('0x' + d.slice(0, 32).match(/../g).reverse().join(''))
}
const intent = { firstInputTxHash: inputs[0].previousOutput.txHash, firstInputIndex: inputs[0].previousOutput.index, totalInputAmount: collected, minAmountOut: collected, tokenOut: xudt(TKB).hash(), ownerLockHash: me.script.hash() }
const commitment = await computeSwapCommitment(intent)
const { witness } = await parseJoyIDOtxResponse(joyid.sign(commitment), intent)

const before = await udtBal(me.script, xudt(TKB))
const tx = ccc.Transaction.from({ inputs, outputs: [{ capacity: 144_00000000n, lock: me.script, type: xudt(TKB) }], outputsData: [enc(collected)] })
tx.addCellDeps(ccc.CellDep.from({ outPoint: { txHash: config.scripts.cellswapOtxLock.txHash, index: BigInt(config.scripts.cellswapOtxLock.index) }, depType: 'code' }))
await tx.addCellDepsOfKnownScripts(client, ccc.KnownScript.XUdt)
tx.setWitnessArgsAt(0, ccc.WitnessArgs.from({ lock: witness }))
await tx.completeInputsByCapacity(acct1); await tx.completeFeeBy(acct1, 1000)
const wHash = await acct1.sendTransaction(tx); await W(wHash)
await waitUdt(me.script, xudt(TKB), before + collected)
const after = await udtBal(me.script, xudt(TKB))
if (after - before < collected) throw new Error(`got ${after - before}, expected ${collected}`)
if (await udtBal(otxLock, xudt(TKB)) !== 0n) throw new Error('OTX lock still holds TKB')
ok(`withdrawn: wallet received ${after - before} TKB back; OTX lock emptied (${wHash.slice(0, 14)}…)`)

console.log('\nOTX withdrawal works: funds left the OTX lock back to the wallet, WebAuthn-verified')
console.log('   on-chain, with no aggregator and no pool, so migration is not one-way.')
