// src/lib/testerAuth.ts: gated tester access (apply to test, log in once approved).
//
// Reuses the same JoyID passkey connect the rest of the app uses (connectJoyID in joyid.ts), but
// signs a much smaller purpose-built challenge (see @cellswap/sdk's tester-auth.ts) rather than an
// OTX trade intent; applying or logging in only proves passkey control. Applying does not grant
// access by itself; only an admin approval plus an open round does (see loginTester).
//
// Nothing in the UI calls applyToTest() or loginTester() while the round is open: an open round
// lets everyone in with any wallet (see useAccessStatus/AccessGate). They stay wired to the
// aggregator's /testers/* routes so a closed round only needs a login screen.

import { signChallenge } from '@joyid/ckb'
import {
  computeApplyCommitment, computeLoginCommitment, parseJoyIDTesterResponse,
  type JoyIDSignResponse,
} from '@cellswap/sdk'
import { connectJoyID } from './joyid'
import { AGGREGATOR_URL } from './cellswap'

const SESSION_KEY = 'cs:testerSession'

export interface TesterSession { token: string; expiresAt: number }

/** The locally-stored session, or null if absent/expired. This is a UI hint only; the
 *  aggregator re-verifies the token (and the live approved/open state) on every gated call. */
export function getStoredSession(): TesterSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as TesterSession
    if (!parsed.token || !parsed.expiresAt || Date.now() > parsed.expiresAt) {
      localStorage.removeItem(SESSION_KEY)
      return null
    }
    return parsed
  } catch { return null }
}

function storeSession(session: TesterSession): void {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)) } catch { /* ignore */ }
}

// Reserved identity the aggregator mints for the operator's own bypass pass (see the aggregator's
// tester-session.ts). Kept in sync by hand. It is not a secret; the security is the HMAC signature
// on the token, which only a holder of AGGREGATOR_API_KEY can produce.
const OPERATOR_ADDRESS = '__operator__'

/** Whether the stored session is an operator (admin-key) pass rather than a normal approved-tester
 *  session. Client-side hint only, exactly like getStoredSession(): it decides whether to render the
 *  app shell even while the round is closed, but every gated aggregator call still re-verifies the
 *  token's HMAC, so a spoofed value unlocks no real functionality. */
export function isOperatorSession(session: TesterSession | null = getStoredSession()): boolean {
  if (!session) return false
  const dot = session.token.indexOf('.')
  if (dot < 0) return false
  try {
    const b64 = session.token.slice(0, dot).replace(/-/g, '+').replace(/_/g, '/')
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
    const payload = atob(b64 + pad)
    const colon = payload.indexOf(':')
    return colon > 0 && payload.slice(0, colon) === OPERATOR_ADDRESS
  } catch { return false }
}

export function clearSession(): void {
  try { localStorage.removeItem(SESSION_KEY) } catch { /* ignore */ }
}

/** Attach the stored session (if any) as a Bearer header for a gated aggregator call
 *  (/otx, /orders). Logged-out / not-yet-approved requests simply omit it and the
 *  aggregator 401s, handled the same way any other aggregator error is (humanizeError). */
export function authHeaders(): Record<string, string> {
  const session = getStoredSession()
  return session ? { Authorization: `Bearer ${session.token}` } : {}
}

export interface AccessState {
  open: boolean
  applicantCount: number
  cap: number
  spotsRemaining: number
}

export async function fetchAccessState(): Promise<AccessState> {
  const res = await fetch(`${AGGREGATOR_URL}/testers/state`)
  if (!res.ok) throw new Error('Could not reach the aggregator')
  return res.json()
}

export type ApplyResult =
  | { ok: true; status: 'pending' | 'approved' | 'rejected' }
  | { ok: false; error: string }

/** Connect (if needed) + sign the apply challenge + submit. Idempotent server-side: reapplying
 *  from the same passkey just refreshes the email and returns the current status. */
export async function applyToTest(email: string): Promise<ApplyResult> {
  const session = await connectJoyID()
  const timestampMs = Date.now()
  const commitment = await computeApplyCommitment({
    pubkeyXY: hexToBytes(session.pubkey), email, timestampMs: BigInt(timestampMs),
  })
  const res = await signChallenge(commitment, session.address) as unknown as JoyIDSignResponse
  const { witness } = await parseJoyIDTesterResponse(res)
  const r = await fetch(`${AGGREGATOR_URL}/testers/apply`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, timestampMs, witness }),
  })
  const body = await r.json()
  if (!r.ok) return { ok: false, error: body.error ?? 'Could not submit your application' }
  return { ok: true, status: body.status }
}

export interface LoginResult {
  status: 'unregistered' | 'pending' | 'approved' | 'rejected'
  open: boolean
  token?: string
  expiresAt?: number
}

/** Connect (if needed) + sign the login challenge + check/refresh access. Stores a session
 *  locally only when one is actually granted (approved and the round is open). */
export async function loginTester(): Promise<LoginResult> {
  const session = await connectJoyID()
  const timestampMs = Date.now()
  const commitment = await computeLoginCommitment({
    pubkeyXY: hexToBytes(session.pubkey), timestampMs: BigInt(timestampMs),
  })
  const res = await signChallenge(commitment, session.address) as unknown as JoyIDSignResponse
  const { witness } = await parseJoyIDTesterResponse(res)
  const r = await fetch(`${AGGREGATOR_URL}/testers/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timestampMs, witness }),
  })
  const body = await r.json()
  if (!r.ok) throw new Error(body.error ?? 'Could not check your access')
  if (body.status === 'approved' && body.token && body.expiresAt) {
    storeSession({ token: body.token, expiresAt: body.expiresAt })
  }
  return body as LoginResult
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  const r = new Uint8Array(h.length / 2)
  for (let i = 0; i < r.length; i++) r[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return r
}
