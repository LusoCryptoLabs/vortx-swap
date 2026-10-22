import { useState } from 'react'
import { Link } from 'react-router-dom'
import { NumericFormat } from 'react-number-format'
import { ccc } from '@ckb-ccc/connector-react'
import { Plus, Sparkles, AlertTriangle, Check, Lock, ArrowRight, ReceiptText } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog } from './ui/dialog'
import { Button } from './ui/button'
import { Segmented } from './ui/segmented'
import { Hint } from './ui/hint'
import { FaucetHelp } from './FaucetHelp'
import { useConnectPrompt } from './ConnectPrompt'
import { TokenPill, TokenSelect } from './TokenSelect'
import { sdk } from '../lib/cellswap'
import { trackTx } from '../lib/txTracker'
import { recordActivity } from '../lib/activity'
import { humanizeError, FUNDS_SAFE_NOTE } from '../lib/errors'
import { CKB, CKB_TOKEN, CKB_TYPE_HASH, isVerifiedToken, type TokenInfo, firstCuratedNonCkb } from '../lib/tokens'
import { useHeldBalance, usePools, useTipEpoch } from '../hooks/useData'
import { anchorOf, buildPricer } from '../lib/pricing'
import { fmtUnits, parseUnits, cn, epochEta, fmtDate, fmtPrice, compact } from '../lib/utils'
import type { Pool } from '@cellswap/sdk'

/** Integer square root (matches the SDK's initial-LP math: lpSupply = sqrt(x*y)). */
function isqrt(n: bigint): bigint {
  if (n < 0n) return 0n
  if (n < 2n) return n
  let x = n, y = (x + 1n) / 2n
  while (y < x) { x = y; y = (x + n / x) / 2n }
  return x
}

// CKB epochs are ~4h, so ~6 per day. That is the resolution for the "lock for N days" commitment.
const EPOCHS_PER_DAY = 6

function randomPoolId(): bigint {
  const b = new Uint8Array(8)
  globalThis.crypto.getRandomValues(b)
  let id = 0n; for (const x of b) id = (id << 8n) | BigInt(x)
  return id
}

export function LiquidityModal({
  open, onOpenChange, mode, presetX, presetY, pool, onDone,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  mode: 'add' | 'create'
  presetX?: TokenInfo
  presetY?: TokenInfo
  pool?: Pool | null
  onDone?: () => void
}) {
  const signer = ccc.useSigner()
  const { promptConnect, connectPromptNode } = useConnectPrompt()
  const held = useHeldBalance(signer ?? undefined)
  const { data: tipEpoch } = useTipEpoch()
  // Default to the first curated non-CKB token paired with CKB. Network-agnostic: a hardcoded testnet
  // default (TKA) does not exist on mainnet and would open the create-pool modal as CKB/CKB.
  const [tokenX, setTokenX] = useState<TokenInfo>(presetX ?? firstCuratedNonCkb())
  const [tokenY, setTokenY] = useState<TokenInfo>(presetY ?? CKB_TOKEN)
  const [amtX, setAmtX] = useState('')
  const [amtY, setAmtY] = useState('')
  const [feeBps, setFeeBps] = useState(30)
  const [picking, setPicking] = useState<null | 'x' | 'y'>(null)
  const [busy, setBusy] = useState(false)
  const [ack, setAck] = useState(false)
  const [lockDays, setLockDays] = useState(0)   // 0 = no commitment lock

  // Creating a pool with an unverified token is permissionless but risky, so require an ack.
  const hasUnverified = mode === 'create' && (!isVerifiedToken(tokenX.args) || !isVerifiedToken(tokenY.args))

  // Anchoring: a pool only has real value if a side can reach a base asset (CKB). If neither
  // token has a path to CKB, the new pool is a closed loop: a price with no exit liquidity.
  const { data: pools = [] } = usePools()
  const xAnchored = tokenX.args === CKB || !!anchorOf(pools, tokenX.args)
  const yAnchored = tokenY.args === CKB || !!anchorOf(pools, tokenY.args)
  const willBeUnanchored = mode === 'create' && !xAnchored && !yAnchored

  // Pre-flight: don't let the user sign a deposit they can't cover.
  const axParsed = parseUnits(amtX, tokenX.decimals)
  const ayParsed = parseUnits(amtY, tokenY.decimals)
  const shortX = axParsed != null && axParsed > held(tokenX.args)
  const shortY = ayParsed != null && ayParsed > held(tokenY.args)
  const shortToken = shortX ? tokenX.symbol : shortY ? tokenY.symbol : null

  // When a side is short, tell the user roughly how much more they need and deep-link a swap
  // that buys exactly that token (/swap?out=<args> pre-selects it as "You receive").
  const shortFor = (t: TokenInfo, parsed: bigint | null): { need: string; symbol: string; args: string } | null => {
    if (parsed == null) return null
    const gap = parsed - held(t.args)
    if (gap <= 0n) return null
    return { need: fmtUnits(gap, t.decimals, 4), symbol: t.symbol, args: t.args }
  }
  const shortInfoX = shortX ? shortFor(tokenX, axParsed) : null
  const shortInfoY = shortY ? shortFor(tokenY, ayParsed) : null

  // A fresh wallet has 0 CKB and dead-ends here (every deposit and the network fee need CKB).
  // Surface the self-contained faucet hand-off when the user holds no CKB at all.
  const noCkb = !!signer && held(CKB) <= 0n

  const ratioLock = mode === 'add' && pool && pool.reserveX > 0n && pool.reserveY > 0n
  const inIsX = pool ? pool.tokenX.toLowerCase() === sdk.udtHash(tokenX.args as any).toLowerCase() : true
  const rX = pool ? (inIsX ? pool.reserveX : pool.reserveY) : 0n
  const rY = pool ? (inIsX ? pool.reserveY : pool.reserveX) : 0n

  // "Top up" slider (add mode): a deposit is ratio-locked, so the most you can add is bounded by
  // whichever side you hold less of at the pool ratio. Picking a % sets tokenX; tokenY ratio-fills.
  const maxDepositX = (() => {
    if (!ratioLock || rY <= 0n) return 0n
    const hX = held(tokenX.args), hY = held(tokenY.args)
    const byY = (hY * rX) / rY
    return byY < hX ? byY : hX
  })()
  const pctValue = maxDepositX > 0n && axParsed != null
    ? Math.max(0, Math.min(100, Number((axParsed * 100n) / maxDepositX)))
    : 0
  const setByPct = (p: number) => onX(fmtUnits((maxDepositX * BigInt(p)) / 100n, tokenX.decimals, tokenX.decimals))

  // Approximate CKB value of one side's amount, using the live price map (CKB per 1 human unit).
  // Returns null when the side has no CKB-priced path (so we can omit it instead of showing a wrong 0).
  const pricer = buildPricer(pools)
  const ckbValueOf = (t: TokenInfo, parsed: bigint | null): number | null => {
    if (parsed == null || parsed <= 0n) return 0
    const th = t.args === CKB ? CKB_TYPE_HASH : sdk.udtHash(t.args as any).toLowerCase()
    const price = pricer.get(th)
    if (price == null || !isFinite(price)) return null
    return (Number(parsed) / 10 ** t.decimals) * price
  }
  const valX = ckbValueOf(tokenX, axParsed)
  const valY = ckbValueOf(tokenY, ayParsed)
  // Combined deposit value in CKB, shown under the inputs. null if neither side can be priced.
  const combinedCkb = valX == null && valY == null ? null : (valX ?? 0) + (valY ?? 0)

  // Output preview (mirrors the Remove modal): the LP "receipt" tokens minted and the resulting
  // share of the pool. add → min of each side's pro-rata mint; create → sqrt(x*y) and you own 100%.
  const { lpReceived, sharePct } = (() => {
    if (mode === 'add' && pool && pool.lpSupply > 0n && rX > 0n && rY > 0n) {
      const dx = inIsX ? axParsed : ayParsed
      const dy = inIsX ? ayParsed : axParsed
      if (!dx || !dy) return { lpReceived: 0n, sharePct: 0 }
      const lpFromX = (dx * pool.lpSupply) / rX
      const lpFromY = (dy * pool.lpSupply) / rY
      const lp = lpFromX < lpFromY ? lpFromX : lpFromY
      return { lpReceived: lp, sharePct: Number(lp) / Number(pool.lpSupply + lp) * 100 }
    }
    if (mode === 'create' && axParsed && ayParsed && axParsed > 0n && ayParsed > 0n) {
      // Matches the SDK: lp_supply = sqrt(x*y); the creator receives that minus a tiny locked
      // MINIMUM_LIQUIDITY (1000) and, as first provider, owns ~100% of the pool.
      const lp = isqrt(axParsed * ayParsed)
      const minted = lp > 1000n ? lp - 1000n : 0n
      return { lpReceived: minted, sharePct: minted > 0n ? 100 : 0 }
    }
    return { lpReceived: 0n, sharePct: 0 }
  })()
  const hasAmounts = !!axParsed && !!ayParsed && axParsed > 0n && ayParsed > 0n
  const showPreview = hasAmounts && lpReceived > 0n

  function onX(v: string) {
    setAmtX(v)
    if (ratioLock) {
      const ax = parseUnits(v, tokenX.decimals)
      if (ax != null && rX > 0n) setAmtY(fmtUnits((ax * rY) / rX, tokenY.decimals, tokenY.decimals))
    }
  }
  function onY(v: string) {
    setAmtY(v)
    if (ratioLock) {
      const ay = parseUnits(v, tokenY.decimals)
      if (ay != null && rY > 0n) setAmtX(fmtUnits((ay * rX) / rY, tokenX.decimals, tokenX.decimals))
    }
  }

  async function submit() {
    if (!signer) return
    let aX = parseUnits(amtX, tokenX.decimals), aY = parseUnits(amtY, tokenY.decimals)
    if (!aX || !aY) return toast.error('Enter amounts')
    if (tokenX.args === tokenY.args) return toast.error('Pick two different tokens')
    if (hasUnverified && !ack) return toast.error('Please confirm you understand the token risk first')
    // CKB-native pools require CKB as tokenX (the SDK reads reserveX off the info-cell capacity).
    // If the user put CKB in slot B, swap sides + amounts so CKB is tokenX.
    let [tX, tY] = [tokenX, tokenY]
    if (tY.args === CKB && tX.args !== CKB) { [tX, tY] = [tY, tX]; [aX, aY] = [aY, aX] }
    setBusy(true)
    const id = toast.loading(mode === 'create' ? 'Creating pool…' : 'Adding liquidity…')
    try {
      let h: string
      if (mode === 'create') {
        h = await trackTx('Create pool', () => sdk.createPool(signer as any, { tokenX: tX.args, tokenY: tY.args, amountX: aX, amountY: aY, feeBps, poolId: randomPoolId() }))
      } else if (pool) {
        // Resolve from the pool object (real reserve-cell type scripts) so non-curated / unusual-args
        // tokens work. Orient amounts onto pool.tokenX/tokenY without udtHash (which can't resolve such
        // tokens): CKB-native → CKB is pool.tokenX (already in slot X after the swap above); xUDT/xUDT →
        // match tX.args to the reserve cell's real type args.
        const poolXArgs = pool.reserveCellX?.output.type?.args
        const tXisPoolX = pool.poolMode === 'CKB_XUDT'
          ? tX.args === CKB
          : (poolXArgs != null && poolXArgs.toLowerCase() === tX.args.toLowerCase())
        const [amountX, amountY] = tXisPoolX ? [aX, aY] : [aY, aX]
        h = await trackTx('Add liquidity', () => sdk.addLiquidityToPool(signer as any, pool, {
          amountX, amountY,
          lockEpochs: lockDays > 0 ? lockDays * EPOCHS_PER_DAY : undefined,
        }))
      } else {
        h = await trackTx('Add liquidity', () => sdk.addLiquidity(signer as any, {
          tokenX: tX.args, tokenY: tY.args, amountX: aX, amountY: aY,
          lockEpochs: lockDays > 0 ? lockDays * EPOCHS_PER_DAY : undefined,
        }))
      }
      toast.success(mode === 'create' ? 'Pool created' : 'Liquidity added', { id, description: `${h.slice(0, 12)}…` })
      recordActivity({
        id: h, kind: 'liquidity', status: 'completed', txHash: h,
        summary: mode === 'create'
          ? `Created ${tX.symbol} / ${tY.symbol} pool with ${amtX} ${tokenX.symbol} + ${amtY} ${tokenY.symbol}`
          : `Added ${amtX} ${tokenX.symbol} + ${amtY} ${tokenY.symbol} to ${tokenX.symbol} / ${tokenY.symbol}`,
      })
      setAmtX(''); setAmtY(''); onOpenChange(false); onDone?.()
    } catch (e) { toast.error(mode === 'create' ? 'Could not create pool' : 'Could not add liquidity', { id, description: `${humanizeError(e)} ${FUNDS_SAFE_NOTE}` }) }
    finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={mode === 'create' ? 'Create a pool' : 'Add liquidity'}>
      <p className="mb-3 text-xs leading-relaxed text-faint">
        {mode === 'create'
          ? 'Start a new market by depositing a pair of tokens. Every time someone trades this pair, you earn a share of the fee.'
          : 'Add both tokens to this pool to earn a share of the trading fees.'}
      </p>

      {/* Both tokens are required; say so before the inputs. */}
      <div className="mb-3 flex items-start gap-2 rounded-xl border border-primary/30 bg-primary/5 p-3 text-xs leading-relaxed text-faint">
        <Plus className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <span>
          You add <span className="text-foreground">both</span> {tokenX.symbol} and {tokenY.symbol} together. A
          pool always holds a pair, so you need some of each side.
        </span>
      </div>

      {/* The "what you get / how to exit" details, at the top of the flow. */}
      <div className="mb-3 flex items-start gap-2 rounded-xl border border-border bg-surface-2/40 p-3 text-xs leading-relaxed text-faint">
        <ReceiptText className="mt-0.5 h-4 w-4 shrink-0 text-faint" />
        <span>
          You get a <span className="text-foreground">receipt</span> for your deposit. You can withdraw any time
          and get both tokens back, plus your share of the trading fees{sdk.timelockEnabled() && mode !== 'create' ? ' (unless you choose to lock it below)' : ''}.
        </span>
      </div>

      <div className="space-y-2">
        <AmtField label="Token A" token={tokenX} amount={amtX} onAmount={onX} onPick={() => mode === 'create' && setPicking('x')}
          balance={held(tokenX.args)} lockToken={mode === 'add'} />
        <div className="flex justify-center"><Plus className="h-4 w-4 text-faint" /></div>
        <AmtField label="Token B" token={tokenY} amount={amtY} onAmount={onY} onPick={() => mode === 'create' && setPicking('y')}
          balance={held(tokenY.args)} lockToken={mode === 'add'} />
      </div>

      {hasAmounts && combinedCkb != null && (
        <p className="mt-2 flex items-center justify-end gap-1 text-xs text-faint">
          Combined value <span className="num text-foreground">≈ {fmtPrice(combinedCkb)} CKB</span>
          <Hint text="A rough estimate of what you're depositing, valued in CKB at the current pool prices." />
        </p>
      )}

      {mode === 'add' && (
        <div className="mt-3 rounded-2xl border border-border bg-surface-2/40 p-4">
          <div className="mb-2 flex items-baseline justify-between text-xs text-faint">
            <span>Amount to add</span>
            <span className="num text-lg font-medium text-foreground">{Math.round(pctValue)}%</span>
          </div>
          <input
            type="range" min={0} max={100} value={Math.round(pctValue)} disabled={maxDepositX <= 0n}
            onChange={(e) => setByPct(Number(e.target.value))}
            className="w-full accent-primary disabled:opacity-40"
          />
          <div className="mt-2 flex gap-1.5">
            {[25, 50, 75, 100].map(p => (
              <button key={p} disabled={maxDepositX <= 0n} onClick={() => setByPct(p)}
                className="flex-1 rounded-lg bg-surface px-2 py-1 text-xs text-faint transition-colors hover:text-foreground disabled:opacity-40">
                {p === 100 ? 'MAX' : `${p}%`}
              </button>
            ))}
          </div>
          {maxDepositX <= 0n && (
            <p className="mt-2 text-xs text-faint">Add some {tokenX.symbol} and {tokenY.symbol} to your wallet to deposit.</p>
          )}
        </div>
      )}

      {mode === 'add' && sdk.timelockEnabled() && (
        <div className="mt-3 rounded-2xl border border-border bg-surface-2/40 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm">
            <Lock className="h-4 w-4 text-faint" /> Lock your deposit <span className="text-xs text-faint">(optional)</span>
            <Hint text="Optionally promise to leave your tokens in the pool for a set time. They can't be withdrawn until the date is up. Some users do this to show long-term commitment to a pool." />
          </div>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {[{ d: 0, l: 'Off' }, { d: 7, l: '7d' }, { d: 30, l: '30d' }, { d: 90, l: '90d' }, { d: 180, l: '180d' }, { d: 365, l: '1y' }].map(p => (
              <button key={p.d} onClick={() => setLockDays(p.d)}
                className={cn('rounded-lg px-2.5 py-1 text-xs transition-colors', lockDays === p.d ? 'bg-primary text-background' : 'bg-surface text-faint hover:text-foreground')}>
                {p.l}
              </button>
            ))}
          </div>
          {lockDays > 0 && (
            <>
              <div className="mb-1 flex items-baseline justify-between text-xs text-faint">
                <span>Duration</span><span className="num text-foreground">{lockDays} days</span>
              </div>
              <input type="range" min={7} max={365} value={lockDays}
                onChange={(e) => setLockDays(Number(e.target.value))} className="w-full accent-primary" />
              <p className="mt-2 text-xs text-faint">
                {tipEpoch != null && <>Unlocks ≈ <span className="text-foreground">{fmtDate(epochEta(tipEpoch + BigInt(lockDays * EPOCHS_PER_DAY), tipEpoch).date)}</span> · </>}
                <span className="text-warning">you can’t withdraw until this date.</span>
              </p>
            </>
          )}
        </div>
      )}

      {mode === 'create' && (
        <div className="mt-4">
          <div className="mb-2 flex items-center gap-1 text-sm text-faint">Fee tier<Hint text="The % traders pay on each swap in this pool. It's split among everyone who provides liquidity, including you. 0.30% is the standard choice for most pairs." /></div>
          <Segmented
            options={[{ value: '5', label: '0.05%' }, { value: '30', label: '0.30%' }, { value: '100', label: '1.00%' }]}
            value={String(feeBps)} onChange={(v) => setFeeBps(Number(v))}
          />
        </div>
      )}

      {ratioLock && (
        <p className="mt-3 text-xs text-faint">Amounts are matched to the pool ratio automatically.</p>
      )}

      {hasUnverified && (
        <div className="mt-4 rounded-xl border border-warning/40 bg-warning/10 p-3">
          <div className="flex items-start gap-2 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div>
              <div className="font-medium text-warning">Not a verified token</div>
              <p className="mt-0.5 text-xs text-faint">
                {!isVerifiedToken(tokenX.args) ? tokenX.symbol : tokenY.symbol} isn’t on our official list.
                Anyone can create a token with any name, so it could be a fake copy of a real one. This pool
                won’t appear in the main trading interface. Only continue if you trust this exact token.
              </p>
            </div>
          </div>
          <button
            onClick={() => setAck(a => !a)}
            className="mt-3 flex w-full items-center gap-2 rounded-lg bg-surface-2/60 px-3 py-2 text-left text-xs"
          >
            <span className={`grid h-4 w-4 shrink-0 place-items-center rounded border ${ack ? 'border-warning bg-warning text-background' : 'border-faint'}`}>
              {ack && <Check className="h-3 w-3" />}
            </span>
            I understand this token is unverified and I’m creating this pool at my own risk.
          </button>
        </div>
      )}

      {willBeUnanchored && (
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-negative/40 bg-negative/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-negative" />
          <div>
            <div className="font-medium text-negative">These tokens can’t be priced in CKB</div>
            <p className="mt-0.5 text-xs text-faint">
              Neither {tokenX.symbol} nor {tokenY.symbol} can be traded for CKB, so there’d be
              <span className="text-foreground"> no way to cash out</span> of this pool and no reliable
              price, since each token would only be worth the other. Pair one side with CKB first.
            </p>
          </div>
        </div>
      )}

      {showPreview && (
        <div className="mt-3 space-y-1.5 rounded-xl border border-border bg-surface-2/50 p-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-faint">Your share of the pool</span>
            <span className="num text-foreground">{sharePct >= 99.95 ? '~100' : sharePct < 0.01 ? '<0.01' : sharePct.toFixed(2)}%</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1 text-faint">
              Pool tokens you get
              <Hint text="Pool tokens (also called LP) are a receipt for your deposit; burn them any time to get your two tokens back, plus your share of the trading fees." />
            </span>
            <span className="num text-foreground">{compact(Number(lpReceived))}</span>
          </div>
          {combinedCkb != null && (
            <div className="flex items-center justify-between">
              <span className="text-faint">Combined value</span>
              <span className="num text-foreground">≈ {fmtPrice(combinedCkb)} CKB</span>
            </div>
          )}
        </div>
      )}

      {/* Plain-English impermanent-loss note before the action button. */}
      <p className="mt-3 rounded-xl bg-surface-2/40 px-3 py-2 text-xs leading-relaxed text-faint">
        If the two token prices drift apart you may get back a different mix, and sometimes less total
        value, than you put in. This is normal for pools.
      </p>

      {/* CKB-floor caveat at deposit time, next to the lock copy above. */}
      {(tokenX.args === CKB || tokenY.args === CKB) && (
        <p className="mt-2 text-xs text-faint">
          CKB pools keep a small amount of CKB in reserve to stay open for trading, so if you are the
          only provider you can withdraw almost (but not quite) all of it.
        </p>
      )}

      {/* Short on a side: say how much more is needed and deep-link a swap that buys it. */}
      {[shortInfoX, shortInfoY].filter((s): s is { need: string; symbol: string; args: string } => s != null).map(s => (
        <div key={s.args} className="mt-2 flex items-center justify-between gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
          <span className="text-faint">
            You need about <span className="num text-foreground">{s.need} {s.symbol}</span> more.
          </span>
          <Link to={`/swap?out=${s.args}`} onClick={() => onOpenChange(false)} className="inline-flex shrink-0 items-center gap-1 text-primary hover:underline">
            Get {s.symbol} <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      ))}

      {/* A fresh wallet with no CKB can't deposit or pay the fee, so hand off to the faucet. */}
      {noCkb && <FaucetHelp signer={signer ?? undefined} className="mt-3" />}

      <Button size="lg" className="mt-4 w-full" disabled={!!signer && (busy || (hasUnverified && !ack) || !!shortToken)} onClick={() => (signer ? submit() : promptConnect())}>
        {mode === 'create' ? <Sparkles className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
        {!signer ? 'Connect wallet' : busy ? 'Confirm in wallet…' : shortToken ? `Insufficient ${shortToken}` : mode === 'create' ? 'Create pool' : 'Add liquidity'}
      </Button>
      {!signer && (
        <p className="mt-2 text-center text-xs text-faint">You will approve this deposit with your wallet. Nothing moves until you do.</p>
      )}

      <TokenSelect
        open={picking !== null} onOpenChange={(o) => !o && setPicking(null)}
        exclude={picking === 'x' ? tokenY.args : tokenX.args}
        onSelect={(t) => { setAck(false); picking === 'x' ? setTokenX(t) : setTokenY(t) }}
      />
      {connectPromptNode}
    </Dialog>
  )
}

function AmtField({ label, token, amount, onAmount, onPick, balance, lockToken }: {
  label: string; token: TokenInfo; amount: string; onAmount: (s: string) => void
  onPick: () => void; balance?: bigint; lockToken?: boolean
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface-2/40 p-4">
      <div className="mb-2 flex items-center justify-between text-xs text-faint">
        <span>{label}</span>
        {balance != null && <span className="num">{fmtUnits(balance, token.decimals, 4)}</span>}
      </div>
      <div className="flex items-center gap-3">
        {/* Only react to user edits (source 'event'). Otherwise programmatically filling the
            paired amount re-fires this and the X↔Y ratio-fill loops, shrinking both each round. */}
        <NumericFormat value={amount} onValueChange={(v, info) => { if (info.source === 'event') onAmount(v.value) }}
          thousandSeparator allowNegative={false}
          decimalScale={token.decimals} placeholder="0.0" inputMode="decimal"
          className="num min-w-0 flex-1 bg-transparent text-2xl font-medium outline-none placeholder:text-faint" />
        <TokenPill token={token} onClick={lockToken ? () => {} : onPick} />
      </div>
    </div>
  )
}
