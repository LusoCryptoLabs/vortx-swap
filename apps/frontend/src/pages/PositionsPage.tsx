import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useQuery } from '@tanstack/react-query'
import { ccc } from '@ckb-ccc/connector-react'
import { Wallet, Clock, X, ExternalLink, Lock, Plus, History, CheckCircle2, AlertCircle, PauseCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../components/ui/button'
import { Hint } from '../components/ui/hint'
import { StatCard } from '../components/ui/stat'
import { PositionCardSkeletonGrid } from '../components/ui/skeleton'
import { PairLogos, TokenLogo } from '../components/TokenLogo'
import { ReservePie } from '../components/charts/ReservePie'
import { RemoveLiquidityModal } from '../components/RemoveLiquidityModal'
import { LiquidityModal } from '../components/LiquidityModal'
import { useConnectPrompt } from '../components/ConnectPrompt'
import { usePositions, usePendingOrders, usePoolViews, useBalances, useTipEpoch, useLpHistory } from '../hooks/useData'
import { tokenByTypeHash, buildPricer } from '../lib/pricing'
import { CKB, CKB_TYPE_HASH, TOKEN_LIST, tokenByArgs } from '../lib/tokens'
import { sdk, AGGREGATOR_URL } from '../lib/cellswap'
import { trackTx } from '../lib/txTracker'
import { fmtUnits, compact, epochEta, fmtDate, cn } from '../lib/utils'
import { explorerTx, explorerAddr, timeAgo } from '../lib/explorer'
import { useActivity, recordActivity } from '../lib/activity'
import { humanizeError, FUNDS_SAFE_NOTE } from '../lib/errors'

export default function PositionsPage() {
  const signer = ccc.useSigner()
  const { promptConnect, connectPromptNode } = useConnectPrompt()
  const { data: positions = [], isLoading, refetch: refetchPositions } = usePositions(signer ?? undefined)
  const { data: pending = [], isSuccess: pendingReady } = usePendingOrders(signer ?? undefined)
  const { data: balances } = useBalances(signer ?? undefined)
  const { views } = usePoolViews()
  const { data: tipEpoch } = useTipEpoch()
  const history = useLpHistory(signer ?? undefined)
  const activity = useActivity()
  const [busy, setBusy] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<typeof positions[number] | null>(null)
  const [addTarget, setAddTarget] = useState<typeof positions[number] | null>(null)

  // Resolve the connected wallet address so an empty device-local history can still point the
  // user to their real, on-chain record on the explorer (a finished trade is never "lost").
  const [address, setAddress] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    if (!signer) { setAddress(null); return }
    signer.getRecommendedAddress().then(a => { if (alive) setAddress(a) }).catch(() => {})
    return () => { alive = false }
  }, [signer])

  // Per-order "auto-fill paused" state. Reuses the same health probe (query key + URL) as
  // the swap panel so React Query dedupes the request; when the settlement service is unreachable an
  // open order won't auto-fill, and we say so on the order itself rather than only in a transient toast.
  const { data: settlementUp = true } = useQuery({
    queryKey: ['otx-health', AGGREGATOR_URL],
    enabled: !!AGGREGATOR_URL,
    refetchInterval: 20_000,
    queryFn: async () => {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 4000)
      try {
        const res = await fetch(`${AGGREGATOR_URL}/pools`, { signal: ctrl.signal }).finally(() => clearTimeout(timer))
        return res.ok
      } catch { return false }
    },
  })
  const autoFillPaused = !AGGREGATOR_URL || settlementUp === false

  // "Placed {timeAgo}" for open orders. The on-chain cell carries no placed time, but the
  // device-local activity log records each order under its tx hash, so we cross-reference by hash.
  const placedTsByHash = new Map<string, number>()
  for (const a of activity) if (a.txHash) placedTsByHash.set(a.txHash.toLowerCase(), a.ts)

  // Reconcile the activity log with the live open-order set: an order still logged as 'pending' that
  // is no longer among the open intent-lock cells has filled, so promote it to 'completed'
  // (recordActivity replaces the entry by id). Cancellations are labelled by cancel() itself, so this
  // only fires for genuine fills. Gate on isSuccess (not merely fetched) so a transient indexer error
  // returning an empty set never promotes a still-open order, and keep a grace period so a freshly
  // placed, not-yet-indexed order is not marked done too early.
  useEffect(() => {
    if (!pendingReady) return
    const open = new Set(pending.map(o => o.outPoint.txHash.toLowerCase()))
    const now = Date.now()
    for (const a of activity) {
      if (a.kind === 'order' && a.status === 'pending' && a.txHash && now - a.ts > 30_000 && !open.has(a.txHash.toLowerCase())) {
        recordActivity({ id: a.id, kind: 'order', status: 'completed', txHash: a.txHash, summary: a.summary.replace(/^Ordered /, 'Filled ') })
      }
    }
  }, [pendingReady, pending, activity])

  const hasPositions = positions.length > 0

  // Resolve token names via the enriched pool views (which include on-chain-resolved names for
  // non-curated tokens), falling back to the curated list. Without this, LP pairs and pending
  // orders for non-curated tokens render as "?" / unknown.
  const nameByHash = new Map<string, ReturnType<typeof tokenByTypeHash>>()
  for (const v of views) {
    if (v.tokenX) nameByHash.set(v.pool.tokenX.toLowerCase(), v.tokenX)
    if (v.tokenY) nameByHash.set(v.pool.tokenY.toLowerCase(), v.tokenY)
  }
  const resolve = (typeHash: string) => nameByHash.get(typeHash.toLowerCase()) ?? tokenByTypeHash(typeHash)

  // Portfolio = wallet holdings + LP position value, all priced in CKB.
  const pricer = buildPricer(views.map(v => v.pool))
  const priceCkb = (args: string) => {
    const th = args === CKB ? CKB_TYPE_HASH : sdk.udtHash(args as any)
    return pricer.get(th.toLowerCase()) ?? 0
  }
  const walletSlices = TOKEN_LIST
    .map(t => ({ name: t.symbol, valueCkb: (Number(balances?.[t.symbol] ?? 0n) / 10 ** t.decimals) * priceCkb(t.args) }))
    .filter(s => s.valueCkb > 0)
  const lpValue = positions.reduce((a, p) => {
    const tx = resolve(p.pool.tokenX), ty = resolve(p.pool.tokenY)
    const vx = (Number(p.valueX) / 10 ** (tx?.decimals ?? 8)) * (pricer.get(p.pool.tokenX.toLowerCase()) ?? 0)
    const vy = (Number(p.valueY) / 10 ** (ty?.decimals ?? 8)) * (pricer.get(p.pool.tokenY.toLowerCase()) ?? 0)
    return a + vx + vy
  }, 0)
  const walletValue = walletSlices.reduce((a, s) => a + s.valueCkb, 0)
  const totalValue = walletValue + lpValue
  const allocation = [...walletSlices, ...(lpValue > 0 ? [{ name: 'LP', valueCkb: lpValue }] : [])]
  // Portfolio numbers aren't meaningful until positions, prices (views) and balances are all in.
  const statLoading = isLoading || views.length === 0 || balances === undefined

  async function cancel(o: typeof pending[number]) {
    if (!signer) return
    setBusy(o.outPoint.txHash)
    const id = toast.loading('Cancelling order…')
    try {
      const cell = { outPoint: o.cell.outPoint, output: o.cell.cellOutput, data: o.cell.outputData }
      const h = await trackTx('Cancel order', () => sdk.cancelIntent(signer as any, cell as any))
      toast.success(`Cancelled: ${h.slice(0, 12)}…`, { id })
      // Label the order's log entry as cancelled so the fill-reconcile effect does not later mislabel
      // it 'Filled' (the cell leaves the open set on cancel just as it does on a fill).
      const logged = activity.find(a => a.kind === 'order' && a.txHash?.toLowerCase() === o.outPoint.txHash.toLowerCase())
      recordActivity({
        id: logged?.id ?? o.outPoint.txHash,
        kind: 'order',
        status: 'completed',
        txHash: o.outPoint.txHash,
        summary: logged ? logged.summary.replace(/^Ordered /, 'Cancelled ') : 'Cancelled order',
      })
    } catch (e) { toast.error("Couldn't cancel the order", { id, description: `${humanizeError(e)} ${FUNDS_SAFE_NOTE}` }) }
    finally { setBusy(null) }
  }

  if (!signer) {
    return (
      <div className="mx-auto grid max-w-6xl place-items-center px-4 py-24">
        <div className="card flex flex-col items-center gap-4 px-10 py-12 text-center">
          <Wallet className="h-8 w-8 text-primary" />
          <h2 className="font-display text-2xl">Connect to view your positions</h2>
          <Button onClick={promptConnect}>Connect wallet</Button>
        </div>
        {connectPromptNode}
      </div>
    )
  }

  // Recent activity (device-local): a durable trace so a finished swap/order/send isn't invisible.
  // Defined once and placed near the top for users with no LP positions (a returning swapper sees
  // their trades first), otherwise kept in its canonical spot at the bottom.
  const activitySection = (
    <section className={hasPositions ? 'mt-8' : 'mb-8'}>
      <h2 className="mb-1 flex items-center gap-2 text-sm font-medium text-muted">
        <History className="h-4 w-4" /> Your trades and recent activity (this device)
        <Hint text="Saved on this device only, as a quick record of what you have done here. It is not your full chain history. Open a different device or browser and this list will be empty. Your wallet is the source of truth." />
      </h2>
      <p className="mb-3 text-xs text-faint">A local record so a completed action leaves a trace. Clear it any time by clearing this site's data.</p>
      {activity.length === 0 ? (
        <div className="card space-y-1 p-8 text-center text-sm text-faint">
          <div>Nothing yet on this device. Once you swap, place an order, or send tokens, it will show up here.</div>
          {address && (
            <div>
              On a new device or browser? Your completed trades are never lost; they live on-chain.{' '}
              <a href={explorerAddr(address)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                View your address on the CKB explorer <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}
        </div>
      ) : (
        <div className="card divide-y divide-border/60 p-0">
          {activity.map(a => (
            <div key={a.id} className="flex items-center justify-between gap-3 p-4">
              <div className="flex min-w-0 items-start gap-3">
                <ActivityIcon status={a.status} />
                <div className="min-w-0 text-sm">
                  <div className="truncate">{a.summary}</div>
                  <div className="flex items-center gap-2 text-xs text-faint">
                    <span className="num">{timeAgo(Math.floor(a.ts / 1000))}</span>
                    <span className="capitalize">{a.status}</span>
                  </div>
                </div>
              </div>
              {a.txHash && (
                <a
                  href={explorerTx(a.txHash)}
                  target="_blank"
                  rel="noreferrer"
                  className="flex shrink-0 items-center gap-1 text-xs text-primary hover:underline"
                >
                  View <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  )

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <motion.h1 initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mb-6 font-display text-3xl sm:text-4xl">Positions</motion.h1>

      {/* A returning swapper with no liquidity sees their trades first, not an empty LP grid. */}
      {!isLoading && !hasPositions && activitySection}

      {/* Portfolio */}
      <section className="mb-8 grid gap-3 sm:grid-cols-[1fr_320px]">
        <div className="grid grid-cols-2 gap-3">
          <StatCard label="Portfolio value" value={`${compact(totalValue)} CKB`} sub="wallet + liquidity" className="col-span-2" loading={statLoading} />
          <StatCard label="Wallet" value={`${compact(walletValue)} CKB`} loading={statLoading} />
          <StatCard label="In pools" value={`${compact(lpValue)} CKB`} loading={statLoading} />
        </div>
        <div className="card p-4">
          <div className="mb-1 text-sm text-faint">Allocation</div>
          {allocation.length ? <ReservePie data={allocation} height={160} /> : (
            <div className="grid h-[160px] place-items-center text-sm text-faint">No assets yet</div>
          )}
        </div>
      </section>

      {/* LP positions */}
      <section className="mb-8">
        <h2 className="mb-3 text-sm font-medium text-muted">Liquidity</h2>
        {isLoading ? (
          <PositionCardSkeletonGrid />
        ) : positions.length === 0 ? (
          <div className="card p-10 text-center text-sm text-faint">
            No liquidity positions yet. <Link to="/pools" className="text-primary">Find a pool →</Link>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {positions.map(pos => {
              const tx = resolve(pos.pool.tokenX), ty = resolve(pos.pool.tokenY)
              const locked = !!pos.locked
              const eta = locked && pos.lockedUntilEpoch != null && tipEpoch != null
                ? epochEta(pos.lockedUntilEpoch, tipEpoch) : null
              return (
                <div key={pos.pool.poolId.toString() + String(pos.lockedUntilEpoch ?? '')} className="card p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <Link to={`/pools/${pos.pool.poolId}`} className="flex items-center gap-2 font-medium hover:text-primary">
                      <PairLogos a={tx?.symbol ?? '?'} b={ty?.symbol ?? '?'} tokenA={tx} tokenB={ty} />
                      {tx?.symbol} / {ty?.symbol}
                    </Link>
                    <div className="flex items-center gap-1.5">
                      {locked && (
                        <span className="flex items-center gap-1 rounded-md bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning">
                          <Lock className="h-3 w-3" />{eta ? `${eta.days}d · ${fmtDate(eta.date)}` : 'locked'}
                          <Hint text="Locked in until this date. This position can't be withdrawn yet." />
                        </span>
                      )}
                      <span title="Your share of this pool" className="rounded-md bg-surface-2 px-2 py-0.5 text-xs num text-muted">{(pos.shareOfPool * 100).toFixed(3)}%</span>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <Stat label={`Pooled ${tx?.symbol}`} value={fmtUnits(pos.valueX, tx?.decimals ?? 8, 4)} />
                    <Stat label={`Pooled ${ty?.symbol}`} value={fmtUnits(pos.valueY, ty?.decimals ?? 8, 4)} />
                    <Stat
                      label="Pool tokens"
                      hint="Pool tokens (LP tokens) are your receipt for adding liquidity. They track your share of this pool and you hand them back when you remove your funds."
                      value={compact(Number(pos.lpAmount))}
                    />
                  </div>
                  <div className="mt-3 flex gap-2">
                    <Button variant="outline" className="flex-1" onClick={() => setAddTarget(pos)}>
                      <Plus className="h-4 w-4" /> Add
                    </Button>
                    <Button variant="outline" className="flex-1" disabled={locked} onClick={() => setRemoveTarget(pos)}>
                      {locked ? (eta ? `Locked · ${fmtDate(eta.date)}` : 'Locked') : 'Remove'}
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <RemoveLiquidityModal
        open={!!removeTarget}
        onOpenChange={(o) => !o && setRemoveTarget(null)}
        position={removeTarget}
        tokenX={removeTarget ? resolve(removeTarget.pool.tokenX) : undefined}
        tokenY={removeTarget ? resolve(removeTarget.pool.tokenY) : undefined}
        onDone={() => refetchPositions()}
      />

      <LiquidityModal
        key={addTarget ? addTarget.pool.poolId.toString() : 'add-none'}
        open={!!addTarget}
        onOpenChange={(o) => !o && setAddTarget(null)}
        mode="add"
        presetX={addTarget ? resolve(addTarget.pool.tokenX) : undefined}
        presetY={addTarget ? resolve(addTarget.pool.tokenY) : undefined}
        pool={addTarget?.pool}
        onDone={() => refetchPositions()}
      />

      {/* LP history: reconstructed add/remove lifecycle, incl. closed positions */}
      {history.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-medium text-muted">Liquidity history</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {history.map(h => {
              const sx = h.tokenX?.symbol ?? '?', sy = h.tokenY?.symbol ?? '?'
              const dxd = h.tokenX?.decimals ?? 8, dyd = h.tokenY?.decimals ?? 8
              return (
                <div key={h.pool.poolId.toString()} className="card p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <Link to={`/pools/${h.pool.poolId}`} className="flex items-center gap-2 font-medium hover:text-primary">
                      <PairLogos a={sx} b={sy} tokenA={h.tokenX} tokenB={h.tokenY} /> {sx} / {sy}
                    </Link>
                    <span className={cn('rounded-md px-2 py-0.5 text-xs', h.closed ? 'bg-surface-2 text-muted' : 'bg-positive/15 text-positive')}>{h.closed ? 'Closed' : 'Open'}</span>
                  </div>
                  <div className="mb-3 flex gap-6">
                    <NetStat label={sx} value={h.netX} decimals={dxd} />
                    <NetStat label={sy} value={h.netY} decimals={dyd} />
                  </div>
                  <div className="space-y-1 text-xs">
                    {h.events.slice(0, 6).map((e, i) => {
                      const isRemove = e.kind === 'remove'
                      const ax = fmtUnits(e.dx < 0n ? -e.dx : e.dx, dxd, 2), ay = fmtUnits(e.dy < 0n ? -e.dy : e.dy, dyd, 2)
                      return (
                        <a key={i} href={explorerTx(e.txHash)} target="_blank" rel="noreferrer" className="flex items-center justify-between text-faint transition-colors hover:text-foreground">
                          <span><span className={isRemove ? 'text-negative' : 'text-positive'}>{isRemove ? 'Removed' : 'Added'}</span> {ax} {sx} · {ay} {sy}</span>
                          <span className="num">{timeAgo(e.time)}</span>
                        </a>
                      )
                    })}
                    {h.events.length > 6 && <div className="text-faint">+{h.events.length - 6} more</div>}
                  </div>
                </div>
              )
            })}
          </div>
          <p className="mt-2 text-xs text-faint">
            Built from your add/remove history. <span className="num">Net = taken out − put in</span> per token -
            your gain or loss so far. Prices shift over time, so you may get back different amounts than you deposited.
            Covers recent activity.
          </p>
        </section>
      )}

      {/* Pending orders (async intent-lock) */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-muted">
          <Clock className="h-4 w-4" /> Pending trades
        </h2>
        {/* A persistent (not transient-toast) note when the fill service is down, so the
            per-order "Auto-fill paused" badges below are explained and never look like a stuck order. */}
        {pending.length > 0 && autoFillPaused && (
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
            <PauseCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Auto-fill is paused: the service that fills your orders is unreachable right now, so these orders won't
              fill until it's back. Your funds stay in your control, and you can cancel any order at any time.
            </span>
          </div>
        )}
        {pending.length === 0 ? (
          <div className="card p-8 text-center text-sm text-faint">
            No orders waiting to fill. Completed trades are not shown here; see your trades and recent activity, or your wallet.
            Orders you place that fill later will appear here, and your funds stay in your control until they complete.
          </div>
        ) : (
          <div className="card divide-y divide-border/60 p-0">
            {pending.map(o => {
              const tin = o.tokenInArgs ? (tokenByArgs(o.tokenInArgs) ?? resolve(sdk.udtHash(o.tokenInArgs as any))) : undefined
              const tout = resolve(o.tokenOutHash)
              const din = tin?.decimals ?? 8, dout = tout?.decimals ?? 8
              // Target price = the minimum received per unit paid (your limit). Guard against a
              // zero amountIn so we never divide by zero.
              const inUnits = Number(o.amountIn) / 10 ** din
              const outUnits = Number(o.minOut) / 10 ** dout
              const targetPrice = inUnits > 0 ? outUnits / inUnits : null
              const placedTs = placedTsByHash.get(o.outPoint.txHash.toLowerCase())
              return (
                <div key={o.outPoint.txHash + o.outPoint.index} className="flex items-center justify-between gap-3 p-4">
                  <div className="flex items-center gap-3">
                    <TokenLogo symbol={tin?.symbol ?? '?'} token={tin} className="h-8 w-8" />
                    <div className="text-sm">
                      <div className="num">{fmtUnits(o.amountIn, din, 4)} {tin?.symbol ?? '?'} → {tout?.symbol ?? '?'}</div>
                      <div className="text-xs text-faint">
                        you’ll get at least <span className="num">{fmtUnits(o.minOut, dout, 4)} {tout?.symbol ?? '?'}</span>
                        {targetPrice != null && <> · target <span className="num">{compact(targetPrice)} {tout?.symbol ?? '?'}/{tin?.symbol ?? '?'}</span></>}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                        {placedTs != null
                          ? <span className="text-faint">Placed {timeAgo(Math.floor(placedTs / 1000))}</span>
                          : <span className="text-faint">Waiting to fill</span>}
                        {autoFillPaused ? (
                          <span title="The service that fills orders is unreachable right now, so this order won't auto-fill until it's back. Your funds stay in your control, and you can cancel any time." className="inline-flex items-center gap-1 rounded-md bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning">
                            <PauseCircle className="h-3 w-3" /> Auto-fill paused
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-md bg-positive/15 px-1.5 py-0.5 text-[10px] text-positive">
                            Auto-fill on
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" disabled={busy === o.outPoint.txHash} onClick={() => cancel(o)}>
                    <X className="h-4 w-4" /> Cancel
                  </Button>
                </div>
              )
            })}
          </div>
        )}
        <p className="mt-3 flex items-center gap-1.5 text-xs text-faint">
          <ExternalLink className="h-3 w-3" /> These orders complete in the background, and your funds stay in your control until they do.
        </p>
      </section>

      {/* When the user has LP positions, the activity/trades list keeps its canonical spot at the
          bottom (it moves to the top only for the no-position case, handled above). */}
      {hasPositions && activitySection}
    </div>
  )
}

const ActivityIcon = ({ status }: { status: 'completed' | 'pending' | 'failed' }) => {
  if (status === 'completed') return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-positive" />
  if (status === 'failed') return <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-negative" />
  return <Clock className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
}

const Stat = ({ label, value, hint }: { label: string; value: string; hint?: string }) => (
  <div>
    <div className="flex items-center gap-1 text-xs text-faint">{label}{hint && <Hint text={hint} />}</div>
    <div className="num">{value}</div>
  </div>
)

const NetStat = ({ label, value, decimals }: { label: string; value: bigint; decimals: number }) => (
  <div>
    <div className="text-xs text-faint">Net {label}</div>
    <div className={cn('num', value > 0n ? 'text-positive' : value < 0n ? 'text-negative' : 'text-faint')}>
      {value > 0n ? '+' : value < 0n ? '−' : ''}{fmtUnits(value < 0n ? -value : value, decimals, 4)}
    </div>
  </div>
)
