import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ccc } from '@ckb-ccc/connector-react'
import { BadgeCheck, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog } from './ui/dialog'
import { Button } from './ui/button'
import { sdk, config } from '../lib/cellswap'
import { trackTx } from '../lib/txTracker'
import { type TokenInfo } from '../lib/tokens'
import { humanizeError, FUNDS_SAFE_NOTE } from '../lib/errors'

/** Register the connected wallet's own token (only shown when it's the issuer). Proves issuer
 *  control via the owner co-sign and stores metadata on-chain → the verified "Registered" badge.
 *  Charges the platform registration fee from config.registry (free if none is configured). */
export function RegisterTokenModal({ open, onClose, token }: {
  open: boolean; onClose: () => void; token: TokenInfo
}) {
  const feeShannons = config.registry?.feeShannons ?? 0n
  const feeCkb = Number(feeShannons) / 1e8
  const signer = ccc.useSigner()
  const qc = useQueryClient()
  const [symbol, setSymbol] = useState(token.symbol)
  const [name, setName] = useState(token.name)
  const [link, setLink] = useState('')
  const [decimals, setDecimals] = useState(token.decimals)
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (!signer) return
    if (!symbol.trim() || !name.trim()) { toast.error('Symbol and name are required'); return }
    setBusy(true)
    const id = toast.loading(`Registering ${symbol}…`)
    try {
      const h = await trackTx(`Register ${symbol}`, () => sdk.registerToken(signer as any, {
        decimals, symbol: symbol.trim(), name: name.trim(), link: link.trim() || undefined,
      }))
      toast.success(`Registered: ${h.slice(0, 12)}…`, { id })
      qc.invalidateQueries({ queryKey: ['registrations', config.network] })
      onClose()
    } catch (e) {
      toast.error('Registration failed', { id, description: `${humanizeError(e)} ${FUNDS_SAFE_NOTE}` })
    } finally { setBusy(false) }
  }

  const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <label className="block">
      <span className="mb-1 block text-xs text-faint">{label}</span>
      {children}
    </label>
  )
  const inputCls = 'w-full rounded-lg border border-border bg-surface-2/60 px-3 py-2 text-sm outline-none focus:border-primary'

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()} title={<span className="flex items-center gap-2"><BadgeCheck className="h-5 w-5 text-primary" /> Register {token.symbol}</span>}>
      <p className="mb-4 text-sm text-muted">
        You created this token, so you can register it. We’ll ask you to sign as proof. Then a verified
        badge shows everyone you’re the real creator, not a copycat.
      </p>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Symbol"><input value={symbol} onChange={e => setSymbol(e.target.value)} className={inputCls} maxLength={12} /></Field>
          <Field label="Decimals"><input type="number" value={decimals} min={0} max={18}
            onChange={e => setDecimals(Math.max(0, Math.min(18, Number(e.target.value) || 0)))} className={inputCls} /></Field>
        </div>
        <Field label="Name"><input value={name} onChange={e => setName(e.target.value)} className={inputCls} maxLength={40} /></Field>
        <Field label="Link (optional)"><input value={link} onChange={e => setLink(e.target.value)} placeholder="https://…" className={inputCls} /></Field>
      </div>

      <div className="mt-4 flex items-center gap-1.5 rounded-lg bg-surface-2/60 px-3 py-2 text-xs text-faint">
        <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-primary" />
        {feeShannons > 0n
          ? <><span className="font-medium text-foreground">{feeCkb.toLocaleString()} CKB</span> registration fee to the platform · anyone can still trade it · only the name and details are saved</>
          : <>Free on {config.network} · anyone can still trade it · only the name and details are saved</>}
      </div>

      <Button className="mt-4 w-full" disabled={busy || !signer} onClick={submit}>
        {busy ? 'Registering…' : feeShannons > 0n ? `Register token · ${feeCkb.toLocaleString()} CKB` : 'Register token'}
      </Button>
    </Dialog>
  )
}
