// Single source of truth for the primary navigation. Consumed by both the Header (desktop bar +
// mobile menu + mobile bottom tab bar) and the CommandPalette, so the two cannot drift. `hint` is
// the nav-layer tooltip that disambiguates the near-synonym pairs (Explore/Pools, Staking/Mining);
// `gate` hides a link on networks where that feature isn't deployed (it would be a dead end).
import { sdk } from './cellswap'

export type NavGate = 'staking' | 'mining'

export interface NavItem {
  to: string
  label: string
  hint: string
  gate?: NavGate
  /** show in the mobile bottom tab bar (the highest-frequency destinations) */
  primary?: boolean
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/swap', label: 'Swap', hint: 'Trade tokens instantly', primary: true },
  { to: '/explore', label: 'Explore', hint: 'Token prices & live trades', primary: true },
  { to: '/pools', label: 'Pools', hint: 'Provide liquidity, earn fees', primary: true },
  { to: '/positions', label: 'Positions', hint: 'Your portfolio & open orders', primary: true },
  { to: '/staking', label: 'Staking', hint: 'Lock one token, earn CKB', gate: 'staking' },
  { to: '/mining', label: 'Mining', hint: 'Stake LP tokens, earn VTX', gate: 'mining' },
  { to: '/wallet', label: 'Wallet', hint: 'Balances, send & receive', primary: true },
]

/** The nav items valid on the current network. Staking/Mining drop out where the contracts
 *  aren't deployed (otherwise the tab is a dead-end that lands on a bare "not available" state). */
export function visibleNavItems(): NavItem[] {
  return NAV_ITEMS.filter((i) =>
    i.gate === 'staking' ? sdk.stakingEnabled()
      : i.gate === 'mining' ? sdk.miningEnabled()
        : true,
  )
}
