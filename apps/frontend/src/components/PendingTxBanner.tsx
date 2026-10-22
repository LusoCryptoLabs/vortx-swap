import { Loader2, ExternalLink } from 'lucide-react'
import { useTxStatus } from '../lib/txTracker'
import { explorerTx } from '../lib/explorer'

/** App-wide banner while a transaction is in flight: stays up through signing and on-chain
 *  confirmation (trackTx waits for the tx to be mined), so the user always sees that work is
 *  still happening, not just a fire-and-forget toast. */
export function PendingTxBanner() {
  const tx = useTxStatus()
  if (tx.active === 0) return null
  return (
    <div className="mx-auto mt-3 max-w-6xl px-4">
      <div className="flex items-center gap-3 rounded-xl border border-primary/25 bg-primary/10 px-4 py-2.5 text-sm">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
        <span className="min-w-0">
          <span className="font-medium text-foreground">
            {tx.label ?? 'Transaction'}{tx.active > 1 ? ` (+${tx.active - 1} more)` : ''}
          </span>{' '}
          <span className="text-muted">
            {tx.phase === 'signing' ? '· confirm in your wallet…' : '· waiting for on-chain confirmation…'}
          </span>
        </span>
        {tx.txHash && (
          <a href={explorerTx(tx.txHash)} target="_blank" rel="noreferrer"
            className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs text-primary hover:underline">
            View <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
    </div>
  )
}
