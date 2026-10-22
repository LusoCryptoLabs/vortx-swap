import { type ReactNode } from 'react'
import { cn } from '../../lib/utils'
import { Skeleton } from './skeleton'

export function StatCard({ label, value, unit, sub, className, loading }: {
  label: ReactNode
  value: ReactNode
  /** Optional unit (e.g. "CKB") rendered as a smaller, non-wrapping sibling so a big value never
   *  splits its unit onto a second line. Prefer this over baking " CKB" into `value`. */
  unit?: ReactNode
  sub?: ReactNode
  className?: string
  /** Show a shimmer in place of the value until the number is ready, instead of a misleading 0/-. */
  loading?: boolean
}) {
  return (
    // Tighter padding + smaller value on phones so single-digit stats don't float in dead space.
    <div className={cn('card p-3 sm:p-[1.1rem]', className)}>
      <div className="eyebrow flex items-center gap-1 text-faint">{label}</div>
      {loading
        ? <div role="status" aria-live="polite" className="mt-1.5">
            <span className="sr-only">Loading {typeof label === 'string' ? label : 'value'}…</span>
            <Skeleton className="h-6 w-24 sm:h-[1.875rem]" />
          </div>
        : <div className="disp mt-1.5 text-2xl font-bold leading-none tracking-tight break-words sm:text-3xl">
            {value}
            {unit != null && <span className="ml-1 align-baseline text-base font-medium text-faint">{unit}</span>}
          </div>}
      {sub != null && <div className="mt-1 text-xs text-faint">{sub}</div>}
    </div>
  )
}

const KIND_STYLES: Record<string, string> = {
  swap: 'bg-primary/15 text-primary',
  add: 'bg-positive/15 text-positive',
  remove: 'bg-negative/15 text-negative',
  create: 'bg-accent/15 text-accent',
}
export function KindBadge({ kind }: { kind: string }) {
  return (
    <span className={cn('rounded-md px-2 py-0.5 text-xs font-medium capitalize', KIND_STYLES[kind] ?? 'bg-surface-2 text-muted')}>
      {kind}
    </span>
  )
}
