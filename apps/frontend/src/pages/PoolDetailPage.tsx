import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ccc } from '@ckb-ccc/connector-react'
import { ArrowLeft, ArrowLeftRight, Plus, AlertTriangle, Lock, ShieldAlert } from 'lucide-react'
import { Button } from '../components/ui/button'
import { Hint } from '../components/ui/hint'
import { LiquidityModal } from '../components/LiquidityModal'
import { StatCard } from '../components/ui/stat'
import { PairLogos } from '../components/TokenLogo'
import { PriceChart } from '../components/charts/PriceChart'
import { ReservePie } from '../components/charts/ReservePie'
import { TxnTable } from '../components/TxnTable'
import { usePoolViews, usePoolHistory, usePoolTxns, useLockedLiquidity, useTipEpoch, usePoolAprs } from '../hooks/useData'
import { buildPricer, poolPairLabel, realizableTvl, buildAnchoring, volumeCkbSince, pctChange } from '../lib/pricing'
import { isVerifiedToken } from '../lib/tokens'
import { fmtUnits, compact, fmtPrice, epochEta, fmtDate, cn, EMPTY } from '../lib/utils'

export default function PoolDetailPage() {
  const { id } = useParams()
  const { views, refetch } = usePoolViews()
  const e = views.find(v => v.id === id)
  const pool = e?.pool
  const [addOpen, setAddOpen] = useState(false)
  const { data: history = [], isFetching } = usePoolHistory(pool, e?.tokenX?.decimals ?? 8, e?.tokenY?.decimals ?? 8)
  const { txns } = usePoolTxns(pool)
  const { data: lockedMap } = useLockedLiquidity()
  const { data: tipEpoch } = useTipEpoch()
  const aprs = usePoolAprs()

  // Locked liquidity in this pool (permissionless on-chain read): total committed LP, its share,
  // and an unlock schedule grouped by deadline. Null when nothing here is time-locked.
  const lockedInfo = useMemo(() => {
    if (!e || !pool || !lockedMap || pool.lpSupply === 0n) return null
    const infoHash = ccc.Script.from(pool.cell.output.type as any).hash().toLowerCase()
    const entry = lockedMap.get(infoHash)
    if (!entry || entry.totalLp === 0n) return null
    const tvl = realizableTvl(e)
    const byDeadline = new Map<string, bigint>()
    for (const l of entry.locks) byDeadline.set(l.deadlineEpoch.toString(), (byDeadline.get(l.deadlineEpoch.toString()) ?? 0n) + l.lpAmount)
    const schedule = [...byDeadline.entries()].map(([ep, lp]) => ({ epoch: BigInt(ep), lp })).sort((a, b) => Number(a.epoch - b.epoch))
    const lpToCkb = (lp: bigint) => (isFinite(tvl) ? tvl * (Number(lp) / Number(pool.lpSupply)) : NaN)
    return { pct: Number(entry.totalLp) / Number(pool.lpSupply), valueCkb: lpToCkb(entry.totalLp), schedule, lpToCkb }
  }, [e, pool, lockedMap])

  const reservePie = useMemo(() => {
    if (!e || !pool) return []
    const pricer = buildPricer(views.map(v => v.pool))
    const dx = e.tokenX?.decimals ?? 8, dy = e.tokenY?.decimals ?? 8
    const px = pricer.get(pool.tokenX.toLowerCase()) ?? NaN
    const py = pricer.get(pool.tokenY.toLowerCase()) ?? NaN
    return [
      { name: e.tokenX?.symbol ?? 'X', valueCkb: (Number(pool.reserveX) / 10 ** dx) * px },
      { name: e.tokenY?.symbol ?? 'Y', valueCkb: (Number(pool.reserveY) / 10 ** dy) * py },
    ]
  }, [e, pool, views])

  if (!e || !pool) {
    return <div className="mx-auto max-w-6xl px-4 py-16 text-center text-faint">Pool not found. <Link to="/pools" className="text-primary">Back to Pools</Link></div>
  }

  const dx = e.tokenX?.decimals ?? 8, dy = e.tokenY?.decimals ?? 8
  // Safe display symbols: never let an unresolved token render the literal "undefined" in labels.
  const sx = e.tokenX?.symbol ?? '?', sy = e.tokenY?.symbol ?? '?'

  // Match the depth of the token-detail page: APR (from the list's computation), 24h volume +
  // change, all derived from the reconstructed history.
  const nowSec = Math.floor(Date.now() / 1000)
  const apr = aprs.get(pool.poolId.toString())
  const aprTxt = !apr ? '-' : apr.windowDays < 0.08 ? 'new' : apr.aprPct >= 1000 ? '>999%' : `${compact(apr.aprPct)}%`
  const change24 = pctChange(history.filter(p => p.time >= nowSec - 86_400).map(p => p.price))
  const anchor = buildAnchoring(views.map(v => v.pool))
  const vol24 = volumeCkbSince(history, anchor.get(pool.tokenX.toLowerCase())?.price ?? NaN, dx, nowSec - 86_400)

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <Link to="/pools" className="mb-4 inline-flex items-center gap-1 text-sm text-faint hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Pools
      </Link>

      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <PairLogos a={e.tokenX?.symbol ?? '?'} b={e.tokenY?.symbol ?? '?'} tokenA={e.tokenX} tokenB={e.tokenY} className="h-10 w-10" />
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-display text-3xl">{poolPairLabel(e)}</h1>
              {!((e.tokenX && isVerifiedToken(e.tokenX.args)) && (e.tokenY && isVerifiedToken(e.tokenY.args))) && (
                <span className="flex items-center gap-1 rounded bg-warning/15 px-2 py-0.5 text-xs text-warning"><ShieldAlert className="h-3.5 w-3.5" />unverified
                  <Hint text="This token isn't on our verified list. Anyone can mint a look-alike under the same name. Double-check it's the real one before trading." /></span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-1 text-sm text-faint">
              {pool.poolMode === 'CKB_XUDT' ? 'Paired with CKB' : 'Token pair'} · fee {(pool.feeBps / 100).toFixed(2)}% · {compact(Number(pool.lpSupply))} pool tokens
              <Hint text="Pool tokens (also called LP) are a receipt for your deposit. Burn them any time to get your two tokens back, plus your share of the trading fees." />
              · pool #{e.id}
            </div>
          </div>
        </div>
        <div className="flex w-full gap-2 sm:w-auto">
          <Button variant="outline" size="lg" className="flex-1 sm:flex-none" onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> Add liquidity</Button>
          <Link to={`/swap?in=${e.tokenX?.args}&out=${e.tokenY?.args}`} className="flex-1 sm:flex-none">
            <Button size="lg" className="w-full sm:w-auto"><ArrowLeftRight className="h-4 w-4" /> Trade this pair</Button>
          </Link>
        </div>
      </motion.div>

      <LiquidityModal
        open={addOpen} onOpenChange={setAddOpen} mode="add"
        presetX={e.tokenX} presetY={e.tokenY} pool={pool} onDone={() => refetch()}
      />

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Value in pool" value={isFinite(realizableTvl(e)) ? compact(realizableTvl(e)) : EMPTY} unit={isFinite(realizableTvl(e)) ? 'CKB' : undefined} />
        <StatCard label={`What 1 ${sx} trades for`} value={e.anchored ? fmtPrice(e.priceYperX, 6) : EMPTY} unit={e.anchored ? sy : undefined} />
        <StatCard label="24h change" value={
          change24 == null ? '-'
            : <span className={cn(change24 >= 0 ? 'text-positive' : 'text-negative')}>{change24 >= 0 ? '+' : '−'}{(Math.abs(change24) * 100).toFixed(2)}%</span>
        } />
        <StatCard label="24h volume" value={isFinite(vol24) ? compact(vol24) : EMPTY} unit={isFinite(vol24) ? 'CKB' : undefined} />
        <StatCard label="Est. APR" value={<span className={apr && apr.windowDays >= 1 && apr.swaps >= 3 ? 'text-positive' : undefined}>{aprTxt}</span>}
          sub={apr ? `${apr.swaps} trade${apr.swaps === 1 ? '' : 's'} · est. from fees` : undefined} />
        <StatCard label="Fee tier" value={`${(pool.feeBps / 100).toFixed(2)}%`} />
      </div>

      {/* Anchoring: what actually backs this pool's value in CKB */}
      <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-surface-2/40 p-3 text-sm">
        {!e.anchored ? (
          <span className="flex items-center gap-2 text-negative">
            <AlertTriangle className="h-4 w-4" /> Can’t be priced in CKB: these tokens can’t be traded for CKB, so there’s no reliable price or way to cash out.
          </span>
        ) : (
          <>
            <span className="text-faint">CKB you can cash out</span>
            <span className="num font-medium">{isFinite(e.effectiveCkbDepth) ? `${compact(e.effectiveCkbDepth)} CKB` : '-'}</span>
            <span className="text-xs text-faint">(how much value you could actually convert to CKB through available pools)</span>
            {e.arbDependent && (
              <span className="flex items-center gap-1.5 rounded-md bg-warning/15 px-2 py-0.5 text-xs text-warning">
                <AlertTriangle className="h-3.5 w-3.5" /> Price estimated through other pools (no direct CKB pair)
              </span>
            )}
          </>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <div className="card p-4 sm:p-5">
          <div className="mb-3 text-sm text-faint">What 1 {sx} trades for · {sy} per {sx}</div>
          {history.length >= 2 ? <PriceChart points={history} height={300} /> : (
            <div className="grid h-[300px] place-items-center rounded-xl border border-dashed border-border text-sm text-faint">
              {isFetching ? 'Loading trading history…' : 'Not enough trades yet to draw a chart.'}
            </div>
          )}
        </div>

        <div className="space-y-5">
          <div className="card p-4 sm:p-5">
            <div className="mb-2 text-sm text-faint">What’s in the pool</div>
            <ReservePie data={reservePie} />
            <div className="mt-3 space-y-1.5 text-sm">
              <div className="flex justify-between"><span className="text-faint">{sx}</span><span className="num">{fmtUnits(pool.reserveX, dx, 4)}</span></div>
              <div className="flex justify-between"><span className="text-faint">{sy}</span><span className="num">{fmtUnits(pool.reserveY, dy, 4)}</span></div>
            </div>
          </div>

          {lockedInfo && (
            <div className="card p-4 sm:p-5">
              <div className="mb-2 flex items-center gap-2 text-sm text-faint"><Lock className="h-4 w-4" /> Locked liquidity</div>
              <div className="flex items-baseline gap-2">
                <span className="num text-2xl">{isFinite(lockedInfo.valueCkb) ? `${compact(lockedInfo.valueCkb)} CKB` : `${(lockedInfo.pct * 100).toFixed(1)}%`}</span>
                <span className="text-sm text-faint">{(lockedInfo.pct * 100).toFixed(1)}% of the pool locked</span>
              </div>
              <p className="mt-1 text-xs text-faint">These tokens are locked in for a set time and can’t be withdrawn until then.</p>
              <div className="mt-3 space-y-1.5 text-sm">
                {lockedInfo.schedule.slice(0, 5).map((s, i) => {
                  const eta = tipEpoch != null ? epochEta(s.epoch, tipEpoch) : null
                  const ckb = lockedInfo.lpToCkb(s.lp)
                  return (
                    <div key={i} className="flex items-center justify-between">
                      <span className="text-faint">{eta ? (eta.matured ? 'matured' : `≈ ${fmtDate(eta.date)} · ${eta.days}d`) : `epoch ${s.epoch}`}</span>
                      <span className="num">{isFinite(ckb) ? `${compact(ckb)} CKB` : `${compact(Number(s.lp))} LP`}</span>
                    </div>
                  )
                })}
                {lockedInfo.schedule.length > 5 && <div className="text-xs text-faint">+{lockedInfo.schedule.length - 5} more</div>}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="card mt-5 p-1">
        <div className="px-4 py-3 text-sm font-medium">Transactions</div>
        <TxnTable txns={txns} limit={40} />
      </div>
    </div>
  )
}
