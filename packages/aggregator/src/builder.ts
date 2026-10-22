// builder.ts: assembles the self-contained OTX settlement transaction
// (many users' cellswap-otx-lock cells + the pool cell, each witness self-validating).

import { ccc }         from '@ckb-ccc/core'
import { ChainClient } from '@cellswap/chain-client'
import { getAmountOut } from '@cellswap/router'
import type { ChainConfig, Pool, Script } from '@cellswap/types'
import { XUDT_CELL_CAPACITY, DEFAULT_FEE_RATE } from '@cellswap/types'
import {
  encodeU128LE, hexToUint8Array, uint8ArrayToHex, writeU64LE,
  POOL_LAST_EPOCH_OFF, POOL_DATA_SIZE,
} from '@cellswap/codec'
import type { OTXPayload } from '@cellswap/sdk'

export class Builder {
  constructor(
    private chain:      ChainClient,
    private config:     ChainConfig,
    private solverLock: Script,
  ) {}

  /** Build and broadcast a self-contained OTX settlement transaction.
   *  Assembles many users' cellswap-otx-lock cells + the pool cell.
   *  Each user's WebAuthn witness self-validates via the lock script:
   *    verifies the user signed (input + intent), and that this tx sends them
   *    >= minAmountOut. No entity cell or Cobuild message needed.
   *  Assets stay in the user's secp256r1-locked cells until settlement. */
  async buildAndSubmitOtx(
    otxs:   OTXPayload[],
    pool:   Pool,
    solverSigner: import('@ckb-ccc/core').ccc.SignerCkbPrivateKey,
  ): Promise<string> {
    const scripts = this.config.scripts
    if (otxs.length === 0) throw new Error('[builder] no OTXs to settle')

    // Compute each user's output amount at current pool price
    type Settlement = { otx: OTXPayload; amtOut: bigint }
    const settlements: Settlement[] = otxs.map(otx => {
      const [reserveIn, reserveOut] = pool.tokenX === otx.tokenIn
        ? [pool.reserveX, pool.reserveY]
        : [pool.reserveY, pool.reserveX]
      return { otx, amtOut: getAmountOut(otx.amountIn, reserveIn, reserveOut, pool.feeBps) }
    })

    // Enforce each user's minimum (the lock also enforces this on-chain)
    for (const { otx, amtOut } of settlements) {
      if (amtOut < otx.minAmountOut) {
        throw new Error(`Slippage exceeded for ${otx.ownerLockHash.slice(0, 10)}: got ${amtOut}, min ${otx.minAmountOut}`)
      }
    }

    // Apply all swaps to pool reserves (sequential: order affects price)
    let newRX = pool.reserveX, newRY = pool.reserveY
    for (const { otx, amtOut } of settlements) {
      if (pool.tokenX === otx.tokenIn) { newRX += otx.amountIn; newRY -= amtOut }
      else                              { newRY += otx.amountIn; newRX -= amtOut }
    }

    const epoch       = await this.chain.getTipEpoch()
    const newPoolData = this.encodeUpdatedPool(pool.cell.data, newRX, newRY, epoch)

    // Reserve cells hold the real tokens; they sit right after the info cell.
    const infoTypeHash = ccc.Script.from(pool.cell.output.type!).hash()
    const poolLock = ccc.Script.from({
      codeHash: scripts.poolLock.codeHash as `0x${string}`,
      hashType:  scripts.poolLock.hashType as 'type', args: infoTypeHash as `0x${string}`,
    })
    const reserveInputs: any[] = []
    const reserveOutputs: any[] = []
    const reserveOutData: `0x${string}`[] = []
    if (pool.reserveCellX) {
      reserveInputs.push({ previousOutput: pool.reserveCellX.outPoint })
      reserveOutputs.push({ capacity: pool.reserveCellX.output.capacity, lock: poolLock, type: pool.reserveCellX.output.type as ccc.Script })
      reserveOutData.push(encodeU128LE(newRX))
    }
    if (pool.reserveCellY) {
      reserveInputs.push({ previousOutput: pool.reserveCellY.outPoint })
      reserveOutputs.push({ capacity: pool.reserveCellY.output.capacity, lock: poolLock, type: pool.reserveCellY.output.type as ccc.Script })
      reserveOutData.push(encodeU128LE(newRY))
    }

    // Inputs: info cell, reserve cells, then each user's OTX input cells.
    // Track where each user's first input sits so we can place their witness there.
    const baseInput = 1 + reserveInputs.length   // index 0 = info, then reserve cells
    const userFirstInputIndex: number[] = []
    let inputCursor = baseInput
    const userInputs: Array<{ previousOutput: { txHash: `0x${string}`; index: number } }> = []
    // Sum each user's OTX input-cell capacity. The cellswap-otx-lock requires the owner-locked
    // output capacity to be >= the consumed group's capacity (Error::RentNotRefunded), so the
    // payout must refund at least this much CKB rent. A flat floor silently fails to settle any
    // cell funded above the floor (e.g. a migration done at more than the occupied minimum).
    const OTX_OUTPUT_FLOOR = XUDT_CELL_CAPACITY   // 144 CKB
    const userInputCap: bigint[] = []
    for (const otx of otxs) {
      userFirstInputIndex.push(inputCursor)
      let capSum = 0n
      for (const c of otx.inputCells) {
        userInputs.push({ previousOutput: { txHash: c.txHash as `0x${string}`, index: c.index } })
        const live = await this.chain.getLiveCell({ txHash: c.txHash, index: c.index })
        if (live) capSum += live.output.capacity
        inputCursor++
      }
      userInputCap.push(capSum)
    }

    const tx = ccc.Transaction.from({
      inputs: [
        { previousOutput: pool.cell.outPoint },
        ...reserveInputs,
        ...userInputs,
      ],
      outputs: [
        { capacity: pool.cell.output.capacity, lock: pool.cell.output.lock as ccc.Script, type: pool.cell.output.type as ccc.Script },
        ...reserveOutputs,
        // Each user receives token_out at their owner lock (validated to hash to ownerLockHash).
        ...settlements.map(({ otx }, u) => ({
          // Refund at least the consumed cells' rent (floor for normal occupied-minimum cells).
          capacity: userInputCap[u]! > OTX_OUTPUT_FLOOR ? userInputCap[u]! : OTX_OUTPUT_FLOOR,
          lock: this.lockFromHash(otx),
          // tokenOut uses the reserve cell's real xUDT type (can't rebuild it from a type hash).
          type: (pool.tokenX === otx.tokenIn ? pool.reserveCellY : pool.reserveCellX)!.output.type as ccc.Script,
        })),
      ],
      outputsData: [
        newPoolData,
        ...reserveOutData,
        ...settlements.map(({ amtOut }) => encodeU128LE(amtOut)),
      ],
      cellDeps: [
        ccc.CellDep.from({ outPoint: { txHash: scripts.poolScript.txHash      as `0x${string}`, index: BigInt(scripts.poolScript.index)      }, depType: 'code' }),
        ccc.CellDep.from({ outPoint: { txHash: scripts.poolLock.txHash        as `0x${string}`, index: BigInt(scripts.poolLock.index)        }, depType: 'code' }),
        ccc.CellDep.from({ outPoint: { txHash: scripts.cellswapOtxLock.txHash as `0x${string}`, index: BigInt(scripts.cellswapOtxLock.index) }, depType: 'code' }),
        ccc.CellDep.from({ outPoint: { txHash: scripts.xudtScript.txHash      as `0x${string}`, index: BigInt(scripts.xudtScript.index)      }, depType: 'code' }),
        // pool info cell uses the permissive (always-success) lock; its code must be available.
        ccc.CellDep.from({ outPoint: { txHash: scripts.alwaysSuccess.txHash   as `0x${string}`, index: BigInt(scripts.alwaysSuccess.index)   }, depType: 'code' }),
      ],
    })

    // Place each user's WebAuthn witness at their first input index.
    // The cellswap-otx-lock reads WitnessArgs.lock from the group's first witness.
    const witnesses: `0x${string}`[] = ['0x']  // index 0: pool cell (permissive lock)
    for (let i = 1; i < inputCursor; i++) witnesses.push('0x')
    otxs.forEach((otx, u) => {
      const idx = userFirstInputIndex[u]!
      witnesses[idx] = ccc.hexFrom(ccc.WitnessArgs.from({
        lock: otx.witness,
        inputType: undefined,
        outputType: undefined,
      }).toBytes()) as `0x${string}`
    })
    tx.witnesses = witnesses

    // The cellswap-otx-lock checks each committed deadline against HeaderDep[0]'s epoch.
    // Attach the tip header (epoch == now <= every still-valid deadline) so settlement passes; an
    // OTX whose deadline has already lapsed cannot be settled (the lock returns Expired).
    const tipHeader = await this.chain.raw.getTipHeader()
    tx.headerDeps.push((tipHeader as { hash: `0x${string}` }).hash)

    await tx.completeFeeBy(solverSigner, DEFAULT_FEE_RATE)
    return solverSigner.sendTransaction(tx)
  }

  /** Reconstruct the user's owner lock; validate its hash matches the committed ownerLockHash. */
  private lockFromHash(otx: OTXPayload): ccc.Script {
    const script = ccc.Script.from(otx.ownerLock)
    if (script.hash() !== otx.ownerLockHash) {
      throw new Error('[builder] ownerLock does not match committed ownerLockHash')
    }
    return script
  }

  private encodeUpdatedPool(
    originalData: string,
    _newReserveX:  bigint,   // reserves live in reserve cells, not info data
    _newReserveY:  bigint,
    epoch:        bigint,
  ): `0x${string}` {
    const hex    = originalData.startsWith('0x') ? originalData.slice(2) : originalData
    const result = hexToUint8Array(hex.padEnd(POOL_DATA_SIZE * 2, '0'))
    writeU64LE(result, epoch, POOL_LAST_EPOCH_OFF)
    return ('0x' + uint8ArrayToHex(result)) as `0x${string}`
  }
}