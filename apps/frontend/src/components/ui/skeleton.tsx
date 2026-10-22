import { cn } from '../../lib/utils'

/** A single shimmer block. Decorative: the announceable status lives on the labelled container
 *  (RowSkeleton / StatCard loading / PageFallback). Fill, shimmer and reduced-motion handling all
 *  live in the `.skeleton` class (index.css); pass a `rounded-*` here for the corner radius. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('skeleton rounded-lg', className)} />
}

/** Generic list/table loading placeholder.
 *  - `header` reserves a thead-height strip (desktop tables render one, so without it the rows jump
 *    down when data lands). It's sm-only, matching the tables' `hidden sm:block`.
 *  - `avatar` toggles the leading circle (PoolList/token rows have a logo; the TxnTable has none).
 *  - `widths` are the bar widths: the first is left-aligned, the rest are pushed right as a group.
 *  - `rows` is a viewport-fill count, not the real result count. */
export function RowSkeleton({
  rows = 5,
  avatar = true,
  widths = ['w-32', 'w-16', 'w-16'],
  header = false,
  label = 'Loading',
}: {
  rows?: number
  avatar?: boolean
  widths?: string[]
  header?: boolean
  label?: string
}) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="divide-y divide-border/60">
      <span className="sr-only">{label}…</span>
      {header && (
        <div aria-hidden="true" className="hidden items-center gap-3 px-4 py-3 sm:flex">
          <Skeleton className="h-2.5 w-20 rounded" />
          <Skeleton className="ml-auto h-2.5 w-12 rounded" />
          <Skeleton className="h-2.5 w-12 rounded" />
        </div>
      )}
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} aria-hidden="true" className="flex items-center gap-3 px-4 py-3.5">
          {avatar && <Skeleton className="h-8 w-8 rounded-full" />}
          {widths[0] && <Skeleton className={cn('h-4', widths[0])} />}
          {widths.length > 1 && (
            <div className="ml-auto flex items-center gap-3">
              {widths.slice(1).map((w, j) => <Skeleton key={j} className={cn('h-4', w)} />)}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

/** LP/position card loading placeholder. Mirrors the real card in PositionsPage (paired logo, a
 *  3-stat body that wraps to two rows, two action buttons) so the card doesn't grow on load. */
export function PositionCardSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="card space-y-3 p-4">
      <span className="sr-only">Loading position…</span>
      <div aria-hidden="true" className="flex items-center justify-between">
        <div className="flex items-center gap-2"><Skeleton className="h-7 w-7 rounded-full" /><Skeleton className="h-5 w-28" /></div>
        <Skeleton className="h-5 w-12" />
      </div>
      <div aria-hidden="true" className="grid grid-cols-2 gap-2">
        <Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-full" />
      </div>
      <div aria-hidden="true" className="flex gap-2"><Skeleton className="h-9 flex-1" /><Skeleton className="h-9 flex-1" /></div>
    </div>
  )
}

export function PositionCardSkeletonGrid({ count = 2 }: { count?: number }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {Array.from({ length: count }).map((_, i) => <PositionCardSkeleton key={i} />)}
    </div>
  )
}
