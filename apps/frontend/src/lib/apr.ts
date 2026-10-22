// src/lib/apr.ts: best-effort fee APR for a pool, without a subgraph.
// LP yield on a constant-product AMM is implicit: every swap charges feeBps on the input
// and that fee stays in the reserves (k grows). So we reconstruct realized fees by diffing
// the reserve snapshots from fetchPoolHistory: a swap moves exactly one reserve up (the
// trader's input) and the other down. fee = inputAmount * feeBps/10000, valued in CKB via
// the anchoring price, then annualized over the observed window and divided by TVL.
import type { PricePoint } from './history'

const SECONDS_PER_YEAR = 365 * 24 * 3600

export interface AprStat {
  /** annualized fee income as a % of TVL */
  aprPct: number
  /** fees actually observed in the window, in CKB */
  feesCkbWindow: number
  /** length of the observed window, in days (annualization is only as good as this) */
  windowDays: number
  /** number of swaps the window covers */
  swaps: number
}

/** Compute fee APR from a pool's reserve history. Returns undefined when it can't be
 *  trusted (unanchored/unpriced pool, no swaps, or a zero-length window). */
export function computePoolApr(opts: {
  history: PricePoint[]
  feeBps: number
  /** CKB per 1 human unit of token X (NaN if unanchored) */
  priceXckb: number
  /** CKB per 1 human unit of token Y (NaN if unanchored) */
  priceYckb: number
  decimalsX: number
  decimalsY: number
  /** pool TVL in CKB (NaN if a side can't be priced) */
  tvlCkb: number
}): AprStat | undefined {
  const { history, feeBps, priceXckb, priceYckb, decimalsX, decimalsY, tvlCkb } = opts
  if (!(tvlCkb > 0) || !isFinite(tvlCkb)) return undefined
  if (!isFinite(priceXckb) || !isFinite(priceYckb)) return undefined
  if (history.length < 2) return undefined

  let feesCkb = 0
  let swaps = 0
  for (let i = 1; i < history.length; i++) {
    const dx = history[i].reserveX - history[i - 1].reserveX
    const dy = history[i].reserveY - history[i - 1].reserveY
    // a swap moves exactly one reserve up (input) and the other down; add/remove move both
    // the same way, create has no predecessor; those are skipped.
    const isSwap = (dx > 0n && dy < 0n) || (dx < 0n && dy > 0n)
    if (!isSwap) continue
    swaps++
    if (dx > 0n) {
      const inHuman = Number(dx) / 10 ** decimalsX
      feesCkb += inHuman * (feeBps / 10_000) * priceXckb
    } else {
      const inHuman = Number(dy) / 10 ** decimalsY
      feesCkb += inHuman * (feeBps / 10_000) * priceYckb
    }
  }
  if (swaps === 0) return undefined

  const windowSec = history[history.length - 1].time - history[0].time
  if (windowSec <= 0) return undefined

  const feesPerYear = feesCkb * (SECONDS_PER_YEAR / windowSec)
  return {
    aprPct: (feesPerYear / tvlCkb) * 100,
    feesCkbWindow: feesCkb,
    windowDays: windowSec / 86_400,
    swaps,
  }
}
