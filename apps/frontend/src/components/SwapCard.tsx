import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { NumericFormat } from 'react-number-format'
import { ccc } from '@ckb-ccc/connector-react'
import { ArrowDown, Settings2, Wallet, Zap, ShieldCheck, Info, Target } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from './ui/button'
import { Popover } from './ui/popover'
import { Segmented } from './ui/segmented'
import { Hint } from './ui/hint'
import { TokenPill, TokenSelect } from './TokenSelect'
import { OtxPanel } from './OtxPanel'
import { ConfirmSheet, type ConfirmRow } from './ConfirmSheet'
import { FaucetHelp } from './FaucetHelp'
import { useConnectPrompt } from './ConnectPrompt'
import { sdk } from '../lib/cellswap'
import { isPasskeyWallet } from '../lib/joyid'
import { relayLimitOrder } from '../lib/orders'
import { trackTx } from '../lib/txTracker'
import { CKB as ZERO, type TokenInfo } from '../lib/tokens'
import { tokenByTypeHash } from '../lib/pricing'
import { useHeldBalance, useQuote } from '../hooks/useData'
import { fmtUnits, parseUnits, cn, fmtPrice } from '../lib/utils'
import { recordActivity } from '../lib/activity'
import { humanizeError, FUNDS_SAFE_NOTE } from '../lib/errors'

// Trade types the user actually chooses between (market vs limit). Settlement mechanics
// (keeper-settled fallback, custody-free OTX) are not order types. They live elsewhere:
// the async/intent-lock path auto-triggers when no atomic route exists, and OTX is a
// "Custody-free mode" account toggle in settings.
const OTX_BLURB = 'Self-custody batch mode: your tokens stay in your own passkey wallet the whole time, and a shared settlement always pays you at least the minimum you set. JoyID is a free wallet that uses Face ID or your fingerprint, with no seed phrase and no app to install. Needs a one-time setup.'
type Mode = 'instant' | 'limit' | 'batch'
const MODES: { value: Mode; label: string; icon: typeof Zap; blurb: string }[] = [
  { value: 'instant', label: 'Instant', icon: Zap, blurb: 'Buy it now: you approve the whole swap and it settles in about 10 seconds. Your funds never leave your wallet until you approve. If there is no direct route, we ask before saving it as an order our service fills for you.' },
  { value: 'limit', label: 'Limit', icon: Target, blurb: 'Set the price you want. Your order waits until the market reaches it (or better), then fills automatically. It stays open until it fills or you cancel it.' },
  { value: 'batch', label: 'Batch', icon: ShieldCheck, blurb: OTX_BLURB },
]

export function SwapCard({
  tokenIn, tokenOut, setTokenIn, setTokenOut, amount, setAmount, initialMode,
}: {
  tokenIn: TokenInfo
  tokenOut: TokenInfo
  setTokenIn: (t: TokenInfo) => void
  setTokenOut: (t: TokenInfo) => void
  amount: string
  setAmount: (s: string) => void
  initialMode?: Mode
}) {
  const signer = ccc.useSigner()
  const navigate = useNavigate()
  const { wallet } = ccc.useCcc() as { wallet?: { name?: string } }
  // Route the card's Connect CTA through the same "New here? Pick JoyID" pre-step the header uses, so
  // a newcomer clicking the big blue button is not dropped into the unlabeled third-party picker.
  const { promptConnect, connectPromptNode } = useConnectPrompt()
  // Batch mode needs a passkey (JoyID). A connected non-passkey wallet (MetaMask, OKX, …) can do
  // everything else but not batch mode; surface that next to the toggle.
  const needsPasskeyForBatch = !!signer && !isPasskeyWallet(wallet?.name)
  // Three modes shown as one segmented control: Instant, Limit, and Batch (custody-free OTX).
  // Persisted across reloads; a ?mode= deep-link wins on first mount.
  const [mode, setMode] = useState<Mode>(() => {
    if (initialMode) return initialMode
    try {
      const m = localStorage.getItem('cs:swapMode'); if (m === 'instant' || m === 'limit' || m === 'batch') return m
      if (localStorage.getItem('cs:custodyFree') === '1') return 'batch'   // migrate the old custody-free toggle preference
    } catch { /* ignore */ }
    return 'instant'
  })
  useEffect(() => {
    try { localStorage.setItem('cs:swapMode', mode) } catch { /* ignore */ }
  }, [mode])
  const custodyFree = mode === 'batch'
  const [slippage, setSlippage] = useState(0.005)
  const [limitPrice, setLimitPrice] = useState('')
  const [picking, setPicking] = useState<null | 'in' | 'out'>(null)
  const [busy, setBusy] = useState(false)
  // Review-before-sign step: the primary button opens this; the real signer runs in onConfirm.
  const [confirmOpen, setConfirmOpen] = useState(false)
  // In-app confirm for the no-route -> keeper-settled order fallback.
  const [keeperConfirmOpen, setKeeperConfirmOpen] = useState(false)

  const held = useHeldBalance(signer ?? undefined)
  const amountIn = useMemo(() => parseUnits(amount, tokenIn.decimals), [amount, tokenIn.decimals])
  const { data: quote, isFetching } = useQuote(tokenIn.args, amountIn ?? undefined, tokenOut.args, slippage)

  const balIn = held(tokenIn.args)
  // CKB has a hard 61-CKB per-cell minimum plus the miner fee, so paying out the whole balance leaves
  // nothing to cover the fee or a change cell and the swap fails at completeInputsByCapacity/completeFeeBy.
  // Reserve a change-cell floor + fee headroom whenever the input token is native CKB.
  const CKB_MAX_RESERVE = 6_200_000_000n   // ~62 CKB: 61 CKB change-cell floor + fee headroom
  const feeReserveCkb = tokenIn.args === ZERO ? 100_000n : 0n   // ~0.001 CKB miner fee when paying CKB
  const insufficient = amountIn != null && amountIn + feeReserveCkb > balIn
  // Flag an empty CKB wallet so we can point first-timers at the faucet.
  const noCkb = !!signer && held(ZERO) <= 0n
  const impactPct = quote ? quote.priceImpact * 100 : 0
  const rate = quote && amountIn && quote.amountOut > 0n
    ? (Number(quote.amountOut) / 10 ** tokenOut.decimals) / (Number(amountIn) / 10 ** tokenIn.decimals)
    : 0
  // Total LP fee across the route, shared by the quote panel and the confirm sheet.
  const feeBps = (quote?.route.pools ?? []).reduce((s, p) => s + Number(p.feeBps ?? 0), 0)
  const feeText = feeBps > 0 ? `${(feeBps / 100).toFixed(2)}%` : '-'
  // The on-chain CKB miner fee, distinct from the LP "Trading fee" %. A swap pays roughly
  // 0.001 CKB at the standard fee rate; phrase it as an estimate.
  const NETWORK_FEE_TEXT = 'about 0.001 CKB'

  // Limit order: a resting intent-lock order whose minAmountOut encodes the target price.
  const isLimit = mode === 'limit'
  const limitPriceNum = Number(limitPrice) || 0
  // Orient the price as CKB-denominated "price of the non-CKB token" so cheaper = lower number
  // (as in a stock app). Let the non-CKB side be the "token" and CKB the "base";
  // the entered price P is always "CKB per 1 token".
  //   BUY  (pay CKB, receive token): tokenIn is CKB, tokenOut is the token. P = max CKB per token.
  //   SELL (pay token, receive CKB): tokenIn is the token, tokenOut is CKB. P = min CKB per token.
  // When neither side is CKB (rare token-to-token), the price is tokenOut per tokenIn.
  const buyToken = tokenIn.args === ZERO && tokenOut.args !== ZERO   // pay CKB, receive the token
  const sellToken = tokenOut.args === ZERO && tokenIn.args !== ZERO  // pay the token, receive CKB
  const ckbPriced = buyToken || sellToken
  const token = buyToken ? tokenOut : sellToken ? tokenIn : tokenOut // the non-CKB side (label subject)
  // Market price in the field's own unit. CKB-priced BUY shows CKB per token = 1/rate; CKB-priced
  // SELL shows CKB per token = rate; token-to-token keeps rate (tokenOut per tokenIn).
  const marketPrice = buyToken ? (rate > 0 ? 1 / rate : 0) : rate
  // limitOut is in base units of tokenOut in every case. For SELL / token-to-token the entered price
  // is tokenOut-per-tokenIn; for BUY it is CKB-per-token (= tokenIn-per-tokenOut), so
  // we invert. Done entirely in bigint (parse the price against the right side's decimals, then
  // cross-multiply) so amounts above 2^53 base units and last-digit float rounding can't drift the
  // committed on-chain limit away from what the user typed.
  const limitOut = ((): bigint => {
    if (!amountIn || limitPriceNum <= 0) return 0n
    if (buyToken) {
      // BUY: price is CKB per token (= tokenIn per 1 tokenOut). out = amountIn * 10^outDec / priceScaled.
      const priceScaled = parseUnits(limitPrice, tokenIn.decimals)
      if (!priceScaled || priceScaled <= 0n) return 0n
      return (amountIn * 10n ** BigInt(tokenOut.decimals)) / priceScaled
    }
    // SELL / token-to-token: price is tokenOut per 1 tokenIn. out = amountIn * priceScaled / 10^inDec.
    const priceScaled = parseUnits(limitPrice, tokenOut.decimals)
    if (!priceScaled || priceScaled <= 0n) return 0n
    return (amountIn * priceScaled) / 10n ** BigInt(tokenIn.decimals)
  })()

  function flip() {
    const ti = tokenIn, to = tokenOut
    setTokenIn(to); setTokenOut(ti); setAmount('')
  }
  function setPct(p: number) {
    if (balIn <= 0n) return
    let v = (balIn * BigInt(Math.round(p * 100))) / 100n
    // MAX on native CKB must leave the fee + change-cell floor behind, or the swap can't settle.
    if (p === 1 && tokenIn.args === ZERO) v = balIn > CKB_MAX_RESERVE ? balIn - CKB_MAX_RESERVE : 0n
    setAmount(fmtUnits(v, tokenIn.decimals, tokenIn.decimals))
  }

  // Plain-English amounts for the confirm sheet / activity log.
  const payText = `${amount || '0'} ${tokenIn.symbol}`
  const receiveAtLeast = isLimit ? limitOut : (quote?.minAmountOut ?? 0n)
  const receiveText = `${fmtUnits(receiveAtLeast, tokenOut.decimals, 6)} ${tokenOut.symbol}`

  // Open the review step instead of signing straight away.
  function reviewSwap() {
    if (!signer || !quote || !amountIn) return
    if (isLimit && limitOut <= 0n) { toast.error('Set a limit price'); return }
    setConfirmOpen(true)
  }

  // Toast actions: "Copy tx" stays, plus a durable link to where the result lives.
  const copyTx = (txHash: string) => ({ label: 'Copy tx', onClick: () => navigator.clipboard.writeText(txHash) })
  const goToPositions = { label: 'View in Positions', onClick: () => navigate('/positions') }
  const goToWallet = { label: 'View in wallet', onClick: () => navigate('/wallet') }

  async function runSwap() {
    if (!signer || !quote || !amountIn) return
    if (isLimit && limitOut <= 0n) { toast.error('Set a limit price'); return }
    setBusy(true)
    const id = toast.loading(isLimit ? `Placing your order…` : `Swapping ${amount} ${tokenIn.symbol} → ${tokenOut.symbol}…`)
    const params = { tokenIn: tokenIn.args, amountIn, tokenOut: tokenOut.args,
      minAmountOut: isLimit ? limitOut : quote.minAmountOut }
    // Place a resting intent-lock order + relay it to the keeper so it auto-fills (the
    // on-chain cell stores only the owner's hash, so the keeper needs the full lock script).
    const placeOrder = async (heading: string, sub: string) => {
      const txHash = await trackTx('Place order', () => sdk.swapAsync(signer as any, params))
      const relayed = await relayLimitOrder(signer as any, txHash, 0)
      // A resting order is not done yet; it waits to fill. Record it as pending so Positions shows a
      // "waiting" state, not a misleading green "completed" check.
      recordActivity({
        id: txHash, kind: 'order', status: 'pending', txHash,
        summary: `Ordered ${receiveText} for ${payText}`,
      })
      toast.success(`${heading}: ${txHash.slice(0, 12)}…`, {
        id, action: goToPositions, cancel: copyTx(txHash), duration: 12_000,
        description: relayed ? sub : 'Order saved. Auto-fill service is offline; you can cancel it from Positions.',
      })
    }
    try {
      if (isLimit) {
        await placeOrder('Order placed', 'Waiting. Fills automatically at your price. Cancel any time from Positions.')
      } else {
        // Instant = atomic swap. If there's no atomic route, ask before falling back to a
        // keeper-settled order. The trust model changes from atomic to keeper liveness, so
        // the user must opt in rather than have it happen silently.
        try {
          const txHash = await trackTx('Swap', () => sdk.swap(signer as any, params))
          recordActivity({
            id: txHash, kind: 'swap', status: 'completed', txHash,
            summary: `Swapped ${payText} for ${fmtUnits(quote.amountOut, tokenOut.decimals, 6)} ${tokenOut.symbol}`,
          })
          toast.success(`Swapped: ${txHash.slice(0, 12)}…`, {
            id, action: goToWallet, cancel: copyTx(txHash), duration: 12_000,
            description: 'Trade complete. The tokens are in your wallet now.',
          })
        } catch (e) {
          if (!/no route|no pool|routed-hop|only ckb-routed/i.test((e as Error).message)) throw e
          // No silent fallback and no browser popup. Dismiss the spinner and open an
          // in-app confirm sheet; the keeper order is placed only if the user accepts there.
          toast.dismiss(id)
          setBusy(false)
          setKeeperConfirmOpen(true)
          return
        }
      }
      setAmount('')
    } catch (e) {
      toast.error(isLimit ? 'Order failed' : 'Swap failed', { id, description: `${humanizeError(e)} ${FUNDS_SAFE_NOTE}` })
    } finally { setBusy(false) }
  }

  // Place the keeper-settled order after the user confirms the in-app fallback sheet. Same
  // params as the instant swap; the trust model is keeper-liveness, surfaced in the sheet's note.
  async function placeKeeperOrder() {
    if (!signer || !quote || !amountIn) return
    setBusy(true)
    const id = toast.loading('Placing your order…')
    const params = { tokenIn: tokenIn.args, amountIn, tokenOut: tokenOut.args, minAmountOut: quote.minAmountOut }
    try {
      const txHash = await trackTx('Place order', () => sdk.swapAsync(signer as any, params))
      const relayed = await relayLimitOrder(signer as any, txHash, 0)
      // Resting/keeper order: pending until it fills, not "completed".
      recordActivity({
        id: txHash, kind: 'order', status: 'pending', txHash,
        summary: `Ordered ${receiveText} for ${payText}`,
      })
      toast.success(`Order placed: ${txHash.slice(0, 12)}…`, {
        id, action: goToPositions, cancel: copyTx(txHash), duration: 12_000,
        description: relayed
          ? 'Our service fills it automatically when possible. Cancel any time from Positions.'
          : 'Order saved. Auto-fill service is offline; you can cancel it from Positions.',
      })
      setAmount('')
    } catch (e) {
      toast.error('Order failed', { id, description: `${humanizeError(e)} ${FUNDS_SAFE_NOTE}` })
    } finally { setBusy(false) }
  }

  const cta = !signer ? 'Connect wallet'
    : !amountIn ? 'Enter an amount'
    : insufficient ? `Insufficient ${tokenIn.symbol}`
    : isLimit && limitOut <= 0n ? 'Set a limit price'
    : isFetching && !quote ? 'Fetching quote…'
    : !quote ? 'No swap available, try another amount or token'
    : busy ? 'Confirm in wallet…'
    : isLimit ? 'Place limit order'
    : 'Swap'

  return (
    <div className="panel p-4 sm:p-5">
      <span className="panel-tick tl" /><span className="panel-tick tr" />
      <span className="panel-tick bl" /><span className="panel-tick br" />
      <div className="mb-4 flex items-center justify-between">
        <Segmented options={MODES.map(m => ({ value: m.value, label: m.label, hint: m.blurb }))} value={mode} onChange={setMode} />
        <Popover trigger={<Button variant="ghost" size="icon" aria-label="Settings"><Settings2 className="h-4 w-4" /></Button>}>
          <div className="flex items-center gap-1 text-sm font-medium">Max price change (slippage)<Hint text="The biggest price move you'll accept between now and when your swap settles. If the price moves more than this, the swap cancels instead of giving you less. Lower is safer; too low and busy-market swaps may fail." /></div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {[0.001, 0.005, 0.01].map(s => (
              <button key={s} onClick={() => setSlippage(s)}
                className={cn('flex min-h-[40px] flex-1 items-center justify-center rounded-lg text-sm transition-colors', slippage === s ? 'bg-primary text-primary-foreground' : 'bg-surface-2 text-muted hover:text-foreground')}>
                {(s * 100).toFixed(s < 0.01 ? 1 : 0)}%
              </button>
            ))}
            <div className="flex min-h-[40px] items-center gap-1 rounded-lg bg-surface-2 px-2">
              <input
                type="number" step="0.1" min="0"
                value={(slippage * 100).toString()}
                onChange={e => setSlippage(Math.max(0, Number(e.target.value) / 100))}
                className="w-14 bg-transparent py-1.5 text-right text-sm outline-none num"
              />
              <span className="text-sm text-faint">%</span>
            </div>
          </div>
          {/* Guard the two extremes: 0% makes nearly every swap fail (price must not move at all), and a
              high setting hands away the "you'll get at least" protection. */}
          {slippage === 0 && (
            <p className="mt-2 text-xs text-warning">0% means the price must not move at all, so almost every swap will fail. You will confirm this before signing.</p>
          )}
          {slippage >= 0.05 && (
            <p className="mt-2 text-xs text-warning">That is a high tolerance. Your swap can fill at a much worse price than you see now.</p>
          )}
          <div className="mt-4 border-t border-border pt-3 text-xs text-faint">
            <span className="flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-primary" />
              Want your funds to never leave your wallet? Use the <span className="font-medium text-foreground">Batch</span> tab above.
            </span>
          </div>
        </Popover>
      </div>

      {/* Point newcomers at the simplest default and explain the batch-vs-instant trade-off. */}
      <p className="mb-1 text-xs text-faint">
        <span className="font-medium text-foreground">Instant (recommended)</span>; Limit and Batch give you more control.
      </p>
      <p className="mb-3 text-xs text-faint">
        Batch gets a better shared price for a one-time setup; Instant is faster and simpler.
      </p>

      {/* You pay */}
      <Field
        label="You pay"
        amount={amount}
        editable
        onAmount={setAmount}
        token={tokenIn}
        onPick={() => setPicking('in')}
        balance={held(tokenIn.args)}
        onPct={setPct}
      />

      {/* Flip (axon connector) */}
      <div className="axon">
        <button onClick={flip} className="node" aria-label="Switch tokens">
          <ArrowDown className="h-4 w-4" />
        </button>
      </div>

      {/* Limit price (limit mode only) */}
      {isLimit && (
        <div className="mb-2 rounded-2xl border border-border bg-surface-2/40 p-4">
          <div className="mb-2 flex items-center justify-between text-xs text-faint">
            {/* CKB-denominated "price of the token" so cheaper = lower number. Token-to-token
                (neither side CKB) uses a tokenOut-per-tokenIn label. */}
            <span>{ckbPriced ? `${token.symbol} price · CKB` : `Limit price · ${tokenOut.symbol} per ${tokenIn.symbol}`}</span>
            <button onClick={() => marketPrice && setLimitPrice(marketPrice.toPrecision(6))} className="hover:text-foreground">
              Market {marketPrice ? fmtPrice(marketPrice) : '-'}
            </button>
          </div>
          <NumericFormat
            value={limitPrice} onValueChange={v => setLimitPrice(v.value)} thousandSeparator allowNegative={false}
            decimalScale={tokenOut.decimals} placeholder="0.0" inputMode="decimal"
            className="num w-full bg-transparent text-2xl font-medium outline-none placeholder:text-faint"
          />
          {/* Restate in the CKB-per-token unit so "cheaper = lower number" holds for a buyer.
              BUY: P is the max you'll pay per token; you buy only when 1 token costs P CKB or less, so it
              rests while P < market (waits for the token to get that cheap) and fills when P >= market.
              SELL: P is the min you'll accept per token; you sell only when 1 token is worth P CKB or
              more, so it rests while P > market (waits for a higher price) and fills when P <= market. */}
          {limitPriceNum > 0 && (
            <div className="mt-1 text-xs text-faint">
              {ckbPriced
                ? (buyToken
                    ? <>Buy {token.symbol} only when 1 {token.symbol} costs {fmtPrice(limitPriceNum)} CKB or less.</>
                    : <>Sell {token.symbol} only when 1 {token.symbol} is worth {fmtPrice(limitPriceNum)} CKB or more.</>)
                : <>Fills when 1 {tokenIn.symbol} gets you at least {fmtPrice(limitPriceNum)} {tokenOut.symbol}.</>}
            </div>
          )}
          {marketPrice > 0 && limitPriceNum > 0 && (
            <div className="mt-1 text-xs text-faint">
              {buyToken
                ? (limitPriceNum >= marketPrice
                    ? <span className="text-warning">At or above the market price now. Fills as soon as you confirm.</span>
                    : <span className="text-positive">{(((1 - limitPriceNum / marketPrice)) * 100).toFixed(2)}% below the market price now. Rests until {token.symbol} gets this cheap.</span>)
                : (limitPriceNum <= marketPrice
                    ? <span className="text-warning">At or below the market price now. Fills as soon as you confirm.</span>
                    : <span className="text-positive">{(((limitPriceNum / marketPrice) - 1) * 100).toFixed(2)}% above the market price now. Rests until the price rises to it.</span>)}
            </div>
          )}
          {/* State the GTC lifetime in plain language. */}
          <div className="mt-2 text-xs text-faint">
            This order stays open until it fills or you cancel it.
          </div>
        </div>
      )}

      {/* You receive */}
      <Field
        label="You receive"
        amount={isLimit
          ? (limitOut > 0n ? fmtUnits(limitOut, tokenOut.decimals, 6) : '')
          : (quote ? fmtUnits(quote.amountOut, tokenOut.decimals, 6) : '')}
        token={tokenOut}
        onPick={() => setPicking('out')}
        balance={held(tokenOut.args)}
        muted
      />
      {/* The quote is fetched (and debounced), so for a moment after typing the field reads 0.0. Say
          it's working, so that pause doesn't read as "you'd get nothing". No wallet is needed to quote. */}
      {!isLimit && isFetching && !quote && amountIn != null && amountIn > 0n && (
        <p className="mt-1 px-1 text-xs text-faint">Getting the best price…</p>
      )}

      {/* Quote details */}
      {quote && amountIn != null && (
        <div className="mt-3 space-y-1.5 rounded-xl border border-border bg-surface-2/50 p-3 text-sm">
          <Row label="Exchange rate" hint="What one token is worth in the other right now."><span className="num">1 {tokenIn.symbol} ≈ {rate ? fmtPrice(rate, 6) : '-'} {tokenOut.symbol}</span></Row>
          <Row label="Price impact" hint="How much your own trade moves the price. Bigger trades move it more, and a higher % means a worse rate for you. Under 1% is good.">
            <span className={cn('num', impactPct >= 5 ? 'text-negative' : impactPct >= 1 ? 'text-warning' : 'text-positive')}>
              {impactPct.toFixed(2)}%
            </span>
          </Row>
          <Row label="You’ll get at least" hint="The least you'll receive. If the price moves more than your max price change, the swap cancels instead of paying you less."><span className="num">{fmtUnits(quote.minAmountOut, tokenOut.decimals, 6)} {tokenOut.symbol}</span></Row>
          {quote.route.hops > 1 && (
            <Row label="Path" hint="The route your trade takes through pools to reach the token you want. Extra steps can mean a slightly worse rate.">
              <span className="num text-xs text-muted">
                {quote.route.path.map(h => h === ZERO ? 'CKB' : (tokenByTypeHash(h)?.symbol ?? '?')).join(' → ')}
              </span>
            </Row>
          )}
          <Row label="Trading fee" hint="Paid to the people who supply the tokens for this pair (the liquidity providers). It's already included in the amount you receive."><span className="num text-muted">{feeText}</span></Row>
          <Row label="Network fee" hint="The tiny cost the CKB network charges to record your transaction. This is separate from the trading fee above, and it does not change with the trade size."><span className="num text-muted">{NETWORK_FEE_TEXT}</span></Row>
        </div>
      )}

      {/* Mode note */}
      <div className="mt-3 flex items-start gap-2 rounded-xl bg-surface-2/40 p-3 text-xs text-faint">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
        <span>{MODES.find(m => m.value === mode)!.blurb}</span>
      </div>
      {custodyFree && needsPasskeyForBatch && (
        <p className="mt-2 rounded-xl bg-surface-2/60 px-3 py-2 text-xs text-faint">
          Batch mode needs JoyID, a free wallet that uses Face ID or your fingerprint, with no seed phrase and no app to install. Your {wallet?.name ?? 'current wallet'} works for every other trade. Connect a passkey in the next step.
        </p>
      )}

      {custodyFree && signer ? (
        <OtxPanel tokenIn={tokenIn} tokenOut={tokenOut} amountIn={amountIn} minOut={quote?.minAmountOut ?? null} />
      ) : (
        <Button
          size="lg"
          className="mt-3 w-full"
          disabled={!!signer && (!quote || !!insufficient || busy || !amountIn || (isLimit && limitOut <= 0n))}
          onClick={() => (signer ? reviewSwap() : promptConnect())}
        >
          {!signer && <Wallet className="h-4 w-4" />}
          {cta}
        </Button>
      )}

      {/* Empty or short on CKB: show the full copy-address and steps flow next to the disabled CTA,
          not a bare link, so a first-timer is not left wondering what their address is. */}
      {!custodyFree && signer && (noCkb || insufficient) && (
        <div className="mt-2">
          {noCkb && (
            <p className="mb-2 text-center text-xs text-faint">
              You need a little CKB to cover network fees. Grab some free testnet CKB below to practice with play money, not real funds.
            </p>
          )}
          <FaucetHelp signer={signer ?? undefined} />
        </div>
      )}

      {/* Review step shown before the wallet signer runs. */}
      <ConfirmSheet
        open={confirmOpen}
        onOpenChange={(o) => { if (!busy) setConfirmOpen(o) }}
        title={isLimit ? 'Review your order' : 'Review your swap'}
        rows={[
          { label: 'You pay', value: payText },
          ...(isLimit
            ? [{ label: 'Target price', value: ckbPriced ? `${fmtPrice(limitPriceNum)} CKB per ${token.symbol}` : `${fmtPrice(limitPriceNum)} ${tokenOut.symbol} per ${tokenIn.symbol}`, emphasize: true } as ConfirmRow]
            : [{ label: 'Price impact', value: `${impactPct.toFixed(2)}%` } as ConfirmRow]),
          { label: 'You receive at least', value: receiveText, emphasize: true },
          { label: 'Trading fee', value: feeText },
          { label: 'Network fee', value: NETWORK_FEE_TEXT },
        ]}
        note={
          <>
            {isLimit
              ? 'This order stays open until it fills or you cancel it. Your funds stay in your wallet until it fills.'
              : 'Your funds stay in your wallet until you approve. Once it confirms on-chain it cannot be reversed.'}
            {/* Warn before a high-impact trade so the user confirms knowingly. */}
            {!isLimit && impactPct >= 5 && (
              <span className="mt-2 block text-warning">This trade moves the price a lot. You may get a poor rate.</span>
            )}
            {/* Restate an extreme max-price-change setting at the point of signing. */}
            {!isLimit && slippage === 0 && (
              <span className="mt-2 block text-warning">Your max price change is 0%, so this swap will only go through if the price does not move at all. It will likely fail; raise it a little if so.</span>
            )}
            {!isLimit && slippage >= 0.05 && (
              <span className="mt-2 block text-warning">Your max price change is {(slippage * 100).toFixed(1)}%, a large tolerance. The swap can fill at a noticeably worse price than shown.</span>
            )}
          </>
        }
        confirmLabel={isLimit ? 'Place order' : 'Swap'}
        busy={busy}
        onConfirm={() => { void runSwap().finally(() => setConfirmOpen(false)) }}
      />

      {/* In-app confirm for the no-route -> keeper-settled order fallback. */}
      <ConfirmSheet
        open={keeperConfirmOpen}
        onOpenChange={(o) => { if (!busy) setKeeperConfirmOpen(o) }}
        title="No instant route right now"
        rows={[
          { label: 'You pay', value: payText },
          { label: 'You receive at least', value: receiveText, emphasize: true },
          { label: 'Network fee', value: NETWORK_FEE_TEXT },
        ]}
        note={`There is no instant route for this pair right now. We can save this as an order our service fills for you when one opens up, and you can cancel it any time from Positions. ${FUNDS_SAFE_NOTE}`}
        confirmLabel="Place order"
        cancelLabel="Not now"
        busy={busy}
        onConfirm={() => { void placeKeeperOrder().finally(() => setKeeperConfirmOpen(false)) }}
      />

      <TokenSelect
        open={picking !== null}
        onOpenChange={(o) => !o && setPicking(null)}
        exclude={picking === 'in' ? tokenOut.args : tokenIn.args}
        onSelect={(t) => (picking === 'in' ? setTokenIn(t) : setTokenOut(t))}
      />
      {connectPromptNode}
    </div>
  )
}

function Field({
  label, amount, token, onPick, balance, onAmount, onPct, editable, muted,
}: {
  label: string
  amount: string
  token: TokenInfo
  onPick: () => void
  balance?: bigint
  onAmount?: (s: string) => void
  onPct?: (p: number) => void
  editable?: boolean
  muted?: boolean
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface-2/40 p-4">
      <div className="mb-2 flex items-center justify-between text-xs text-faint">
        <span>{label}</span>
        {balance != null && (
          <span className="flex items-center gap-1">
            <Wallet className="h-3 w-3" /> <span className="num">{fmtUnits(balance, token.decimals, 4)}</span>
          </span>
        )}
      </div>
      <div className="flex items-center gap-3">
        <NumericFormat
          value={amount}
          onValueChange={(v) => onAmount?.(v.value)}
          thousandSeparator
          allowNegative={false}
          decimalScale={token.decimals}
          placeholder="0.0"
          readOnly={!editable}
          inputMode="decimal"
          className={cn('num min-w-0 flex-1 bg-transparent text-3xl font-medium outline-none placeholder:text-faint', muted && 'text-muted')}
        />
        <TokenPill token={token} onClick={onPick} />
      </div>
      {editable && onPct && (
        <div className="mt-3 flex gap-2">
          {[0.25, 0.5, 0.75, 1].map(p => (
            <button key={p} onClick={() => onPct(p)}
              className="flex min-h-[40px] flex-1 items-center justify-center rounded-lg bg-surface px-2 text-xs text-faint transition-colors hover:text-foreground">
              {p === 1 ? 'MAX' : `${p * 100}%`}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const Row = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
  <div className="flex items-center justify-between">
    <span className="flex items-center gap-1 text-faint">{label}{hint && <Hint text={hint} />}</span>
    {children}
  </div>
)
