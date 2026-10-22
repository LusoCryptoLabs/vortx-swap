// src/lib/pricing.ts: derive token prices (in CKB) and pool TVL from the live pools.
import { sdk } from './cellswap'
import { CKB, CKB_TYPE_HASH, TOKEN_LIST, tokenByArgs, isVerifiedToken, type TokenInfo } from './tokens'
import { compact, shortHash } from './utils'
import type { Pool } from '@cellswap/sdk'

/** type hash (what pools store) → TokenInfo (what the UI shows). */
let _byTypeHash: Map<string, TokenInfo> | null = null
export function tokenByTypeHash(typeHash: string): TokenInfo | undefined {
  if (!_byTypeHash) {
    _byTypeHash = new Map()
    for (const t of TOKEN_LIST) {
      const th = (t.args === CKB ? CKB_TYPE_HASH : sdk.udtHash(t.args as any).toLowerCase())
      _byTypeHash.set(th, t)
    }
  }
  return _byTypeHash.get(typeHash.toLowerCase())
}

const human = (raw: bigint, decimals: number) => Number(raw) / 10 ** decimals

export interface EnrichedPool {
  pool: Pool
  tokenX?: TokenInfo
  tokenY?: TokenInfo
  /** spot price: tokenY per tokenX */
  priceYperX: number
  /** total value locked, in CKB (NaN if a side can't be priced) */
  tvlCkb: number
  /** both sides have a path to a base asset → value is realizable */
  anchored: boolean
  /** xUDT/xUDT pool priced only by routing; its CKB value relies on arbitrage staying aligned */
  arbDependent: boolean
  /** realizable CKB depth: the thinnest pool you'd route through to exit to CKB */
  effectiveCkbDepth: number
  id: string
}

// Base assets: what liquidity must bottom out in to be "real". Only CKB; curated stablecoins
// could be added here.
const BASE_ASSETS = new Set([CKB_TYPE_HASH])

export interface Anchor {
  price: number              // CKB per 1 human unit
  hops: number               // 0 = a base asset, 1 = direct CKB pool, 2+ = routed via intermediaries
  hasDirectBasePool: boolean // is one hop from a base asset (its own CKB market)
  /** bottleneck pool CKB-TVL along the realization path: the depth you can actually exit through */
  effectiveCkbDepth: number
}

/**
 * Anchor every token to the base assets by BFS over the pool graph (shortest path).
 * A token is "anchored" iff it appears in the returned map (a liquid path to CKB exists).
 * Each entry carries its CKB price, hop count, and the bottleneck depth on the path,
 * because a derived price is only realizable up to the thinnest pool you'd route through.
 */
export function buildAnchoring(pools: Pool[]): Map<string, Anchor> {
  // adjacency: token type hash → [{ other, pool }]
  const adj = new Map<string, { other: string; pool: Pool }[]>()
  const push = (k: string, v: { other: string; pool: Pool }) => {
    const a = adj.get(k); if (a) a.push(v); else adj.set(k, [v])
  }
  for (const p of pools) {
    const xh = p.tokenX.toLowerCase(), yh = p.tokenY.toLowerCase()
    push(xh, { other: yh, pool: p }); push(yh, { other: xh, pool: p })
  }

  const anchor = new Map<string, Anchor>()
  const queue: string[] = []
  for (const b of BASE_ASSETS) {
    anchor.set(b, { price: 1, hops: 0, hasDirectBasePool: false, effectiveCkbDepth: Infinity })
    queue.push(b)
  }

  while (queue.length) {
    const cur = queue.shift()!
    const ca = anchor.get(cur)!
    for (const { other, pool } of adj.get(cur) ?? []) {
      if (anchor.has(other)) continue            // BFS → first (shortest) path wins
      const curIsX = pool.tokenX.toLowerCase() === cur
      const dx = tokenByTypeHash(pool.tokenX)?.decimals ?? 8
      const dy = tokenByTypeHash(pool.tokenY)?.decimals ?? 8
      const rCur = human(curIsX ? pool.reserveX : pool.reserveY, curIsX ? dx : dy)
      const rOther = human(curIsX ? pool.reserveY : pool.reserveX, curIsX ? dy : dx)
      if (rCur <= 0 || rOther <= 0) continue
      const price = ca.price * (rCur / rOther)
      const poolDepthCkb = 2 * rCur * ca.price    // this pool's CKB-denominated TVL
      anchor.set(other, {
        price,
        hops: ca.hops + 1,
        hasDirectBasePool: BASE_ASSETS.has(cur),
        effectiveCkbDepth: Math.min(ca.effectiveCkbDepth, poolDepthCkb),
      })
      queue.push(other)
    }
  }
  return anchor
}

/** Backward-compatible price map (CKB per 1 human unit), derived from the anchoring. */
export function buildPricer(pools: Pool[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const [k, a] of buildAnchoring(pools)) out.set(k, a.price)
  return out
}

export const isBaseAsset = (typeHash: string) => BASE_ASSETS.has(typeHash.toLowerCase())

export function enrichPools(pools: Pool[]): EnrichedPool[] {
  const anchor = buildAnchoring(pools)
  return pools.map(p => {
    const xh = p.tokenX.toLowerCase(), yh = p.tokenY.toLowerCase()
    const tokenX = tokenByTypeHash(p.tokenX)
    const tokenY = tokenByTypeHash(p.tokenY)
    const dx = tokenX?.decimals ?? 8, dy = tokenY?.decimals ?? 8
    const rx = human(p.reserveX, dx), ry = human(p.reserveY, dy)
    const ax = anchor.get(xh), ay = anchor.get(yh)
    const tvlCkb = (ax ? rx * ax.price : NaN) + (ay ? ry * ay.price : NaN)
    const anchored = !!ax && !!ay
    const hasBaseSide = isBaseAsset(xh) || isBaseAsset(yh)
    return {
      pool: p, tokenX, tokenY,
      priceYperX: rx > 0 ? ry / rx : 0,
      tvlCkb,
      anchored,
      arbDependent: anchored && !hasBaseSide,
      effectiveCkbDepth: Math.min(ax?.effectiveCkbDepth ?? NaN, ay?.effectiveCkbDepth ?? NaN),
      id: p.poolId.toString(),
    }
  })
}

/** Anchor info for a single token (by its xUDT args / CKB). undefined = unanchored (no path to CKB). */
export function anchorOf(pools: Pool[], args: string): Anchor | undefined {
  const th = args === CKB ? CKB_TYPE_HASH : sdk.udtHash(args as any).toLowerCase()
  return buildAnchoring(pools).get(th)
}

// An unresolved token shows a short form of its args (a real, if unfamiliar, identifier) rather than
// "???", so an unverified-but-real pool reads as unknown, not broken.
const pairSym = (t?: TokenInfo) => t?.symbol ?? (t?.args ? shortHash(t.args, 4) : 'Unknown')
export function poolPairLabel(e: EnrichedPool): string {
  return `${pairSym(e.tokenX)} / ${pairSym(e.tokenY)}`
}

// A reserve below this many whole units can't facilitate a real trade: the pool is degenerate
// (e.g. drained to dust by earlier swaps). At those reserves the constant-product marginal price
// explodes, so both the price and the marginal-price TVL of that side are paper, not realizable.
const DUST_UNITS = 0.01

/** True when a side's reserve is dust, so the pool's price/TVL are unreliable. We only check the
 *  xUDT side(s): a CKB-native pool's CKB reserve is real CKB (and floored by MIN_POOL_CAPACITY). */
export function isLowLiquidity(e: EnrichedPool): boolean {
  const human = (raw: bigint, dec: number) => Number(raw) / 10 ** dec
  const ry = human(e.pool.reserveY, e.tokenY?.decimals ?? 8)
  if (e.pool.poolMode === 'CKB_XUDT') return ry < DUST_UNITS          // tokenY = the xUDT
  const rx = human(e.pool.reserveX, e.tokenX?.decimals ?? 8)
  return rx < DUST_UNITS || ry < DUST_UNITS
}

/** Realizable TVL in CKB. Two paper-value cases get capped so the figure reflects real liquidity:
 *  - low-liquidity (dust on one side): count only the realizable side: the CKB reserve for a
 *    CKB-native pool, or the effective depth for an xUDT pair.
 *  - arbitrage-dependent (no direct CKB side): cap at the thinnest pool on the routing path. */
export function realizableTvl(e: EnrichedPool): number {
  if (!isFinite(e.tvlCkb)) return NaN
  if (isLowLiquidity(e)) {
    if (e.pool.poolMode === 'CKB_XUDT') return Number(e.pool.reserveX) / 1e8   // CKB side only
    return isFinite(e.effectiveCkbDepth) ? e.effectiveCkbDepth : 0
  }
  if (e.arbDependent && isFinite(e.effectiveCkbDepth)) return Math.min(e.tvlCkb, e.effectiveCkbDepth)
  return e.tvlCkb
}

/** Pick the pool that best represents a token's price trend: prefer a direct-CKB, anchored,
 *  deepest pool, so its history series IS the token's CKB price (oriented so the token is the
 *  numerator). Returns the pool id + whether the token is side X. */
export function bestPoolForToken(views: EnrichedPool[], tokenArgs: string): { id: string; tokenIsX: boolean } | null {
  const th = tokenArgs === CKB ? CKB_TYPE_HASH : sdk.udtHash(tokenArgs as any).toLowerCase()
  let best: { id: string; tokenIsX: boolean; score: number } | null = null
  for (const e of views) {
    const xh = e.pool.tokenX.toLowerCase(), yh = e.pool.tokenY.toLowerCase()
    const tokenIsX = xh === th
    if (!tokenIsX && yh !== th) continue
    const otherIsCkb = (tokenIsX ? yh : xh) === CKB_TYPE_HASH
    const depth = isFinite(realizableTvl(e)) ? realizableTvl(e) : 0
    // direct-CKB pools win decisively (their series is a true CKB price); break ties by depth.
    const score = (otherIsCkb ? 1e15 : 0) + (e.anchored ? depth : 0)
    if (!best || score > best.score) best = { id: e.id, tokenIsX, score }
  }
  return best
}

/** Percentage change (last vs first) of a numeric series; null if fewer than 2 points. */
export function pctChange(series: number[]): number | null {
  const s = series.filter(n => isFinite(n) && n > 0)
  return s.length >= 2 && s[0] > 0 ? (s[s.length - 1] - s[0]) / s[0] : null
}

/** CKB-denominated swap throughput since `sinceSec`, from a pool's history. Counts only swaps
 *  (opposite-sign reserve moves; liquidity events move both sides the same way), valuing the
 *  X-side delta at its CKB price. */
export function volumeCkbSince(
  history: { time: number; reserveX: bigint; reserveY: bigint }[],
  priceXckb: number, decimalsX: number, sinceSec: number,
): number {
  if (!isFinite(priceXckb)) return NaN
  let v = 0
  for (let i = 1; i < history.length; i++) {
    const a = history[i - 1], b = history[i]
    if (b.time < sinceSec) continue
    const dx = b.reserveX - a.reserveX, dy = b.reserveY - a.reserveY
    if (!((dx > 0n && dy < 0n) || (dx < 0n && dy > 0n))) continue   // swaps only
    v += (Number(dx < 0n ? -dx : dx) / 10 ** decimalsX) * priceXckb
  }
  return v
}

export type RiskLevel = 'low' | 'medium' | 'high'
export interface TokenRisk { level: RiskLevel; label: string; reasons: string[] }

/** A risk read for a token, built from what we already know on-chain: curated verification,
 *  whether it has a liquid path to CKB, and how deep that exit is. Every signal is spelled out in
 *  `reasons`. */
export function tokenRisk(pools: Pool[], args: string): TokenRisk {
  if (args.toLowerCase() === CKB) return { level: 'low', label: 'Base asset', reasons: ['CKB is the network’s base asset.'] }
  const reasons: string[] = []
  let level: RiskLevel = 'low'
  const bump = (l: RiskLevel) => { if (l === 'high' || (l === 'medium' && level === 'low')) level = l }

  if (isVerifiedToken(args)) reasons.push('On our official list, verified as the real token.')
  else { reasons.push('Not verified. Anyone can create a look-alike, so double-check this is the real one before trading.'); bump('medium') }

  const anchor = anchorOf(pools, args)
  if (!anchor) { reasons.push('Can’t be traded for CKB, so there’s no reliable price and no easy way to cash out.'); bump('high') }
  else {
    const depth = anchor.effectiveCkbDepth
    if (!isFinite(depth) || depth < 1000) { reasons.push(`Very little CKB available (~${compact(depth)} CKB), so anything but a small trade will get a poor price.`); bump('medium') }
    else reasons.push(`Can be cashed out to CKB (~${compact(depth)} CKB available).`)
    if (anchor.hops > 1) { reasons.push('No direct CKB pair. The price is estimated through other pools, so it can be less reliable.'); bump('medium') }
  }
  const label = level === 'low' ? 'Low risk' : level === 'medium' ? 'Use caution' : 'High risk'
  return { level, label, reasons }
}

export { tokenByArgs }
