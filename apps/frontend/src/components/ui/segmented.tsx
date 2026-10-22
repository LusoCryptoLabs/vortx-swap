import { cn } from '../../lib/utils'
import { Hint } from './hint'

/** A pill segmented control (order-type tabs, timeframe selectors, etc.). When an option has a
 *  `hint`, a small tappable info affordance sits at the pill's trailing edge so the explanation is
 *  reachable on touch (a bare `title=` is dead on mobile). The Hint is a sibling of the option
  *  button (never nested inside it), so the markup stays valid and tapping the hint (which stops
  *  propagation) doesn't flip the tab. The button still fills the whole pill, so the full pill stays
  *  a tap target for switching. */
export function Segmented<T extends string>({
  options, value, onChange, size = 'md', className,
}: {
  options: { value: T; label: string; hint?: string }[]
  value: T
  onChange: (v: T) => void
  size?: 'sm' | 'md'
  className?: string
}) {
  return (
    <div className={cn('inline-flex rounded-xl bg-surface-2 p-1', className)}>
      {options.map(o => (
        <div key={o.value} className="relative inline-flex">
          <button
            type="button"
            onClick={() => onChange(o.value)}
            className={cn(
              // inline-flex + min-h gives a real (>=36/40px) thumb target instead of text-height-only pills.
              'relative inline-flex items-center justify-center rounded-lg font-medium transition-all',
              size === 'sm' ? 'min-h-[36px] text-xs' : 'min-h-[40px] text-sm',
              // Extra trailing room so the absolutely-positioned hint icon never overlaps the label.
              o.hint
                ? (size === 'sm' ? 'pl-3 pr-7' : 'pl-4 pr-8')
                : (size === 'sm' ? 'px-3' : 'px-4'),
              value === o.value
                ? 'bg-surface text-foreground shadow-sm'
                : 'text-faint hover:text-muted',
            )}
          >
            {o.label}
          </button>
          {o.hint && (
            <Hint
              text={o.hint}
              className={cn(
                'absolute top-1/2 -translate-y-1/2',
                size === 'sm' ? 'right-2' : 'right-2.5',
              )}
            />
          )}
        </div>
      ))}
    </div>
  )
}
