// packages/aggregator/src/tester-session.ts
//
// Stateless per-tester session tokens: HMAC-SHA256, no JWT library. This follows the repo's
// Node-builtin-crypto-only convention (see security.ts's authorized(), the same shared-secret
// Bearer style, just per-user instead of a single static key).
//
// Revocation without a token store: verification re-checks the live testers/app_state tables on
// every call (one indexed SQLite lookup, at most 25 rows), not just the token's own signature. So
// rejecting someone or flipping `close` invalidates their still-unexpired token on their next
// request, with no blocklist.

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { TestersDB } from './testers.js'

const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000   // 14 days

// Reserved identity for the operator's own bypass pass (minted only via the AGGREGATOR_API_KEY-gated
// /testers/admin-session route). It can never collide with a real tester: those are 64 lowercase hex
// chars (blake2b256 of a pubkey), this has underscores. A token bound to it is honored regardless of
// the open/closed switch and without a whitelist row, so the operator is never locked out of their
// own app while a round is closed. It consumes no tester slot.
export const OPERATOR_ADDRESS = '__operator__'

function secret(): string {
  const s = process.env.TESTER_SESSION_SECRET
  if (!s) throw new Error('TESTER_SESSION_SECRET not set')
  return s
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url')
}

export function mintSession(addressHash: string): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + SESSION_TTL_MS
  const payload = `${addressHash.toLowerCase()}:${expiresAt}`
  const token = `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`
  return { token, expiresAt }
}

function verifyToken(token: string): { addressHash: string } | null {
  const dot = token.indexOf('.')
  if (dot < 0) return null
  const payloadB64 = token.slice(0, dot)
  const sigB64 = token.slice(dot + 1)
  let payload: string
  try { payload = Buffer.from(payloadB64, 'base64url').toString() } catch { return null }
  const expectedSig = sign(payload)
  const a = Buffer.from(sigB64), b = Buffer.from(expectedSig)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  const [addressHash, expiresAtStr] = payload.split(':')
  if (!addressHash || !expiresAtStr) return null
  const expiresAt = Number(expiresAtStr)
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return null
  return { addressHash }
}

function bearerToken(req: IncomingMessage): string | undefined {
  const auth = req.headers['authorization']
  return typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined
}

export interface SessionCheckResult { ok: boolean; addressHash?: string; reason?: string }

/** Note: this reads the same `Authorization: Bearer <token>` header as security.ts's authorized(),
 *  but the two token shapes are structurally different (an opaque shared admin secret vs. a
 *  base64url-payload.base64url-signature pair) and no route calls both: /otx and /orders call
 *  only this; /testers/list + the approve/reject/open/close admin routes call only
 *  authorized(). */
export function requireTesterSession(req: IncomingMessage, testersDb: TestersDB): SessionCheckResult {
  const token = bearerToken(req)
  if (!token) return { ok: false, reason: 'missing session token' }
  const verified = verifyToken(token)
  if (!verified) return { ok: false, reason: 'invalid or expired session token' }
  // Operator bypass: a valid token bound to the reserved identity skips the open/approved checks
  // entirely (it could only have been minted by a holder of AGGREGATOR_API_KEY). Deliberately
  // before isOpen()/getByAddress() so the operator gets in even with the round closed.
  if (verified.addressHash === OPERATOR_ADDRESS) return { ok: true, addressHash: OPERATOR_ADDRESS }
  if (!testersDb.isOpen()) return { ok: false, reason: 'testing is not open' }
  const row = testersDb.getByAddress(verified.addressHash)
  if (!row || row.status !== 'approved') return { ok: false, reason: 'not an approved tester' }
  return { ok: true, addressHash: verified.addressHash }
}

/** Access check for the functional routes (/otx, /orders).
 *
 *  An open round is open to everyone: no session, no application, any wallet. The session login is
 *  a JoyID passkey signature, so demanding one would shut out MetaMask / OKX / UTXO Global users
 *  who sign every other flow fine.
 *
 *  A closed round falls back to the invite-only path: an approved tester's session, or the
 *  operator's own bypass pass. `admin-testers.mjs close` restores the gated behaviour, with the
 *  whitelist and the 25-slot cap intact.
 *
 *  Custody is unaffected: the contracts enforce it regardless of who reaches this server, so an
 *  open round widens who can use the operator's convenience routes, never who can move someone
 *  else's funds. */
export function requireAccess(req: IncomingMessage, testersDb: TestersDB): SessionCheckResult {
  if (testersDb.isOpen()) return { ok: true }
  return requireTesterSession(req, testersDb)
}
