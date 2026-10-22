import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Command } from 'cmdk'
import { ArrowLeftRight, Compass, Layers, Wallet, Sun, Moon, Coins, Droplets, Send, Lock, Pickaxe } from 'lucide-react'
import { TOKEN_LIST } from '../lib/tokens'
import { usePoolViews } from '../hooks/useData'
import { visibleNavItems } from '../lib/navItems'
import { poolPairLabel } from '../lib/pricing'

// Per-route icons for the Navigate group; the items themselves come from the shared nav source.
const NAV_ICONS: Record<string, typeof Compass> = {
  '/swap': ArrowLeftRight,
  '/explore': Compass,
  '/pools': Layers,
  '/positions': Wallet,
  '/staking': Lock,
  '/mining': Pickaxe,
  '/wallet': Send,
}
import { useTheme } from '../lib/theme'

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const { toggle, theme } = useTheme()
  const { views } = usePoolViews()
  const [q, setQ] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen(o => !o) }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const go = (path: string) => { setOpen(false); setQ(''); navigate(path) }

  return (
    <Command.Dialog
      open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQ('') }} label="Command menu"
      className="fixed left-1/2 top-[18%] z-[60] w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 card overflow-hidden p-0 shadow-2xl"
      overlayClassName="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm"
    >
      <Command.Input
        value={q}
        onValueChange={setQ}
        placeholder="Search tokens, pools, actions…"
        className="w-full border-b border-border bg-transparent px-4 py-4 text-base outline-none placeholder:text-faint"
      />

      <Command.List className="max-h-80 overflow-y-auto p-2">
        <Command.Empty className="px-3 py-6 text-center text-sm text-faint">No results.</Command.Empty>

        <Command.Group heading="Navigate" className="px-1 text-xs text-faint [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
          {visibleNavItems().map(n => {
            const Icon = NAV_ICONS[n.to] ?? ArrowLeftRight
            return (
              <Item key={n.to} value={`go ${n.label} ${n.hint}`} onSelect={() => go(n.to)} icon={<Icon className="h-4 w-4" />}>
                {n.label} <span className="text-faint">· {n.hint}</span>
              </Item>
            )
          })}
        </Command.Group>

        <Command.Group heading="Tokens" className="px-1 text-xs text-faint [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
          {TOKEN_LIST.map(t => (
            <Item key={t.args} value={`token ${t.symbol} ${t.name}`} onSelect={() => go(`/explore/tokens/${t.args}`)} icon={<Coins className="h-4 w-4" />}>
              {t.symbol} <span className="text-faint">· {t.name}</span>
            </Item>
          ))}
        </Command.Group>

        {views.length > 0 && (
          <Command.Group heading="Pools" className="px-1 text-xs text-faint [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
            {views.map(v => (
              <Item key={v.id} value={`pool ${poolPairLabel(v)}`} onSelect={() => go(`/pools/${v.id}`)} icon={<Droplets className="h-4 w-4" />}>
                {poolPairLabel(v)}
              </Item>
            ))}
          </Command.Group>
        )}

        <Command.Group heading="Actions" className="px-1 text-xs text-faint [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
          <Item onSelect={() => { toggle(); setOpen(false) }} icon={theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}>
            Switch to {theme === 'dark' ? 'light' : 'dark'} theme
          </Item>
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  )
}

function Item({ children, onSelect, icon, value }: { children: React.ReactNode; onSelect: () => void; icon?: React.ReactNode; value?: string }) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-foreground aria-selected:bg-surface-2"
    >
      <span className="text-faint">{icon}</span>{children}
    </Command.Item>
  )
}
