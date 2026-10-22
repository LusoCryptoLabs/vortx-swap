// src/hooks/useAccessStatus.ts: gated tester access status.
//
// Global open/closed and cap info comes from the public GET /testers/state (no signature needed).
// Whether this browser is let in is a client-side hint only (a locally stored session token from
// a prior approved login). The aggregator re-verifies the approved/open state on every gated call
// (/otx, /orders), so this hook is not the trust boundary; it only decides whether to
// render the app shell or the closed screen.

import { useQuery } from '@tanstack/react-query'
import { fetchAccessState, getStoredSession, isOperatorSession, type AccessState } from '../lib/testerAuth'

export interface AccessStatus extends AccessState {
  hasSession: boolean
  operator: boolean
  allowed: boolean
  isLoading: boolean
}

export function useAccessStatus(): AccessStatus {
  const q = useQuery({
    queryKey: ['tester-access-state'],
    queryFn: fetchAccessState,
    refetchInterval: 12_000,
  })
  const session = getStoredSession()
  const hasSession = !!session
  // An open round is open to everyone: any wallet, no application, no login. This also keeps
  // non-JoyID wallets usable: the session login is passkey-only (see AccessGate), so requiring a
  // session here would lock out MetaMask / OKX / UTXO Global users even though every other flow
  // signs fine for them.
  //
  // Fail open when the aggregator can't be reached. The round is open by default, enforcement lives
  // server-side on each gated call, and swap/pools read the chain directly, so an aggregator outage
  // must not lock anyone out of an on-chain DEX. Only a definitive `open: false` closes the UI. An
  // operator bypass session still gets in while it is closed.
  const operator = isOperatorSession(session)
  const open = q.data?.open ?? true
  return {
    open,
    applicantCount: q.data?.applicantCount ?? 0,
    cap: q.data?.cap ?? 25,
    spotsRemaining: q.data?.spotsRemaining ?? 0,
    hasSession,
    operator,
    allowed: operator || open,
    isLoading: q.isLoading,
  }
}
