// src/lib/joyid.ts: JoyID connect and the custody-free OTX signing flow
import { ccc } from '@ckb-ccc/core'
import { connect, signChallenge } from '@joyid/ckb'
import {
  computeSwapCommitment, parseJoyIDOtxResponse, buildOtxLockArgs,
  type SwapIntent, type OTXPayload, type JoyIDSignResponse,
} from '@cellswap/sdk'

const encU128 = (v: bigint): `0x${string}` => {
  const b = new Uint8Array(16); let n = v
  for (let i = 0; i < 16; i++) { b[i] = Number(n & 0xffn); n >>= 8n }
  return ('0x' + Array.from(b, x => x.toString(16).padStart(2, '0')).join('')) as `0x${string}`
}
import type { TypeHash, TxHash } from '@cellswap/types'
import { client, config, AGGREGATOR_URL } from './cellswap'
import { readU128LE } from './utils'
import { authHeaders } from './testerAuth'

export interface JoyIDSession {
  address: string
  pubkey:  string   // 64-byte x‖y hex (JoyID format)
}

/** Batch mode (OTX) needs a WebAuthn secp256r1 passkey, which only JoyID provides. Other CCC
 *  wallets (MetaMask, OKX, UTXO Global, …) sign every other flow but can't do batch mode. */
export const isPasskeyWallet = (name?: string): boolean => /joy ?id/i.test(name ?? '')

/** Settlement window for an OTX intent. A signed intent is only valid through
 *  `currentEpoch + OTX_DEADLINE_EPOCHS`, so a censoring solver can't hold it as a perpetual option.
 *  CKB epochs are ~4h, so 6 epochs ≈ 24h: long enough to settle, short enough to bound the option. */
const OTX_DEADLINE_EPOCHS = 6n

/** Current tip epoch + the settlement window, used as the committed OTX deadline. */
async function otxDeadlineEpoch(): Promise<bigint> {
  const header = await client.getTipHeader()
  const now = BigInt((header as { epoch: [bigint, bigint, bigint] }).epoch[0])
  return now + OTX_DEADLINE_EPOCHS
}

/** Tip block hash, for attaching as the HeaderDep the cellswap-otx-lock reads to check the deadline. */
async function tipHeaderHash(): Promise<`0x${string}`> {
  const header = await client.getTipHeader()
  return (header as { hash: `0x${string}` }).hash
}

/** Connect a JoyID passkey wallet. Returns address + secp256r1 pubkey. */
export async function connectJoyID(): Promise<JoyIDSession> {
  const res = await connect()
  return { address: res.address, pubkey: res.pubkey }
}

/** The cellswap-otx-lock script for a passkey (args = scheme ‖ blake2b256(pubkey)). */
export async function otxLockScript(pubkey: string): Promise<ccc.Script> {
  return ccc.Script.from({
    codeHash: config.scripts.cellswapOtxLock.codeHash as `0x${string}`,
    hashType: config.scripts.cellswapOtxLock.hashType as 'type',
    args:     await buildOtxLockArgs(pubkey),
  })
}

/** Balances held under a passkey's OTX lock (migrated funds, invisible to the normal
 *  wallet scan because they live in a different lock). Groups xUDT by args + sums CKB. */
export async function otxLockBalances(pubkey: string): Promise<{ ckb: bigint; tokens: { args: string; amount: bigint }[] }> {
  const lock = await otxLockScript(pubkey)
  const xudtCode = config.scripts.xudtScript.codeHash.toLowerCase()
  let ckb = 0n
  const by = new Map<string, bigint>()
  for await (const cell of client.findCellsByLock(lock)) {
    const type = cell.cellOutput.type
    if (!type) { ckb += cell.cellOutput.capacity; continue }
    if (type.codeHash.toLowerCase() !== xudtCode) continue
    const amt = readU128LE(cell.outputData as string)
    const k = type.args.toLowerCase()
    by.set(k, (by.get(k) ?? 0n) + amt)
  }
  return { ckb, tokens: [...by.entries()].filter(([, a]) => a > 0n).map(([args, amount]) => ({ args, amount })) }
}

/**
 * Withdraw a token from your OTX lock back to your normal wallet: a self-contained spend
 * (no aggregator, no pool). token_out = the same token, paid to your owner lock, so the
 * cellswap-otx-lock's "output >= min_amount_out to owner" check is satisfied by the payout.
 * You authorize it with one passkey signature (FaceID); your CCC signer pays the fee.
 */
export async function withdrawFromOtx(params: {
  session:     JoyIDSession
  ownerSigner: ccc.Signer
  tokenArgs:   string
  amount?:     bigint        // omit to withdraw the full balance of that token
}): Promise<TxHash> {
  const { session, ownerSigner, tokenArgs } = params
  const otxLock   = await otxLockScript(session.pubkey)
  const tokenType = ccc.Script.from({
    codeHash: config.scripts.xudtScript.codeHash as `0x${string}`,
    hashType: config.scripts.xudtScript.hashType as 'type',
    args:     tokenArgs as `0x${string}`,
  })
  const owner = (await ownerSigner.getRecommendedAddressObj()).script
  const ownerLockHash = owner.hash() as TypeHash

  // Collect this token's OTX-lock cells (the whole balance, or enough to cover `amount`).
  const inputs: { previousOutput: { txHash: TxHash; index: number } }[] = []
  let collected = 0n
  for await (const cell of client.findCells({
    script: otxLock, scriptType: 'lock', scriptSearchMode: 'exact', filter: { script: tokenType },
  })) {
    inputs.push({ previousOutput: { txHash: cell.outPoint.txHash as TxHash, index: Number(cell.outPoint.index) } })
    collected += readU128LE(cell.outputData)
    if (params.amount != null && collected >= params.amount) break
  }
  if (collected === 0n) throw new Error('No funds under your OTX lock for this token')
  const amount = params.amount != null && params.amount < collected ? params.amount : collected
  const change = collected - amount

  // Intent: pay `amount` of the same token to the owner. firstInput / totalInput must match
  // the consumed group exactly, or the on-chain commitment recompute won't match the signature.
  // Self-withdraw: token_out == token_in (paying the same token back to the owner). A future deadline
  // is set so the fresh signature is settleable now; the user re-signs on every withdraw.
  const intent: SwapIntent = {
    firstInputTxHash: inputs[0]!.previousOutput.txHash,
    firstInputIndex:  inputs[0]!.previousOutput.index,
    totalInputAmount: collected,
    minAmountOut:     amount,
    tokenOut:         tokenType.hash() as TypeHash,
    ownerLockHash,
    tokenInTypeHash:  tokenType.hash() as TypeHash,
    deadlineEpoch:    await otxDeadlineEpoch(),
  }
  const commitment = await computeSwapCommitment(intent)
  const res = await signChallenge(commitment, session.address) as unknown as JoyIDSignResponse
  const { witness } = await parseJoyIDOtxResponse(res, intent)

  const argLen = (s: string) => BigInt((s.startsWith('0x') ? s.length - 2 : s.length) / 2)
  const cellMin = (lockArgs: string) =>
    (8n + 32n + 1n + argLen(lockArgs) + 32n + 1n + argLen(tokenType.args) + 16n) * 100_000_000n

  const outputs: ccc.CellOutputLike[] = [{ capacity: cellMin(owner.args), lock: owner, type: tokenType }]
  const outputsData: `0x${string}`[] = [encU128(amount)]
  if (change > 0n) {   // partial withdraw: re-lock the surplus under the OTX lock
    outputs.push({ capacity: cellMin(otxLock.args), lock: otxLock, type: tokenType })
    outputsData.push(encU128(change))
  }

  const tx = ccc.Transaction.from({ inputs, outputs, outputsData })
  // The cellswap-otx-lock checks the committed deadline against HeaderDep[0]'s epoch.
  // The tip header's epoch is the current epoch (<= the deadline we just signed), so settlement passes.
  tx.headerDeps.push(await tipHeaderHash())
  tx.addCellDeps(ccc.CellDep.from({
    outPoint: { txHash: config.scripts.cellswapOtxLock.txHash as `0x${string}`, index: BigInt(config.scripts.cellswapOtxLock.index) },
    depType: 'code',
  }))
  await tx.addCellDepsOfKnownScripts(ownerSigner.client, ccc.KnownScript.XUdt)
  // The otx-lock reads its WebAuthn witness from the group's first input (index 0). Set it
  // before completing capacity/fee so the fee accounts for the (large) witness size.
  tx.setWitnessArgsAt(0, ccc.WitnessArgs.from({ lock: witness }))
  await tx.completeInputsByCapacity(ownerSigner)
  await tx.completeFeeBy(ownerSigner, 1000)
  return ownerSigner.sendTransaction(tx) as Promise<TxHash>
}

/**
 * Custody-free OTX swap. The user signs a commitment to (their input + intent);
 * their funds never leave their cellswap-otx-lock cell. The aggregator settles.
 *
 * Steps:
 *  1. find the user's input cell(s) under cellswap-otx-lock
 *  2. compute the commitment, sign it with JoyID (FaceID/TouchID)
 *  3. POST the signed OTX payload to the aggregator
 */
export async function swapViaOtx(params: {
  session:      JoyIDSession
  tokenIn:      TypeHash
  amountIn:     bigint
  tokenOut:     TypeHash
  minAmountOut: bigint
  ownerLock:    { codeHash: `0x${string}`; hashType: 'type'|'data'|'data1'; args: `0x${string}` }
}): Promise<{ queueDepth: number }> {
  const { session, tokenIn, amountIn, tokenOut, minAmountOut, ownerLock } = params

  // cellswap-otx-lock for this user. Args must match what buildMigrationTx wrote:
  // scheme(0x01) ‖ blake2b256(pubkey), not the raw pubkey, or we won't find the cells.
  const otxLock = ccc.Script.from({
    codeHash: config.scripts.cellswapOtxLock.codeHash as `0x${string}`,
    hashType:  config.scripts.cellswapOtxLock.hashType as 'type',
    args:      await buildOtxLockArgs(session.pubkey),
  })

  // Collect the user's token_in cells under the OTX lock
  const tokenInType = ccc.Script.from({
    codeHash: config.scripts.xudtScript.codeHash as `0x${string}`,
    hashType:  config.scripts.xudtScript.hashType as 'type',
    args:      tokenIn as `0x${string}`,
  })

  const inputCells: Array<{ txHash: TxHash; index: number }> = []
  let collected = 0n
  for await (const cell of client.findCells({
    script: otxLock, scriptType: 'lock', scriptSearchMode: 'exact',
    filter: { script: tokenInType },
  })) {
    inputCells.push({ txHash: cell.outPoint.txHash as TxHash, index: Number(cell.outPoint.index) })
    collected += readU128LE(cell.outputData)
    if (collected >= amountIn) break
  }
  if (collected < amountIn) {
    throw new Error(`Not enough ${tokenIn} under your CellSwap address. Migrate funds first.`)
  }

  const ownerLockHash = ccc.Script.from(ownerLock).hash() as TypeHash
  const tokenInTypeHash = tokenInType.hash() as TypeHash      // binds the input asset
  const deadlineEpoch = await otxDeadlineEpoch()              // bounded, committed deadline

  const intent: SwapIntent = {
    firstInputTxHash: inputCells[0]!.txHash,
    firstInputIndex:  inputCells[0]!.index,
    totalInputAmount: collected,
    minAmountOut,
    tokenOut,
    ownerLockHash,
    tokenInTypeHash,
    deadlineEpoch,
  }

  // 2. Commitment + JoyID signature (this triggers FaceID/TouchID)
  const commitment = await computeSwapCommitment(intent)
  const res = await signChallenge(commitment, session.address) as unknown as JoyIDSignResponse

  const { witness, lockArgs } = await parseJoyIDOtxResponse(res, intent)

  // 3. POST to aggregator
  const payload: OTXPayload = {
    inputCells, lockArgs, witness,
    tokenIn, tokenInTypeHash, amountIn: collected, tokenOut, minAmountOut,
    ownerLockHash, deadlineEpoch, ownerLock,
  }
  const r = await fetch(`${AGGREGATOR_URL}/otx`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload, (_k, v) => typeof v === 'bigint' ? v.toString() : v),
  })
  if (!r.ok) throw new Error(`Aggregator rejected: ${(await r.json()).error}`)
  return r.json()
}
