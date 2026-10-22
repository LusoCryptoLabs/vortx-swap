import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ccc } from '@ckb-ccc/connector-react'
import { motion } from 'framer-motion'
import { ArrowLeft, ArrowLeftRight, Copy, Check, BadgeCheck } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../components/ui/button'
import { StatCard } from '../components/ui/stat'
import { TokenLogo } from '../components/TokenLogo'
import { PriceChart } from '../components/charts/PriceChart'
import { PoolList } from '../components/PoolList'
import { RiskBadge } from '../components/RiskBadge'
import { RegisterTokenModal } from '../components/RegisterTokenModal'
import { usePoolViews, usePoolHistory, usePoolHistories, useRegistrations, useSignerAddress } from '../hooks/useData'
import { buildPricer, buildAnchoring, tokenRisk, volumeCkbSince, pctChange } from '../lib/pricing'
import { sdk } from '../lib/cellswap'
import { CKB, tokenByArgs } from '../lib/tokens'
import { compact, shortHash, fmtPrice, cn, EMPTY } from '../lib/utils'

export default function TokenDetailPage() {
  const { args = '' } = useParams()
  const { views, isLoading } = usePoolViews()
  const histories = usePoolHistories()
  // Resolve curated first, else fall back to the on-chain-resolved token off any pool it's in,
  // so a non-curated pooled token (clicked from Explore) still opens instead of "Unknown token".
  const token = useMemo(() => {
    const curated = tokenByArgs(args)
    if (curated) return curated
    for (const v of views) {
      if (v.tokenX?.args.toLowerCase() === args.toLowerCase()) return v.tokenX
      if (v.tokenY?.args.toLowerCase() === args.toLowerCase()) return v.tokenY
    }
    return undefined
  }, [args, views])

  const related = views.filter(v => v.tokenX?.args === args || v.tokenY?.args === args)
  // prefer a CKB market for the price chart
  const ckbPool = related.find(v => v.tokenX?.args === CKB || v.tokenY?.args === CKB) ?? related[0]
  const { data: history = [], isFetching } = usePoolHistory(ckbPool?.pool, token?.decimals ?? 8, 8)

  // orient history to CKB-per-token
  const tokenIsX = ckbPool ? ckbPool.tokenX?.args === args : true
  const displayHistory = useMemo(
    () => (tokenIsX ? history : history.map(p => ({ ...p, price: p.price ? 1 / p.price : 0 }))),
    [history, tokenIsX])

  const pools = useMemo(() => views.map(v => v.pool), [views])
  const anchor = useMemo(() => buildAnchoring(pools), [pools])
  const risk = useMemo(() => tokenRisk(pools, args), [pools, args])

  const th = args === CKB ? ('0x' + '0'.repeat(64)) : sdk.udtHash(args as any)
  const price = useMemo(() => buildPricer(pools).get(th.toLowerCase()), [pools, th])
  const { data: registrations } = useRegistrations()
  const reg = registrations?.get(th.toLowerCase())
  const registered = !!reg && reg.ownerLockHash.toLowerCase() === args.toLowerCase()  // valid issuer proof
  const depth = anchor.get(th.toLowerCase())?.effectiveCkbDepth

  // The connected wallet can register this token only if it controls its issuer lock, i.e. its
  // lock hash equals the token's args (xUDT identity = owner lock hash).
  const signer = ccc.useSigner()
  // The connected account's lock hash, scoped to the account so switching wallets re-resolves it
  // instead of leaving a stale issuer check keyed on `!!signer`.
  const myLockHash = useSignerAddress(signer ?? undefined)
  const isIssuer = !!myLockHash && args !== CKB && myLockHash.toLowerCase() === args.toLowerCase()
  const [registerOpen, setRegisterOpen] = useState(false)
  // The raw token-ID hash is jargon to most people; keep it tucked behind a toggle so the header
  // leads with the human name, not a 0x... string.
  const [showId, setShowId] = useState(false)

  const nowSec = Math.floor(Date.now() / 1000)
  const change24 = useMemo(
    () => pctChange(displayHistory.filter(p => p.time >= nowSec - 86_400).map(p => p.price)),
    [displayHistory, nowSec])
  const vol24 = useMemo(() => {
    if (!ckbPool) return NaN
    const px = anchor.get(ckbPool.pool.tokenX.toLowerCase())?.price ?? NaN
    return volumeCkbSince(history, px, ckbPool.tokenX?.decimals ?? 8, nowSec - 86_400)
  }, [history, ckbPool, anchor, nowSec])

  const totalLiq = related.reduce((a, v) => a + (isFinite(v.tvlCkb) ? v.tvlCkb : 0), 0)

  if (!token) {
    return <div className="mx-auto max-w-6xl px-4 py-16 text-center text-faint">
      {isLoading ? 'Loading token…' : <>Unknown token. <Link to="/explore" className="text-primary">Back to Explore</Link></>}
    </div>
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <Link to="/explore" className="mb-4 inline-flex items-center gap-1 text-sm text-faint hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Explore
      </Link>

      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <TokenLogo token={token} className="h-12 w-12" />
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-display text-3xl">{token.name} <span className="text-faint">{token.symbol}</span></h1>
              {/* RiskBadge is itself a tap-to-open popover listing every reason, so render it directly;
                  wrapping it in another Popover trigger nested a button inside a button (invalid) and the
                  inner badge swallowed the click so the outer one never opened. */}
              <RiskBadge risk={risk} />
              {registered && (
                <span title={`Verified: registered by its real creator${reg?.link ? ` · ${reg.link}` : ''}`}
                  className="inline-flex items-center gap-1 rounded-md bg-positive/15 px-2 py-0.5 text-xs font-medium text-positive">
                  <Check className="h-3.5 w-3.5" /> Registered
                </span>
              )}
              {isIssuer && !registered && sdk.registryEnabled() && (
                <Button size="sm" variant="outline" onClick={() => setRegisterOpen(true)}>
                  <BadgeCheck className="mr-1.5 h-4 w-4" /> Register token
                </Button>
              )}
            </div>
            {!showId ? (
              <button
                onClick={() => setShowId(true)}
                className="-ml-1 mt-0.5 inline-flex items-center gap-1 rounded px-1 py-1.5 text-xs text-faint hover:text-foreground"
              >
                Show token ID
              </button>
            ) : (
              <button
                onClick={() => { navigator.clipboard.writeText(token.args); toast.success('Token ID copied') }}
                title="Token ID: this token's unique address on the blockchain. Tap to copy."
                className="-ml-1 mt-0.5 inline-flex items-center gap-1 rounded px-1 py-1.5 text-xs text-faint hover:text-foreground"
              >
                <span className="num">{shortHash(token.args, 8)}</span><Copy className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
        <Link to={`/swap?in=${token.args}`}>
          <Button size="lg"><ArrowLeftRight className="h-4 w-4" /> Trade {token.symbol}</Button>
        </Link>
      </motion.div>

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Price" value={price != null ? fmtPrice(price, 6) : EMPTY} unit={price != null ? 'CKB' : undefined}
          sub={price != null ? `cash out 1 ${token.symbol}` : undefined} />
        <StatCard label="24h change" value={
          change24 == null ? EMPTY
            : <span className={cn(change24 >= 0 ? 'text-positive' : 'text-negative')}>{change24 >= 0 ? '+' : '−'}{(Math.abs(change24) * 100).toFixed(2)}%</span>
        } />
        <StatCard label="24h volume" value={isFinite(vol24) ? compact(vol24) : EMPTY} unit={isFinite(vol24) ? 'CKB' : undefined} />
        <StatCard label="CKB available" value={depth != null && isFinite(depth) ? compact(depth) : EMPTY} unit={depth != null && isFinite(depth) ? 'CKB' : undefined}
          sub={isFinite(totalLiq) ? `${compact(totalLiq)} CKB paired` : undefined} />
        <StatCard label="Pools" value={related.length} />
        <StatCard label="Decimals" value={token.decimals} />
      </div>

      <div className="card p-4 sm:p-5">
        <div className="mb-3 text-sm text-faint">How much you can cash out · CKB per {token.symbol}</div>
        {displayHistory.length >= 2 ? <PriceChart points={displayHistory} height={300} /> : (
          <div className="grid h-[300px] place-items-center rounded-xl border border-dashed border-border text-sm text-faint">
            {isFetching ? 'Loading price history…' : ckbPool ? 'Not enough trades yet to draw a chart.' : 'No CKB market for this token yet.'}
          </div>
        )}
      </div>

      <div className="card mt-5 p-1">
        <div className="px-4 py-3 text-sm font-medium">Pools</div>
        <PoolList pools={related} histories={histories} />
      </div>

      <RegisterTokenModal open={registerOpen} onClose={() => setRegisterOpen(false)} token={token} />
    </div>
  )
}
