import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowUpRight, ShieldCheck, ShieldAlert } from 'lucide-react'
import { Segmented } from '../components/ui/segmented'
import { ProtocolStats } from '../components/ProtocolStats'
import { RowSkeleton } from '../components/ui/skeleton'
import { TxnTable } from '../components/TxnTable'
import { TokenLogo } from '../components/TokenLogo'
import { Sparkline } from '../components/charts/Sparkline'
import { RiskBadge } from '../components/RiskBadge'
import { usePoolViews, useAllTxns, usePoolHistories } from '../hooks/useData'
import { buildPricer, bestPoolForToken, pctChange, tokenRisk } from '../lib/pricing'
import { sdk } from '../lib/cellswap'
import { CKB, TOKEN_LIST, type TokenInfo } from '../lib/tokens'
import { fmtPrice, cn, EMPTY } from '../lib/utils'

type Tab = 'tokens' | 'txns'

const WINDOWS: { value: string; label: string; secs: number }[] = [
  { value: '24h', label: '24H', secs: 86_400 },
  { value: '7d', label: '7D', secs: 604_800 },
  { value: 'all', label: 'All', secs: Infinity },
]

/** Colored "+2.43%" / "−0.49%" change pill. */
function Change({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="text-faint">-</span>
  const up = pct >= 0
  return <span className={cn('num', up ? 'text-positive' : 'text-negative')}>{up ? '+' : '−'}{(Math.abs(pct) * 100).toFixed(2)}%</span>
}

/** Explore page, a markets overview: token prices and live trades across every pool.
 *  (The pool list + Create pool live on /pools.) */
export default function ExplorePage() {
  const [tab, setTab] = useState<Tab>('tokens')
  const [win, setWin] = useState('7d')
  const { views, isLoading: poolsLoading } = usePoolViews()
  const { txns, isLoading: txLoading } = useAllTxns()
  const histories = usePoolHistories()

  // Every token that appears in a pool (not just the curated list), so a pooled token resolved
  // on-chain (e.g. TKB) still shows up. Curated tokens take precedence (they carry real metadata).
  const universe = useMemo(() => {
    const m = new Map<string, TokenInfo>()
    for (const t of TOKEN_LIST) m.set(t.args.toLowerCase(), t)
    for (const v of views) for (const t of [v.tokenX, v.tokenY]) if (t && !m.has(t.args.toLowerCase())) m.set(t.args.toLowerCase(), t)
    return [...m.values()]
  }, [views])

  const tokenRows = useMemo(() => {
    const pools = views.map(v => v.pool)
    const pricer = buildPricer(pools)
    const secs = WINDOWS.find(w => w.value === win)?.secs ?? Infinity
    const nowSec = Math.floor(Date.now() / 1000)
    return universe.map(t => {
      const th = t.args === CKB ? ('0x' + '0'.repeat(64)) : sdk.udtHash(t.args as any)
      const price = pricer.get(th.toLowerCase())
      const poolCount = views.filter(v => v.tokenX?.args === t.args || v.tokenY?.args === t.args).length
      // Token-oriented price series from its representative pool (direct-CKB preferred), windowed.
      const best = bestPoolForToken(views, t.args)
      const pts = best ? (histories.get(best.id) ?? []) : []
      const wpts = secs === Infinity ? pts : pts.filter(p => p.time >= nowSec - secs)
      const series = wpts.map(p => best && best.tokenIsX ? p.price : (p.price ? 1 / p.price : 0))
      return { token: t, price, poolCount, series, change: pctChange(series), risk: tokenRisk(pools, t.args) }
    })
  }, [universe, views, histories, win])

  const winLabel = WINDOWS.find(w => w.value === win)?.label ?? '7D'

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mb-6">
        <h1 className="font-display text-3xl sm:text-4xl">Explore</h1>
        <p className="mt-1 text-sm text-faint">Token prices and live trades, read straight from the blockchain.</p>
      </motion.div>

      <ProtocolStats />
      <div className="mb-4 text-sm text-faint">{universe.length} listed tokens · {views.length} pools</div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <Segmented
          options={[{ value: 'tokens', label: 'Tokens' }, { value: 'txns', label: 'Transactions' }]}
          value={tab} onChange={setTab}
        />
        {tab === 'tokens' && (
          <Segmented size="sm" options={WINDOWS.map(w => ({ value: w.value, label: w.label }))} value={win} onChange={setWin} />
        )}
      </div>

      <div className="card overflow-hidden p-1">
        {tab === 'txns' && (txLoading && !txns.length ? <RowSkeleton rows={6} avatar={false} header widths={['w-16', 'w-44', 'w-12']} /> : <TxnTable txns={txns} limit={60} />)}
        {tab === 'tokens' && poolsLoading && !tokenRows.length && <RowSkeleton rows={6} header />}
        {tab === 'tokens' && !(poolsLoading && !tokenRows.length) && (
          <>
          {/* Legend so a green shield reads as "we checked, looks fine" and a warning reads as
              something to tap; "safe" and "unrated" should never look identical. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-xs text-faint">
            <span className="inline-flex items-center gap-1"><ShieldCheck className="h-3.5 w-3.5 text-positive" /> looks fine</span>
            <span className="inline-flex items-center gap-1"><ShieldAlert className="h-3.5 w-3.5 text-warning" /> tap for what to watch</span>
          </div>
          {/* Desktop table; mobile (<sm) gets stacked token cards, no horizontal scroll. */}
          <div className="hidden overflow-x-auto sm:block">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-faint">
                <th className="px-4 py-3 font-medium">Token</th>
                <th className="px-4 py-3 text-right font-medium">Price</th>
                <th className="px-4 py-3 text-right font-medium">{WINDOWS.find(w => w.value === win)?.label} change</th>
                <th className="hidden px-4 py-3 text-right font-medium sm:table-cell">Trend</th>
                <th className="px-4 py-3 text-right font-medium">Pools</th>
                <th className="px-4 py-3 text-right font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {tokenRows.map(({ token, price, poolCount, series, change, risk }) => (
                <tr key={token.args} className="group border-t border-border/60">
                  <td className="px-4 py-3">
                    <Link to={`/explore/tokens/${token.args}`} className="flex items-center gap-3">
                      <TokenLogo token={token} className="h-8 w-8" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium group-hover:text-primary">{token.symbol}</span>
                          <RiskBadge risk={risk} showLabel={false} />
                        </div>
                        <div className="truncate text-xs text-faint">{token.name}</div>
                      </div>
                    </Link>
                  </td>
                  <td className="num px-4 py-3 text-right">{price != null ? `${fmtPrice(price)} CKB` : EMPTY}</td>
                  <td className="px-4 py-3 text-right"><Change pct={change} /></td>
                  <td className="hidden px-4 py-3 sm:table-cell">
                    <div className="flex flex-col items-end gap-0.5">
                      {series.length >= 2 ? (
                        <Sparkline data={series} positive={(change ?? 0) >= 0} />
                      ) : (
                        <>
                          {/* A faint flat dash holds the sparkline's footprint so a brand-new token
                              (no trades) is visibly distinct from a missing/broken chart. */}
                          <span aria-hidden className="block h-[1.5px] w-16 rounded-full bg-faint/30" />
                          <span className="text-xs text-faint/70">no trades yet</span>
                        </>
                      )}
                    </div>
                  </td>
                  <td className="num px-4 py-3 text-right text-muted">{poolCount}</td>
                  <td className="px-4 py-3 text-right">
                    <Link to={`/swap?in=${token.args}`} className="inline-flex items-center gap-1 text-faint hover:text-primary">
                      Trade <ArrowUpRight className="h-3 w-3" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>

          {/* Mobile stacked token cards */}
          <div className="divide-y divide-border/60 sm:hidden">
            {/* Which time window the % on each card refers to (mobile has no column header). */}
            <div className="px-2 py-2 text-xs text-faint">Showing {winLabel} change</div>
            {tokenRows.map(({ token, price, poolCount, series, change, risk }) => (
              <Link key={token.args} to={`/explore/tokens/${token.args}`} className="group flex items-center gap-2.5 px-2 py-3">
                <TokenLogo token={token} className="h-9 w-9 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className="truncate font-medium group-hover:text-primary">{token.symbol}</span>
                    <RiskBadge risk={risk} showLabel={false} />
                  </div>
                  <div className="truncate text-xs text-faint">{token.name}</div>
                </div>
                {series.length >= 2 ? (
                  <div className="h-6 w-14 shrink-0 overflow-hidden"><Sparkline data={series} width={56} height={24} positive={(change ?? 0) >= 0} /></div>
                ) : (
                  // Faint dash in the sparkline's slot: a new token reads as new, not broken.
                  <div className="flex h-6 w-14 shrink-0 items-center justify-center" aria-hidden>
                    <span className="block h-[1.5px] w-10 rounded-full bg-faint/30" />
                  </div>
                )}
                <div className="shrink-0 text-right">
                  <div className="num text-sm">{price != null ? `${fmtPrice(price)} CKB` : EMPTY}</div>
                  {change == null && price != null
                    ? <div className="text-xs text-faint">no trades yet · {poolCount} {poolCount === 1 ? 'pool' : 'pools'}</div>
                    : <div className="text-xs"><Change pct={change} /> <span className="text-faint">· {winLabel} · {poolCount} {poolCount === 1 ? 'pool' : 'pools'}</span></div>}
                </div>
              </Link>
            ))}
          </div>
          </>
        )}
      </div>
    </div>
  )
}
