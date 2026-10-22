// src/lib/orders.ts
// Relay a placed resting (limit / async) order to the aggregator's fill loop.
//
// The intent-lock cell stores only the owner's lock hash, but settling the order means
// building an output that pays the owner, which needs the full lock script. So after the
// user signs the placement tx, we hand the keeper the outpoint + full owner lock. The
// keeper still can't cheat: the intent-lock validates on-chain that the owner is paid
// >= minOut, so relaying only grants liveness (it gets filled), never custody.
import { ccc } from '@ckb-ccc/connector-react'
import { AGGREGATOR_URL } from './cellswap'
import { authHeaders } from './testerAuth'

/** POST a just-placed order to the keeper. `index` is the intent cell's output index
 *  (0: swapAsync emits the intent cell first). Best-effort: a failure here only means
 *  the order won't auto-fill (it still rests on-chain and is cancelable). */
export async function relayLimitOrder(signer: ccc.Signer, txHash: string, index = 0): Promise<boolean> {
  try {
    const addr = await signer.getRecommendedAddressObj()
    const s = addr.script
    const body = {
      outPoint: { txHash, index },
      ownerLock: { codeHash: s.codeHash, hashType: s.hashType, args: s.args },
    }
    const res = await fetch(`${AGGREGATOR_URL}/orders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    })
    return res.ok
  } catch {
    return false
  }
}
