// packages/aggregator/src/security.ts
//
// Deployment-hardening helpers for the aggregator's HTTP servers. Everything here is opt-in via
// environment variables so local dev keeps working with permissive defaults, while a production
// deploy can lock CORS, require an API key on privileged reads, sit behind a TLS-terminating proxy
// (or serve TLS natively), and rate-limit on the real client IP.
//
//   CORS_ORIGIN         comma-separated allowlist of origins ("*" or unset = permissive + warning)
//   TRUST_PROXY         "1"/"true" → derive the client IP from X-Forwarded-For (TLS proxy in front)
//   AGGREGATOR_API_KEY  if set, `authorized()` requires it (Bearer <key> or X-API-Key: <key>)
//   TLS_CERT_PATH +     if both set, the server listens over HTTPS natively (no proxy needed);
//   TLS_KEY_PATH        otherwise plain HTTP; terminate TLS at a reverse proxy.

import type { IncomingMessage, ServerResponse } from 'http'
import { createServer as createHttp } from 'http'
import { createServer as createHttps } from 'https'
import { readFileSync } from 'fs'
import { timingSafeEqual } from 'crypto'

type Handler = (req: IncomingMessage, res: ServerResponse) => void

const corsList = (): string[] =>
  (process.env.CORS_ORIGIN ?? '*').split(',').map(s => s.trim()).filter(Boolean)

/** Apply CORS headers from an explicit allowlist. With a list set, only an allowlisted Origin is
 *  echoed back (others get no ACAO header → the browser blocks the cross-origin read). */
export function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const allow = corsList()
  res.setHeader('Vary', 'Origin')
  if (allow.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*')
  } else {
    const origin = req.headers.origin
    if (origin && allow.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin)
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key')
}

/** Proxy-aware client IP. Behind reverse proxies set TRUST_PROXY=1 so the rate limiter keys on the
 *  real client instead of one proxy's single address; otherwise every user collapses into one
 *  bucket and the per-IP limit is meaningless. Also set TRUST_PROXY_HOPS to how many reverse-proxy
 *  hops sit in front (default 1).
 *
 *  Each hop appends its own view of the caller's address to whatever X-Forwarded-For it received
 *  (nginx's $proxy_add_x_forwarded_for does this), so the chain grows left-to-right as it passes
 *  through more trusted hops. The real client is the entry the first trusted hop appended: `hops`
 *  positions in counting from the right, never the leftmost entry. The leftmost entry is whatever
 *  the caller put there and is attacker-controlled (spoofed by sending a fake X-Forwarded-For
 *  header), so taking [0] would let anyone reset their own rate-limit bucket on demand. With the
 *  default hops=1 this is "take the last entry", the standard reading for a single
 *  $proxy_add_x_forwarded_for hop. A deployment behind two such hops (host nginx, then the frontend
 *  container's own nginx) runs with TRUST_PROXY_HOPS=2. */
export function clientIp(req: IncomingMessage): string {
  if (/^(1|true|yes)$/i.test(process.env.TRUST_PROXY ?? '')) {
    const xff = req.headers['x-forwarded-for']
    const first = Array.isArray(xff) ? xff[0] : xff
    if (first) {
      const chain = first.split(',').map(s => s.trim()).filter(Boolean)
      const hops = Math.max(1, Number(process.env.TRUST_PROXY_HOPS ?? 1))
      const idx = chain.length - hops
      if (idx >= 0 && chain[idx]) return chain[idx]!
    }
  }
  return req.socket.remoteAddress ?? 'unknown'
}

/** Whether an API-key gate is configured at all. */
export const apiKeyConfigured = (): boolean => !!process.env.AGGREGATOR_API_KEY

/** True if no key is configured (open), or the request presents the configured key. */
export function authorized(req: IncomingMessage): boolean {
  const key = process.env.AGGREGATOR_API_KEY
  if (!key) return true
  const auth = req.headers['authorization']
  const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined
  const apiKey = req.headers['x-api-key']
  const presented = bearer ?? (typeof apiKey === 'string' ? apiKey : undefined)
  if (presented === undefined) return false
  const a = Buffer.from(presented), b = Buffer.from(key)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Create an HTTP server, or an HTTPS one if TLS_CERT_PATH + TLS_KEY_PATH are both set. */
export function createSecureServer(handler: Handler): { server: ReturnType<typeof createHttp>; tls: boolean } {
  const cert = process.env.TLS_CERT_PATH, key = process.env.TLS_KEY_PATH
  if (cert && key) {
    return { server: createHttps({ cert: readFileSync(cert), key: readFileSync(key) }, handler), tls: true }
  }
  return { server: createHttp(handler), tls: false }
}

/** One-time startup warning so an operator notices insecure defaults. */
export function logSecurityPosture(label: string): void {
  const warns: string[] = []
  if (corsList().includes('*')) warns.push('CORS=* (set CORS_ORIGIN to your frontend origin)')
  if (!process.env.TLS_CERT_PATH || !process.env.TLS_KEY_PATH)
    warns.push('no native TLS (terminate at a proxy or set TLS_CERT_PATH/TLS_KEY_PATH)')
  if (!process.env.AGGREGATOR_API_KEY) warns.push('no API key (privileged reads open)')
  if (warns.length) console.warn(`[${label}] INSECURE DEFAULTS: ${warns.join('; ')}`)
}
