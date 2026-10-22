import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { ccc } from '@ckb-ccc/connector-react'
import { Moon, Sun, Wallet, Menu, X } from 'lucide-react'
import { toast } from 'sonner'
import { isPasskeyWallet } from '../lib/joyid'
import { Button } from './ui/button'
import { useConnectPrompt } from './ConnectPrompt'
import { AccountMenu } from './AccountMenu'
import { BrandGlyph } from './Synapse'
import { AppearanceMenu } from './AppearanceMenu'
import { useTheme } from '../lib/theme'
import { NETWORK } from '../lib/cellswap'
import { usePendingOrders } from '../hooks/useData'
import { visibleNavItems } from '../lib/navItems'
import { cn } from '../lib/utils'

function ConnectButton() {
  const { wallet } = ccc.useCcc() as { wallet?: { name?: string } }
  const signer = ccc.useSigner()
  const [addr, setAddr] = useState<string | null>(null)
  // The wallet picker is a third-party modal we cannot label, and newcomers do not know which entry
  // is JoyID. A shared pre-step names the pick before the modal opens. It is used here and by the
  // swap card's Connect CTA so both entry points give the same guidance.
  const { promptConnect, connectPromptNode } = useConnectPrompt()

  useEffect(() => {
    if (!signer) { setAddr(null); return }
    let cancelled = false
    signer.getRecommendedAddress().then(a => !cancelled && setAddr(a)).catch(() => {})
    return () => { cancelled = true }
  }, [signer])

  // One-time heads-up when a non-passkey wallet (MetaMask, OKX, …) connects: everything works
  // except the custody-free Batch mode, which needs a JoyID passkey. Once per wallet per session.
  useEffect(() => {
    const name = wallet?.name
    if (!signer || !name || isPasskeyWallet(name)) return
    const key = `cs:batchNote:${name}`
    try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1') } catch { /* ignore */ }
    toast(`Connected with ${name}`, {
      description: 'Everything works with this wallet. The one exception is the custody-free Batch mode, which needs a JoyID Face ID passkey.',
    })
  }, [signer, wallet])

  if (signer && addr) {
    const name = wallet?.name
    const needsPasskey = !!name && !isPasskeyWallet(name)
    return (
      <div className="flex flex-col items-end gap-0.5">
        <AccountMenu address={addr} />
        {/* Persistent reminder: this wallet trades fine, but the custody-free Batch mode needs a
            JoyID passkey (Face ID / fingerprint). Desktop only to keep the mobile bar tidy. */}
        {needsPasskey && (
          <span className="hidden max-w-[15rem] text-right text-[11px] leading-tight text-faint sm:block">
            Batch mode needs a JoyID passkey (Face ID or fingerprint). Everything else works with {name}.
          </span>
        )}
      </div>
    )
  }
  return (
    <div className="flex flex-col items-end gap-0.5">
      <Button onClick={promptConnect} className="gap-2">
        <Wallet className="h-4 w-4" /> Connect
      </Button>
      {connectPromptNode}
      {/* Name the connect path for first-timers and explain JoyID. Desktop only: the compact mobile
          header (h-16) has no room for these captions, and stacking them there overflows the bar onto
          the logo. On mobile the same guidance lives in the "Choose how to connect" dialog and on the
          swap card. */}
      <div className="hidden flex-col items-end gap-0.5 sm:flex">
        <span className="max-w-[14rem] text-right text-[11px] leading-tight text-faint">
          New here? Use JoyID, a free wallet with Face ID or your fingerprint. No app, no seed phrase. It is
          also what the custody-free Batch mode needs.
        </span>
        <span className="max-w-[16rem] text-right text-[11px] leading-tight text-faint">
          JoyID will ask for Face ID or your fingerprint next. That is how you approve; it never sees your
          face or fingerprint.
        </span>
      </div>
    </div>
  )
}

/** A plain-English label for the open-orders count badge, e.g. "2 orders waiting to fill". */
export function ordersWaitingLabel(count: number): string {
  return `${count} ${count === 1 ? 'order' : 'orders'} waiting to fill`
}

/** A small count badge for the Positions nav item. Open limit/async orders are placed on Swap but
 *  managed here, so a persistent badge keeps that create->manage handoff discoverable. */
function NavBadge({ count }: { count: number }) {
  if (count <= 0) return null
  const label = ordersWaitingLabel(count)
  return (
    <span
      aria-label={label}
      title={label}
      className="ml-1.5 inline-flex h-[1.05rem] min-w-[1.05rem] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold leading-none text-primary-foreground"
    >
      {count > 9 ? '9+' : count}
    </span>
  )
}

export function Header() {
  const { theme, toggle } = useTheme()
  const [menuOpen, setMenuOpen] = useState(false)
  const signer = ccc.useSigner()
  const { data: pending = [] } = usePendingOrders(signer ?? undefined)
  const items = visibleNavItems()
  const badgeFor = (to: string) => (to === '/positions' ? pending.length : 0)
  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/70 pt-[env(safe-area-inset-top)] backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] sm:gap-6">
        <button className="-ml-2 grid h-11 w-11 shrink-0 place-items-center text-muted md:hidden" onClick={() => setMenuOpen(o => !o)} aria-label="Menu">
          {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
        <NavLink to="/" className="flex items-center gap-2">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-primary to-accent">
            <BrandGlyph size={20} color="var(--primary-foreground)" />
          </div>
          <span className="font-display text-xl font-bold tracking-tight sm:text-2xl">Vortx<span className="gradient-text"> Swap</span></span>
        </NavLink>

        <nav aria-label="Primary" className="hidden items-center gap-1 md:flex">
          {items.map(l => (
            <NavLink
              key={l.to}
              to={l.to}
              title={l.hint}
              className={({ isActive }) => cn(
                'inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                isActive ? 'bg-surface-2 text-foreground ring-1 ring-inset ring-primary/30' : 'text-muted hover:text-foreground',
              )}
            >
              {l.label}<NavBadge count={badgeFor(l.to)} />
            </NavLink>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          {/* Compact always-on chip so phone users see this is play money, not real funds.
              The roomier "testnet · practice" chip below takes over from the sm breakpoint up. */}
          {NETWORK === 'testnet' && (
            <span
              title="Test network, for practice with play money, not real funds"
              className="rounded-md border border-border bg-surface px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-muted sm:hidden"
            >
              TEST
            </span>
          )}
          <span
            title={NETWORK === 'testnet' ? 'Test network, for practice with play money, not real funds' : `Connected to ${NETWORK}`}
            className="hidden rounded-lg border border-border bg-surface px-2.5 py-1 text-xs font-medium text-muted sm:block"
          >
            {NETWORK === 'testnet' ? 'testnet · practice' : NETWORK}
          </span>
          <span className="hidden sm:inline-flex"><AppearanceMenu /></span>
          <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle theme">
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
          <ConnectButton />
        </div>
      </div>

      {menuOpen && (
        <>
          {/* Dim the page behind the menu so it reads as a layer, not text floating over the app.
              Fixed + z-30 sits over the page but under the sticky header (z-40) and this menu. */}
          <button
            aria-hidden
            tabIndex={-1}
            onClick={() => setMenuOpen(false)}
            className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm md:hidden"
          />
          <nav aria-label="More" className="relative z-40 flex flex-col gap-1 border-t border-border/60 bg-background px-4 py-3 shadow-2xl md:hidden">
            {/* The 5 primary destinations live in the fixed bottom tab bar on mobile; the hamburger is
                the overflow menu (Staking/Mining where deployed, plus network), so nothing duplicates. The
                theme toggle already sits in the header bar on mobile, so it is not repeated here. The
                earning paths show their hint as a caption, since phones have no desktop tooltip. */}
            {items.filter(l => !l.primary).map(l => (
              <NavLink key={l.to} to={l.to} onClick={() => setMenuOpen(false)}
                className={({ isActive }) => cn(
                  'flex min-h-11 flex-col justify-center rounded-lg px-3 py-2.5',
                  isActive ? 'bg-surface-2 text-foreground' : 'text-muted',
                )}>
                <span className="flex items-center text-base font-medium">{l.label}<NavBadge count={badgeFor(l.to)} /></span>
                <span className="text-xs font-normal text-faint">{l.hint}</span>
              </NavLink>
            ))}
            <div className="mt-2 flex items-center gap-3 border-t border-border/60 px-3 pt-3 text-xs text-faint">
              <span>{NETWORK === 'testnet' ? 'testnet · practice' : NETWORK}</span>
            </div>
          </nav>
        </>
      )}
    </header>
  )
}
