import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ccc } from '@ckb-ccc/connector-react'
import { QRCodeSVG } from 'qrcode.react'
import { NumericFormat } from 'react-number-format'
import { Send, QrCode, Copy, Wallet, BadgeCheck, ShieldCheck, ChevronRight, ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../components/ui/button'
import { Segmented } from '../components/ui/segmented'
import { Skeleton } from '../components/ui/skeleton'
import { WalletAssetList } from '../components/WalletAssets'
import { ConfirmSheet } from '../components/ConfirmSheet'
import { useConnectPrompt } from '../components/ConnectPrompt'
import { TokenPill, TokenSelect } from '../components/TokenSelect'
import { RegisterTokenModal } from '../components/RegisterTokenModal'
import { useHeldBalance, useRegistrations } from '../hooks/useData'
import { sendToken } from '../lib/transfer'
import { sdk, client } from '../lib/cellswap'
import { trackTx } from '../lib/txTracker'
import { recordActivity } from '../lib/activity'
import { humanizeError, FUNDS_SAFE_NOTE } from '../lib/errors'
import { TOKENS, tokenByArgs, type TokenInfo } from '../lib/tokens'
import { fmtUnits, parseUnits, shortHash } from '../lib/utils'

export default function WalletPage() {
  const signer = ccc.useSigner()
  const { promptConnect, connectPromptNode } = useConnectPrompt()
  const [params] = useSearchParams()
  const [mode, setMode] = useState<'send' | 'receive'>(params.get('mode') === 'receive' ? 'receive' : 'send')
  const [address, setAddress] = useState('')

  useEffect(() => {
    if (!signer) { setAddress(''); return }
    signer.getRecommendedAddress().then(setAddress).catch(() => {})
  }, [signer])

  if (!signer) {
    return (
      <div className="mx-auto grid max-w-6xl place-items-center px-4 py-24">
        <div className="card flex flex-col items-center gap-4 px-6 py-12 text-center sm:px-10">
          <Wallet className="h-8 w-8 text-primary" />
          <h2 className="text-balance font-display text-2xl">Connect to send & receive</h2>
          <Button onClick={promptConnect}>Connect wallet</Button>
        </div>
        {connectPromptNode}
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-md px-4 py-8">
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
        <div className="mb-4 flex justify-center">
          <Segmented
            options={[{ value: 'send', label: 'Send' }, { value: 'receive', label: 'Receive' }]}
            value={mode} onChange={setMode}
          />
        </div>
        {mode === 'send' ? <SendForm signer={signer} /> : <Receive address={address} />}

        {/* Held balances: the wallet page shows your assets, not just Send/Receive. */}
        <div className="card mt-4 overflow-hidden p-1">
          <div className="px-4 pb-1 pt-3 text-xs text-faint">Your assets</div>
          <WalletAssetList signer={signer} />
        </div>

        {/* Pointer to Batch-mode balances. They live under a passkey-controlled lock, so reading them
            here would force a Face ID / fingerprint prompt on page load. Instead of doing that, we send
            the user to Swap > Batch, where the passkey prompt is intentional. */}
        <Link to="/swap?mode=batch" className="card mt-4 flex items-center gap-3 p-4 transition-colors hover:border-primary/40">
          <ShieldCheck className="h-5 w-5 shrink-0 text-primary" />
          <span className="flex-1 text-sm">
            <span className="font-medium">Trading in Batch mode?</span>
            <span className="block text-xs text-faint">Manage those balances in Swap &gt; Batch. They are kept separate from your main balance.</span>
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-faint" />
        </Link>

        <OwnTokenRegister signer={signer} />
      </motion.div>
    </div>
  )
}

/** Register the connected wallet's own token (xUDT args = its lock hash), the one token it can
 *  register. Reachable with no pool required, unlike the in-context button on a token's page. */
function OwnTokenRegister({ signer }: { signer: ccc.Signer }) {
  const [lockHash, setLockHash] = useState('')
  const [open, setOpen] = useState(false)
  const { data: regs } = useRegistrations()

  useEffect(() => {
    signer.getRecommendedAddressObj().then(a => setLockHash(a.script.hash())).catch(() => {})
  }, [signer])

  if (!sdk.registryEnabled() || !lockHash) return null
  const typeHash = sdk.udtHash(lockHash as any)
  const reg = regs?.get(typeHash.toLowerCase())
  const registered = !!reg && reg.ownerLockHash.toLowerCase() === lockHash.toLowerCase()
  // Pre-fill from a prior registration, else a curated entry for this token, else blank.
  const curated = tokenByArgs(lockHash)
  const token = {
    args: lockHash,
    symbol: reg?.symbol ?? curated?.symbol ?? '',
    name: reg?.name ?? curated?.name ?? '',
    decimals: reg?.decimals ?? curated?.decimals ?? 8,
  } as TokenInfo

  return (
    <div className="card mt-4 p-4">
      <div className="mb-1 flex items-center gap-2">
        <BadgeCheck className="h-4 w-4 text-primary" />
        <span className="text-sm font-medium">Your token</span>
        {registered && <span className="badge badge-pos">Registered</span>}
      </div>
      <p className="mb-3 text-xs text-faint">
        Your wallet can create its own token.{' '}
        {registered ? 'It carries the verified badge across the app.' : 'Register it to earn the verified badge. It proves you’re the real creator so traders can trust it.'}
      </p>
      <div className="num mb-3 text-xs text-faint" title="Your token's unique ID on the blockchain">Token ID: {shortHash(lockHash, 8)}</div>
      {!registered && (
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <BadgeCheck className="mr-1.5 h-4 w-4" /> Register your token
        </Button>
      )}
      <RegisterTokenModal open={open} onClose={() => setOpen(false)} token={token} />
    </div>
  )
}

function SendForm({ signer }: { signer: ccc.Signer }) {
  const held = useHeldBalance(signer)
  const [token, setToken] = useState<TokenInfo>(TOKENS.CKB)
  const [amount, setAmount] = useState('')
  const [to, setTo] = useState('')
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [addrValid, setAddrValid] = useState<boolean | null>(null)   // null = nothing typed yet

  const bal = held(token.args)
  const amt = parseUnits(amount, token.decimals)
  const insufficient = amt != null && amt > bal

  // Show the CKB-denominated cost before signing. A simple transfer at the standard fee rate
  // (1000 shannon/KB, matching lib/transfer.ts) lands around 0.001 CKB, phrased as an estimate
  // because the exact size depends on how many cells get consumed. CKB has 8 decimals, so
  // 0.001 CKB = 100,000 shannon.
  const FEE_ESTIMATE = 100_000n            // ~0.001 CKB, in shannon
  const sendingCkb = token.args.toLowerCase() === TOKENS.CKB.args.toLowerCase()
  // When sending CKB, the fee comes out of the same balance as the amount; otherwise the fee is
  // paid in CKB separately, so "Balance after" tracks the token you actually moved.
  const balAfter = amt == null ? null
    : sendingCkb ? bal - amt - FEE_ESTIMATE
    : bal - amt
  const balAfterLabel = balAfter != null && balAfter >= 0n
    ? `${fmtUnits(balAfter, token.decimals, 4)} ${token.symbol}`
    : '-'
  // MAX on native CKB must leave the miner fee + a 61-CKB change-cell floor behind, or the send can't
  // settle (CKB cells have a hard 61-CKB minimum). Token sends pay the fee in CKB separately, so their
  // MAX is the full token balance.
  const CKB_SEND_RESERVE = 6_200_000_000n   // ~62 CKB: 61 CKB change-cell floor + fee headroom
  const maxSendable = sendingCkb ? (bal > CKB_SEND_RESERVE ? bal - CKB_SEND_RESERVE : 0n) : bal

  // Validate the recipient inline as it is typed, so a bad address is caught before signing instead
  // of failing only after submit. ccc.Address.fromString is async, so guard against a stale result
  // by capturing the value we validated and ignoring it if the field changed underneath us.
  useEffect(() => {
    const trimmed = to.trim()
    if (!trimmed) { setAddrValid(null); return }
    let stale = false
    ccc.Address.fromString(trimmed, client)
      .then(() => { if (!stale) setAddrValid(true) })
      .catch(() => { if (!stale) setAddrValid(false) })
    return () => { stale = true }
  }, [to])

  const ready = !!amt && addrValid === true && !insufficient && (balAfter == null || balAfter >= 0n)

  async function send() {
    if (!amt || addrValid !== true) return
    setBusy(true)
    const id = toast.loading(`Sending ${amount} ${token.symbol}…`)
    const summary = `Sent ${amount} ${token.symbol} to ${shortHash(to.trim(), 6)}`
    try {
      const h = await trackTx(`Send ${token.symbol}`, () => sendToken(signer, to.trim(), token.args, amt))
      toast.success(`Sent: ${h.slice(0, 12)}…`, { id })
      recordActivity({ id: h, kind: 'send', status: 'completed', summary, txHash: h })
      setConfirming(false)
      setAmount(''); setTo(''); setAddrValid(null)
    } catch (e) {
      toast.error('Send failed', { id, description: `${humanizeError(e)} ${FUNDS_SAFE_NOTE}` })
      recordActivity({ id: `send-fail-${Date.now()}`, kind: 'send', status: 'failed', summary: `Failed to send ${amount} ${token.symbol}` })
    } finally { setBusy(false) }
  }

  return (
    <div className="card p-5">
      <div className="rounded-2xl border border-border bg-surface-2/40 p-4">
        <div className="mb-2 flex items-center justify-between text-xs text-faint">
          <span>Amount</span>
          <button onClick={() => setAmount(fmtUnits(maxSendable, token.decimals, token.decimals))} className="num hover:text-foreground">
            {fmtUnits(bal, token.decimals, 4)} max
          </button>
        </div>
        <div className="flex items-center gap-3">
          <NumericFormat value={amount} onValueChange={v => setAmount(v.value)} thousandSeparator allowNegative={false}
            decimalScale={token.decimals} placeholder="0.0" inputMode="decimal"
            className="num min-w-0 flex-1 bg-transparent text-3xl font-medium outline-none placeholder:text-faint" />
          <TokenPill token={token} onClick={() => setPicking(true)} />
        </div>
      </div>

      <div className="mt-3">
        <label className="mb-1.5 block text-xs text-faint">Recipient address</label>
        <input value={to} onChange={e => setTo(e.target.value)} placeholder="Paste the recipient’s address"
          className={`num w-full rounded-xl border bg-surface-2/40 px-3 py-3 text-sm outline-none placeholder:text-faint focus:border-primary/50 ${addrValid === false ? 'border-negative/60' : 'border-border'}`} />
        {addrValid === false && (
          <p className="mt-1.5 text-xs text-negative">That does not look like a valid Nervos address. Double-check it.</p>
        )}
      </div>

      <Button size="lg" className="mt-4 w-full" disabled={!ready || busy} onClick={() => setConfirming(true)}>
        <Send className="h-4 w-4" />
        {insufficient ? `Insufficient ${token.symbol}` : 'Review send'}
      </Button>

      <ConfirmSheet
        open={confirming}
        onOpenChange={o => { if (!busy) setConfirming(o) }}
        title="Review your send"
        rows={[
          { label: 'Amount', value: `${amount || '0'} ${token.symbol}`, emphasize: true },
          { label: 'To', value: shortHash(to.trim(), 10) },
          { label: 'Network fee', value: '~0.001 CKB (estimate)' },
          { label: 'Balance after', value: balAfterLabel },
        ]}
        note="Sending is irreversible. Double-check the address."
        confirmLabel="Send now"
        onConfirm={send}
        busy={busy}
      />

      <TokenSelect open={picking} onOpenChange={setPicking} onSelect={setToken} />
    </div>
  )
}

function Receive({ address }: { address: string }) {
  const [showFull, setShowFull] = useState(false)
  return (
    <div className="card flex flex-col items-center gap-4 p-6 text-center">
      <div className="flex items-center gap-2 text-sm text-faint"><QrCode className="h-4 w-4" /> Your address</div>
      {address ? (
        <>
          <div className="rounded-2xl bg-white p-4">
            <QRCodeSVG value={address} size={208} bgColor="#ffffff" fgColor="#07090c" level="M" />
          </div>
          <button
            onClick={() => { navigator.clipboard.writeText(address); toast.success('Address copied') }}
            className="flex max-w-full items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 text-sm transition-colors hover:bg-border/60"
          >
            <span className={showFull ? 'num break-all text-left' : 'num truncate'}>{showFull ? address : shortHash(address, 10)}</span>
            <Copy className="h-4 w-4 shrink-0 text-faint" />
          </button>
          <button
            onClick={() => setShowFull(v => !v)}
            className="flex items-center gap-1 text-xs text-faint transition-colors hover:text-foreground"
          >
            {showFull ? 'Hide full address' : 'Show full address'}
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showFull ? 'rotate-180' : ''}`} />
          </button>
          <p className="text-xs text-faint">Only send Nervos CKB assets to this address. Coins from other networks could be lost.</p>
        </>
      ) : (
        <div role="status" aria-live="polite" className="flex flex-col items-center gap-4">
          <span className="sr-only">Loading address…</span>
          <Skeleton className="h-[208px] w-[208px] rounded-2xl" />
          <Skeleton className="h-9 w-48 rounded-xl" />
        </div>
      )}
    </div>
  )
}
