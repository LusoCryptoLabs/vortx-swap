import { useEffect, useRef, useState } from 'react'
import { ccc } from '@ckb-ccc/connector-react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Copy, Check, ExternalLink, RefreshCw } from 'lucide-react'
import { cn } from '../lib/utils'
import { useHeldBalance } from '../hooks/useData'
import { CKB } from '../lib/tokens'

// Pudge testnet faucet. A fresh wallet has 0 CKB, so any "you need CKB" dead end routes here. A bare
// link leaves a newcomer asking for their address, so this hand-off is self-contained: copy your
// address, paste it at the faucet, come back. Used by Swap, Wallet, the LP modal and Mining.
const FAUCET_URL = 'https://faucet.nervos.org/'

export function FaucetHelp({ signer, className }: { signer?: ccc.Signer; className?: string }) {
  const [address, setAddress] = useState('')
  const [copied, setCopied] = useState(false)
  const [checking, setChecking] = useState(false)
  const queryClient = useQueryClient()

  // The public faucet is a bot-protected app with no programmatic claim, so we can't push CKB in.
  // Instead we close the loop: watch the connected wallet's CKB balance and celebrate the moment it
  // lands, so the manual faucet trip has a clear finish line.
  const held = useHeldBalance(signer)
  const ckb = signer ? held(CKB) : 0n
  const prevCkb = useRef<bigint | null>(null)
  useEffect(() => {
    if (!signer) { prevCkb.current = null; return }
    const prev = prevCkb.current
    if (prev !== null && prev === 0n && ckb > 0n) {
      toast.success('Test CKB arrived. You can trade now.')
    }
    prevCkb.current = ckb
  }, [signer, ckb])

  useEffect(() => {
    if (!signer) { setAddress(''); return }
    let live = true
    signer.getRecommendedAddress().then(a => { if (live) setAddress(a) }).catch(() => {})
    return () => { live = false }
  }, [signer])

  function copy() {
    if (!address) return
    navigator.clipboard.writeText(address).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }

  function checkNow() {
    if (checking) return
    setChecking(true)
    Promise.resolve(queryClient.invalidateQueries({ queryKey: ['wallet-cells'] }))
      .finally(() => setTimeout(() => setChecking(false), 800))
  }

  const waiting = !!signer && ckb === 0n

  return (
    <div className={cn('rounded-xl border border-border bg-surface-2/50 p-3 text-xs', className)}>
      <div className="font-medium text-foreground">Get free testnet CKB (play money, not real funds)</div>
      <ol className="mt-2 space-y-2 text-faint">
        <li>
          <span className="text-foreground">1.</span> Copy your address:
          {address ? (
            <button
              onClick={copy}
              className="mt-1 flex w-full items-center gap-2 rounded-lg bg-surface px-2 py-1.5 text-left transition-colors hover:text-foreground"
            >
              <span className="num min-w-0 flex-1 truncate">{address}</span>
              {copied ? <Check className="h-3.5 w-3.5 shrink-0 text-positive" /> : <Copy className="h-3.5 w-3.5 shrink-0" />}
            </button>
          ) : (
            <span className="ml-1 text-faint">connect a wallet first</span>
          )}
        </li>
        <li>
          <span className="text-foreground">2.</span> Paste it at the{' '}
          <a href={FAUCET_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
            Nervos faucet <ExternalLink className="h-3 w-3" />
          </a>
        </li>
        <li><span className="text-foreground">3.</span> Come back here. Your CKB usually lands in about 30 seconds.</li>
      </ol>
      {waiting && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-2.5">
          <span className="text-faint">Waiting for your CKB to arrive...</span>
          <button
            onClick={checkNow}
            disabled={checking}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-surface px-2 py-1 text-foreground transition-colors hover:text-primary disabled:opacity-60"
          >
            <RefreshCw className={cn('h-3 w-3', checking && 'animate-spin')} />
            {checking ? 'Checking...' : 'I have sent it, check now'}
          </button>
        </div>
      )}
    </div>
  )
}
