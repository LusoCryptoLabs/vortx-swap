import { useMemo, useState } from 'react'
import { ccc } from '@ckb-ccc/connector-react'
import { toast } from 'sonner'
import { Dialog } from './ui/dialog'
import { Button } from './ui/button'
import { PairLogos } from './TokenLogo'
import { sdk } from '../lib/cellswap'
import { trackTx } from '../lib/txTracker'
import { recordActivity } from '../lib/activity'
import { humanizeError, FUNDS_SAFE_NOTE } from '../lib/errors'
import type { TokenInfo } from '../lib/tokens'
import { fmtUnits } from '../lib/utils'

type Position = { pool: any; lpAmount: bigint; shareOfPool: number; valueX: bigint; valueY: bigint }

/** Pick how much of an LP position to withdraw (slider / quick %), preview the returned
 *  amounts, and burn that LP. The slider is capped at the safe maximum: for CKB-native
 *  pools the info cell keeps a small CKB floor, so 100% of a position may not be removable. */
export function RemoveLiquidityModal({
  open, onOpenChange, position, tokenX, tokenY, onDone,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  position: Position | null
  tokenX?: TokenInfo
  tokenY?: TokenInfo
  onDone?: () => void
}) {
  const signer = ccc.useSigner()
  const [pct, setPct] = useState(100)
  const [busy, setBusy] = useState(false)

  // Cap removable LP at the pool's floor (CKB-native keeps the info cell solvent).
  const maxLp = useMemo(() => {
    if (!position) return 0n
    const floor = sdk.maxRemovableLp(position.pool)
    return floor < position.lpAmount ? floor : position.lpAmount
  }, [position])

  if (!position) return null
  const dx = tokenX?.decimals ?? 8, dy = tokenY?.decimals ?? 8
  const lpToBurn = (maxLp * BigInt(Math.round(pct * 100))) / 10000n
  const supply = position.pool.lpSupply as bigint
  const outX = supply > 0n ? (position.pool.reserveX as bigint) * lpToBurn / supply : 0n
  const outY = supply > 0n ? (position.pool.reserveY as bigint) * lpToBurn / supply : 0n
  const cappedBelowFull = maxLp < position.lpAmount   // can't fully exit (CKB floor)

  async function submit() {
    if (!signer || lpToBurn <= 0n) return
    setBusy(true)
    const id = toast.loading('Removing liquidity…')
    try {
      // Resolve straight from the pool object (which carries the real reserve-cell type scripts), so it
      // works for non-curated / unusual-args tokens that the args→type-hash lookup can't resolve.
      const h = await trackTx('Remove liquidity', () => sdk.removeLiquidityFromPool(signer as any, position!.pool, {
        lpAmount: lpToBurn,
      }))
      toast.success(`Removed: ${h.slice(0, 12)}…`, { id })
      recordActivity({
        id: h, kind: 'liquidity', status: 'completed', txHash: h,
        summary: `Removed ${fmtUnits(outX, dx, 4)} ${tokenX?.symbol ?? '?'} + ${fmtUnits(outY, dy, 4)} ${tokenY?.symbol ?? '?'} from ${tokenX?.symbol ?? '?'} / ${tokenY?.symbol ?? '?'}`,
      })
      onOpenChange(false); onDone?.()
    } catch (e) { toast.error('Could not remove liquidity', { id, description: `${humanizeError(e)} ${FUNDS_SAFE_NOTE}` }) }
    finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Remove liquidity">
      <p className="mb-3 text-xs leading-relaxed text-faint">
        Take your tokens back out of the pool. You’ll receive both tokens, in the pool’s current balance.
      </p>
      <div className="mb-4 flex items-center gap-2">
        <PairLogos a={tokenX?.symbol ?? '?'} b={tokenY?.symbol ?? '?'} tokenA={tokenX} tokenB={tokenY} />
        <span className="font-medium">{tokenX?.symbol} / {tokenY?.symbol}</span>
      </div>

      <div className="rounded-2xl border border-border bg-surface-2/40 p-4">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-xs text-faint">How much to withdraw</span>
          <span className="num text-3xl font-medium">{pct}%</span>
        </div>
        <input
          type="range" min={0} max={100} value={pct} onChange={e => setPct(Number(e.target.value))}
          className="w-full accent-primary"
        />
        <div className="mt-3 flex gap-1.5">
          {[25, 50, 75, 100].map(p => (
            <button key={p} onClick={() => setPct(p)}
              className="flex-1 rounded-lg bg-surface px-2 py-1 text-xs text-faint transition-colors hover:text-foreground">
              {p === 100 ? 'MAX' : `${p}%`}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 space-y-1.5 rounded-xl border border-border bg-surface-2/50 p-3 text-sm">
        <Row label={`You receive ${tokenX?.symbol}`}>{fmtUnits(outX, dx, 6)}</Row>
        <Row label={`You receive ${tokenY?.symbol}`}>{fmtUnits(outY, dy, 6)}</Row>
      </div>

      {cappedBelowFull && pct === 100 && (
        <p className="mt-2 text-xs text-warning">
          CKB pools must keep a small amount of CKB to stay open for trading, so you can’t withdraw 100%
          when you’re the only provider. This withdraws as much as your position allows.
        </p>
      )}

      <Button size="lg" className="mt-4 w-full" disabled={!signer || busy || lpToBurn <= 0n} onClick={submit}>
        {busy ? 'Confirm in wallet…' : 'Remove liquidity'}
      </Button>
    </Dialog>
  )
}

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex items-center justify-between"><span className="text-faint">{label}</span><span className="num">{children}</span></div>
)
