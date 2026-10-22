import { NavLink, useLocation } from 'react-router-dom'
import { ccc } from '@ckb-ccc/connector-react'
import { ArrowLeftRight, Compass, Layers, PieChart, Wallet, Sparkles } from 'lucide-react'
import { visibleNavItems } from '../lib/navItems'
import { usePendingOrders } from '../hooks/useData'
import { sdk } from '../lib/cellswap'
import { cn } from '../lib/utils'

// Persistent mobile wayfinding for the highest-frequency destinations, plus an Earn shortcut so the
// Staking/Mining pages (which the landing links to) aren't buried in the hamburger with no
// "you are here" indicator. The hamburger still lists Staking and Mining individually.
const ICONS: Record<string, typeof Compass> = {
  '/swap': ArrowLeftRight,
  '/explore': Compass,
  '/pools': Layers,
  '/positions': PieChart,
  '/wallet': Wallet,
}

const TAB = 'relative flex min-h-[3.25rem] flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[10px] font-medium transition-colors'

export function MobileTabBar() {
  const signer = ccc.useSigner()
  const { pathname } = useLocation()
  const { data: pending = [] } = usePendingOrders(signer ?? undefined)
  const items = visibleNavItems().filter(i => i.primary && ICONS[i.to])
  // One "Earn" tab covers both earning features; it's active on either route (NavLink's own isActive
  // only matches its single `to`, so we drive the active style off the pathname instead).
  const showEarn = sdk.miningEnabled() || sdk.stakingEnabled()
  const earnTo = sdk.miningEnabled() ? '/mining' : '/staking'
  const earnActive = pathname.startsWith('/mining') || pathname.startsWith('/staking')
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border/60 bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden"
    >
      {items.map(i => {
        const Icon = ICONS[i.to]
        const badge = i.to === '/positions' ? pending.length : 0
        return (
          <NavLink
            key={i.to}
            to={i.to}
            className={({ isActive }) => cn(TAB, isActive ? 'text-primary' : 'text-muted')}
          >
            <Icon className="h-5 w-5" />
            {i.label}
            {badge > 0 && (
              <span
                aria-label={`${badge} ${badge === 1 ? 'order' : 'orders'} waiting to fill`}
                title={`${badge} ${badge === 1 ? 'order' : 'orders'} waiting to fill`}
                className="absolute right-[22%] top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-bold leading-none text-primary-foreground"
              >
                {badge > 9 ? '9+' : badge}
              </span>
            )}
          </NavLink>
        )
      })}
      {showEarn && (
        <NavLink to={earnTo} aria-label="Earn (Staking and Mining)" className={cn(TAB, earnActive ? 'text-primary' : 'text-muted')}>
          <Sparkles className="h-5 w-5" />
          Earn
        </NavLink>
      )}
    </nav>
  )
}
