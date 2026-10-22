// src/lib/transfer.ts: plain CKB / xUDT transfers via CCC (no SDK method for this).
import { ccc } from '@ckb-ccc/connector-react'
import { config } from './cellswap'
import { CKB } from './tokens'

const encodeU128LE = (v: bigint) => {
  const b = new Uint8Array(16)
  let n = v; for (let i = 0; i < 16; i++) { b[i] = Number(n & 0xffn); n >>= 8n }
  return ('0x' + Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('')) as `0x${string}`
}

/** Send `amount` (base units) of a token to `toAddress`. tokenArgs = CKB zero hash for native CKB. */
export async function sendToken(
  signer: ccc.Signer, toAddress: string, tokenArgs: string, amount: bigint,
): Promise<string> {
  const client = signer.client
  const to = await ccc.Address.fromString(toAddress, client)

  if (tokenArgs === CKB) {
    const tx = ccc.Transaction.from({ outputs: [{ capacity: amount, lock: to.script }] })
    await tx.completeInputsByCapacity(signer)
    await tx.completeFeeBy(signer, 1000)
    return signer.sendTransaction(tx)
  }

  const xudt = ccc.Script.from({
    codeHash: config.scripts.xudtScript.codeHash as `0x${string}`,
    hashType: config.scripts.xudtScript.hashType as 'type', args: tokenArgs as `0x${string}`,
  })
  const tx = ccc.Transaction.from({
    outputs: [{ capacity: 14_400_000_000n, lock: to.script, type: xudt }],
    outputsData: [encodeU128LE(amount)],
  })
  await tx.addCellDepsOfKnownScripts(client, ccc.KnownScript.XUdt)
  await tx.completeInputsByUdt(signer, xudt)
  // completeInputsByUdt collects whole cells until their UDT sum covers `amount`, so the inputs
  // usually hold more than we send. completeFeeBy only ever adds a typeless CKB change cell, so
  // without an explicit UDT change output the surplus token is silently burned. Pay the remainder
  // back to the sender's own lock before completing capacity/fee.
  const inputUdt = await tx.getInputsUdtBalance(client, xudt)
  const outputUdt = tx.getOutputsUdtBalance(xudt)
  if (inputUdt > outputUdt) {
    const { script: changeLock } = await signer.getRecommendedAddressObj()
    tx.addOutput({ capacity: 14_400_000_000n, lock: changeLock, type: xudt }, encodeU128LE(inputUdt - outputUdt))
  }
  await tx.completeInputsByCapacity(signer)
  await tx.completeFeeBy(signer, 1000)
  return signer.sendTransaction(tx)
}
