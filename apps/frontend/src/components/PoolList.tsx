import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ShieldAlert, Plus } from 'lucide-react'
import { PairLogos } from './TokenLogo'
import { Sparkline } from './charts/Sparkline'
import { Button } from './ui/button'
import { Hint } from './ui/hint'
import { LiquidityModal } from './LiquidityModal'
import { compact, cn, fmtPrice, EMPTY } from '../lib/utils'
import { poolPairLabel, realizableTvl, isLowLiquidity, pctChange, type EnrichedPool } from '../lib/pricing'
import { isVerifiedToken } from '../lib/tokens'
import type { AprStat } from '../hooks/useData'
import type { PricePoint } from '../lib/history'

// APR display guards: a number annualized from a tiny window is noise. Below ~2h → "new"; below
// a full day (or <3 swaps) → shown muted as a low-confidence estimate; absurd values are capped.
const TOO_FRESH_DAYS = 0.08
const CONFIDENT_DAYS = 1
function aprDisplay(a?: AprStat): { txt: string; muted: boolean; title: string } | 'new' | null {
  if (!a) return null
  if (a.windowDays < TOO_FRESH_DAYS) return 'new'
  const v = a.aprPct
  const txt = v >= 1000 ? '>999%' : v < 0.01 ? '<0.01%' : `${compact(v)}%`
  const muted = a.windowDays < CONFIDENT_DAYS || a.swaps < 3
  const win = a.windowDays < 1 ? '<1' : a.windowDays.toFixed(0)
  return { txt, muted, title: `Estimated yearly return from ${a.swaps} trade${a.swaps === 1 ? '' : 's'} over ${win} day${a.windowDays >= 2 ? 's' : ''}${muted ? ' (rough estimate, not much history yet)' : ''}, based on recent trading fees.` }
}

// A pool side is "trusted" when it's CKB or a curated/verified token; otherwise it's a token anyone
// could have minted under that symbol, so the pair gets an "unverified" flag.
const sideVerified = (t?: { args: string }) => !!t && isVerifiedToken(t.args)

// Below this realizable CKB depth a pool is effectively dead (drained to dust / never seeded) and
// adds only noise to the default list.
const FLOOR_CKB = 1
const rtvl = (e: EnrichedPool) => { const r = realizableTvl(e); return isFinite(r) ? r : -Infinity }

// Pools are keyed on-chain by token type hash + fee, never by symbol. So two rows can read the same
// ("CKB / TKA") yet be different tokens, and legacy testnet runs leave several pools for the very
// same (pair, fee). Collapse each (pair, fee) to its deepest pool; the redundant copies + any dead
// sub-floor pools move behind a "show all" toggle so the default list reads cleanly.
function dedupeKey(e: EnrichedPool): string {
  const a = e.pool.tokenX.toLowerCase(), b = e.pool.tokenY.toLowerCase()
  const [lo, hi] = a < b ? [a, b] : [b, a]
  return `${lo}-${hi}-${e.pool.feeBps}`
}

// Fee tier chip, shown next to the pair so identical-looking pairs at different tiers are
// distinguishable at a glance (the on-chain identity differs even when the name doesn't).
function feeChip(feeBps: number) {
  return (
    <span className="num inline-flex items-center gap-0.5 rounded bg-surface px-1.5 py-0.5 text-[10px] text-faint">
      {(feeBps / 100).toFixed(2)}%
      <Hint text="Trading fee charged on each swap in this pool. It is split among the pool's liquidity providers." />
    </span>
  )
}

// On a phone card we show only the single most important status (the desktop table shows them all),
// so the row reads cleanly instead of stacking up to five chips. Priority: safety > trust > housekeeping.
function priorityChip(e: EnrichedPool, reason: 'duplicate' | 'inactive' | null, lowLiq: boolean, unverified: boolean) {
  if (lowLiq) return <span className="flex items-center gap-1 rounded bg-negative/15 px-1.5 py-0.5 text-[10px] text-negative"><AlertTriangle className="h-3 w-3" />low liquidity</span>
  if (!e.anchored) return <span className="flex items-center gap-1 rounded bg-negative/15 px-1.5 py-0.5 text-[10px] text-negative"><AlertTriangle className="h-3 w-3" />no CKB price</span>
  if (unverified) return <span className="flex items-center gap-1 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning"><ShieldAlert className="h-3 w-3" />unverified</span>
  if (reason === 'duplicate') return <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] text-faint">duplicate</span>
  if (reason === 'inactive') return <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] text-faint">inactive</span>
  if (e.arbDependent) return <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning">estimated</span>
  return null
}

// Shared cell formatters (used by both the desktop table and the mobile card).
function tvlText(e: EnrichedPool) {
  const r = realizableTvl(e)
  return isFinite(r) ? `${compact(r)} CKB` : EMPTY
}
function aprText(a?: AprStat): { txt: string; cls: string } {
  const d = aprDisplay(a)
  if (!d) return { txt: EMPTY, cls: 'text-faint' }
  if (d === 'new') return { txt: 'new', cls: 'text-faint' }
  return { txt: `${d.muted ? '~' : ''}${d.txt}`, cls: d.muted ? 'text-muted' : 'text-positive' }
}

export function PoolList({ pools, aprs, histories, onChanged }: { pools: EnrichedPool[]; aprs?: Map<string, AprStat>; histories?: Map<string, PricePoint[]>; onChanged?: () => void }) {
  const [showAll, setShowAll] = useState(false)
  // Which pool's "Add liquidity" sheet is open (the existing LiquidityModal, in add mode). Keeping the
  // chosen pool in state lets a single shared modal serve every row.
  const [addTo, setAddTo] = useState<EnrichedPool | null>(null)
  if (!pools.length) return <div className="py-12 text-center text-sm text-faint">No pools found on this network.</div>

  const sorted = [...pools].sort((a, b) => rtvl(b) - rtvl(a))

  // The deepest pool in each (pair, fee) group is the canonical one; the rest are redundant.
  const primaryId = new Set<string>()
  const groups = new Map<string, EnrichedPool[]>()
  for (const e of sorted) { const k = dedupeKey(e); const g = groups.get(k); if (g) g.push(e); else groups.set(k, [e]) }
  for (const g of groups.values()) primaryId.add(g[0].id)   // g is already TVL-desc (sorted source)

  const hiddenReason = (e: EnrichedPool): 'duplicate' | 'inactive' | null => {
    if (!primaryId.has(e.id)) return 'duplicate'            // a deeper pool exists for this pair+fee
    if (rtvl(e) < FLOOR_CKB) return 'inactive'              // dead / sub-floor (dust)
    return null
  }
  const visible = sorted.filter(e => !hiddenReason(e))
  const hidden = sorted.filter(e => hiddenReason(e))
  const rows = showAll ? sorted : visible

  const toggle = hidden.length > 0 && (
    <div className="border-t border-border/60 px-4 py-3 text-center">
      <button onClick={() => setShowAll(s => !s)} className="text-xs text-faint hover:text-primary">
        {showAll ? `Hide ${hidden.length} duplicate / inactive pool${hidden.length === 1 ? '' : 's'}` : `Show ${hidden.length} more (duplicate & low-activity pool${hidden.length === 1 ? '' : 's'})`}
      </button>
    </div>
  )

  if (!rows.length) return (
    <>
      <div className="py-12 text-center text-sm text-faint">Every pool on this network is currently low-activity or a duplicate. Use "Show all" to see them.</div>
      {toggle}
    </>
  )

  return (
    <>
    {/* Desktop: full table. Mobile (<sm): a stacked card per pool, no horizontal scroll. */}
    <div className="hidden overflow-x-auto sm:block">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-faint">
            <th className="px-4 py-3 font-medium">Pool</th>
            <th className="px-4 py-3 font-medium">Type</th>
            <th className="px-4 py-3 text-right font-medium">Price</th>
            <th className="hidden px-4 py-3 text-right font-medium md:table-cell">7D</th>
            <th className="px-4 py-3 text-right font-medium" title="Total value of tokens in this pool">Value</th>
            <th className="px-4 py-3 text-right font-medium" title="Estimated yearly return for liquidity providers, from recent fees">Est. APR</th>
            <th className="px-4 py-3 text-right font-medium"><span className="sr-only">Add liquidity</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(e => {
            const apr = aprs?.get(e.id)
            const lowLiq = isLowLiquidity(e)
            const unverified = !(sideVerified(e.tokenX) && sideVerified(e.tokenY))
            const reason = hiddenReason(e)
            return (
            <tr key={e.id} className={cn('group border-t border-border/60', reason && 'opacity-60')}>
              <td className="px-4 py-3">
                <Link to={`/pools/${e.id}`} className="flex flex-wrap items-center gap-2">
                  <PairLogos a={e.tokenX?.symbol ?? '?'} b={e.tokenY?.symbol ?? '?'} tokenA={e.tokenX} tokenB={e.tokenY} />
                  <span className="font-medium group-hover:text-primary">{poolPairLabel(e)}</span>
                  {feeChip(e.pool.feeBps)}
                  {unverified && <span title="This token isn't on our verified list. Anyone can mint a look-alike under the same name. Double-check it's the real one before trading." className="flex items-center gap-1 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning"><ShieldAlert className="h-3 w-3" />unverified</span>}
                  {reason === 'duplicate' && <span title="Another pool already exists for this exact pair and fee with more liquidity. This is a redundant copy." className="rounded bg-surface px-1.5 py-0.5 text-[10px] text-faint">duplicate</span>}
                  {reason === 'inactive' && <span title="This pool has almost no liquidity left and can't facilitate real trades." className="rounded bg-surface px-1.5 py-0.5 text-[10px] text-faint">inactive</span>}
                  {lowLiq
                    ? <span title="One side of this pool is nearly empty, so it can't handle real trades and its price isn't reliable." className="flex items-center gap-1 rounded bg-negative/15 px-1.5 py-0.5 text-[10px] text-negative"><AlertTriangle className="h-3 w-3" />low liquidity</span>
                    : !e.anchored
                      ? <span title="These tokens can't be traded for CKB, so there's no reliable price or way to cash out." className="flex items-center gap-1 rounded bg-negative/15 px-1.5 py-0.5 text-[10px] text-negative"><AlertTriangle className="h-3 w-3" />no CKB price</span>
                      : e.arbDependent
                        ? <span title="Price is estimated through other pools; there's no direct CKB pair." className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning">estimated</span>
                        : null}
                </Link>
              </td>
              <td className="px-4 py-3 text-faint">{e.pool.poolMode === 'CKB_XUDT' ? 'Paired with CKB' : 'Token pair'}</td>
              <td className={cn('num px-4 py-3 text-right', lowLiq && 'text-muted')} title={lowLiq ? 'Not enough in the pool to price reliably' : undefined}>{fmtPrice(e.priceYperX)}</td>
              <td className="hidden px-4 py-3 md:table-cell">
                {(() => {
                  const pts = histories?.get(e.id) ?? []
                  const cutoff = Math.floor(Date.now() / 1000) - 604_800
                  const series = pts.filter(p => p.time >= cutoff).map(p => p.price)
                  const ch = pctChange(series)
                  return <div className="flex justify-end">{series.length >= 2 ? <Sparkline data={series} positive={(ch ?? 0) >= 0} width={84} height={26} /> : <span className="text-faint">{EMPTY}</span>}</div>
                })()}
              </td>
              <td className="num px-4 py-3 text-right">
                {(() => {
                  const r = realizableTvl(e)
                  if (!isFinite(r)) return <span className="text-faint">{EMPTY}</span>
                  const paper = e.arbDependent && isFinite(e.tvlCkb) && e.tvlCkb > r * 1.05
                  return <span
                    className={paper ? 'cursor-help border-b border-dotted border-warning/40' : ''}
                    title={paper ? `Worth ~${compact(e.tvlCkb)} CKB on paper, but you could only actually cash out ~${compact(r)} CKB through the available CKB pools.` : undefined}
                  >{compact(r)} CKB</span>
                })()}
              </td>
              <td className="num px-4 py-3 text-right">
                {(() => {
                  const d = aprDisplay(apr)
                  if (!d) return <span className="text-faint" title="Not enough trading history to estimate">{EMPTY}</span>
                  if (d === 'new') return <span className="text-faint" title="Too new to estimate yet">new</span>
                  return <span className={d.muted ? 'text-muted' : 'text-positive'} title={d.title}>{d.muted ? '~' : ''}{d.txt}</span>
                })()}
              </td>
              <td className="px-4 py-3 text-right">
                <Button variant="outline" size="sm" onClick={() => setAddTo(e)} title="Add both tokens to this pool to earn a share of the trading fees">
                  <Plus className="h-3.5 w-3.5" /> Add liquidity
                </Button>
              </td>
            </tr>
            )
          })}
        </tbody>
      </table>
    </div>

    {/* Mobile stacked cards (no horizontal scroll): pair + fee + one status chip, then Price/Value/APR */}
    <div className="divide-y divide-border/60 sm:hidden">
      {rows.map(e => {
        const apr = aprs?.get(e.id)
        const lowLiq = isLowLiquidity(e)
        const unverified = !(sideVerified(e.tokenX) && sideVerified(e.tokenY))
        const reason = hiddenReason(e)
        const chip = priorityChip(e, reason, lowLiq, unverified)
        const aprS = aprText(apr)
        return (
          <div key={e.id} className={cn('px-1 py-3', reason && 'opacity-60')}>
            <Link to={`/pools/${e.id}`} className="group block">
              <div className="flex flex-wrap items-center gap-2">
                <PairLogos a={e.tokenX?.symbol ?? '?'} b={e.tokenY?.symbol ?? '?'} tokenA={e.tokenX} tokenB={e.tokenY} />
                <span className="min-w-0 truncate font-medium group-hover:text-primary">{poolPairLabel(e)}</span>
                {feeChip(e.pool.feeBps)}
                {chip && <span className="ml-auto shrink-0">{chip}</span>}
              </div>
              <dl className="mt-2.5 grid grid-cols-3 gap-2 text-xs">
                <div><dt className="text-faint">Price</dt><dd className={cn('num mt-0.5', lowLiq && 'text-muted')}>{fmtPrice(e.priceYperX)}</dd></div>
                <div><dt className="text-faint">Value</dt><dd className="num mt-0.5">{tvlText(e)}</dd></div>
                <div><dt className="text-faint">Est. APR</dt><dd className={cn('num mt-0.5', aprS.cls)}>{aprS.txt}</dd></div>
              </dl>
            </Link>
            <Button variant="outline" size="sm" className="mt-2.5 w-full" onClick={() => setAddTo(e)}>
              <Plus className="h-3.5 w-3.5" /> Add liquidity
            </Button>
          </div>
        )
      })}
    </div>

    {/* One shared "Add liquidity" sheet, opened in add mode for whichever row was tapped. */}
    {addTo && (
      <LiquidityModal
        open={!!addTo} onOpenChange={(o) => !o && setAddTo(null)} mode="add"
        presetX={addTo.tokenX} presetY={addTo.tokenY} pool={addTo.pool}
        onDone={() => { setAddTo(null); onChanged?.() }}
      />
    )}

    {toggle}
    </>
  )
}
