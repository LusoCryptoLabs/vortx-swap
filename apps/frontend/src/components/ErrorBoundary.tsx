import { Component, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { AlertTriangle, RefreshCw, RotateCcw } from 'lucide-react'
import { Button } from './ui/button'

/**
 * Catches render/lazy-import errors in the routed page tree. Without this, any thrown error
 * (a transient dynamic-import failure on navigation, a runtime bug in a page) unmounts the
 * whole React tree and the user is left staring at the bare background. We instead show a
 * recoverable panel and surface the message so the failure is diagnosable, not silent.
 */
class Boundary extends Component<{ resetKey: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) { return { error } }

  componentDidUpdate(prev: { resetKey: string }) {
    // Navigating to a different route clears a prior error so the new page can render.
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }

  componentDidCatch(error: Error, info: unknown) { console.error('[route error]', error, info) }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    // A stale lazy chunk after a redeploy is a load failure, not a code bug, so suggest a reload.
    const isChunk = /dynamically imported module|importing a module|failed to fetch dynamically|chunk/i.test(error.message)
    return (
      <div className="mx-auto max-w-lg px-4 py-24">
        <div className="card flex flex-col items-center gap-4 p-8 text-center">
          <AlertTriangle className="h-8 w-8 text-warning" />
          <h2 className="font-display text-2xl">{isChunk ? 'A newer version is available' : 'Something broke on this page'}</h2>
          <p className="text-sm text-faint">
            {isChunk ? 'The app was updated since you loaded it. Reload to get the latest.' : error.message || 'An unexpected error occurred.'}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => this.setState({ error: null })}><RotateCcw className="h-4 w-4" /> Try again</Button>
            <Button onClick={() => window.location.reload()}><RefreshCw className="h-4 w-4" /> Reload</Button>
          </div>
        </div>
      </div>
    )
  }
}

/** Per-route boundary. Recovers when you navigate elsewhere. */
export function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  return <Boundary resetKey={pathname}>{children}</Boundary>
}

/** Top-level catch-all for errors above the routes (providers, header) that would otherwise
 *  blank the entire screen. No router dependency, so it works at the very root of the tree. */
export function AppErrorBoundary({ children }: { children: ReactNode }) {
  return <Boundary resetKey="app">{children}</Boundary>
}
