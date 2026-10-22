// src/components/AccessGate.tsx: layout route that guards the app routes (swap, pools, etc).
//
// The test round is open to everyone: any wallet, no application, no login. The gate renders the
// paused notice only when an operator has closed the round (`node scripts/admin-testers.mjs close`).
// An operator bypass session still gets through.
//
// There is no "log in" button here. The session login is a JoyID WebAuthn passkey signature, which
// MetaMask, OKX and UTXO Global cannot produce. Requiring it would lock those wallets out of the app
// even though they sign every other flow (only batch/OTX needs a passkey; see lib/joyid.ts).

import { Outlet, Link } from 'react-router-dom'
import { useAccessStatus } from '../hooks/useAccessStatus'

export function AccessGate() {
  const status = useAccessStatus()

  if (status.allowed) return <Outlet />

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-24 text-center">
      <h1 className="font-display text-2xl font-bold">Testing is paused</h1>
      <p className="text-sm leading-relaxed text-muted">
        The open test round is closed at the moment. Nothing is wrong with your wallet. Check back shortly.
      </p>
      <Link to="/" className="text-sm text-muted underline underline-offset-4 hover:text-foreground">
        Back to the home page
      </Link>
    </div>
  )
}
