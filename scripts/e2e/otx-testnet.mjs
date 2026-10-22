#!/usr/bin/env node
// OTX path on testnet. Same flow as run.mjs step 13, but with a confirmation timeout longer than
// CCC's default 60s waitTransaction window, which testnet confirmation can exceed. Checks that
// cellswap-otx-lock settles on testnet: migrate xUDT into the OTX lock → sign the commitment
// (simulated JoyID P-256/WebAuthn) → the aggregator-style settlement routes it through the pool
// and pays the owner, with the WebAuthn signature verified on-chain.
import { ccc } from '@ckb-ccc/core'
import { CellSwap, computeSwapCommitment, parseJoyIDOtxResponse, buildOtxLockArgs } from '@cellswap/sdk'
import { getConfig } from '@cellswap/config'
import { createHash, createSign, generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'

const WAIT = Number(process.env.WAIT_MS ?? '240000')   // 4 min confirmation window

function makeSimulatedJoyID() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const pubkeyXY = publicKey.export({ type: 'spki', format: 'der' }).slice(-64)
  return {
    pubkeyHex: Buffer.from(pubkeyXY).toString('hex'),
    sign(commitment) {
      const ad = Buffer.alloc(37)
      createHash('sha256').update(Buffer.from('app.cellswap.io')).digest().copy(ad, 0)
      ad[32] = 0x05; ad.writeUInt32BE(1, 33)
      const cd = Buffer.from(JSON.stringify({
        type: 'webauthn.get', challenge: Buffer.from(commitment).toString('base64url'),
        origin: 'https://app.cellswap.io', crossOrigin: false,
      }))
      const sigBase = Buffer.concat([ad, createHash('sha256').update(cd).digest()])
      const der = createSign('SHA256').update(sigBase).sign({ key: privateKey, dsaEncoding: 'der' })
      return { pubkey: Buffer.from(pubkeyXY).toString('hex'), challenge: '',
        message: Buffer.concat([ad, cd]).toString('base64url'),
        signature: Buffer.from(der).toString('base64url'), alg: -7, keyType: 'main_key' }
    },
  }
}
const encodeU128LE = (v) => { const b = new Uint8Array(16); let n = v; for (let i = 0; i < 16; i++) { b[i] = Number(n & 0xffn); n >>= 8n } return '0x' + Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('') }

const config = getConfig('testnet')
const client = new ccc.ClientPublicTestnet({ url: config.rpcUrl })
const signer = new ccc.SignerCkbPrivateKey(client, readFileSync('.testnet-deployer.key', 'utf8').trim())
const acct1  = new ccc.SignerCkbPrivateKey(client, readFileSync('.testnet-acct1.key', 'utf8').trim())
const sdk    = new CellSwap({ network: 'testnet', config })

const me     = await signer.getRecommendedAddressObj()
const acct1A = await acct1.getRecommendedAddressObj()
const xudt = (ownerLockHash) => ccc.Script.from({ codeHash: config.scripts.xudtScript.codeHash, hashType: config.scripts.xudtScript.hashType, args: ownerLockHash })
const tokenA = { args: me.script.hash(),     script: xudt(me.script.hash()) }      // owner = deployer
const tokenB = { args: acct1A.script.hash(), script: xudt(acct1A.script.hash()) }   // owner = acct1

console.log('[otx] tokenA args', tokenA.args)
console.log('[otx] tokenB args', tokenB.args)

const joyid    = makeSimulatedJoyID()
const lockArgs = await buildOtxLockArgs(joyid.pubkeyHex)
const otxLock  = ccc.Script.from({ codeHash: config.scripts.cellswapOtxLock.codeHash, hashType: config.scripts.cellswapOtxLock.hashType, args: lockArgs })

// 1. Migrate 10,000 TOKEN_A into an otx-lock cell (deployer owns tokenA → owner-mode mint)
const migTx = ccc.Transaction.from({ outputs: [{ capacity: 16_000_000_000n, lock: otxLock, type: tokenA.script }], outputsData: [encodeU128LE(10_000n)] })
await migTx.addCellDepsOfKnownScripts(signer.client, ccc.KnownScript.XUdt)
await migTx.completeInputsByCapacity(signer)
await migTx.completeFeeBy(signer, 1000)
const migHash = await signer.sendTransaction(migTx)
console.log('[otx] migrate tx', migHash, 'waiting (up to', WAIT, 'ms)...')
await client.waitTransaction(migHash, 0, WAIT)
console.log('[otx] migrated 10,000 TOKEN_A into the OTX lock')

// 2. Commitment + simulated JoyID signature
const ownerLockHash = ccc.hashCkb(me.script.toBytes())
const intent = { firstInputTxHash: migHash, firstInputIndex: 0, totalInputAmount: 10_000n, minAmountOut: 4_000n, tokenOut: sdk.udtHash(tokenB.args), ownerLockHash }
const commitment = await computeSwapCommitment(intent)
const { witness } = await parseJoyIDOtxResponse(joyid.sign(commitment), intent)

// 3. Settlement: route the OTX cell's TOKEN_A through the pool, pay the owner TOKEN_B
const pool = await sdk.getPool(tokenA.args, tokenB.args)
if (!pool) throw new Error('no A/B pool on testnet; run scripts/e2e/run.mjs first')
const fee = BigInt(pool.feeBps)
const amountOut = (10_000n * (10_000n - fee) * pool.reserveY) / (pool.reserveX * 10_000n + 10_000n * (10_000n - fee))
if (amountOut < 4_000n) throw new Error(`would underpay: ${amountOut}`)
const poolLock = ccc.Script.from({ codeHash: config.scripts.poolLock.codeHash, hashType: config.scripts.poolLock.hashType, args: ccc.Script.from(pool.cell.output.type).hash() })
const tx = ccc.Transaction.from({
  inputs: [
    { previousOutput: { txHash: migHash, index: 0 } },
    { previousOutput: pool.cell.outPoint },
    { previousOutput: pool.reserveCellX.outPoint },
    { previousOutput: pool.reserveCellY.outPoint },
  ],
  outputs: [
    { capacity: pool.cell.output.capacity, lock: pool.cell.output.lock, type: pool.cell.output.type },
    { capacity: pool.reserveCellX.output.capacity, lock: poolLock, type: pool.reserveCellX.output.type },
    { capacity: pool.reserveCellY.output.capacity, lock: poolLock, type: pool.reserveCellY.output.type },
    { capacity: 14_400_000_000n, lock: me.script, type: pool.reserveCellY.output.type },
  ],
  outputsData: [ pool.cell.data, encodeU128LE(pool.reserveX + 10_000n), encodeU128LE(pool.reserveY - amountOut), encodeU128LE(amountOut) ],
})
for (const s of [config.scripts.poolScript, config.scripts.poolLock, config.scripts.xudtScript, config.scripts.cellswapOtxLock, config.scripts.alwaysSuccess]) {
  tx.addCellDeps(ccc.CellDep.from({ outPoint: { txHash: s.txHash, index: s.index }, depType: 'code' }))
}
tx.setWitnessArgsAt(0, ccc.WitnessArgs.from({ lock: witness }))
await tx.completeInputsByCapacity(signer)
await tx.completeFeeBy(signer, 1000)
const hash = await signer.sendTransaction(tx)   // node verifies the OTX lock here, before mempool
console.log('[otx] settlement accepted by node (OTX lock verified):', hash, 'waiting...')
await client.waitTransaction(hash, 0, WAIT)
console.log(`\nOTX settled on testnet in ${hash}`)
console.log(`   owner received ${amountOut} TOKEN_B (min 4000), WebAuthn verified on-chain, custody-free`)
