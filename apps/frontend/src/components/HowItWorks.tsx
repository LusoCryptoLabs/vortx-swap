import { useState, type ReactNode } from 'react'
import { HelpCircle, ChevronDown } from 'lucide-react'
import { cn } from '../lib/utils'

/** A collapsible, numbered "how it works" explainer. <details>/<summary> for native a11y +
 *  keyboard support, but the open state is held in React (synced via onToggle) so a user's
 *  collapse sticks across the page's react-query re-renders; a plain `open={bool}` prop would
 *  get reverted on every poll. Default open so first-time visitors see the steps. */
export function HowItWorks({
  title = 'How it works',
  steps,
  note,
  defaultOpen = true,
  openOnMobile = false,
  className,
}: {
  title?: string
  steps: { title: string; body: ReactNode }[]
  note?: ReactNode
  defaultOpen?: boolean
  /** Keep it open on phones too. Use where the explainer sits below the primary CTA (e.g. the swap
   *  page), so opening it doesn't push the CTA below the fold and the reassurance stays visible. */
  openOnMobile?: boolean
  className?: string
}) {
  // Default-open on desktop (first-time users see the steps) but collapsed on phones by default,
  // where a long explainer above the fold otherwise pushes the stats/CTA down. `openOnMobile` opts a
  // below-the-CTA instance back into open-on-phone. The user's own toggle still sticks either way.
  const [open, setOpen] = useState(() => {
    if (!defaultOpen) return false
    if (openOnMobile) return true
    return typeof window !== 'undefined' ? window.matchMedia('(min-width: 768px)').matches : true
  })
  return (
    <details
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className={cn('card group mb-6 overflow-hidden p-0', className)}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium select-none">
        <span className="inline-flex items-center gap-2">
          <HelpCircle className="h-4 w-4 text-primary" /> {title}
        </span>
        <ChevronDown className="h-4 w-4 text-faint transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-border px-4 py-4">
        <ol className="space-y-3">
          {steps.map((s, i) => (
            <li key={i} className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-bold text-primary">
                {i + 1}
              </span>
              <div className="text-sm">
                <div className="font-medium text-foreground">{s.title}</div>
                <div className="leading-snug text-muted">{s.body}</div>
              </div>
            </li>
          ))}
        </ol>
        {note != null && (
          <p className="mt-4 rounded-lg bg-surface-2/60 px-3 py-2 text-xs leading-snug text-muted">{note}</p>
        )}
      </div>
    </details>
  )
}
