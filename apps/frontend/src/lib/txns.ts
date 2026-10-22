// src/lib/txns.ts: derive a human transaction feed by diffing consecutive pool states.
import type { PricePoint } from './history'
import type { TokenInfo } from './tokens'

export type TxnKind = 'create' | 'swap' | 'add' | 'remove'
export interface Txn {
  kind: TxnKind
  time: number
  txHash: string
  /** signed deltas in base units (output reserves − previous) */
  dx: bigint
  dy: bigint
  tokenX?: TokenInfo
  tokenY?: TokenInfo
}

export function deriveTxns(points: PricePoint[], tokenX?: TokenInfo, tokenY?: TokenInfo): Txn[] {
  const out: Txn[] = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    if (i === 0) {
      out.push({ kind: 'create', time: p.time, txHash: p.txHash, dx: p.reserveX, dy: p.reserveY, tokenX, tokenY })
      continue
    }
    const prev = points[i - 1]
    const dx = p.reserveX - prev.reserveX
    const dy = p.reserveY - prev.reserveY
    let kind: TxnKind = 'swap'
    if (dx > 0n && dy > 0n) kind = 'add'
    else if (dx < 0n && dy < 0n) kind = 'remove'
    else kind = 'swap'
    out.push({ kind, time: p.time, txHash: p.txHash, dx, dy, tokenX, tokenY })
  }
  return out.reverse() // newest first
}
