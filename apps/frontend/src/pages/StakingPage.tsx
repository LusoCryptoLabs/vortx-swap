import { useState } from 'react'
import { motion } from 'framer-motion'
import { Link } from 'react-router-dom'
import { ccc } from '@ckb-ccc/connector-react'
import { Wallet, Coins, Gift, Shield, TrendingUp, Pickaxe, Search, ArrowRight } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../components/ui/button'
import { StatCard } from '../components/ui/stat'
import { Hint } from '../components/ui/hint'
import { HowItWorks } from '../components/HowItWorks'
import { TokenLogo } from '../components/TokenLogo'
import { ConfirmSheet, type ConfirmRow } from '../components/ConfirmSheet'
import { useConnectPrompt } from '../components/ConnectPrompt'
import { useStakeStats, useStakePool, useStakePosition, usePoolViews, useHeldBalance } from '../hooks/useData'
import { tokenByTypeHash, buildPricer } from '../lib/pricing'
import { sdk } from '../lib/cellswap'
import { trackTx } from '../lib/txTracker'
import { recordActivity } from '../lib/activity'
import { humanizeError, FUNDS_SAFE_NOTE } from '../lib/errors'
import { TOKEN_ARGS } from '../lib/tokens'
import { fmtUnits, compact, shortHash, parseUnits } from '../lib/utils'

// "trade it on Swap" target for VTX: pre-fills the swap input when we know VTX's args.
const VTX_SWAP_TO = TOKEN_ARGS['VTX'] ? `/swap?in=${TOKEN_ARGS['VTX']}` : '/swap'

const EPOCHS_PER_YEAR = 2190 // ~4h epochs → 365*24/4

export default function StakingPage() {
  const signer = ccc.useSigner()
  const { promptConnect, connectPromptNode } = useConnectPrompt()
  const { data: stats } = useStakeStats()
  const { data: pool } = useStakePool()
  const { data: position, refetch: refetchPos } = useStakePosition(signer ?? undefined)
  const { views } = usePoolViews()
  const held = useHeldBalance(signer ?? undefined)
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState<'stake' | 'unstake' | 'claim' | null>(null)
  // Review-before-sign step (mirrors swap): the Stake/Unstake buttons open this; the signer runs in onConfirm.
  const [confirm, setConfirm] = useState<null | 'stake' | 'unstake'>(null)

  const enabled = sdk.stakingEnabled()
  const token = pool ? tokenByTypeHash(pool.stakeToken) : undefined
  const decimals = token?.decimals ?? 8
  const symbol = token?.symbol ?? 'token'
  // Connected but holds 0 of the stake token → they cannot deposit. Point them at the one action
  // that unblocks them: buy the token on Swap (preset as the output).
  const heldStake = signer && token ? held(token.args) : 0n
  const needsToken = !!signer && !!token && heldStake <= 0n
  // Pre-flight the stake amount against the held balance (mirrors SwapCard/LiquidityModal) so an
  // overspend is caught before the wallet round-trip, not with a generic downstream error.
  const stakeAmt = parseAmount(amount, decimals)
  const insufficientStake = !!signer && !!token && stakeAmt > 0n && stakeAmt > heldStake

  // Best-effort APR: annualized CKB streamed ÷ total staked valued in CKB (needs a CKB price).
  const pricer = buildPricer(views.map(v => v.pool))
  const priceCkbPerToken = pool ? (pricer.get(pool.stakeToken.toLowerCase()) ?? 0) : 0
  const stakedCkb = pool ? (Number(pool.total) / 10 ** decimals) * priceCkbPerToken : 0
  const rewardPerYearCkb = stats ? (Number(stats.rewardPerEpochCkb) / 1e8) * EPOCHS_PER_YEAR : 0
  const aprPct = stakedCkb > 0 ? (rewardPerYearCkb / stakedCkb) * 100 : null

  async function doStake() {
    if (!signer || !pool || !token) return
    const amt = parseAmount(amount, decimals)
    if (amt <= 0n) { toast.error('Enter an amount'); return }
    if (amt > heldStake) { toast.error(`Insufficient ${symbol}`); return }
    setBusy('stake')
    const id = toast.loading(`Staking ${amount} ${symbol}…`)
    try {
      const h = await trackTx('Stake', () => sdk.stake(signer as any, { token: token.args, amount: amt }))
      toast.success(`Staked: ${h.slice(0, 12)}…`, { id })
      recordActivity({ id: h, kind: 'stake', status: 'completed', summary: `Staked ${amount} ${symbol} to earn CKB`, txHash: h })
      setAmount(''); refetchPos()
    } catch (e) { toast.error('Stake failed', { id, description: `${humanizeError(e)} ${FUNDS_SAFE_NOTE}` }) }
    finally { setBusy(null) }
  }

  async function doUnstake() {
    if (!signer || !position) return
    const amt = parseAmount(amount, decimals)
    if (amt <= 0n || amt > position.amount) { toast.error('Enter a valid amount to unstake'); return }
    setBusy('unstake')
    const id = toast.loading(`Unstaking ${amount} ${symbol}…`)
    try {
      const h = await trackTx('Unstake', () => sdk.unstake(signer as any, { amount: amt }))
      toast.success(`Unstaked: ${h.slice(0, 12)}…`, { id })
      recordActivity({ id: h, kind: 'stake', status: 'completed', summary: `Unstaked ${amount} ${symbol}`, txHash: h })
      setAmount(''); refetchPos()
    } catch (e) { toast.error('Unstake failed', { id, description: `${humanizeError(e)} ${FUNDS_SAFE_NOTE}` }) }
    finally { setBusy(null) }
  }

  async function doClaim() {
    if (!signer) return
    setBusy('claim')
    const id = toast.loading('Claiming reward…')
    try {
      const h = await trackTx('Claim reward', () => sdk.claim(signer as any))
      toast.success(`Claimed: ${h.slice(0, 12)}…`, { id })
      recordActivity({ id: h, kind: 'stake', status: 'completed', summary: `Claimed CKB staking reward`, txHash: h })
      refetchPos()
    } catch (e) { toast.error('Claim failed', { id, description: `${humanizeError(e)} ${FUNDS_SAFE_NOTE}` }) }
    finally { setBusy(null) }
  }

  if (!enabled || !pool) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <Coins className="mx-auto mb-4 h-10 w-10 text-muted-foreground" />
        <h1 className="text-2xl font-semibold">Staking</h1>
        <p className="mt-2 text-muted-foreground">
          Not live on this network yet. Meanwhile, earn fees by adding liquidity in Pools.
        </p>
        <Link to="/pools" className="mt-5 inline-flex">
          <Button><TrendingUp className="mr-2 h-4 w-4" /> Go to Pools</Button>
        </Link>
      </div>
    )
  }

  // A staking pool exists but it uses a token that is not in our list, so the stake form can't show
  // a friendly symbol/decimals yet. Detect that before rendering the form, since a "Stake token" form
  // for an unnamed token is a dead end. Name the token (its on-chain id), explain that it is safe,
  // and offer to recognise it, with Mining as one option rather than the only path.
  if (!token) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16">
        <div className="text-center">
          <Coins className="mx-auto mb-4 h-10 w-10 text-muted-foreground" />
          <h1 className="text-2xl font-semibold">Staking</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This staking pool rewards a token that is not on our list yet, so we cannot show its name or
            decimals here. Nothing is wrong and your funds are safe; we just do not have its details.
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            The token is identified on-chain as{' '}
            <span className="num text-foreground">{shortHash(pool.stakeToken)}</span>.
          </p>
        </div>
        <div className="mt-6 space-y-3 text-left">
          <div className="rounded-xl border border-border bg-surface-2/40 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Search className="h-4 w-4 text-primary" /> Recognise this token
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              If you know the token, you can add it to your list from the token picker on the Swap page
              (paste its address to import it). Naming a token only saves its details. It never moves any
              funds. Once recognised, it shows up here with its proper name.
            </p>
            <Link to="/swap" className="mt-3 inline-flex">
              <Button variant="secondary" size="sm"><Search className="mr-2 h-4 w-4" /> Import it on Swap</Button>
            </Link>
          </div>
          <div className="rounded-xl border border-border bg-surface-2/40 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Pickaxe className="h-4 w-4 text-primary" /> Or earn rewards now with Mining
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Add liquidity to a CKB pool and stake your pool tokens to earn VTX. This works with any pool
              token, no matter what it is called.
            </p>
            <Link to="/mining" className="mt-3 inline-flex">
              <Button size="sm"><Pickaxe className="mr-2 h-4 w-4" /> Go to Mining</Button>
            </Link>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6 flex items-center gap-3">
        <h1 className="text-2xl font-semibold">Stake {symbol}</h1>
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-500">
          <Shield className="h-3 w-3" /> you stay in control
        </span>
      </div>
      <p className="mb-6 max-w-xl text-sm text-muted-foreground">
        Lock up your {symbol} and earn <span className="font-medium text-foreground">CKB</span> in
        return. The longer you stake and the more you stake, the larger your share. Your tokens never
        leave your control; take them back any time. Rewards are paid out each{' '}
        <span className="font-medium text-foreground">epoch</span>
        <Hint text="An epoch is a CKB time period of about 4 hours. Your CKB reward is tallied and added once per epoch." />.
      </p>

      <HowItWorks
        steps={[
          { title: `Stake your ${symbol}`,
            body: `Deposit any amount. It moves into a secure on-chain vault that only your wallet can open. Staking doesn't hand custody to anyone.` },
          { title: 'Earn CKB automatically',
            body: 'A fixed amount of CKB is released to stakers every epoch (~4 hours) and split by your share. Your reward grows continuously; there is nothing to do while it accrues.' },
          { title: 'Claim or unstake any time',
            body: 'Claim your CKB reward whenever you like, or unstake to withdraw your tokens and any pending reward together. No lock-up period.' },
        ]}
        note={
          <>
            <span className="font-medium text-foreground">Where the CKB comes from:</span> a reward
            reserve funded by protocol fees, not freshly printed tokens. As the reserve is paid out,
            the rate gradually slows. &nbsp;·&nbsp; <span className="font-medium text-foreground">Staking vs mining:</span>{' '}
            staking earns CKB on a single token. To earn <span className="font-medium text-foreground">VTX</span> instead,
            provide liquidity and stake your pool tokens in{' '}
            <Link to="/mining" className="inline-flex items-center gap-1 text-primary hover:underline">
              <Pickaxe className="h-3 w-3" /> Mining
            </Link>. VTX is Vortx's token; you can{' '}
            <Link to={VTX_SWAP_TO} className="text-primary hover:underline">trade it on Swap</Link>.
          </>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label={<>Total staked <Hint text={`How much ${symbol} everyone has staked here, combined. Your share of this determines your share of the rewards.`} /></>}
          value={`${compact(Number(pool.total) / 10 ** decimals)}`} sub={symbol} />
        <StatCard
          label={<>Reward reserve <Hint text="CKB set aside to pay stakers. Rewards stream out of this reserve; when it runs low, the reward rate slows down." /></>}
          value={`${compact(Number(stats?.rewardReserve ?? 0n) / 1e8)}`} sub="CKB" loading={!stats} />
        <StatCard
          label={<>Reward rate <Hint text="CKB released to all stakers each epoch (~4 hours), split between everyone by their share." /></>}
          value={`${compact(Number(stats?.rewardPerEpochCkb ?? 0n) / 1e8)}`} sub="CKB every ~4h" loading={!stats} />
        <StatCard
          label={<>Est. yearly return <Hint text="A rough APR: roughly a year of rewards ÷ total staked, valued in CKB. It moves with price and with how much is staked. Not a guarantee." /></>}
          value={aprPct != null ? `${aprPct.toFixed(1)}%` : '-'} sub={aprPct == null ? 'price unknown' : 'in CKB'} loading={!stats} />
      </div>

      {/* Position */}
      {signer && position && (
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
          className="mb-6 rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <TokenLogo token={token} symbol={symbol} className="h-5 w-5" /> Your position
            </div>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <TrendingUp className="h-3 w-3" /> {pool.emissionBps / 100}% reward rate / ~4h
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-4">
            <div>
              <div className="text-xs text-muted-foreground">Staked</div>
              <div className="text-lg font-semibold">{fmtUnits(position.amount, decimals)} {symbol}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Pending reward</div>
              <div className="text-lg font-semibold text-emerald-500">{fmtUnits(position.pending, 8)} CKB</div>
            </div>
          </div>
          <Button className="mt-4 w-full" variant="secondary" disabled={busy !== null || position.pending <= 0n} onClick={doClaim}>
            <Gift className="mr-2 h-4 w-4" /> {position.pending > 0n ? 'Claim reward' : 'No reward yet (builds up over time)'}
          </Button>
        </motion.div>
      )}

      {/* Holder-less signpost: you can't stake a token you don't hold. One clear step: get it on Swap. */}
      {needsToken && (
        <Link to={`/swap?out=${token.args}`}
          className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-primary/40 bg-primary/5 px-4 py-3 transition hover:border-primary">
          <span className="text-sm text-foreground">
            You need <span className="font-medium">{symbol}</span> to stake. Get it on Swap.
          </span>
          <span className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-primary">
            Swap <ArrowRight className="h-4 w-4" />
          </span>
        </Link>
      )}

      {/* Stake / unstake */}
      {!signer ? (
        <Button className="w-full" onClick={promptConnect}>
          <Wallet className="mr-2 h-4 w-4" /> Connect wallet to stake
        </Button>
      ) : (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <label className="text-xs text-muted-foreground">Amount ({symbol})</label>
            {/* Show the wallet balance for the stake token, with a MAX-of-wallet button (mirrors Swap). */}
            <button className="num text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setAmount(fmtUnits(heldStake, decimals, decimals))}>
              {fmtUnits(heldStake, decimals, 4)} {symbol} max
            </button>
          </div>
          <input
            value={amount}
            onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
            placeholder="0.0"
            inputMode="decimal"
            className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-lg outline-none focus:border-primary"
          />
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Button disabled={busy !== null || insufficientStake || stakeAmt <= 0n} onClick={() => setConfirm('stake')}>
              <Coins className="mr-2 h-4 w-4" /> {busy === 'stake' ? 'Staking…' : insufficientStake ? `Insufficient ${symbol}` : 'Stake'}
            </Button>
            <Button variant="secondary" disabled={busy !== null || !position} onClick={() => setConfirm('unstake')}>
              {busy === 'unstake' ? 'Unstaking…' : 'Unstake'}
            </Button>
          </div>
          {position && (
            <button className="mt-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setAmount(fmtUnits(position.amount, decimals, decimals))}>
              Max staked: {fmtUnits(position.amount, decimals)} {symbol}
            </button>
          )}
        </div>
      )}

      {/* Review-before-sign for stake / unstake, mirroring the swap confirm step. */}
      <ConfirmSheet
        open={confirm !== null}
        onOpenChange={(o) => { if (busy === null) setConfirm(o ? confirm : null) }}
        title={confirm === 'unstake' ? 'Review your unstake' : 'Review your stake'}
        rows={[
          { label: confirm === 'unstake' ? 'Unstake' : 'Stake', value: `${amount || '0'} ${symbol}`, emphasize: true },
          ...(confirm === 'unstake' && position
            ? [{ label: 'Currently staked', value: `${fmtUnits(position.amount, decimals, 4)} ${symbol}` } as ConfirmRow]
            : [{ label: 'Wallet balance', value: `${fmtUnits(heldStake, decimals, 4)} ${symbol}` } as ConfirmRow]),
          { label: 'Network fee', value: 'about 0.001 CKB' },
        ]}
        note={confirm === 'unstake'
          ? 'Your tokens and any pending reward come back to your wallet. Nothing moves until you approve.'
          : 'Your tokens move into an on-chain vault only your wallet can open. Nothing moves until you approve.'}
        confirmLabel={confirm === 'unstake' ? 'Unstake' : 'Stake'}
        busy={busy !== null}
        onConfirm={() => {
          const kind = confirm
          setConfirm(null)
          if (kind === 'stake') void doStake()
          else if (kind === 'unstake') void doUnstake()
        }}
      />
      {connectPromptNode}
    </div>
  )
}

/** Parse a decimal string into base units, treating empty/invalid input as 0. A thin wrapper over
 *  the shared utils.parseUnits (which returns null) so the stake/unstake checks can compare directly. */
function parseAmount(s: string, decimals: number): bigint {
  return parseUnits(s, decimals) ?? 0n
}
