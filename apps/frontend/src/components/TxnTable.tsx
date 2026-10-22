import { ArrowUpRight } from 'lucide-react'
import { KindBadge } from './ui/stat'
import { explorerTx, timeAgo } from '../lib/explorer'
import { fmtUnits, shortHash, cn, compact } from '../lib/utils'
import type { Txn } from '../lib/txns'

function summary(t: Txn): string {
  const sx = t.tokenX?.symbol ?? '?', sy = t.tokenY?.symbol ?? '?'
  const dxX = t.tokenX?.decimals ?? 8, dyY = t.tokenY?.decimals ?? 8
  const ax = fmtUnits(t.dx < 0n ? -t.dx : t.dx, dxX, 4)
  const ay = fmtUnits(t.dy < 0n ? -t.dy : t.dy, dyY, 4)
  if (t.kind === 'swap') {
    // pool reserve up = user paid that side; down = user received
    return t.dx > 0n ? `${ax} ${sx} → ${ay} ${sy}` : `${ay} ${sy} → ${ax} ${sx}`
  }
  if (t.kind === 'add') return `+${ax} ${sx} · +${ay} ${sy}`
  if (t.kind === 'remove') return `−${ax} ${sx} · −${ay} ${sy}`
  return `${ax} ${sx} · ${ay} ${sy}`
}

/** Trade direction from tokenY's perspective (tokenX is the base/CKB side): the user buys tokenY
 *  when the pool's tokenY reserve falls (they received it), sells when it rises. */
function action(t: Txn): { text: string; cls: string } {
  if (t.kind === 'swap') {
    return t.dy < 0n
      ? { text: 'Buy', cls: 'bg-positive/15 text-positive' }
      : { text: 'Sell', cls: 'bg-negative/15 text-negative' }
  }
  return { text: t.kind, cls: '' }
}

/** Trade size proxy in tokenX (base) units; drives the relative value bar. */
const sizeX = (t: Txn) => Number(t.dx < 0n ? -t.dx : t.dx) / 10 ** (t.tokenX?.decimals ?? 8)

export function TxnTable({ txns, limit, compact: dense }: { txns: Txn[]; limit?: number; compact?: boolean }) {
  const rows = limit ? txns.slice(0, limit) : txns
  if (!rows.length) return <div className="py-10 text-center text-sm text-faint">No activity yet.</div>
  const maxSize = Math.max(...rows.map(sizeX), 1)
  return (
    <>
    {/* Desktop table; mobile (<sm) gets stacked rows so nothing scrolls sideways. */}
    <div className="hidden overflow-x-auto sm:block">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-faint">
            <th className="px-3 py-2 font-medium">Action</th>
            <th className="px-3 py-2 font-medium">Detail</th>
            {!dense && <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Value</th>}
            {!dense && <th className="px-3 py-2 font-medium">Time</th>}
            <th className="px-3 py-2 text-right font-medium" title="Opens the full transaction on the blockchain explorer">Link</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t, i) => {
            const a = action(t)
            const sx = t.tokenX?.symbol ?? '?'
            const val = sizeX(t)
            const pct = Math.max(3, Math.min(100, (val / maxSize) * 100))
            return (
              <tr key={t.txHash + i} className="border-t border-border/60 transition-colors hover:bg-surface-2/40">
                <td className="px-3 py-2.5">
                  {a.cls
                    ? <span className={cn('rounded-md px-2 py-0.5 text-xs font-medium', a.cls)}>{a.text}</span>
                    : <KindBadge kind={t.kind} />}
                </td>
                <td className="num px-3 py-2.5">{summary(t)}</td>
                {!dense && (
                  <td className="hidden px-3 py-2.5 sm:table-cell">
                    <div className="ml-auto flex w-28 flex-col items-end gap-1">
                      <span className="num text-xs text-muted">{compact(val)} {sx}</span>
                      <div className="h-1 w-full overflow-hidden rounded-full bg-border/50">
                        <div className={cn('h-full rounded-full', t.kind === 'swap' ? (t.dy < 0n ? 'bg-positive/70' : 'bg-negative/70') : 'bg-primary/60')} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  </td>
                )}
                {!dense && <td className="px-3 py-2.5 text-faint">{timeAgo(t.time)}</td>}
                <td className="px-3 py-2.5 text-right">
                  <a href={explorerTx(t.txHash)} target="_blank" rel="noreferrer"
                    className="inline-flex items-center gap-1 text-faint transition-colors hover:text-primary">
                    <span className="num">{shortHash(t.txHash, 4)}</span><ArrowUpRight className="h-3 w-3" />
                  </a>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>

    {/* Mobile stacked rows */}
    <div className="divide-y divide-border/60 sm:hidden">
      {rows.map((t, i) => {
        const a = action(t)
        return (
          <div key={t.txHash + i} className="flex items-start justify-between gap-3 px-1 py-2.5">
            <div className="min-w-0">
              {a.cls
                ? <span className={cn('rounded-md px-2 py-0.5 text-xs font-medium', a.cls)}>{a.text}</span>
                : <KindBadge kind={t.kind} />}
              <div className="num mt-1 break-words text-sm">{summary(t)}</div>
            </div>
            <div className="shrink-0 text-right">
              <div className="text-xs text-faint">{timeAgo(t.time)}</div>
              <a href={explorerTx(t.txHash)} target="_blank" rel="noreferrer"
                className="mt-0.5 inline-flex items-center gap-1 text-xs text-faint transition-colors hover:text-primary">
                <span className="num">{shortHash(t.txHash, 4)}</span><ArrowUpRight className="h-3 w-3" />
              </a>
            </div>
          </div>
        )
      })}
    </div>
    </>
  )
}
