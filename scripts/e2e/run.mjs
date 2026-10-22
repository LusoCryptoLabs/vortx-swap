#!/usr/bin/env node
// scripts/e2e/run.mjs
//
// End-to-end smoke test for CellSwap on a local devnet.
// Run after the contracts compile and deploy:
//   1. offckb node                          (terminal 1)
//   2. bash scripts/deploy.sh devnet        (deploys contracts, patches config)
//   3. pnpm -r build                        (builds SDK from patched config)
//   4. node scripts/e2e/run.mjs             (this script)
//
// Verifies the full lifecycle:
//   • issue two test xUDT tokens (TOKEN_A, TOKEN_B)
//   • create a liquidity pool A/B
//   • quote a swap
//   • execute a direct atomic swap (A → B)
//   • verify reserves changed correctly and user received >= minOut
//   • execute an async intent-lock swap and settle it
//
// No frontend needed: this checks that the backend works end-to-end.

import { ccc } from '@ckb-ccc/core'
import { CellSwap } from '@cellswap/sdk'
import { computeSwapCommitment, parseJoyIDOtxResponse, buildOtxLockArgs } from '@cellswap/sdk'
import { getConfig, validateScripts } from '@cellswap/config'
import { createHash, createSign, generateKeyPairSync } from 'node:crypto'

// Stand in for JoyID's signChallenge() with a local P-256 key (CI-friendly, no popup).
// Returns exactly JoyID's response shape: { pubkey(64B x‖y hex), message(b64url), signature(b64url DER) }.
function makeSimulatedJoyID() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const pubkeyXY = publicKey.export({ type: 'spki', format: 'der' }).slice(-64) // x‖y
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
      return {
        pubkey: Buffer.from(pubkeyXY).toString('hex'), challenge: '',
        message: Buffer.concat([ad, cd]).toString('base64url'),
        signature: Buffer.from(der).toString('base64url'), alg: -7, keyType: 'main_key',
      }
    },
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────

const NETWORK = process.env.NETWORK ?? 'devnet'
// Require the key explicitly, so an unset env var fails with a clear error instead of
// insufficient-capacity failures. See scripts/e2e/README.md for offckb account-0's key.
const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY
if (!DEPLOYER_KEY) {
  console.error('DEPLOYER_PRIVATE_KEY is not set. Export offckb account-0 (see scripts/e2e/README.md), e.g.:')
  console.error('  export DEPLOYER_PRIVATE_KEY=0x<offckb-account-0-key>')
  process.exit(1)
}

const log  = (...a) => console.log('  ', ...a)
const step = (n, t) => console.log(`\n[${n}] ${t}`)
const ok   = (t) => console.log(`   ok   ${t}`)
const fail = (t, e) => { console.error(`   FAIL ${t}: ${e?.message ?? e}`); process.exitCode = 1 }

let testsPassed = 0, testsFailed = 0
async function check(name, fn) {
  try { await fn(); ok(name); testsPassed++ }
  catch (e) { fail(name, e); testsFailed++ }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Issue a new xUDT token owned by signer. Returns the token's type hash. */
async function issueXudt(client, signer, symbol, amount) {
  const owner = await signer.getRecommendedAddressObj()
  // xUDT args = owner lock hash (the token's "owner")
  const ownerLockHash = ccc.hashCkb(owner.script.toBytes())
  const xudtType = await ccc.Script.fromKnownScript(client, ccc.KnownScript.XUdt, ownerLockHash)

  const tx = ccc.Transaction.from({
    outputs: [{ capacity: 14_400_000_000n, lock: owner.script, type: xudtType }],
    outputsData: [encodeU128LE(amount)],
  })
  await tx.addCellDepsOfKnownScripts(client, ccc.KnownScript.XUdt)
  await tx.completeInputsByCapacity(signer)
  await tx.completeFeeBy(signer, 1000)
  const hash = await signer.sendTransaction(tx)
  await client.waitTransaction(hash)
  // The SDK identifies a token by its xUDT args (the owner lock hash).
  return { args: ownerLockHash, typeHash: xudtType.hash(), script: xudtType, mintTx: hash }
}

/** Transfer `amount` of an xUDT from `fromSigner` to `toScript`. */
async function transferXudt(client, fromSigner, toScript, xudtType, amount) {
  const from = await fromSigner.getRecommendedAddressObj()
  const tx = ccc.Transaction.from({
    outputs: [{ capacity: 14_400_000_000n, lock: toScript, type: xudtType }],
    outputsData: [encodeU128LE(amount)],
  })
  await tx.addCellDepsOfKnownScripts(client, ccc.KnownScript.XUdt)
  // Collect the sender's xUDT cells to cover `amount` (+ change handled by CCC).
  await tx.completeInputsByUdt(fromSigner, xudtType)
  await tx.completeInputsByCapacity(fromSigner)
  await tx.completeFeeBy(fromSigner, 1000)
  const hash = await fromSigner.sendTransaction(tx)
  await client.waitTransaction(hash)
  return hash
}

function encodeU128LE(v) {
  const b = new Uint8Array(16)
  let n = v; for (let i = 0; i < 16; i++) { b[i] = Number(n & 0xffn); n >>= 8n }
  return ('0x' + Array.from(b).map(x => x.toString(16).padStart(2, '0')).join(''))
}

/** Read a u128 LE from the first 16 bytes of a cell's data hex. */
function readAmt(outputData) {
  const d = outputData.startsWith('0x') ? outputData.slice(2) : outputData
  return BigInt('0x' + (d.slice(0, 32).match(/../g).reverse().join('')))
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════')
  console.log(' CellSwap E2E Test:', NETWORK)
  console.log('═══════════════════════════════════════════')

  step(0, 'Validate deployment config')
  try {
    validateScripts(NETWORK)
    ok('All contract addresses are set (not placeholder)')
  } catch (e) {
    fail('Config validation', e)
    console.error('\n   Run: bash scripts/deploy.sh ' + NETWORK + ' first.\n')
    process.exit(1)
  }

  const config = getConfig(NETWORK)
  // On a local devnet the system-script (secp256k1, xUDT, …) cell-deps differ from
  // testnet's baked-in defaults. Load offckb's CCC export and pass it as `scripts`
  // so the signer's client resolves the right deps.
  let knownScripts
  if (process.env.CCC_SCRIPTS_JSON) {
    const { readFileSync } = await import('node:fs')
    knownScripts = JSON.parse(readFileSync(process.env.CCC_SCRIPTS_JSON, 'utf8'))
  }
  const client = NETWORK === 'mainnet'
    ? new ccc.ClientPublicMainnet({ url: config.rpcUrl })
    : new ccc.ClientPublicTestnet({ url: config.rpcUrl, ...(knownScripts ? { scripts: knownScripts } : {}) })
  const signer = new ccc.SignerCkbPrivateKey(client, DEPLOYER_KEY)
  // A second funded account, used to mint a distinct xUDT (xUDT identity = owner lock
  // hash, so two distinct tokens need two distinct owners). offckb devnet account #1.
  const SECOND_KEY = process.env.SECOND_PRIVATE_KEY
    ?? '0x9f315d5a9618a39fdc487c7a67a8581d40b045bd7a42d83648ca80ef3b2cb4a1'
  const signerB = new ccc.SignerCkbPrivateKey(client, SECOND_KEY)
  const sdk    = new CellSwap({ network: NETWORK, config })

  // LP token script for a pool (lp-token type, args = the pool info cell's type hash).
  const lpScript = (pool) => ccc.Script.from({
    codeHash: config.scripts.lpTokenScript.codeHash,
    hashType: config.scripts.lpTokenScript.hashType,
    args:     ccc.Script.from(pool.cell.output.type).hash(),
  })

  const me = await signer.getRecommendedAddressObj()
  log('Signer address:', me.toString())

  // ── 1. Issue two test tokens ────────────────────────────────────────────────
  step(1, 'Issue test xUDT tokens (two distinct owners)')
  let tokenA, tokenB
  await check('Issue TOKEN_A (1,000,000) owned by acct#0', async () => {
    tokenA = await issueXudt(client, signer, 'TKA', 1_000_000n)
    log('TOKEN_A type hash:', tokenA.typeHash)
  })
  await check('Issue TOKEN_B (1,000,000) owned by acct#1', async () => {
    tokenB = await issueXudt(client, signerB, 'TKB', 1_000_000n)
    log('TOKEN_B type hash:', tokenB.typeHash)
  })
  await check('Transfer TOKEN_B to acct#0 (pool creator)', async () => {
    await transferXudt(client, signerB, me.script, tokenB.script, 1_000_000n)
    const bal = await getUdtBalance(client, me.script, tokenB.script)
    if (bal < 1_000_000n) throw new Error(`acct#0 TOKEN_B balance ${bal} < 1000000`)
    log('acct#0 now holds TOKEN_B:', bal)
  })

  // ── 2. Create a liquidity pool ────────────────────────────────────────────────
  step(2, 'Create A/B liquidity pool')
  await check('createPool A/B with 500k each', async () => {
    const txHash = await sdk.createPool(signer, {
      tokenX:  tokenA.args,
      tokenY:  tokenB.args,
      amountX: 500_000n,
      amountY: 500_000n,
      feeBps:  30,
      poolId:  1n,
    })
    await client.waitTransaction(txHash)
    log('Pool created in tx:', txHash)
  })

  await check('Pool is discoverable via getPool', async () => {
    const pool = await sdk.getPool(tokenA.args, tokenB.args)
    if (!pool) throw new Error('Pool not found after creation')
    log(`Reserves: X=${pool.reserveX} Y=${pool.reserveY} fee=${pool.feeBps}bps`)
    if (pool.reserveX !== 500_000n) throw new Error(`Expected reserveX 500000, got ${pool.reserveX}`)
  })

  // ── 3. Quote a swap ─────────────────────────────────────────────────────────
  step(3, 'Quote swap 10,000 A → B')
  let quote
  await check('Quote returns positive output with price impact', async () => {
    quote = await sdk.quoteSwap(tokenA.args, 10_000n, tokenB.args, 0.005)
    log(`amountIn=${quote.amountIn} amountOut=${quote.amountOut} minOut=${quote.minAmountOut}`)
    log(`priceImpact=${(quote.priceImpact * 100).toFixed(3)}%`)
    if (quote.amountOut <= 0n) throw new Error('Non-positive output')
    if (quote.amountOut >= 10_000n) throw new Error('Output should be < input for equal reserves + fee')
  })

  // ── 4. Direct atomic swap ─────────────────────────────────────────────────────
  step(4, 'Execute direct atomic swap (A → B)')
  let balanceBefore
  await check('Record TOKEN_B balance before swap', async () => {
    balanceBefore = await getUdtBalance(client, me.script, tokenB.script)
    log('TOKEN_B before:', balanceBefore)
  })
  await check('swap() executes and confirms', async () => {
    const txHash = await sdk.swap(signer, {
      tokenIn:      tokenA.args,
      amountIn:     10_000n,
      tokenOut:     tokenB.args,
      minAmountOut: quote.minAmountOut,
    })
    await client.waitTransaction(txHash)
    log('Swap settled in tx:', txHash)
  })
  await check('Received >= minAmountOut TOKEN_B', async () => {
    const after = await getUdtBalance(client, me.script, tokenB.script)
    const received = after - balanceBefore
    log(`TOKEN_B after: ${after} (received ${received})`)
    if (received < quote.minAmountOut) {
      throw new Error(`Received ${received} < minOut ${quote.minAmountOut}`)
    }
  })
  await check('Pool reserves updated correctly', async () => {
    const pool = await sdk.getPool(tokenA.args, tokenB.args)
    log(`New reserves: X=${pool.reserveX} Y=${pool.reserveY}`)
    if (pool.reserveX !== 510_000n) throw new Error(`Expected reserveX 510000, got ${pool.reserveX}`)
    // Invariant: new_x * new_y >= old_x * old_y (fee makes it strictly greater)
    if (pool.reserveX * pool.reserveY < 500_000n * 500_000n) {
      throw new Error('Invariant violated')
    }
  })

  // ── 5. Async intent-lock swap ─────────────────────────────────────────────────
  step(5, 'Execute async intent-lock swap (A → B)')
  await check('swapAsync() creates intent cell', async () => {
    const txHash = await sdk.swapAsync(signer, {
      tokenIn:      tokenA.args,
      amountIn:     5_000n,
      tokenOut:     tokenB.args,
      minAmountOut: 4_000n,
    })
    await client.waitTransaction(txHash)
    log('Intent cell created in tx:', txHash)
  })
  await check('aggregator-style settlement routes intent through pool, pays owner', async () => {
    // Find the unspent intent-lock cell.
    let intentCell
    for await (const c of client.findCells({
      script: { codeHash: config.scripts.intentLock.codeHash, hashType: config.scripts.intentLock.hashType, args: '0x' },
      scriptType: 'lock', scriptSearchMode: 'prefix',
    })) { intentCell = c; break }
    if (!intentCell) throw new Error('intent cell not found')
    const inAmt = readAmt(intentCell.outputData)              // tokenA locked in the intent
    const pool = await sdk.getPool(tokenA.args, tokenB.args)
    const fee = BigInt(pool.feeBps)
    const amountOut = (inAmt * (10_000n - fee) * pool.reserveY) / (pool.reserveX * 10_000n + inAmt * (10_000n - fee))
    if (amountOut < 4_000n) throw new Error(`settlement underpays: ${amountOut} < 4000`)
    const poolLock = ccc.Script.from({
      codeHash: config.scripts.poolLock.codeHash, hashType: config.scripts.poolLock.hashType,
      args: ccc.Script.from(pool.cell.output.type).hash(),
    })
    const tx = ccc.Transaction.from({
      inputs: [
        { previousOutput: intentCell.outPoint },
        { previousOutput: pool.cell.outPoint },
        { previousOutput: pool.reserveCellX.outPoint },
        { previousOutput: pool.reserveCellY.outPoint },
      ],
      outputs: [
        { capacity: pool.cell.output.capacity, lock: pool.cell.output.lock, type: pool.cell.output.type },
        { capacity: pool.reserveCellX.output.capacity, lock: poolLock, type: pool.reserveCellX.output.type },
        { capacity: pool.reserveCellY.output.capacity, lock: poolLock, type: pool.reserveCellY.output.type },
        { capacity: 14_400_000_000n, lock: me.script, type: pool.reserveCellY.output.type }, // tokenOut → owner
      ],
      outputsData: [ pool.cell.data, encodeU128LE(pool.reserveX + inAmt), encodeU128LE(pool.reserveY - amountOut), encodeU128LE(amountOut) ],
    })
    for (const s of [config.scripts.poolScript, config.scripts.poolLock, config.scripts.xudtScript, config.scripts.intentLock, config.scripts.alwaysSuccess]) {
      tx.addCellDeps(ccc.CellDep.from({ outPoint: { txHash: s.txHash, index: s.index }, depType: 'code' }))
    }
    await tx.completeInputsByCapacity(signer)
    await tx.completeFeeBy(signer, 1000)
    const hash = await signer.sendTransaction(tx)
    await client.waitTransaction(hash)
    log(`Intent settled in ${hash}: owner received ${amountOut} TOKEN_B (min 4000)`)
  })

  // ── 6. Add liquidity (deposit) ────────────────────────────────────────────────
  step(6, 'Add liquidity (deposit A + B, mint LP)')
  let rxBeforeDeposit
  await check('addLiquidity grows reserves and mints LP', async () => {
    const before = await sdk.getPool(tokenA.args, tokenB.args)
    rxBeforeDeposit = before.reserveX
    const lpBefore = await getUdtBalance(client, me.script, lpScript(before))
    // Proportional deposit (~10% of each reserve).
    const dx = before.reserveX / 10n, dy = before.reserveY / 10n
    const txHash = await sdk.addLiquidity(signer, { tokenX: tokenA.args, tokenY: tokenB.args, amountX: dx, amountY: dy })
    await client.waitTransaction(txHash)
    const after = await sdk.getPool(tokenA.args, tokenB.args)
    const lpAfter = await getUdtBalance(client, me.script, lpScript(after))
    log(`reserves ${before.reserveX}/${before.reserveY} → ${after.reserveX}/${after.reserveY}; LP ${lpBefore} → ${lpAfter}`)
    if (after.reserveX <= before.reserveX || after.reserveY <= before.reserveY) throw new Error('reserves did not grow')
    if (lpAfter <= lpBefore) throw new Error('no LP minted')
  })

  // ── 7. Remove liquidity (withdraw) ────────────────────────────────────────────
  step(7, 'Remove liquidity (burn LP, return A + B)')
  await check('removeLiquidity burns LP and returns tokens', async () => {
    const before = await sdk.getPool(tokenA.args, tokenB.args)
    const aBefore = await getUdtBalance(client, me.script, tokenA.script)
    const lpBefore = await getUdtBalance(client, me.script, lpScript(before))
    const burn = lpBefore / 5n  // burn 20% of our LP
    const txHash = await sdk.removeLiquidity(signer, { tokenX: tokenA.args, tokenY: tokenB.args, lpAmount: burn })
    await client.waitTransaction(txHash)
    const after = await sdk.getPool(tokenA.args, tokenB.args)
    const aAfter = await getUdtBalance(client, me.script, tokenA.script)
    log(`reserves ${before.reserveX}/${before.reserveY} → ${after.reserveX}/${after.reserveY}; TOKEN_A ${aBefore} → ${aAfter}`)
    if (after.reserveX >= before.reserveX || after.reserveY >= before.reserveY) throw new Error('reserves did not shrink')
    if (aAfter <= aBefore) throw new Error('did not receive tokens back')
  })

  // ── 8-10. CKB / xUDT pool ─────────────────────────────────────────────────────
  const CKB_HASH = '0x' + '0'.repeat(64)
  step(8, 'Create CKB / TOKEN_A pool')
  await check('createPool CKB/A (200 CKB + 100k A)', async () => {
    const txHash = await sdk.createPool(signer, {
      tokenX: CKB_HASH, tokenY: tokenA.args,
      amountX: 20_000_000_000n, amountY: 100_000n, feeBps: 30, poolId: 2n,
    })
    await client.waitTransaction(txHash)
    const pool = await sdk.getPool(CKB_HASH, tokenA.args)
    if (!pool) throw new Error('CKB pool not found')
    log(`CKB pool: CKB reserve=${pool.reserveX} A reserve=${pool.reserveY} mode=${pool.poolMode}`)
    if (pool.reserveY !== 100_000n) throw new Error(`reserveY ${pool.reserveY} != 100000`)
    if (pool.poolMode !== 'CKB_XUDT') throw new Error(`mode ${pool.poolMode} != CKB_XUDT`)
  })
  step(9, 'Swap CKB → TOKEN_A')
  await check('swap CKB in, receive TOKEN_A', async () => {
    const before = await sdk.getPool(CKB_HASH, tokenA.args)
    const aBefore = await getUdtBalance(client, me.script, tokenA.script)
    const txHash = await sdk.swap(signer, { tokenIn: CKB_HASH, amountIn: 2_000_000_000n, tokenOut: tokenA.args, minAmountOut: 1n })
    await client.waitTransaction(txHash)
    const after = await sdk.getPool(CKB_HASH, tokenA.args)
    const aAfter = await getUdtBalance(client, me.script, tokenA.script)
    log(`CKB reserve ${before.reserveX}→${after.reserveX}; A reserve ${before.reserveY}→${after.reserveY}; my A +${aAfter - aBefore}`)
    if (after.reserveX <= before.reserveX) throw new Error('CKB reserve did not grow')
    if (after.reserveY >= before.reserveY) throw new Error('A reserve did not shrink')
    if (aAfter <= aBefore) throw new Error('did not receive TOKEN_A')
  })
  step(10, 'Swap TOKEN_A → CKB')
  await check('swap TOKEN_A in, receive CKB', async () => {
    const before = await sdk.getPool(CKB_HASH, tokenA.args)
    const txHash = await sdk.swap(signer, { tokenIn: tokenA.args, amountIn: 50_000n, tokenOut: CKB_HASH, minAmountOut: 1n })
    await client.waitTransaction(txHash)
    const after = await sdk.getPool(CKB_HASH, tokenA.args)
    log(`CKB reserve ${before.reserveX}→${after.reserveX}; A reserve ${before.reserveY}→${after.reserveY}`)
    if (after.reserveX >= before.reserveX) throw new Error('CKB reserve did not shrink')
    if (after.reserveY <= before.reserveY) throw new Error('A reserve did not grow')
    // Invariant holds across the round-trip.
    if (after.reserveX * after.reserveY < before.reserveX * before.reserveY) throw new Error('invariant violated')
  })

  step(11, 'Add liquidity to CKB pool (deposit CKB + A)')
  await check('addLiquidity CKB pool grows reserves and mints LP', async () => {
    const before = await sdk.getPool(CKB_HASH, tokenA.args)
    const lpBefore = await getUdtBalance(client, me.script, lpScript(before))
    const dx = before.reserveX / 10n, dy = before.reserveY / 10n
    const txHash = await sdk.addLiquidity(signer, { tokenX: CKB_HASH, tokenY: tokenA.args, amountX: dx, amountY: dy })
    await client.waitTransaction(txHash)
    const after = await sdk.getPool(CKB_HASH, tokenA.args)
    const lpAfter = await getUdtBalance(client, me.script, lpScript(after))
    log(`CKB ${before.reserveX}→${after.reserveX}; A ${before.reserveY}→${after.reserveY}; LP ${lpBefore}→${lpAfter}`)
    if (after.reserveX <= before.reserveX || after.reserveY <= before.reserveY) throw new Error('reserves did not grow')
    if (lpAfter <= lpBefore) throw new Error('no LP minted')
  })
  step(12, 'Remove liquidity from CKB pool (burn LP, return CKB + A)')
  await check('removeLiquidity CKB pool shrinks reserves and returns A', async () => {
    const before = await sdk.getPool(CKB_HASH, tokenA.args)
    const aBefore = await getUdtBalance(client, me.script, tokenA.script)
    const lpBefore = await getUdtBalance(client, me.script, lpScript(before))
    const txHash = await sdk.removeLiquidity(signer, { tokenX: CKB_HASH, tokenY: tokenA.args, lpAmount: lpBefore / 5n })
    await client.waitTransaction(txHash)
    const after = await sdk.getPool(CKB_HASH, tokenA.args)
    const aAfter = await getUdtBalance(client, me.script, tokenA.script)
    log(`CKB ${before.reserveX}→${after.reserveX}; A ${before.reserveY}→${after.reserveY}; my A +${aAfter - aBefore}`)
    if (after.reserveX >= before.reserveX || after.reserveY >= before.reserveY) throw new Error('reserves did not shrink')
    if (aAfter <= aBefore) throw new Error('did not receive TOKEN_A back')
  })

  // ── 13. OTX path (cellswap-otx-lock, the JoyID custody-free flow) ──────────────
  step(13, 'OTX swap via cellswap-otx-lock (simulated JoyID WebAuthn)')
  await check('migrate → sign commitment → settle; lock verifies WebAuthn on-chain', async () => {
    const joyid    = makeSimulatedJoyID()
    const lockArgs = await buildOtxLockArgs(joyid.pubkeyHex)   // 0x01 || blake2b256(pubkey)
    const otxLock  = ccc.Script.from({
      codeHash: config.scripts.cellswapOtxLock.codeHash, hashType: config.scripts.cellswapOtxLock.hashType, args: lockArgs,
    })
    // 1. Migrate 10,000 TOKEN_A into an otx-lock cell (acct#0 is the xUDT owner → owner-mode mint).
    const migTx = ccc.Transaction.from({ outputs: [{ capacity: 16_000_000_000n, lock: otxLock, type: tokenA.script }], outputsData: [encodeU128LE(10_000n)] })
    await migTx.addCellDepsOfKnownScripts(signer.client, ccc.KnownScript.XUdt)
    await migTx.completeInputsByCapacity(signer)
    await migTx.completeFeeBy(signer, 1000)
    const migHash = await signer.sendTransaction(migTx)
    await client.waitTransaction(migHash)

    // 2. Compute the commitment over (otx cell outpoint, total in, intent) and sign it.
    const ownerLockHash = ccc.hashCkb(me.script.toBytes())
    const intent = {
      firstInputTxHash: migHash, firstInputIndex: 0, totalInputAmount: 10_000n,
      minAmountOut: 4_000n, tokenOut: sdk.udtHash(tokenB.args), ownerLockHash,
    }
    const commitment = await computeSwapCommitment(intent)
    const { witness } = await parseJoyIDOtxResponse(joyid.sign(commitment), intent)

    // 3. Aggregator settles: route the otx cell's TOKEN_A through the pool, pay the owner TOKEN_B.
    const pool = await sdk.getPool(tokenA.args, tokenB.args)
    const fee  = BigInt(pool.feeBps)
    const amountOut = (10_000n * (10_000n - fee) * pool.reserveY) / (pool.reserveX * 10_000n + 10_000n * (10_000n - fee))
    if (amountOut < 4_000n) throw new Error(`would underpay: ${amountOut}`)
    const poolLock = ccc.Script.from({
      codeHash: config.scripts.poolLock.codeHash, hashType: config.scripts.poolLock.hashType,
      args: ccc.Script.from(pool.cell.output.type).hash(),
    })
    const tx = ccc.Transaction.from({
      inputs: [
        { previousOutput: { txHash: migHash, index: 0 } },  // otx-lock cell: must be input 0 (group witness 0)
        { previousOutput: pool.cell.outPoint },
        { previousOutput: pool.reserveCellX.outPoint },
        { previousOutput: pool.reserveCellY.outPoint },
      ],
      outputs: [
        { capacity: pool.cell.output.capacity, lock: pool.cell.output.lock, type: pool.cell.output.type },
        { capacity: pool.reserveCellX.output.capacity, lock: poolLock, type: pool.reserveCellX.output.type },
        { capacity: pool.reserveCellY.output.capacity, lock: poolLock, type: pool.reserveCellY.output.type },
        { capacity: 14_400_000_000n, lock: me.script, type: pool.reserveCellY.output.type }, // TOKEN_B → owner
      ],
      outputsData: [ pool.cell.data, encodeU128LE(pool.reserveX + 10_000n), encodeU128LE(pool.reserveY - amountOut), encodeU128LE(amountOut) ],
    })
    for (const s of [config.scripts.poolScript, config.scripts.poolLock, config.scripts.xudtScript, config.scripts.cellswapOtxLock, config.scripts.alwaysSuccess]) {
      tx.addCellDeps(ccc.CellDep.from({ outPoint: { txHash: s.txHash, index: s.index }, depType: 'code' }))
    }
    // Set the WebAuthn witness for the otx-lock group before fee calc so the fee covers its size.
    tx.setWitnessArgsAt(0, ccc.WitnessArgs.from({ lock: witness }))
    await tx.completeInputsByCapacity(signer)
    await tx.completeFeeBy(signer, 1000)
    const hash = await signer.sendTransaction(tx)
    await client.waitTransaction(hash)
    log(`OTX settled in ${hash}: owner received ${amountOut} TOKEN_B (WebAuthn-verified, custody-free)`)
  })

  // ── 14. Public pool: a different account swaps against acct#0's pool ───────────
  step(14, 'Public pool: acct#1 swaps against the pool acct#0 created')
  await check('acct#1 swaps A→B against acct#0 pool (permissive info-cell lock)', async () => {
    const meB = await signerB.getRecommendedAddressObj()
    // Give acct#1 some TOKEN_A to trade with (it owns none).
    await transferXudt(client, signer, meB.script, tokenA.script, 20_000n)
    const before = await getUdtBalance(client, meB.script, tokenB.script)
    const pBefore = await sdk.getPool(tokenA.args, tokenB.args)
    const txHash = await sdk.swap(signerB, { tokenIn: tokenA.args, amountIn: 10_000n, tokenOut: tokenB.args, minAmountOut: 1n })
    await client.waitTransaction(txHash)
    const after = await getUdtBalance(client, meB.script, tokenB.script)
    const pAfter = await sdk.getPool(tokenA.args, tokenB.args)
    log(`acct#1 received ${after - before} TOKEN_B; pool A reserve ${pBefore.reserveX}→${pAfter.reserveX}`)
    if (after <= before) throw new Error('acct#1 received no TOKEN_B; pool is not publicly swappable')
    if (pAfter.reserveX <= pBefore.reserveX) throw new Error('pool reserve did not move')
  })

  // ── Summary ───────────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════')
  console.log(` Results: ${testsPassed} passed, ${testsFailed} failed`)
  console.log('═══════════════════════════════════════════\n')
  process.exit(testsFailed > 0 ? 1 : 0)
}

async function getUdtBalance(client, lock, udtType) {
  let total = 0n
  for await (const cell of client.findCells({
    script: lock, scriptType: 'lock', scriptSearchMode: 'exact',
    filter: { script: udtType },
  })) {
    const d = cell.outputData.startsWith('0x') ? cell.outputData.slice(2) : cell.outputData
    const bytes = d.slice(0, 32).match(/.{2}/g)
    if (bytes) total += BigInt('0x' + bytes.reverse().join(''))
  }
  return total
}

main().catch(e => { console.error('\nFATAL:', e); process.exit(1) })
