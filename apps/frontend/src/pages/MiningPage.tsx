import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ccc } from '@ckb-ccc/connector-react'
import { Pickaxe, Wallet, Gift, Sparkles, TrendingUp, Plus, Coins, Lock, ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../components/ui/button'
import { Dialog } from '../components/ui/dialog'
import { StatCard } from '../components/ui/stat'
import { Skeleton } from '../components/ui/skeleton'
import { Hint } from '../components/ui/hint'
import { HowItWorks } from '../components/HowItWorks'
import { ConfirmSheet } from '../components/ConfirmSheet'
import { useConnectPrompt } from '../components/ConnectPrompt'
import { PairLogos } from '../components/TokenLogo'
import { useMiningPools, usePoolViews, useHeldBalance, useSignerAddress } from '../hooks/useData'
import { FaucetHelp } from '../components/FaucetHelp'
import { sdk, config } from '../lib/cellswap'
import { LOCK_BOOST_TIERS } from '@cellswap/sdk'
import { trackTx } from '../lib/txTracker'
import { recordActivity } from '../lib/activity'
import { humanizeError, FUNDS_SAFE_NOTE } from '../lib/errors'
import { CKB, TOKEN_ARGS } from '../lib/tokens'
import type { EnrichedPool } from '../lib/pricing'
import { compact, EMPTY, epochEta, fmtDate } from '../lib/utils'

// VTX (the reward token) args, so "trade it on Swap" can pre-fill the swap input.
const VTX_ARGS = TOKEN_ARGS['VTX']
// "trade it on Swap" target: pre-fills VTX when we know its args, else just opens Swap.
const VTX_SWAP_TO = VTX_ARGS ? `/swap?in=${VTX_ARGS}` : '/swap'

const EPOCHS_PER_YEAR = 2190 // ~4h epochs
const EPOCH_SECONDS = 14_400 // ~4h per epoch (matches EPOCHS_PER_YEAR)

/** The LP token hash for an AMM pool (args = its info type hash), used to join mining pools to pairs. */
function lpHashOf(pool: EnrichedPool['pool']): string {
  const infoTypeHash = ccc.Script.from(pool.cell.output.type as any).hash()
  return ccc.Script.from({
    codeHash: config.scripts.lpTokenScript.codeHash as `0x${string}`,
    hashType: config.scripts.lpTokenScript.hashType as 'type',
    args: infoTypeHash as `0x${string}`,
  }).hash()
}

export default function MiningPage() {
  const signer = ccc.useSigner()
  const held = useHeldBalance(signer ?? undefined)
  const ckbBalance = held(CKB)
  const { data: pools = [], isLoading: poolsLoading } = useMiningPools()
  const { views, isLoading: viewsLoading } = usePoolViews()
  // Both feeds must be in before we can say "no pools"; otherwise the cold fetch (which
  // DataLoadingNotice warns can take 5-10s) would flash the empty state instead of loading.
  const loading = poolsLoading || viewsLoading

  // Join each mining pool to its CKB/xUDT pair (by LP hash). Only pairs with a resolvable token
  // (curated/registered → we know its args) can be staked from here.
  const rows = useMemo(() => {
    const byLp = new Map(views.map(v => [lpHashOf(v.pool), v]))
    return pools.map(mp => ({ mp, view: byLp.get(mp.stakeToken) })).filter(r => r.view)
  }, [pools, views])

  // Testnet has several mining pools for the same pair (e.g. TKA/CKB three times), which stacked as
  // near-identical cards. Group by pair and show the most active one; the rest collapse behind a
  // disclosure (collapsed, never removed, so a position staked in a quieter pool is still reachable).
  const grouped = useMemo(() => {
    const ckbHash = sdk.udtHash(CKB)
    const pairLabel = (v: EnrichedPool) => {
      const ckbIsX = v.pool.tokenX === ckbHash
      const a = ckbIsX ? v.tokenY : v.tokenX
      const b = ckbIsX ? v.tokenX : v.tokenY
      return `${a?.symbol ?? '?'} / ${b?.symbol ?? 'CKB'}`
    }
    const byPair = new Map<string, typeof rows>()
    for (const r of rows) {
      const k = pairLabel(r.view!)
      const arr = byPair.get(k) ?? []
      arr.push(r)
      byPair.set(k, arr)
    }
    return [...byPair.entries()].map(([label, group]) => {
      const sorted = [...group].sort((x, y) =>
        y.mp.emissionPerEpoch !== x.mp.emissionPerEpoch
          ? (y.mp.emissionPerEpoch > x.mp.emissionPerEpoch ? 1 : -1)
          : (y.mp.total > x.mp.total ? 1 : -1))
      return { label, primary: sorted[0]!, extras: sorted.slice(1) }
    })
  }, [rows])
  const [expandedPairs, setExpandedPairs] = useState<Set<string>>(new Set())
  const togglePair = (k: string) => setExpandedPairs(s => {
    const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n
  })

  if (!sdk.miningEnabled()) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <Pickaxe className="mx-auto mb-4 h-10 w-10 text-muted-foreground" />
        <h1 className="text-2xl font-semibold">Liquidity mining</h1>
        <p className="mt-2 text-muted">
          Not live on this network yet. Meanwhile, earn fees by adding liquidity in Pools.
        </p>
        <Link to="/pools" className="mt-5 inline-flex">
          <Button><Plus className="mr-2 h-4 w-4" /> Go to Pools</Button>
        </Link>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-2 flex items-center gap-3">
        <h1 className="font-display text-3xl font-bold">Liquidity mining</h1>
        <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
          <Sparkles className="h-3 w-3" /> earn VTX
        </span>
      </div>
      <p className="mb-6 max-w-xl text-sm text-muted">
        Earn <span className="font-medium text-foreground">VTX</span> on top of trading fees.{' '}
        <span className="text-faint">
          VTX is Vortx's token; you can{' '}
          <Link to={VTX_SWAP_TO} className="text-primary hover:underline">trade it on Swap</Link>.
        </span>{' '}
        You stake your <span className="font-medium text-foreground">pool tokens</span>{' '}
        (the receipt you get for adding liquidity to a CKB pool), and they keep earning fees the whole
        time. Everything stays in a vault only your wallet can open. Rewards settle once per{' '}
        <span className="font-medium text-foreground">epoch</span>
        <Hint text="An epoch is a CKB time period of about 4 hours. Rewards are tallied and paid out once per epoch." />.
      </p>

      <HowItWorks
        steps={[
          { title: 'Add liquidity to a CKB pool',
            body: <>Deposit a token + CKB into a pool. In return you receive <span className="font-medium text-foreground">pool tokens</span> (also called LP tokens), your proof of a share in that pool. They already earn you a cut of every trade.</> },
          { title: 'Stake those pool tokens here',
            body: <>Staking them mines <span className="font-medium text-foreground">VTX</span> on top: a fixed amount is minted each epoch (~4 hours) and split between miners by share.</> },
          { title: 'Two rewards at once, withdraw any time',
            body: 'Your pool tokens keep earning trading fees while staked. Claim VTX whenever you like, or unstake to reclaim your pool tokens. No lock-up by default; withdraw any time. (Optional: commit for a fixed term for a bigger share of rewards.)' },
        ]}
        note={
          <>
            <span className="font-medium text-foreground">Don’t have pool tokens yet?</span> You get
            them by adding liquidity: open a CKB pool below (or in{' '}
            <Link to="/pools" className="text-primary hover:underline">Pools</Link>) and click{' '}
            <span className="font-medium text-foreground">Add liquidity</span> first. &nbsp;·&nbsp;{' '}
            <span className="font-medium text-foreground">Mining vs staking:</span> mining earns VTX
            from pool tokens; <Link to="/staking" className="inline-flex items-center gap-1 text-primary hover:underline"><Coins className="h-3 w-3" /> Staking</Link>{' '}
            earns CKB from a single token.
          </>
        }
      />


      {loading ? (
        <div className="space-y-3" role="status" aria-live="polite" aria-busy="true">
          <span className="sr-only">Loading mining pools…</span>
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} aria-hidden="true" className="card space-y-4 p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3"><Skeleton className="h-8 w-8 rounded-full" /><Skeleton className="h-5 w-44" /></div>
                <Skeleton className="h-6 w-20 rounded-full" />
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {Array.from({ length: 4 }).map((_, j) => <Skeleton key={j} className="h-14 w-full" />)}
              </div>
              <Skeleton className="h-10 w-full" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="card p-8 text-center">
          <Coins className="mx-auto mb-3 h-9 w-9 text-muted-foreground" />
          <p className="text-sm text-muted">
            You need pool tokens before you can mine VTX. Add liquidity to a CKB pool to get them.
          </p>
          {/* Plain-English framing of what "add liquidity" means, and the trade-off, so a
              newcomer is not pushed into mining without understanding it. */}
          <p className="mx-auto mt-3 max-w-md text-left text-xs leading-relaxed text-muted">
            Adding liquidity means depositing a token plus CKB into a shared pool so other people can
            trade against it. In return you get <b className="text-foreground">pool tokens</b> (a receipt
            for your share), which you can stake here to earn VTX. The trade-off: while your funds are in
            a pool their value rises and falls with the price (this is called impermanent loss), and you
            can withdraw any time.
          </p>
          {/* "New to this? Start with Staking": the simpler one-step path, alongside the add-liquidity CTA. */}
          <div className="mx-auto mt-4 max-w-md rounded-xl border border-border bg-surface-2/40 p-3 text-left">
            <div className="text-xs font-medium text-foreground">New to this? Start with Staking. It is one step.</div>
            <div className="mt-1 text-xs text-muted">
              Staking lets you deposit a single token and earn CKB, with nothing else to set up.{' '}
              <Link to="/staking" className="inline-flex items-center gap-1 text-primary hover:underline">
                <Coins className="h-3 w-3" /> Go to Staking
              </Link>
            </div>
          </div>
          <Link to="/pools" className="mt-5 inline-flex">
            <Button><Plus className="mr-2 h-4 w-4" /> Add liquidity to get started</Button>
          </Link>
          <div className="mx-auto mt-6 grid max-w-md grid-cols-1 gap-3 text-left sm:grid-cols-2">
            <div className="rounded-xl border border-border bg-surface-2/40 p-3">
              <div className="text-xs font-semibold text-primary">Step 1</div>
              <div className="mt-1 text-xs text-muted">Add liquidity to get pool tokens.</div>
            </div>
            <div className="rounded-xl border border-border bg-surface-2/40 p-3">
              <div className="text-xs font-semibold text-primary">Step 2</div>
              <div className="mt-1 text-xs text-muted">Stake them here to earn VTX.</div>
            </div>
          </div>
          {/* Adding liquidity needs CKB. A zero balance dead-ends the user, so hand them off to the faucet. */}
          {signer && ckbBalance <= 0n && (
            <div className="mx-auto mt-6 max-w-md text-left">
              <p className="mb-2 text-xs text-muted">
                You will need some CKB to add liquidity. Your balance is empty. Grab free testnet CKB first:
              </p>
              <FaucetHelp signer={signer ?? undefined} />
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {grouped.map(({ label, primary, extras }) => (
            <div key={label} className="space-y-3">
              <MiningCard mp={primary.mp} view={primary.view!} />
              {extras.length > 0 && (
                expandedPairs.has(label) ? (
                  <>
                    {extras.map(({ mp, view }) => <MiningCard key={mp.poolTypeHash} mp={mp} view={view!} />)}
                    <button onClick={() => togglePair(label)}
                      className="w-full rounded-xl border border-border py-2.5 text-xs font-medium text-muted transition-colors hover:text-foreground">
                      Hide the extra {label} pools
                    </button>
                  </>
                ) : (
                  <button onClick={() => togglePair(label)}
                    className="w-full rounded-xl border border-dashed border-border py-2.5 text-xs font-medium text-muted transition-colors hover:text-foreground">
                    Show {extras.length} more {label} {extras.length === 1 ? 'pool' : 'pools'} (duplicate or lower-activity)
                  </button>
                )
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function MiningCard({ mp, view }: { mp: Awaited<ReturnType<typeof sdk.getMiningPools>>[number]; view: EnrichedPool }) {
  const signer = ccc.useSigner()
  const { promptConnect, connectPromptNode } = useConnectPrompt()
  const account = useSignerAddress(signer ?? undefined)
  const qc = useQueryClient()
  const [modal, setModal] = useState<'stake' | 'unstake' | null>(null)
  const [busy, setBusy] = useState<'stake' | 'unstake' | 'claim' | null>(null)

  // The pair: CKB + the xUDT side. tokenY may be on either side of the AMM pool.
  const ckbIsX = view.pool.tokenX === sdk.udtHash(CKB)
  const tok = ckbIsX ? view.tokenY : view.tokenX
  const tokB = ckbIsX ? view.tokenX : view.tokenY
  const tokenArgs = tok?.args
  const { data: position, refetch } = useQuery({
    queryKey: ['mining-pos', config.network, mp.poolTypeHash, account],
    enabled: !!signer && !!account,
    refetchInterval: 20_000,
    queryFn: () => (signer ? sdk.getMiningPositionForPool(signer as any, mp) : Promise.resolve(null)),
  })

  // The owner's unstaked LP for this pool = what's available to stake (staked LP lives in a
  // guard-locked custody cell, so getLpPositions doesn't count it).
  const { data: availLp = 0n, refetch: refetchAvail } = useQuery({
    queryKey: ['mining-avail', config.network, view.pool.poolId.toString(), account],
    enabled: !!signer && !!account,
    refetchInterval: 20_000,
    queryFn: async () => {
      if (!signer) return 0n
      const positions = await sdk.getLpPositions(signer as any)
      return positions.find(p => p.pool.poolId === view.pool.poolId)?.lpAmount ?? 0n
    },
  })

  // Lock-boost is offered only when the guard is deployed and this pool was created with the 225-byte
  // (lock-boost) args. Pools with 193-byte args only support unlocked staking.
  const lockBoostPool = sdk.lockBoostEnabled() && (((mp.cell.output.type?.args?.length ?? 2) - 2) / 2) >= 225
  const { data: nowEpoch = 0n } = useQuery({
    queryKey: ['tip-epoch', config.network],
    refetchInterval: 60_000,
    queryFn: () => sdk.tipEpoch(),
  })
  const unlockEpoch = position?.unlockEpoch ?? 0n
  const locked = unlockEpoch > 0n
  const matured = nowEpoch > 0n && nowEpoch >= unlockEpoch
  const daysLeft = unlockEpoch > nowEpoch ? Number(unlockEpoch - nowEpoch) / 6 : 0

  const aprNote = `${compact(Number(mp.emissionPerEpoch) * EPOCHS_PER_YEAR)} VTX / yr`

  // ── Live reward estimate ──────────────────────────────────────────────────
  // On-chain rewards settle once per epoch (~4h). Show a smooth estimate that ticks every second
  // from the user's share of the emission, so progress is visible between settlements. The Claim
  // button still pays the settled on-chain `pending`; this number is advisory ("≈").
  const vtxPerSec = useMemo(() => {
    if (!position || position.amount <= 0n || mp.total <= 0n || mp.emissionPerEpoch <= 0n) return 0
    const perEpochBase = Number(mp.emissionPerEpoch) * Number(position.amount) / Number(mp.total)
    return perEpochBase / 1e8 / EPOCH_SECONDS // VTX per second
  }, [position?.amount?.toString(), mp.total.toString(), mp.emissionPerEpoch.toString()])

  const anchor = useRef<{ t: number; base: number; amt: bigint } | null>(null)
  const [, forceTick] = useState(0)
  useEffect(() => {
    const settled = position ? Number(position.pending) / 1e8 : 0
    const amt = position?.amount ?? 0n
    const a = anchor.current
    // (Re)anchor on first load, when the staked amount changes, or when a claim dropped `pending`.
    // A plain per-epoch settlement (pending rises) is not re-anchored, so the estimate climbs smoothly.
    if (amt > 0n && (!a || a.amt !== amt || settled + 1e-12 < a.base)) anchor.current = { t: Date.now(), base: settled, amt }
    else if (amt === 0n) anchor.current = null
  }, [position?.amount?.toString(), position ? Number(position.pending) : -1])
  useEffect(() => {
    if (vtxPerSec <= 0) return
    const id = setInterval(() => forceTick(n => n + 1), 1000)
    return () => clearInterval(id)
  }, [vtxPerSec])
  const liveVtx = anchor.current
    ? anchor.current.base + vtxPerSec * Math.max(0, (Date.now() - anchor.current.t) / 1000)
    : (position ? Number(position.pending) / 1e8 : 0)

  function refreshAll() {
    refetch(); refetchAvail(); qc.invalidateQueries({ queryKey: ['mining-pools', config.network] })
  }

  const pairLabel = `${tok?.symbol ?? '?'} / ${tokB?.symbol ?? 'CKB'}`

  async function doClaim() {
    if (!signer) return
    setBusy('claim')
    const id = toast.loading('Claiming…')
    try {
      const h = await trackTx('Claim VTX', () => sdk.claimMiningFromPool(signer as any, mp))
      toast.success(`Done: ${h.slice(0, 12)}…`, { id })
      recordActivity({ id: h, kind: 'stake', status: 'completed', summary: `Claimed VTX from ${pairLabel} mining`, txHash: h })
      refreshAll()
    } catch (e) {
      toast.error('Claim failed', { id, description: `${humanizeError(e)} ${FUNDS_SAFE_NOTE}` })
    }
    finally { setBusy(null) }
  }

  // Partial stake/unstake: `amt` (pool tokens) comes from the modal's percentage/Max picker. Both
  // re-lock the remainder on-chain, so any fraction is safe. Throws on failure so the modal stays open.
  async function doStake(kind: 'stake' | 'unstake', amt: bigint, termEpochs = 0n) {
    if (!signer) return
    const max = kind === 'stake' ? availLp : (position?.amount ?? 0n)
    if (amt <= 0n || amt > max) { toast.error(`Enter 1 to ${max} pool tokens`); throw new Error('invalid amount') }
    setBusy(kind)
    const id = toast.loading(kind === 'stake' ? (termEpochs > 0n ? 'Locking…' : 'Staking…') : 'Unstaking…')
    try {
      // Pool-based SDK calls resolve straight from the live pool objects, so non-curated /
      // unusual-args tokens (which the args→type-hash lookup can't resolve) still stake/unstake.
      const h = kind === 'stake'
        ? (termEpochs > 0n
            ? await trackTx('Lock-stake LP', () => sdk.stakeMiningLockedToPool(signer as any, view.pool, mp, amt, termEpochs))
            : await trackTx('Stake LP', () => sdk.stakeMiningToPool(signer as any, view.pool, mp, amt)))
        : await trackTx('Unstake LP', () => sdk.unstakeMiningFromPool(signer as any, mp, amt))
      toast.success(`Done: ${h.slice(0, 12)}…`, { id })
      const summary = kind === 'unstake'
        ? `Unstaked ${compact(Number(amt))} ${pairLabel} pool tokens`
        : termEpochs > 0n
          ? `Locked ${compact(Number(amt))} ${pairLabel} pool tokens to mine VTX`
          : `Staked ${compact(Number(amt))} ${pairLabel} pool tokens to mine VTX`
      recordActivity({ id: h, kind: 'stake', status: 'completed', summary, txHash: h })
      refreshAll()
    } catch (e) {
      toast.error(`${kind === 'unstake' ? 'Unstake' : 'Stake'} failed`, { id, description: `${humanizeError(e)} ${FUNDS_SAFE_NOTE}` })
      throw e
    } finally { setBusy(null) }
  }

  return (
    <div className="panel p-4 sm:p-5">
      <span className="panel-tick tl hidden sm:block" /><span className="panel-tick tr hidden sm:block" />
      <span className="panel-tick bl hidden sm:block" /><span className="panel-tick br hidden sm:block" />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <PairLogos a={tok?.symbol ?? '?'} b={tokB?.symbol ?? 'CKB'} tokenA={tok} tokenB={tokB} className="h-8 w-8" />
          <div>
            <div className="font-display text-lg font-bold">{tok?.symbol ?? '?'} / {tokB?.symbol ?? 'CKB'}</div>
            <div className="flex items-center gap-1 text-xs text-faint"><TrendingUp className="h-3 w-3" /> {aprNote}</div>
          </div>
        </div>
        {!tokenArgs && <span className="badge badge-warn">token not in your list</span>}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3">
        <StatCard
          label={<>Total staked <Hint text="Pool tokens staked here by everyone. Your share of this sets your share of the VTX rewards." /></>}
          value={compact(Number(mp.total))} sub="pool tokens" />
        <StatCard
          label={<>Reward rate <Hint text="VTX minted for all miners each epoch (~4 hours), split between everyone by their share." /></>}
          value={compact(Number(mp.emissionPerEpoch))} sub="VTX every ~4h" />
        <StatCard
          className="col-span-2 sm:col-span-1"
          label={<>Your rewards <Hint text="A live ESTIMATE of the VTX you're mining, ticking from your share of the emission rate. The actual claimable amount settles once per epoch (~4h) on-chain, and that's what Claim pays out, so this estimate runs slightly ahead between settlements." /></>}
          value={<span className="num tabular-nums">{position && position.amount > 0n ? liveVtx.toFixed(6) : (position ? compact(Number(position.pending) / 1e8) : EMPTY)}</span>}
          sub={position && position.amount > 0n ? 'VTX · ≈ accruing' : 'VTX to claim'} />
      </div>

      {!signer ? (
        <>
          <Button className="mt-4 w-full" onClick={promptConnect}><Wallet className="mr-2 h-4 w-4" /> Connect wallet</Button>
          {connectPromptNode}
        </>
      ) : (
        <>
          {position && position.amount > 0n && (
            <div className="mt-4 flex flex-col gap-2 rounded-xl bg-surface-2/60 px-4 py-2.5 text-sm sm:flex-row sm:items-center sm:justify-between">
              <span className="min-w-0 truncate text-muted">
                Staked: <b className="text-foreground">{compact(Number(position.amount))} pool tokens</b>
                {locked && (
                  <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-500">
                    <Lock className="h-3 w-3" />
                    {matured ? 'matured, unstake to claim' : `locked ~${daysLeft.toFixed(0)}d · epoch ${unlockEpoch}`}
                  </span>
                )}
              </span>
              <Button size="sm" variant="secondary" className="w-full sm:w-auto"
                disabled={busy !== null || locked || position.pending <= 0n}
                title={locked ? 'Locked positions realize their reward at unstake' : undefined}
                onClick={doClaim}>
                <Gift className="mr-1.5 h-4 w-4" /> {locked ? 'Reward at unstake' : (position.pending > 0n ? 'Claim VTX' : 'No reward yet')}
              </Button>
            </div>
          )}
          <div className="mt-4 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
            <span className="inline-flex items-center gap-1 text-xs text-muted">
              Pool tokens
              <Hint text="Pool tokens (LP) are the receipt you get for adding liquidity to this CKB pool. Stake them here to mine VTX while they keep earning trading fees." />
            </span>
            <Link to={`/pools/${view.pool.poolId.toString()}`}
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
              <Plus className="h-3 w-3" /> Get pool tokens<span className="hidden sm:inline"> (add liquidity)</span>
            </Link>
          </div>
          <div className="mt-1 text-xs text-faint">
            Available to stake: <b className="num text-foreground">{compact(Number(availLp))}</b> pool tokens
          </div>
          <div className="mt-3 flex gap-2">
            <Button className="flex-1" disabled={busy !== null || availLp <= 0n || locked}
              title={locked ? 'You already have a locked position in this pool' : undefined}
              onClick={() => setModal('stake')}>Stake…</Button>
            <Button variant="secondary" className="flex-1" disabled={busy !== null || !position?.amount || (locked && !matured)}
              title={locked && !matured ? `Unlocks at epoch ${unlockEpoch}` : undefined}
              onClick={() => setModal('unstake')}>{locked ? (matured ? 'Unstake (matured)' : 'Locked') : 'Unstake…'}</Button>
          </div>
          <StakeModal
            mode={modal}
            balance={modal === 'unstake' ? (position?.amount ?? 0n) : availLp}
            busy={busy === 'stake' || busy === 'unstake'}
            lockBoost={modal === 'stake' && lockBoostPool}
            lockedUnstake={modal === 'unstake' && locked}
            unlockEpoch={unlockEpoch}
            nowEpoch={nowEpoch}
            pairLabel={pairLabel}
            onClose={() => setModal(null)}
            onConfirm={(amt, term) => doStake(modal === 'unstake' ? 'unstake' : 'stake', amt, term)}
          />
        </>
      )}
    </div>
  )
}

/** Lock-term options for the stake selector: None (1.0×) + the pinned tiers, ascending by term.
 *  Multiplier label derives from the same bps the SDK/contract use. `multNum` is the same value as a
 *  number so we can quantify the upside (e.g. "+25% vs Flexible") next to the one-way "frozen" caution. */
const TERM_OPTS = [
  { label: 'None', sub: 'flexible', epochs: 0n, mult: '1.0×', multNum: 1 },
  ...[...LOCK_BOOST_TIERS].reverse().map(t => ({
    label: `${t.days}d`, sub: `${t.days} days`, epochs: t.epochs,
    mult: `${(Number(t.bps) / 10_000).toString()}×`, multNum: Number(t.bps) / 10_000,
  })),
]

/** Stake / Unstake amount picker. Percentage chips (25/50/75) and Max over the relevant balance
 *  (available LP for stake, staked LP for unstake), plus a free numeric input. Partial amounts are
 *  safe on-chain for unlocked positions (the SDK re-locks the remainder). When `lockBoost` is set the
 *  stake flow also offers a fixed-term commitment (boosts mining weight up to 2.5×); a `lockedUnstake`
 *  position can only be withdrawn in full, once matured. Stays open while busy / on failure. */
function StakeModal({ mode, balance, busy, lockBoost = false, lockedUnstake = false, unlockEpoch = 0n, nowEpoch = 0n, pairLabel = '', onClose, onConfirm }: {
  mode: 'stake' | 'unstake' | null
  balance: bigint
  busy: boolean
  lockBoost?: boolean
  lockedUnstake?: boolean
  unlockEpoch?: bigint
  nowEpoch?: bigint
  pairLabel?: string
  onClose: () => void
  onConfirm: (amt: bigint, termEpochs: bigint) => Promise<void>
}) {
  const [val, setVal] = useState('')
  const [termIdx, setTermIdx] = useState(0)
  // The fixed-term lock tiers contradict the "withdraw any time" headline, so they live behind an
  // Advanced toggle, off by default, so staking is one step unless a user opts in.
  const [advancedOpen, setAdvancedOpen] = useState(false)
  // A lock is a one-way commitment, so it gets a plain-English review step before the signer fires.
  const [confirmLock, setConfirmLock] = useState(false)
  // Reset on (re)open; a locked unstake is full-only, so pre-fill the staked balance.
  // Default term is index 0 = None (Flexible): never auto-select a lock, and keep Advanced closed.
  useEffect(() => { setVal(mode === 'unstake' && lockedUnstake ? balance.toString() : ''); setTermIdx(0); setConfirmLock(false); setAdvancedOpen(false) }, [mode])
  if (!mode) return null

  const isStake = mode === 'stake'
  const term = TERM_OPTS[termIdx]
  let amt = 0n
  try { amt = BigInt(val || '0') } catch { amt = 0n }
  const valid = amt > 0n && amt <= balance
  const setPct = (p: number) => setVal((balance * BigInt(p) / 100n).toString())
  const weight = isStake && term.epochs > 0n ? amt * BigInt(LOCK_BOOST_TIERS.find(t => t.epochs === term.epochs)!.bps) / 10_000n : amt
  // Quantify the upside of the picked lock tier vs staying flexible (the same VTX emission, bigger slice).
  const boostPct = Math.round((term.multNum - 1) * 100)
  // Unlock ETA for the confirm step: epochs aren't clock-exact, so phrase the date as approximate.
  const eta = term.epochs > 0n ? epochEta(nowEpoch + term.epochs, nowEpoch) : null

  // A flexible stake (or any unstake) signs immediately. A lock first shows a review restating the
  // unlock epoch/date and the one-way commitment, so nobody freezes funds without reading it.
  function submit() {
    if (isStake && term.epochs > 0n) { setConfirmLock(true); return }
    void run()
  }
  async function run() {
    try { await onConfirm(amt, isStake ? term.epochs : 0n); onClose() } catch { /* keep open on failure */ }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}
      title={<span className="flex items-center gap-2">
        {isStake ? <Pickaxe className="h-5 w-5 text-primary" /> : <Coins className="h-5 w-5 text-primary" />}
        {isStake ? 'Stake' : 'Unstake'} pool tokens
      </span>}>
      <div className="mb-2 flex items-center justify-between text-sm">
        <span className="text-muted">{isStake ? 'Available' : 'Staked'}</span>
        <button type="button" onClick={() => setPct(100)} className="num text-primary hover:underline">
          {compact(Number(balance))} pool tokens
        </button>
      </div>
      <input value={val} onChange={(e) => setVal(e.target.value.replace(/[^0-9]/g, ''))}
        placeholder="0" inputMode="numeric" autoFocus disabled={lockedUnstake}
        className="num w-full rounded-xl border border-border bg-surface-2/60 px-4 py-3 text-2xl outline-none focus:border-primary disabled:opacity-60" />
      {!lockedUnstake && (
        <div className="mt-3 grid grid-cols-4 gap-2">
          {[25, 50, 75, 100].map((p) => (
            <button key={p} type="button" disabled={balance <= 0n} onClick={() => setPct(p)}
              className="rounded-lg border border-border bg-surface-2/60 py-1.5 text-xs font-medium hover:border-primary disabled:opacity-40">
              {p === 100 ? 'Max' : `${p}%`}
            </button>
          ))}
        </div>
      )}

      {isStake && lockBoost && (
        <div className="mt-4">
          {/* Lock is off by default. Until a user opens Advanced, the only message is the short
              note below; the fixed-term tiers stay hidden so they can't contradict the
              "withdraw any time" headline. */}
          <button type="button" onClick={() => setAdvancedOpen(o => { if (o) setTermIdx(0); return !o })}
            className="flex w-full items-center justify-between rounded-lg border border-border bg-surface-2/60 px-3 py-2 text-left text-xs hover:border-primary">
            <span className="inline-flex items-center gap-1.5 text-muted">
              <Lock className="h-3 w-3" /> Advanced: lock for a bigger reward share
              <Hint text="Optional. Lock your pool tokens for a fixed term to mine a bigger SLICE of the same VTX rewards (it does not increase the total VTX paid out). A locked stake is frozen on-chain until the term ends, with no early withdrawal, and its reward is paid in one go when you unstake. Longer term = bigger slice." />
            </span>
            <ChevronDown className={`h-4 w-4 text-faint transition-transform ${advancedOpen ? 'rotate-180' : ''}`} />
          </button>
          {!advancedOpen ? (
            <div className="mt-1.5 text-[11px] text-faint">Off: withdraw whenever you want.</div>
          ) : (
            <div className="mt-2">
              <div className="mb-2 text-[11px] text-faint">
                A bigger multiplier means a <b className="text-foreground">bigger slice of the same VTX rewards</b>,
                not more total yield. The lock is off by default; pick a term only if you are happy to freeze
                your pool tokens for the whole period.
              </div>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                {TERM_OPTS.map((t, i) => (
                  <button key={t.label} type="button" onClick={() => setTermIdx(i)}
                    className={`rounded-lg border py-1.5 text-center text-xs font-medium transition ${
                      i === termIdx ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-surface-2/60 hover:border-primary'}`}>
                    <div>{i === 0 ? 'Off' : t.label}</div>
                    <div className="text-[10px] opacity-70">{i === 0 ? 'flexible' : t.mult}</div>
                  </button>
                ))}
              </div>
              {term.epochs > 0n ? (
                <div className="mt-2 space-y-2">
                  {/* Frozen warning first and at full weight: a one-way commitment outranks the upside. */}
                  <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-600 dark:text-amber-400">
                    <div className="flex items-center gap-1.5 text-xs font-semibold">
                      <Lock className="h-3.5 w-3.5" /> Frozen until {eta ? `~${fmtDate(eta.date)}` : `epoch ${(nowEpoch + term.epochs).toString()}`}, no early withdrawal
                    </div>
                    <div className="mt-1 text-[11px] opacity-90">
                      Your {pairLabel ? `${pairLabel} ` : ''}pool tokens are frozen on-chain for {term.sub}
                      {' '}(~{Number(term.epochs)} epochs). You cannot unstake early, and the VTX is paid in one go
                      when you unstake at the end. You confirm the exact unlock date next.
                    </div>
                  </div>
                  <div className="rounded-lg bg-surface-2/60 px-3 py-2 text-[11px] text-muted">
                    Upside: a bigger slice of the same rewards: about <b className="num text-foreground">+{boostPct}%</b> more
                    VTX share than flexible ({term.mult}), not {term.mult} more VTX overall. Mining weight ≈{' '}
                    <b className="num text-foreground">{compact(Number(weight))}</b>.
                  </div>
                </div>
              ) : (
                <div className="mt-2 text-[11px] text-faint">
                  Off: withdraw or claim whenever you want, no commitment. Pick a term above for a bigger slice of the same rewards.
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {lockedUnstake && (
        <div className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-[11px] text-amber-600 dark:text-amber-400">
          This is a locked position. It unstakes in full and pays its accrued VTX in the same tx
          (matured at epoch {unlockEpoch.toString()}).
        </div>
      )}

      <Button className="mt-4 w-full" disabled={!valid || busy} onClick={submit}>
        {busy ? (isStake ? (term.epochs > 0n ? 'Locking…' : 'Staking…') : 'Unstaking…')
              : (isStake ? (term.epochs > 0n ? `Review lock (${term.mult})` : 'Stake') : 'Unstake')}
      </Button>

      {/* Lock review: restate the unlock epoch/date before the one-way commitment is signed. */}
      <ConfirmSheet
        open={confirmLock}
        onOpenChange={(o) => { if (!o && !busy) setConfirmLock(false) }}
        title={<span className="flex items-center gap-2"><Lock className="h-5 w-5 text-amber-500" /> Confirm lock</span>}
        rows={[
          { label: 'Pool tokens', value: <>{compact(Number(amt))}{pairLabel ? ` ${pairLabel}` : ''}</> },
          { label: 'Lock term', value: term.sub },
          { label: 'Reward share', value: <>{term.mult} bigger slice (about +{boostPct}% VTX share, not +{boostPct}% total VTX)</>, emphasize: true },
          { label: 'Frozen until', value: <>{eta ? `~${fmtDate(eta.date)}` : `epoch ${(nowEpoch + term.epochs).toString()}`}, no early withdrawal</>, emphasize: true },
        ]}
        note={<>A bigger multiplier is a bigger slice of the same VTX rewards, not more total yield. Your pool tokens are frozen on-chain until then, with no early unstake, and the VTX reward is paid in one go when you unstake at the end. The "Frozen until" date is approximate (an epoch is a CKB time period of about 4 hours). This is a test network, so you are practising with play money, not real funds.</>}
        confirmLabel={`Lock for ${term.sub}`}
        busy={busy}
        onConfirm={run}
      />
    </Dialog>
  )
}
