import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ccc } from '@ckb-ccc/connector-react'
import { ShieldCheck, Fingerprint, ArrowDownToLine, Send, Check, Wallet, Bot } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from './ui/button'
import { ConfirmSheet } from './ConfirmSheet'
import { FaucetHelp } from './FaucetHelp'
import { buildOtxLockArgs, buildMigrationTx } from '@cellswap/sdk'
import { connectJoyID, swapViaOtx, otxLockBalances, withdrawFromOtx, isPasskeyWallet, type JoyIDSession } from '../lib/joyid'
import { sdk, client, config, AGGREGATOR_URL } from '../lib/cellswap'
import { tokenByArgs, CKB, type TokenInfo } from '../lib/tokens'
import { useHeldBalance } from '../hooks/useData'
import { fmtUnits } from '../lib/utils'
import { recordActivity } from '../lib/activity'
import { humanizeError, FUNDS_SAFE_NOTE } from '../lib/errors'

/**
 * Custody-free Batch flow (the JoyID passkey path; "OTX" / open transactions under the hood).
 * Distinct from the generic CCC signer because it needs the raw secp256r1 pubkey + WebAuthn
 * signChallenge:
 *   1. Connect JoyID (passkey)  2. Set up batch mode: migrate funds into your CellSwap lock (one-time)
 *   3. Sign the commitment (FaceID) → the relayer settles, paying you ≥ your minimum.
 * Requires the aggregator to be running (VITE_AGGREGATOR_URL).
 */
export function OtxPanel({ tokenIn, tokenOut, amountIn, minOut }: {
  tokenIn: TokenInfo
  tokenOut: TokenInfo
  amountIn: bigint | null
  minOut: bigint | null
}) {
  const signer = ccc.useSigner()
  const { wallet } = ccc.useCcc() as { wallet?: { name?: string } }
  const walletName = wallet?.name ?? 'your wallet'
  // OTX needs the raw secp256r1 passkey (+ WebAuthn signChallenge), which the generic CCC
  // signer doesn't expose, so we authorize the passkey separately. If the connected wallet
  // is already JoyID this is a light re-confirm of the same identity, not a new wallet.
  const isJoyID = isPasskeyWallet(walletName)
  const [session, setSession] = useState<JoyIDSession | null>(null)
  const [step, setStep] = useState<'idle' | 'connecting' | 'migrating' | 'submitting'>('idle')
  const [withdrawing, setWithdrawing] = useState<string | null>(null)   // token args being withdrawn
  // Review-before-sign step for the trade. The "Confirm trade" button opens this; the real
  // passkey signature runs in onConfirm. No silent signing; mirrors the Instant swap confirm.
  const [confirmOpen, setConfirmOpen] = useState(false)
  // The migration (step 2) moves funds into a separate lock. Warn plainly before signing it, not
  // just before the later trade.
  const [migrateConfirmOpen, setMigrateConfirmOpen] = useState(false)

  // Main-wallet CKB (the CCC signer pays capacity + fee when setting up batch mode). A fresh wallet
  // has 0 CKB, so setup would fail on the migration tx; those users are sent to the testnet faucet.
  const held = useHeldBalance(signer ?? undefined)
  const noCkb = !!signer && held(CKB) <= 0n

  // Batching-service health check. Before anyone sets up batch mode (a Face ID tap plus an on-chain
  // tx), confirm the settlement service is reachable, so the user never signs only to fail on the
  // POST. We probe the origin that serves /otx with a cheap GET /pools (a public, read-only route).
  // Re-checked every 20s; treated as healthy until known otherwise, so a slow first poll doesn't gate
  // a service that is up.
  const { data: settlementUp = true } = useQuery({
    queryKey: ['otx-health', AGGREGATOR_URL],
    enabled: !!AGGREGATOR_URL,
    refetchInterval: 20_000,
    queryFn: async () => {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 4000)
      try {
        const res = await fetch(`${AGGREGATOR_URL}/pools`, { signal: ctrl.signal }).finally(() => clearTimeout(timer))
        return res.ok
      } catch { return false }
    },
  })
  // Two distinct states: the aggregator is not configured in this build (permanent: batch mode is not
  // available, VITE_AGGREGATOR_URL unset, see lib/cellswap AGGREGATOR_URL), or it is configured but
  // unreachable right now (transient: try again). The copy differs so a disabled feature does not read
  // as a passing outage.
  const batchUnavailable = !AGGREGATOR_URL
  const settlementOffline = batchUnavailable || settlementUp === false

  // Funds migrated into batch mode live under a different lock than the wallet, so they
  // don't show in the normal balance. Read them straight from that lock so the user
  // can see what's parked there (and watch it change after setup / swapping). The read uses
  // the existing session's pubkey, so it never forces a fresh passkey prompt.
  const { data: otxBal, refetch: refetchOtx } = useQuery({
    queryKey: ['otx-balance', config.network, session?.pubkey],
    enabled: !!session,
    refetchInterval: 15_000,
    queryFn: () => otxLockBalances(session!.pubkey),
  })
  // How much of the current tokenIn is already parked in batch mode.
  const inOtx = otxBal?.tokens.find(t => t.args.toLowerCase() === tokenIn.args.toLowerCase())?.amount ?? 0n

  async function connect() {
    setStep('connecting')
    try { setSession(await connectJoyID()); toast.success('JoyID connected') }
    catch (e) { toast.error('Could not authorize your passkey', { description: humanizeError(e) }) }
    finally { setStep('idle') }
  }

  async function migrate() {
    if (!signer || !session || !amountIn) return
    setStep('migrating')
    const id = toast.loading(`Setting up batch mode with ${fmtUnits(amountIn, tokenIn.decimals, 4)} ${tokenIn.symbol}…`)
    try {
      const lockArgs = await buildOtxLockArgs(session.pubkey)
      const tokenType = ccc.Script.from({
        codeHash: config.scripts.xudtScript.codeHash as `0x${string}`,
        hashType: config.scripts.xudtScript.hashType as 'type', args: tokenIn.args,
      })
      const tx = await buildMigrationTx(signer as any, tokenType as any, amountIn, lockArgs, config.scripts.cellswapOtxLock.codeHash as `0x${string}`)
      const h = await (signer as any).sendTransaction(tx)
      await client.waitTransaction(h, 0, 180_000)
      toast.success('Batch mode is set up', { id, description: 'Your tokens stay locked to your passkey. Nobody else can move them.' })
      recordActivity({
        id: h,
        kind: 'batch',
        status: 'completed',
        summary: `Set up batch mode with ${fmtUnits(amountIn, tokenIn.decimals, 4)} ${tokenIn.symbol}`,
        txHash: h,
      })
      refetchOtx()
    } catch (e) { toast.error('Setup did not complete', { id, description: `${humanizeError(e)} ${FUNDS_SAFE_NOTE}` }) }
    finally { setStep('idle') }
  }

  async function submit() {
    if (!signer || !session || !amountIn || minOut == null) return
    setStep('submitting')
    const id = toast.loading('Confirm your trade with Face ID…')
    try {
      const owner = await signer.getRecommendedAddressObj()
      const res = await swapViaOtx({
        session,
        tokenIn: tokenIn.args as any,
        amountIn,
        tokenOut: sdk.udtHash(tokenOut.args as any),
        minAmountOut: minOut,
        ownerLock: { codeHash: owner.script.codeHash as `0x${string}`, hashType: owner.script.hashType as any, args: owner.script.args as `0x${string}` },
      })
      toast.success('Trade submitted', { id, description: `Position in queue: ${res.queueDepth}. Settles automatically, your funds stay yours` })
      recordActivity({
        id: `batch-${Date.now()}`,
        kind: 'batch',
        status: 'pending',
        summary: `Batch trade: ${fmtUnits(amountIn, tokenIn.decimals, 4)} ${tokenIn.symbol} → ${tokenOut.symbol} (queued, settles automatically)`,
      })
      refetchOtx()
    } catch (e) {
      toast.error('Could not submit trade', { id, description: `${humanizeError(e)} ${FUNDS_SAFE_NOTE}` })
    } finally { setStep('idle') }
  }

  async function withdraw(tokenArgs: string, symbol: string) {
    if (!signer || !session) return
    setWithdrawing(tokenArgs)
    const id = toast.loading(`Moving ${symbol} back to your wallet. Confirm with Face ID…`)
    try {
      const h = await withdrawFromOtx({ session, ownerSigner: signer as any, tokenArgs })
      await client.waitTransaction(h, 0, 180_000)
      toast.success(`${symbol} moved back to your main wallet`, { id, description: `${h.slice(0, 12)}…` })
      recordActivity({
        id: h,
        kind: 'batch',
        status: 'completed',
        summary: `Moved ${symbol} back to your main wallet from batch mode`,
        txHash: h,
      })
      refetchOtx()
    } catch (e) { toast.error('Could not move funds back', { id, description: `${humanizeError(e)} ${FUNDS_SAFE_NOTE}` }) }
    finally { setWithdrawing(null) }
  }

  return (
    <div className="mt-3 space-y-2 rounded-2xl border border-border bg-surface-2/40 p-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <ShieldCheck className="h-4 w-4 text-primary" /> Batch mode: funds stay in your wallet
      </div>

      {!session && (
        <p className="rounded-lg bg-surface/60 p-2.5 text-xs text-faint">
          {isJoyID
            ? <>You’re signed in with JoyID, a free wallet that uses Face ID or your fingerprint, with no seed phrase and no app to install. This just re-confirms your Face ID to set up batch trading. Same wallet, no new account.</>
            : <>Batch mode is secured by a <span className="text-foreground">passkey</span> from JoyID, a free wallet that uses Face ID or your fingerprint, with no seed phrase and no app to install. {walletName} can’t create that kind of signature, so connect a JoyID passkey below. Your funds never leave your control.</>}
        </p>
      )}

      <Stepline n={1} done={!!session} icon={<Fingerprint className="h-4 w-4" />} label={session ? `Passkey ready (${session.address.slice(0, 8)}…)` : isJoyID ? 'Authorize your JoyID passkey (Face ID or fingerprint)' : 'Connect a JoyID passkey (Face ID or fingerprint)'}>
        {!session && <Button size="sm" disabled={step === 'connecting'} onClick={connect}>{step === 'connecting' ? 'Authorizing…' : isJoyID ? 'Authorize' : 'Connect'}</Button>}
      </Stepline>

      <Stepline n={2} done={inOtx > 0n} icon={<ArrowDownToLine className="h-4 w-4" />} label="Set up batch mode (one-time)">
        <Button size="sm" variant="secondary" disabled={!session || !amountIn || step === 'migrating' || settlementOffline} onClick={() => setMigrateConfirmOpen(true)}>
          {step === 'migrating' ? 'Setting up…' : inOtx > 0n ? 'Add more' : 'Set up batch mode (one-time)'}
        </Button>
      </Stepline>

      {/* Show the real parked amount (read from the existing session, so no new passkey prompt),
          not just a generic "you have funds parked" line. */}
      {inOtx > 0n && (
        <p className="rounded-lg bg-surface/60 p-2.5 text-xs text-faint">
          You have <span className="num text-foreground">{fmtUnits(inOtx, tokenIn.decimals, 6)} {tokenIn.symbol}</span> parked in Batch mode, ready to trade.
        </p>
      )}

      {/* When no amount is entered, prompt instead of leaving a silently-disabled button. */}
      {session && !amountIn && (
        <p className="rounded-lg bg-surface/60 p-2.5 text-xs text-faint">
          Enter an amount above to set up batch trading.
        </p>
      )}

      {/* Setup pays an on-chain fee from the main wallet. A 0-CKB wallet cannot pay it, so hand the
          user to the testnet faucet instead of a stuck button. */}
      {session && amountIn != null && noCkb && (
        <FaucetHelp signer={signer ?? undefined} className="mt-1" />
      )}

      {/* Ownership note and the way out, right under the setup button. */}
      <p className="rounded-lg bg-surface/60 p-2.5 text-xs leading-snug text-faint">
        Your tokens stay locked to YOUR passkey. Nobody else can move them. You can move funds back to your
        main wallet any time with one Face ID tap, even if the settlement service goes offline.
      </p>

      {/* Surface a settlement outage up front, before any Face ID prompt. */}
      {settlementOffline && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs leading-snug text-amber-600 dark:text-amber-400">
          {batchUnavailable
            ? 'Batch mode is not available in this build yet; your funds are safe. Use Instant or Limit mode in the meantime.'
            : 'Settlement is temporarily offline; your funds are safe. Try again shortly.'}
        </p>
      )}

      {/* The button opens a review step first; the passkey signature runs from the sheet, never silently. */}
      <Stepline n={3} done={false} icon={<Send className="h-4 w-4" />} label="Confirm your trade with Face ID">
        <Button size="sm" disabled={!session || !amountIn || minOut == null || step === 'submitting' || settlementOffline} onClick={() => setConfirmOpen(true)}>
          {step === 'submitting' ? 'Submitting…' : 'Review trade'}
        </Button>
      </Stepline>

      {session && (otxBal?.tokens.length || otxBal?.ckb) ? (
        <div className="mt-1 rounded-lg border border-border/60 bg-surface/60 p-2.5 text-xs">
          <div className="mb-1 flex items-center gap-1.5 text-faint"><Wallet className="h-3 w-3" /> In batch mode (kept separate from your main wallet balance)</div>
          <div className="space-y-1.5">
            {otxBal!.tokens.map(t => {
              const sym = tokenByArgs(t.args)?.symbol ?? `${t.args.slice(2, 8)}…`
              return (
                <div key={t.args} className="flex items-center justify-between gap-2">
                  <span>{sym}</span>
                  <div className="flex items-center gap-2">
                    <span className="num">{fmtUnits(t.amount, tokenByArgs(t.args)?.decimals ?? 8, 6)}</span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => withdraw(t.args, sym)}
                      disabled={withdrawing !== null}
                    >
                      {withdrawing === t.args ? 'Moving back…' : 'Withdraw'}
                    </Button>
                  </div>
                </div>
              )
            })}
            <div className="flex justify-between text-faint">
              <span>CKB (covers network fees)</span>
              <span className="num">{fmtUnits(otxBal!.ckb, 8, 2)}</span>
            </div>
          </div>
        </div>
      ) : null}

      {/* Name and bound the actor in plain words, as visible text rather than a hover-only tooltip. */}
      <div className="flex items-start gap-2 rounded-lg bg-surface/60 p-2.5 text-xs leading-snug text-faint">
        <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          Who settles your trade? An automated relayer: software, no human and no custody. It can only
          submit the exact trade you signed with Face ID and can never move your funds anywhere else.
        </span>
      </div>

      <p className="pt-1 text-xs text-faint">
        Your funds stay in your own passkey-controlled wallet the whole time. Trades settle together in a
        batch and always pay you at least the minimum you set.
      </p>

      {/* Review-before-sign step, mirroring the Instant swap confirm. No silent signing. */}
      <ConfirmSheet
        open={confirmOpen}
        onOpenChange={(o) => { if (step !== 'submitting') setConfirmOpen(o) }}
        title="Review your batch trade"
        rows={[
          { label: 'You pay', value: amountIn != null ? `${fmtUnits(amountIn, tokenIn.decimals, 6)} ${tokenIn.symbol}` : '-' },
          { label: 'You receive at least', value: minOut != null ? `${fmtUnits(minOut, tokenOut.decimals, 6)} ${tokenOut.symbol}` : '-', emphasize: true },
          { label: 'Settles', value: 'Together with other traders, for a better shared price' },
        ]}
        note="Your funds stay locked to your own passkey the whole time. Nobody else can move them. You approve this trade with one Face ID tap, and you can move funds back to your main wallet any time with one tap."
        confirmLabel="Confirm with Face ID"
        busy={step === 'submitting'}
        onConfirm={() => { void submit().finally(() => setConfirmOpen(false)) }}
      />

      {/* Warning before the migration itself (step 2), which moves funds. Explain plainly that it
          stays self-custody before any signature. */}
      <ConfirmSheet
        open={migrateConfirmOpen}
        onOpenChange={(o) => { if (step !== 'migrating') setMigrateConfirmOpen(o) }}
        title="Set up batch mode"
        rows={[
          { label: 'Moves', value: amountIn != null ? `${fmtUnits(amountIn, tokenIn.decimals, 6)} ${tokenIn.symbol}` : '-', emphasize: true },
          { label: 'To', value: 'A batch-trading cell only your passkey can open' },
          { label: 'Shows up', value: 'Separately from your main balance, still yours' },
        ]}
        note="This is still self-custody: the tokens move into a cell locked to YOUR passkey, not to us or anyone else. They will show under 'In batch mode' rather than your spendable balance, and you can move them back any time with one Face ID tap, even if the settlement service goes offline."
        confirmLabel="Set up batch mode"
        busy={step === 'migrating'}
        onConfirm={() => { setMigrateConfirmOpen(false); void migrate() }}
      />
    </div>
  )
}

function Stepline({ n, done, icon, label, children }: {
  n: number; done: boolean; icon: React.ReactNode; label: string; children?: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-3">
      <div className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs ${done ? 'bg-positive/20 text-positive' : 'bg-surface text-faint'}`}>
        {done ? <Check className="h-4 w-4" /> : n}
      </div>
      <span className="flex flex-1 items-center gap-2 text-sm">{icon}{label}</span>
      {children}
    </div>
  )
}
