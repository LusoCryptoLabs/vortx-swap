import { useState } from 'react'
import { ccc } from '@ckb-ccc/connector-react'
import { Search, BadgeCheck, AlertTriangle, Plus, Trash2, Wallet, ChevronDown, ChevronRight } from 'lucide-react'
import { Dialog } from './ui/dialog'
import { ConfirmSheet } from './ConfirmSheet'
import { TokenLogo } from './TokenLogo'
import { TOKEN_LIST, CKB, useCustomTokens, isVerifiedToken, type TokenInfo } from '../lib/tokens'
import { useWalletTokens, usePoolViews } from '../hooks/useData'
import { fmtUnits, shortHash } from '../lib/utils'

type Row = TokenInfo & { amount?: bigint; icon?: string; removable?: boolean; owned?: boolean; pooled?: boolean }

export function TokenPill({ token, onClick }: { token: TokenInfo; onClick: () => void }) {
  const unverified = !isVerifiedToken(token.args)
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 rounded-full bg-surface-2 py-1.5 pl-1.5 pr-3 font-medium transition-colors hover:bg-border/60"
    >
      <TokenLogo token={token} className="h-7 w-7" />
      <span>{token.symbol}</span>
      {unverified && (
        <AlertTriangle
          role="img"
          aria-label="Not on our verified list, trade with caution."
          className="h-3.5 w-3.5 text-warning"
        >
          <title>Not on our verified list, trade with caution.</title>
        </AlertTriangle>
      )}
      <ChevronDown className="-ml-1 h-4 w-4 text-faint" />
    </button>
  )
}

export function TokenSelect({
  open, onOpenChange, onSelect, exclude,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onSelect: (t: TokenInfo) => void
  exclude?: string
}) {
  const [q, setQ] = useState('')
  // Advanced (import-by-address) stays collapsed by default so verified tokens are the obvious path.
  const [advanced, setAdvanced] = useState(false)
  const [addr, setAddr] = useState('')
  // A pending unverified pick the user must confirm before it enters the trade. `fresh` flags
  // a brand-new import (not yet in the list) so we persist it on confirm.
  const [pending, setPending] = useState<{ token: TokenInfo; fresh: boolean } | null>(null)
  const signer = ccc.useSigner()
  const { list: custom, add, remove } = useCustomTokens()
  const { data: owned = [] } = useWalletTokens(signer ?? undefined)
  const { views } = usePoolViews()

  // Merge: curated → imported → wallet holdings → any token that has a pool (so every tradeable
  // token is selectable, not just curated/held ones). Non-curated entries stay marked unverified.
  const byArgs = new Map<string, Row>()
  for (const t of TOKEN_LIST) byArgs.set(t.args.toLowerCase(), { ...t })
  for (const t of custom) if (!byArgs.has(t.args.toLowerCase())) byArgs.set(t.args.toLowerCase(), { ...t, removable: true })
  for (const a of owned) {
    const k = a.args.toLowerCase()
    const ex = byArgs.get(k)
    if (ex) { ex.amount = a.amount; ex.owned = true; if (a.icon) ex.icon = a.icon }
    else byArgs.set(k, { symbol: a.symbol, name: a.name, args: a.args as `0x${string}`, decimals: a.decimals, amount: a.amount, icon: a.icon, owned: true })
  }
  for (const v of views) {
    for (const t of [v.tokenX, v.tokenY]) {
      if (!t || t.args === CKB) continue   // CKB is already curated
      if (!byArgs.has(t.args.toLowerCase())) byArgs.set(t.args.toLowerCase(), { ...t, pooled: true })
    }
  }
  const all = [...byArgs.values()]
  // owned first, then by symbol
  all.sort((x, y) => (Number(!!y.owned) - Number(!!x.owned)) || x.symbol.localeCompare(y.symbol))
  const list = all.filter(t =>
    t.args !== exclude &&
    (t.symbol.toLowerCase().includes(q.toLowerCase()) || t.name.toLowerCase().includes(q.toLowerCase()) || t.args.toLowerCase().includes(q.toLowerCase())))

  const isArgs = /^0x[0-9a-fA-F]{64}$/.test(addr.trim())
  const canImport = isArgs && !all.some(t => t.args.toLowerCase() === addr.trim().toLowerCase())

  function finish(t: TokenInfo) {
    onSelect(t); onOpenChange(false)
    setQ(''); setAddr(''); setAdvanced(false); setPending(null)
  }

  // One-tap for verified tokens; an unverified token (imported by address or pool-discovered) routes
  // through a confirm step so a newcomer never silently trades a token we have not checked.
  function choose(t: TokenInfo, fresh = false) {
    if (isVerifiedToken(t.args)) { finish(t); return }
    setPending({ token: t, fresh })
  }

  function startImport() {
    const args = addr.trim() as `0x${string}`
    const t: TokenInfo = { symbol: args.slice(2, 6).toUpperCase(), name: 'Imported token', args, decimals: 8 }
    choose(t, true)
  }

  function confirmPending() {
    if (!pending) return
    if (pending.fresh) add(pending.token)
    finish(pending.token)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Select a token">
      <div className="mb-3 flex items-center gap-2 rounded-xl border border-border bg-surface-2 px-3">
        <Search className="h-4 w-4 text-faint" />
        <input
          autoFocus value={q} onChange={e => setQ(e.target.value)}
          placeholder="Search by name or symbol"
          className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-faint"
        />
      </div>

      <div className="-mx-2 max-h-80 overflow-y-auto">
        {list.length === 0 && <div className="px-4 py-8 text-center text-sm text-faint">No tokens found</div>}
        {list.map(t => {
          const verified = isVerifiedToken(t.args)
          const amount = t.amount
          return (
            <div key={t.args} className="group flex items-center gap-1">
              <button
                onClick={() => choose(t)}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-surface-2"
              >
                <TokenLogo token={t} icon={t.icon} className="h-9 w-9" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 font-medium">
                    {t.symbol}
                    {verified
                      ? <BadgeCheck className="h-3.5 w-3.5 text-primary" />
                      : <AlertTriangle
                          role="img"
                          aria-label="Not on our verified list, trade with caution."
                          className="h-3.5 w-3.5 text-warning"
                        >
                          <title>Not on our verified list, trade with caution.</title>
                        </AlertTriangle>}
                    {t.owned && <Wallet className="h-3 w-3 text-faint" />}
                  </div>
                  <div className="truncate text-xs text-faint">{verified ? t.name : shortHash(t.args, 6)}</div>
                </div>
                {amount != null && amount > 0n && (
                  <div className="num text-sm text-muted">{fmtUnits(amount, t.decimals, 4)}</div>
                )}
              </button>
              {t.removable && (
                <button onClick={() => remove(t.args)} className="rounded-lg p-2 text-faint opacity-0 transition-opacity hover:text-negative group-hover:opacity-100" title="Remove imported token">
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          )
        })}
      </div>
      {/* Advanced: import a token by its address. Tucked away so newcomers default to the
          verified list and only power users reach for it. */}
      <div className="mt-3 border-t border-border pt-3">
        <button
          type="button"
          onClick={() => setAdvanced(a => !a)}
          aria-expanded={advanced}
          className="flex w-full items-center gap-1 text-xs font-medium text-faint transition-colors hover:text-foreground"
        >
          {advanced ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          Advanced: import a token by address
        </button>
        {advanced && (
          <div className="mt-3 space-y-2">
            <input
              value={addr}
              onChange={e => setAddr(e.target.value)}
              placeholder="Paste a token address (0x…)"
              className="h-11 w-full rounded-xl border border-border bg-surface-2 px-3 text-sm outline-none placeholder:text-faint"
            />
            {addr.trim().length > 0 && !isArgs && (
              <p className="text-xs text-faint">Enter a full 0x token address (66 characters).</p>
            )}
            {isArgs && !canImport && (
              <p className="text-xs text-faint">That token is already in the list above.</p>
            )}
            <button
              onClick={startImport}
              disabled={!canImport}
              className="flex w-full items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2.5 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="h-4 w-4 text-warning" />
              <span className="flex-1">Import {isArgs ? <span className="num">{shortHash(addr.trim(), 6)}</span> : 'token'}</span>
              <span className="text-xs text-warning">not verified</span>
            </button>
          </div>
        )}
      </div>

      <p className="mt-3 text-center text-xs text-faint">
        Tokens on our official list are <span className="text-primary">verified</span>. Tokens you import
        yourself are <span className="text-warning">not checked</span>. Anyone can create a token with any
        name, so only trade ones you trust.
      </p>

      {/* Confirm before an unverified token enters the trade. */}
      <ConfirmSheet
        open={pending != null}
        onOpenChange={(o) => { if (!o) setPending(null) }}
        title="Import an unverified token?"
        rows={pending ? [
          { label: 'Token', value: pending.token.symbol, emphasize: true },
          { label: 'Address', value: <span className="num">{shortHash(pending.token.args, 6)}</span> },
        ] : []}
        note="This token is not on our verified list. Anyone can create a token with any name, so only continue if you trust it. Import and use it anyway?"
        confirmLabel="Import and use"
        cancelLabel="Cancel"
        onConfirm={confirmPending}
      />
    </Dialog>
  )
}
