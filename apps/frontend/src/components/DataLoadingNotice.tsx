import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { usePools } from '../hooks/useData'

/** A self-dismissing notice shown only during a slow cold load. The app reads everything from
 *  chain, so the first visit (nothing cached yet) can take a few seconds. The notice explains the
 *  wait so the page does not look broken.
 *
 *  Gated on usePools().isLoading (true only when there is no data at all) plus an 800ms delay, so
 *  it does not flash on instant loads (persisted cache or snapshot endpoint), and it hides as soon
 *  as data lands. Dismissal sticks for the rest of the page session. */
export function DataLoadingNotice() {
  const { isLoading } = usePools()
  const [show, setShow] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (!isLoading || dismissed) { setShow(false); return }
    const t = setTimeout(() => setShow(true), 800)   // only surface if it's actually slow
    return () => clearTimeout(t)
  }, [isLoading, dismissed])

  if (!show) return null
  return (
    <div className="mx-auto mt-3 max-w-6xl px-4">
      <div className="flex items-center gap-3 rounded-xl border border-primary/20 bg-primary/5 px-4 py-2.5 text-sm">
        <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
        </span>
        <span className="text-muted">
          <span className="font-medium text-foreground">Reading live from the blockchain.</span>{' '}
          The first load fetches everything straight from chain (no server in the middle), so it can
          take 5 to 10&nbsp;seconds. It’s near-instant after that.
        </span>
        <button onClick={() => setDismissed(true)} aria-label="Dismiss" className="ml-auto shrink-0 text-faint transition-colors hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
