// @cellswap/router: pure path finding, no I/O
// Multi-hop slippage is applied per hop, not just to the final output

import type { Pool, SwapQuote, SwapRoute, TypeHash } from '@cellswap/types'
import { HIGH_IMPACT_THRESHOLD, MIN_SWAP_AMOUNT, CKB_TYPE_HASH } from '@cellswap/types'

export const FEE_DENOMINATOR = 10_000n

// ─── AMM Math (mirrors Rust shared/amm-math) ─────────────────────────────

export function getAmountOut(
  amountIn:   bigint,
  reserveIn:  bigint,
  reserveOut: bigint,
  feeBps:     number,
): bigint {
  if (amountIn === 0n) throw new Error('Zero input')
  if (reserveIn === 0n || reserveOut === 0n) throw new Error('Zero reserve')
  const fee     = BigInt(feeBps)
  const num     = amountIn * (FEE_DENOMINATOR - fee) * reserveOut
  const den     = reserveIn * FEE_DENOMINATOR + amountIn * (FEE_DENOMINATOR - fee)
  return num / den
}

export function getPriceImpact(
  amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBps: number,
): number {
  const midPrice = Number(reserveOut) / Number(reserveIn)
  const amountOut = getAmountOut(amountIn, reserveIn, reserveOut, feeBps)
  const execPrice = Number(amountOut) / Number(amountIn)
  return Math.abs(midPrice - execPrice) / midPrice
}

// ─── Router ───────────────────────────────────────────────────────────────

export class Router {
  constructor(private pools: Pool[]) {}

  quote(tokenIn: TypeHash, tokenOut: TypeHash, amountIn: bigint, slippage: number): SwapQuote {
    if (amountIn < MIN_SWAP_AMOUNT) {
      throw new Error(`Amount too small: minimum is ${MIN_SWAP_AMOUNT} base units`)
    }

    // Try direct route
    const direct = this.findDirectPool(tokenIn, tokenOut)
    if (direct) return this.quoteViaPool(direct, tokenIn, amountIn, slippage)

    // Try 2-hop
    const twoHop = this.findTwoHopRoute(tokenIn, tokenOut)
    if (twoHop) return this.quoteTwoHop(twoHop, tokenIn, tokenOut, amountIn, slippage)

    throw new Error(`No route: ${tokenIn} → ${tokenOut}`)
  }

  findP2PMatch(
    a: { tokenIn: TypeHash; tokenOut: TypeHash; amountIn: bigint; minAmountOut: bigint },
    b: { tokenIn: TypeHash; tokenOut: TypeHash; amountIn: bigint; minAmountOut: bigint },
  ): boolean {
    return (
      a.tokenIn === b.tokenOut && a.tokenOut === b.tokenIn &&
      a.amountIn >= b.minAmountOut && b.amountIn >= a.minAmountOut
    )
  }

  // ─── Private ───────────────────────────────────────────────────────────

  private findDirectPool(tokenIn: TypeHash, tokenOut: TypeHash): Pool | null {
    // Pool creation is permissionless, so a pair can have several pools (including empty decoys).
    // Pick the deepest one by reserve product: a first-match that landed on a zero-reserve pool
    // would make getAmountOut throw 'Zero reserve' even when a funded pool for the pair exists.
    const matches = this.pools.filter(p =>
      !p.paused && (
        (p.tokenX === tokenIn  && p.tokenY === tokenOut) ||
        (p.tokenX === tokenOut && p.tokenY === tokenIn)
      )
    )
    if (matches.length === 0) return null
    return matches.reduce((best, p) =>
      (p.reserveX * p.reserveY) > (best.reserveX * best.reserveY) ? p : best)
  }

  private findTwoHopRoute(tokenIn: TypeHash, tokenOut: TypeHash): [Pool, Pool] | null {
    for (const poolA of this.pools) {
      if (poolA.paused) continue
      const mid = poolA.tokenX === tokenIn ? poolA.tokenY
                : poolA.tokenY === tokenIn ? poolA.tokenX
                : null
      if (!mid) continue
      const poolB = this.findDirectPool(mid, tokenOut)
      if (poolB) return [poolA, poolB]
    }
    return null
  }

  private quoteViaPool(
    pool: Pool, tokenIn: TypeHash, amountIn: bigint, slippage: number,
  ): SwapQuote {
    const [rIn, rOut] = this.getReserves(pool, tokenIn)
    const amountOut   = getAmountOut(amountIn, rIn, rOut, pool.feeBps)
    const impact      = getPriceImpact(amountIn, rIn, rOut, pool.feeBps)

    // Apply slippage to final output
    const slippageBps = BigInt(Math.floor(slippage * 10_000))
    const minOut      = amountOut * (10_000n - slippageBps) / 10_000n
    const tokenOut    = pool.tokenX === tokenIn ? pool.tokenY : pool.tokenX

    return {
      amountIn,
      amountOut,
      minAmountOut:   minOut,
      priceImpact:    impact,
      fee:            amountIn * BigInt(pool.feeBps) / FEE_DENOMINATOR,
      route:          { path: [tokenIn, tokenOut], pools: [pool], hops: 1 },
      executionPrice: Number(amountOut) / Number(amountIn),
      warning:        impact > HIGH_IMPACT_THRESHOLD ? 'HIGH_IMPACT' : undefined,
    }
  }

  private quoteTwoHop(
    [poolA, poolB]: [Pool, Pool],
    tokenIn: TypeHash,
    tokenOut: TypeHash,
    amountIn: bigint,
    slippage: number,
  ): SwapQuote {
    const mid    = poolA.tokenX === tokenIn ? poolA.tokenY : poolA.tokenX
    const [rA_in, rA_out] = this.getReserves(poolA, tokenIn)
    const midAmount       = getAmountOut(amountIn, rA_in, rA_out, poolA.feeBps)

    const [rB_in, rB_out] = this.getReserves(poolB, mid)
    const amountOut       = getAmountOut(midAmount, rB_in, rB_out, poolB.feeBps)

    // For multi-hop: slippage applied at each hop, then compounded
    // This gives a tighter and more accurate minAmountOut than applying once to the final
    const hopSlippage  = 1 - Math.sqrt(1 - slippage)     // per-hop slippage for compound effect
    const slipBps      = BigInt(Math.floor(hopSlippage * 10_000))
    const minMid       = midAmount   * (10_000n - slipBps) / 10_000n
    const minOut       = getAmountOut(minMid, rB_in, rB_out, poolB.feeBps)
                       * (10_000n - slipBps) / 10_000n

    const impactA = getPriceImpact(amountIn,  rA_in, rA_out, poolA.feeBps)
    const impactB = getPriceImpact(midAmount, rB_in, rB_out, poolB.feeBps)
    const totalImpact = 1 - (1 - impactA) * (1 - impactB)

    return {
      amountIn,
      amountOut,
      minAmountOut:   minOut,
      priceImpact:    totalImpact,
      fee:            amountIn * BigInt(poolA.feeBps + poolB.feeBps) / FEE_DENOMINATOR,
      route:          { path: [tokenIn, mid, tokenOut], pools: [poolA, poolB], hops: 2 },
      executionPrice: Number(amountOut) / Number(amountIn),
      warning:        totalImpact > HIGH_IMPACT_THRESHOLD ? 'HIGH_IMPACT' : undefined,
    }
  }

  /** Get [reserveIn, reserveOut] in the direction of the trade. */
  private getReserves(pool: Pool, tokenIn: TypeHash): [bigint, bigint] {
    return pool.tokenX === tokenIn
      ? [pool.reserveX, pool.reserveY]
      : [pool.reserveY, pool.reserveX]
  }
}

export { Pool, SwapQuote, SwapRoute, TypeHash } from '@cellswap/types'
