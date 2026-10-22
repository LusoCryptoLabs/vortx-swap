import { useState } from 'react'
import { motion } from 'framer-motion'
import { LiquidityModal } from '../components/LiquidityModal'
import { ProtocolStats } from '../components/ProtocolStats'
import { RowSkeleton } from '../components/ui/skeleton'
import { PoolList } from '../components/PoolList'
import { usePoolViews, usePoolAprs, usePoolHistories } from '../hooks/useData'

/** Pools page, the LP destination: every pool, its TVL, and a one-click way to add one.
 *  (Markets overview content, tokens and trades, lives on /explore.) */
export default function PoolsPage() {
  const [createOpen, setCreateOpen] = useState(false)
  const { views, isLoading, refetch } = usePoolViews()
  const aprs = usePoolAprs()
  const histories = usePoolHistories()

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mb-6">
        <h1 className="font-display text-3xl sm:text-4xl">Pools</h1>
        <p className="mt-1 text-sm text-faint">Add a pair of tokens to a pool and earn a share of every trade. Prices come live from the blockchain.</p>
        <p className="mt-3 text-xs text-faint">
          Most people add to an existing pool below.{' '}
          <button onClick={() => setCreateOpen(true)} className="text-faint underline decoration-dotted underline-offset-2 hover:text-primary">
            Advanced: create a new pool
          </button>
        </p>
      </motion.div>

      <ProtocolStats />

      <LiquidityModal open={createOpen} onOpenChange={setCreateOpen} mode="create" onDone={() => refetch()} />

      <div className="card overflow-hidden p-1">
        {isLoading ? <RowSkeleton rows={5} header /> : <PoolList pools={views} aprs={aprs} histories={histories} onChanged={() => refetch()} />}
      </div>
    </div>
  )
}
