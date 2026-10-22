import type { MouseEvent } from 'react'
import { ShieldCheck, ShieldAlert, Shield, ChevronDown } from 'lucide-react'
import { cn } from '../lib/utils'
import { Popover } from './ui/popover'
import type { TokenRisk } from '../lib/pricing'

const STYLE = {
  low: 'bg-positive/15 text-positive',
  medium: 'bg-warning/15 text-warning',
  high: 'bg-negative/15 text-negative',
} as const
const ICON = { low: ShieldCheck, medium: Shield, high: ShieldAlert }

/** Compact risk pill. Tap (or click) to read every reason behind the rating, so the badge is never a
 *  black box. On a phone, a warning icon you cannot explain only scares without informing.
 *  Medium/high pills always carry their short label plus a caret cue so the warning reads as
 *  tappable; low risk shows a subtle green "Low risk" pill so "safe" never looks like "unrated". */
export function RiskBadge({ risk, className, showLabel = true }: { risk: TokenRisk; className?: string; showLabel?: boolean }) {
  const Icon = ICON[risk.level]
  // A warning that can't be explained only scares. Force the label + a caret cue on medium/high so
  // it clearly invites a tap, even when the caller asked to hide the label on low-risk rows.
  const flagged = risk.level !== 'low'
  const withLabel = showLabel || flagged
  // The badge is often nested inside a Link/row; keep a tap on it from navigating away.
  const stop = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation() }
  return (
    <Popover
      align="start"
      className="w-64"
      trigger={
        <button
          type="button"
          onClick={stop}
          aria-label={`Risk: ${risk.label}. Tap for details.`}
          className={cn('inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium', STYLE[risk.level], className)}
        >
          <Icon className="h-3.5 w-3.5" />
          {withLabel && <span>{risk.label}</span>}
          {flagged && <ChevronDown aria-hidden className="-ml-0.5 h-3 w-3 opacity-70" />}
        </button>
      }
    >
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <Icon className="h-4 w-4" />{risk.label}
      </div>
      <ul className="mt-2 space-y-1.5 text-xs text-muted">
        {risk.reasons.map((reason, i) => (
          <li key={i} className="flex gap-1.5">
            <span aria-hidden className="text-faint">-</span>
            <span>{reason}</span>
          </li>
        ))}
      </ul>
    </Popover>
  )
}
