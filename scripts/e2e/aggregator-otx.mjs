#!/usr/bin/env node
// Drive the running aggregator: build a signed OTX payload, POST it to /otx,
// and confirm the aggregator settles it on-chain (owner receives tokenOut).
// Requires: the aggregator running (NETWORK=devnet SOLVER_PRIVATE_KEY=… CCC_SCRIPTS_JSON=… node packages/aggregator/dist/main.js)
// and the A/B pool already created (scripts/e2e/run.mjs) on the same chain.

import { ccc } from '@ckb-ccc/core'
import { CellSwap, computeSwapCommitment, parseJoyIDOtxResponse, buildOtxLockArgs } from '@cellswap/sdk'
import { getConfig } from '@cellswap/config'
import { readFileSync } from 'node:fs'
import { createHash, createSign, generateKeyPairSync } from 'node:crypto'

const NETWORK = 'devnet'
const KEY0 = process.env.DEPLOYER_PRIVATE_KEY
// offckb well-known devnet account #1 (publicly documented, pre-funded, shared by every offckb user).
// Devnet-only: never fund this key on testnet/mainnet, and do not copy this practice for real keys.
const KEY1 = '0x9f315d5a9618a39fdc487c7a67a8581d40b045bd7a42d83648ca80ef3b2cb4a1'
const OTX_PORT = process.env.OTX_PORT ?? '3002'
const config = getConfig(NETWORK)
const knownScripts = JSON.parse(readFileSync(process.env.CCC_SCRIPTS_JSON, 'utf8'))
const client = new ccc.ClientPublicTestnet({ url: config.rpcUrl, scripts: knownScripts })
const signer = new ccc.SignerCkbPrivateKey(client, KEY0)
const signerB = new ccc.SignerCkbPrivateKey(client, KEY1)
const sdk = new CellSwap({ network: NETWORK, config })
const u128le = (v) => { const b = new Uint8Array(16); let n = v; for (let i=0;i<16;i++){b[i]=Number(n&0xffn);n>>=8n} return '0x'+Array.from(b).map(x=>x.toString(16).padStart(2,'0')).join('') }

function makeSimulatedJoyID() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const pubkeyXY = publicKey.export({ type: 'spki', format: 'der' }).slice(-64)
  return { pubkeyHex: Buffer.from(pubkeyXY).toString('hex'), sign(c) {
    const ad = Buffer.alloc(37); createHash('sha256').update(Buffer.from('app.cellswap.io')).digest().copy(ad,0); ad[32]=0x05; ad.writeUInt32BE(1,33)
    const cd = Buffer.from(JSON.stringify({ type:'webauthn.get', challenge: Buffer.from(c).toString('base64url'), origin:'https://app.cellswap.io', crossOrigin:false }))
    const der = createSign('SHA256').update(Buffer.concat([ad, createHash('sha256').update(cd).digest()])).sign({ key: privateKey, dsaEncoding:'der' })
    return { pubkey: Buffer.from(pubkeyXY).toString('hex'), challenge:'', message: Buffer.concat([ad,cd]).toString('base64url'), signature: Buffer.from(der).toString('base64url'), alg:-7, keyType:'main_key' }
  } }
}
async function getUdt(lock, type) {
  let t = 0n
  for await (const c of client.findCells({ script: lock, scriptType:'lock', scriptSearchMode:'exact', filter:{ script:type } })) {
    const d = c.outputData.slice(2); t += BigInt('0x'+(d.slice(0,32).match(/../g).reverse().join('')))
  }
  return t
}

const me = await signer.getRecommendedAddressObj()
const aArgs = ccc.hashCkb(me.script.toBytes())
const bArgs = ccc.hashCkb((await signerB.getRecommendedAddressObj()).script.toBytes())
const xudt = (args) => ccc.Script.from({ codeHash: config.scripts.xudtScript.codeHash, hashType: config.scripts.xudtScript.hashType, args })
const tokenAType = xudt(aArgs), tokenBType = xudt(bArgs)

console.log('\n=== Aggregator OTX settlement ===')
const pool = await sdk.getPool(aArgs, bArgs)
if (!pool) { console.error('No A/B pool; run scripts/e2e/run.mjs first.'); process.exit(1) }

// 1. Migrate 10,000 TOKEN_A into a cellswap-otx-lock cell.
const joyid = makeSimulatedJoyID()
const lockArgs = await buildOtxLockArgs(joyid.pubkeyHex)
const otxLock = ccc.Script.from({ codeHash: config.scripts.cellswapOtxLock.codeHash, hashType: config.scripts.cellswapOtxLock.hashType, args: lockArgs })
const migTx = ccc.Transaction.from({ outputs: [{ capacity: 16_000_000_000n, lock: otxLock, type: tokenAType }], outputsData: [u128le(10_000n)] })
await migTx.addCellDepsOfKnownScripts(client, ccc.KnownScript.XUdt)
await migTx.completeInputsByCapacity(signer)
await migTx.completeFeeBy(signer, 1000)
const migHash = await signer.sendTransaction(migTx)
await client.waitTransaction(migHash)
console.log('Migrated OTX cell:', migHash.slice(0,18) + '…:0')

// 2. Sign the commitment and build the OTX payload for the aggregator.
const ownerLockHash = ccc.hashCkb(me.script.toBytes())
const intent = { firstInputTxHash: migHash, firstInputIndex: 0, totalInputAmount: 10_000n, minAmountOut: 4_000n, tokenOut: sdk.udtHash(bArgs), ownerLockHash }
const { witness } = await parseJoyIDOtxResponse(joyid.sign(await computeSwapCommitment(intent)), intent)
const payload = {
  inputCells: [{ txHash: migHash, index: 0 }],
  lockArgs, witness,
  tokenIn: sdk.udtHash(aArgs), amountIn: '10000',
  tokenOut: sdk.udtHash(bArgs), minAmountOut: '4000',
  ownerLockHash,
  ownerLock: { codeHash: me.script.codeHash, hashType: me.script.hashType, args: me.script.args },
}

// 3. POST to the aggregator's /otx intake.
const before = await getUdt(me.script, tokenBType)
const res = await fetch(`http://127.0.0.1:${OTX_PORT}/otx`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) })
console.log('POST /otx →', res.status, await res.text())
if (!res.ok) process.exit(1)

// 4. Wait for the aggregator's settlement loop (ticks every 2s).
console.log('Waiting for the aggregator to settle…')
let settled = false
for (let i = 0; i < 20; i++) {
  await new Promise(r => setTimeout(r, 2000))
  const now = await getUdt(me.script, tokenBType)
  if (now > before) { console.log(`\nAggregator settled it: owner TOKEN_B ${before} → ${now} (received ${now - before})`); settled = true; break }
}
if (!settled) console.log('\nFAIL: not settled within 40s; check the aggregator logs.')
process.exit(settled ? 0 : 1)
