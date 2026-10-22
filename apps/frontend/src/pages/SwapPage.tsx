import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { TrendingUp, TrendingDown, Activity } from 'lucide-react'
import { ccc } from '@ckb-ccc/connector-react'
import { SwapCard } from '../components/SwapCard'
import { PriceChart } from '../components/charts/PriceChart'
import { Segmented } from '../components/ui/segmented'
import { HowItWorks } from '../components/HowItWorks'
import { sdk } from '../lib/cellswap'
import { TOKENS, tokenByArgs, firstCuratedNonCkb, type TokenInfo } from '../lib/tokens'

const tokenByArgsLocal = (a: string | null) => (a ? tokenByArgs(a) : undefined)
import { usePool, usePoolHistory, usePoolViews } from '../hooks/useData'
import { bestPoolForToken, isLowLiquidity } from '../lib/pricing'
import { cn, fmtPrice, compact } from '../lib/utils'

export default function SwapPage() {
  const signer = ccc.useSigner()
  const [params] = useSearchParams()
  const wantIn = params.get('in'), wantOut = params.get('out')
  const wantAmt = params.get('amt')   // deep-link prefill
  const wantMode = params.get('mode') // deep-link a swap mode (e.g. the landing's custody-free CTA)
  const initialMode = wantMode === 'instant' || wantMode === 'limit' || wantMode === 'batch' ? wantMode : undefined
  const presetIn = tokenByArgsLocal(wantIn)
  const presetOut = tokenByArgsLocal(wantOut)
  // Default the pair to CKB (You pay) -> VTX (You receive) for newcomers. ?in / ?out presets
  // still win. VTX only exists on testnet, so fall back to the first curated non-CKB token elsewhere.
  const defaultOut = TOKENS.VTX ?? firstCuratedNonCkb()
  const [tokenIn, setTokenIn] = useState<TokenInfo>(presetIn ?? TOKENS.CKB)
  const [tokenOut, setTokenOut] = useState<TokenInfo>(
    presetOut ?? (presetIn && presetIn.args.toLowerCase() === defaultOut.args.toLowerCase() ? TOKENS.CKB : defaultOut))
  const [amount, setAmount] = useState(wantAmt && /^\d*\.?\d+$/.test(wantAmt) ? wantAmt : '')
  const [range, setRange] = useState('all')

  // The URL token may be a non-curated pooled token (tokenByArgs only knows curated/custom), so
  // the synchronous preset above falls back to the default pair. Once pools load, resolve the
  // requested token off any pool it's in and apply it once, and pick a real counterpart (its
  // deepest pool's other side, CKB-preferred) so "Trade <X>" lands on a tradeable pair.
  const { views } = usePoolViews()
  const applied = useRef(false)
  useEffect(() => {
    if (applied.current) return
    if (!wantIn && !wantOut) { applied.current = true; return }
    const resolve = (a: string | null) => {
      if (!a) return undefined
      const c = tokenByArgs(a); if (c) return c
      for (const v of views) {
        if (v.tokenX?.args.toLowerCase() === a.toLowerCase()) return v.tokenX
        if (v.tokenY?.args.toLowerCase() === a.toLowerCase()) return v.tokenY
      }
      return undefined
    }
    const inTok = resolve(wantIn), outTok = resolve(wantOut)
    if (wantIn && !inTok) return                       // wait until pools resolve the name
    if (inTok) {
      setTokenIn(inTok)
      let out = outTok
      if (!out) {
        const best = bestPoolForToken(views, inTok.args)
        const e = best ? views.find(v => v.id === best.id) : undefined
        out = (best && (best.tokenIsX ? e?.tokenY : e?.tokenX)) ?? (inTok.symbol === 'CKB' ? firstCuratedNonCkb() : TOKENS.CKB)
      }
      if (out && out.args.toLowerCase() !== inTok.args.toLowerCase()) setTokenOut(out)
    } else if (outTok) setTokenOut(outTok)
    applied.current = true
  }, [views, wantIn, wantOut])

  const { data: pool } = usePool(tokenIn.args, tokenOut.args)
  const { data: allHistory = [] } = usePoolHistory(pool, tokenIn.decimals, tokenOut.decimals)

  // Timeframe filter: keep points within the selected window.
  const RANGES: { value: string; label: string; secs: number }[] = [
    { value: '1d', label: '1D', secs: 86_400 },
    { value: '1w', label: '1W', secs: 604_800 },
    { value: '1m', label: '1M', secs: 2_592_000 },
    { value: 'all', label: 'All', secs: Infinity },
  ]
  const rangeSecs = RANGES.find(r => r.value === range)?.secs ?? Infinity
  const nowSec = Math.floor(Date.now() / 1000)
  const history = useMemo(
    () => (rangeSecs === Infinity ? allHistory : allHistory.filter(p => p.time >= nowSec - rangeSecs)),
    [allHistory, rangeSecs, nowSec])

  // Resolve swap-direction reserves for the depth curve + spot price.
  const dir = useMemo(() => {
    if (!pool) return null
    const inHash = sdk.udtHash(tokenIn.args as any)
    const inIsX = pool.tokenX.toLowerCase() === inHash.toLowerCase()
    return {
      reserveIn: inIsX ? pool.reserveX : pool.reserveY,
      reserveOut: inIsX ? pool.reserveY : pool.reserveX,
    }
  }, [pool, tokenIn.args])

  const spot = dir && dir.reserveIn > 0n
    ? (Number(dir.reserveOut) / 10 ** tokenOut.decimals) / (Number(dir.reserveIn) / 10 ** tokenIn.decimals)
    : null
  // history price is reserveY/reserveX in pool orientation; flip if needed for display direction
  const inIsX = pool ? pool.tokenX.toLowerCase() === sdk.udtHash(tokenIn.args as any).toLowerCase() : true
  const displayHistory = useMemo(
    () => (inIsX ? history : history.map(p => ({ ...p, price: p.price ? 1 / p.price : 0 }))),
    [history, inIsX])
  // Change must track the displayed direction (the chart uses displayHistory), else a rising chart
  // can show a falling % (the pool-orientation move is the inverse).
  const change = displayHistory.length >= 2 && displayHistory[0].price > 0
    ? (displayHistory[displayHistory.length - 1].price - displayHistory[0].price) / displayHistory[0].price : 0
  const changeTxt = Math.abs(change * 100) >= 1000 ? compact(change * 100) : (change * 100).toFixed(2)

  // Only show the chart when it actually carries signal: a real, anchored, non-degenerate pair
  // with enough swaps to draw. Otherwise the chart is an empty/misleading box dominating the
  // landing page, so we hide it and let the swap form take center stage (it reappears on its own
  // once the pair has genuine trading history).
  const view = useMemo(() => (pool ? views.find(v => v.id === pool.poolId.toString()) : undefined), [views, pool])
  const showChart = !!pool && !!view && view.anchored && !isLowLiquidity(view) && displayHistory.length >= 3

  return (
    <div className={cn('mx-auto px-4 py-6', showChart ? 'grid max-w-6xl gap-5 lg:grid-cols-[1fr_minmax(380px,420px)]' : 'max-w-md')}>
      {/* Chart panel, only when the pair has meaningful history */}
      {showChart && (
      <motion.section
        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}
        className="order-2 lg:order-1 min-w-0"
      >
        <div className="card p-4 sm:p-5">
          {/* Stack on mobile so the wide price block and the timeframe toggle don't collide. The toggle
              sits on its own row below. */}
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm text-faint">
                <Activity className="h-4 w-4" /> {tokenIn.symbol} / {tokenOut.symbol}
              </div>
              <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="num text-2xl sm:text-3xl">{spot != null ? fmtPrice(spot, 6) : '-'}</span>
                <span className="whitespace-nowrap text-sm text-faint">{tokenOut.symbol} per {tokenIn.symbol}</span>
                {displayHistory.length >= 2 && (
                  <span className={cn('flex items-center gap-1 text-sm num', change >= 0 ? 'text-positive' : 'text-negative')}>
                    {change >= 0 ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
                    {change >= 0 ? '+' : '−'}{changeTxt.replace('-', '')}%
                  </span>
                )}
              </div>
            </div>
            <div className="-mx-1 shrink-0 overflow-x-auto px-1 sm:mx-0 sm:overflow-visible sm:px-0">
              <Segmented size="sm" className="min-w-max" options={RANGES.map(r => ({ value: r.value, label: r.label }))} value={range} onChange={setRange} />
            </div>
          </div>

          <PriceChart points={displayHistory} />

        </div>
      </motion.section>
      )}

      {/* Swap panel */}
      <motion.div
        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: 0.05 }}
        className={showChart ? 'order-1 lg:order-2 min-w-0' : ''}
      >
        <SwapCard
          tokenIn={tokenIn} tokenOut={tokenOut}
          setTokenIn={setTokenIn} setTokenOut={setTokenOut}
          amount={amount} setAmount={setAmount}
          initialMode={initialMode}
        />
        {/* First-time onboarding, shown only before a wallet is connected: getting a passkey and free
            testnet CKB from the faucet, then the first swap. */}
        {!signer && (
          <HowItWorks
            openOnMobile
            className="mt-5"
            title="New here? Start in 3 steps"
            steps={[
              { title: 'Connect a wallet',
                body: 'Tap Connect, choose JoyID, and approve with Face ID or your fingerprint. That creates your wallet, with no seed phrase and no app to install.' },
              { title: 'Get free testnet CKB',
                body: <>This is a <span className="font-medium text-foreground">test network, so you practice with play money, not real funds</span>. Grab free testnet CKB from the{' '}
                  <a href="https://faucet.nervos.org/" target="_blank" rel="noreferrer" className="text-primary hover:underline">Nervos faucet</a>{' '}
                  to cover tiny network fees and have something to swap.</> },
              { title: 'Make your first swap',
                body: 'Pick a token, type an amount, and approve. The price you see is the price you get. One tested formula sets every quote, with no hidden spread.' },
            ]}
            note={<><span className="font-medium text-foreground">Nothing here is real money.</span> Vortx is custody-free: your funds stay in your own wallet until you approve, and this testnet build is pre-audit, so practice with play money, not real funds.</>}
          />
        )}
      </motion.div>
    </div>
  )
}
