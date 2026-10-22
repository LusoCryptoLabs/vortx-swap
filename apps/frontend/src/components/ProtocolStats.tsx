import { StatCard } from './ui/stat'
import { usePoolViews } from '../hooks/useData'
import { realizableTvl } from '../lib/pricing'
import { compact } from '../lib/utils'

/** The protocol-wide headline stats (TVL / pools / paired tokens), computed once from the shared
 *  pool views so Explore and Pools can't show different numbers for the same thing. */
export function ProtocolStats({ className }: { className?: string }) {
  const { views, isLoading } = usePoolViews()
  const totalTvl = views.reduce((a, v) => { const r = realizableTvl(v); return a + (isFinite(r) ? r : 0) }, 0)
  const tokens = new Set<string>()
  for (const v of views) { if (v.tokenX) tokens.add(v.tokenX.args); if (v.tokenY) tokens.add(v.tokenY.args) }
  const loading = isLoading && views.length === 0
  return (
    <div className={'mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 ' + (className ?? '')}>
      <StatCard label="Total value in pools" value={compact(totalTvl)} unit="CKB" className="col-span-2 sm:col-span-1" loading={loading} />
      <StatCard label="Pools" value={views.length} loading={loading} />
      <StatCard label="Tokens paired" value={tokens.size} loading={loading} />
    </div>
  )
}
