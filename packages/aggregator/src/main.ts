// aggregator/src/main.ts: Cobuild OTX aggregator
// Receives OTXs from users (JoyID), assembles settlement transactions,
// entity-script validates custody-free conditions on-chain.

import { ccc }          from '@ckb-ccc/core'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { getConfig, validateScripts } from '@cellswap/config'
import { ChainClient }  from '@cellswap/chain-client'
import { Router }       from '@cellswap/router'
import { Scanner }      from './scanner.js'
import { Builder }      from './builder.js'
import { Submitter }    from './submitter.js'
import { verifyOtxPayload } from './verify-otx.js'
import { applyCors, clientIp, authorized, createSecureServer, logSecurityPosture } from './security.js'
import { refreshSnapshot, poolsSnapshot } from './snapshot.js'
import { StateDB }      from './db.js'
import { TestersDB, type TesterStatus } from './testers.js'
import { verifyTesterWitness } from './verify-tester.js'
import { mintSession, requireAccess, OPERATOR_ADDRESS } from './tester-session.js'
import { CellSwap } from '@cellswap/sdk'
import type { Pool, TxHash }    from '@cellswap/types'
import type { OTXPayload }      from '@cellswap/sdk'

const network = (process.env.NETWORK ?? 'devnet') as 'devnet' | 'testnet' | 'mainnet'
const config  = getConfig(network)

// Validate all contract addresses filled in
try { validateScripts(network) }
catch (e) {
  console.error('[aggregator] FATAL:', (e as Error).message)
  process.exit(1)
}

const SOLVER_PRIVATE_KEY = process.env.SOLVER_PRIVATE_KEY
if (!SOLVER_PRIVATE_KEY) {
  console.error('[aggregator] FATAL: SOLVER_PRIVATE_KEY not set')
  process.exit(1)
}

// On devnet, load offckb's CCC system-script export so the solver's client resolves deps.
let cccScripts: Record<string, unknown> | undefined
if (network === 'devnet' && process.env.CCC_SCRIPTS_JSON) {
  const { readFileSync } = await import('node:fs')
  cccScripts = JSON.parse(readFileSync(process.env.CCC_SCRIPTS_JSON, 'utf8'))
}
const chain   = new ChainClient(config, { cccScripts })
const scanner = new Scanner(chain, config)
// Intent-lifecycle tracking (optional). The OTX settlement path doesn't use it, so if the
// native better-sqlite3 binding isn't built we keep running without lifecycle persistence.
let db: StateDB | null = null
try { db = new StateDB() }
catch (e) { console.warn('[aggregator] StateDB disabled (better-sqlite3 not built):', (e as Error).message.split('\n')[0]) }

// Gated tester access (whitelist + open/closed switch). Unlike StateDB above, this is not
// optional: a gate that silently ran open because its DB failed to open would defeat its purpose,
// so refuse to start rather than fall back to a null/permissive mode.
if (!process.env.TESTER_SESSION_SECRET) {
  console.error('[aggregator] FATAL: TESTER_SESSION_SECRET not set')
  process.exit(1)
}
let testersDb: TestersDB
try { testersDb = new TestersDB() }
catch (e) {
  console.error('[aggregator] FATAL: tester-access DB could not open:', (e as Error).message)
  process.exit(1)
}
const TESTER_CAP = Number(process.env.TESTER_CAP ?? 25)
const RL_MAX_TESTERS_PER_IP = Number(process.env.TESTER_APPLY_MAX_PER_MIN ?? 5)

// Derive solver lock from private key
const solverSigner = new ccc.SignerCkbPrivateKey(chain.raw, SOLVER_PRIVATE_KEY)
let solverLock: import('@cellswap/types').Script | null = null

// ─── Limit / async order relay + fill loop ─────────────────────────────────
// Resting intent-lock orders only auto-fill if a keeper relays the owner's full lock
// script (the intent cell stores only its hash) and settles when the live price reaches
// the limit. The intent-lock validates on-chain that the owner is paid >= minOut, so the
// keeper cannot cheat: it only gains liveness (will it bother to fill), never custody.
// Production: persist this store to Redis/Postgres (in-memory mirrors the OTX queue).
const sdk       = new CellSwap({ network, config })
const sdkSolver = new ccc.SignerCkbPrivateKey(sdk.chain.raw, SOLVER_PRIVATE_KEY)

interface RestingOrder {
  outPoint:  { txHash: string; index: number }
  ownerLock: { codeHash: string; hashType: string; args: string }
  placedAt:  number
}
const orders = new Map<string, RestingOrder>()   // `${txHash}:${index}` → order
const orderKey = (op: { txHash: string; index: number }) => `${op.txHash.toLowerCase()}:${op.index}`

// Bound the resting-order store so forged / never-fillable orders cannot accumulate without
// limit (off-chain keeper-liveness DoS). These are purely liveness caps;
// the keeper still cannot be made to steal. Tunable via env.
const MAX_ORDERS           = Number(process.env.MAX_ORDERS ?? 5000)            // global ceiling
const MAX_ORDERS_PER_OWNER = Number(process.env.MAX_ORDERS_PER_OWNER ?? 50)
const ORDER_TTL_MS         = Number(process.env.ORDER_TTL_MS ?? 86_400_000)    // drop after 24h unfilled
const ownerKey = (ol: { args?: string }) => (ol.args ?? '').toLowerCase()
function ordersForOwner(key: string): number {
  let n = 0
  for (const o of orders.values()) if (ownerKey(o.ownerLock) === key) n++
  return n
}
function evictForRoom(): void {
  while (orders.size >= MAX_ORDERS) {
    let oldestId: string | null = null, oldest = Infinity
    for (const [id, o] of orders) if (o.placedAt < oldest) { oldest = o.placedAt; oldestId = id }
    if (oldestId == null) break
    orders.delete(oldestId)
  }
}

// Persist the order store to a JSON file (no native deps) so resting orders survive a restart.
// Production can swap this for Redis/Postgres; the file path is `ORDER_STORE` (default below).
const ORDER_STORE = process.env.ORDER_STORE ?? `.orders-${network}.json`
function saveOrders(): void {
  try { writeFileSync(ORDER_STORE, JSON.stringify([...orders.values()])) }
  catch (e) { console.warn('[limit] could not persist orders:', (e as Error).message) }
}
function loadOrders(): void {
  if (!existsSync(ORDER_STORE)) return
  try {
    const arr = JSON.parse(readFileSync(ORDER_STORE, 'utf8'))
    for (const o of Array.isArray(arr) ? arr : []) if (validOrder(o)) orders.set(orderKey(o.outPoint), o)
    if (orders.size) console.log(`[limit] restored ${orders.size} resting order(s) from ${ORDER_STORE}`)
  } catch (e) { console.warn('[limit] could not load orders:', (e as Error).message) }
}

const isHex = (s: unknown, bytes: number) => typeof s === 'string' && /^0x[0-9a-fA-F]*$/.test(s) && (s.length - 2) === bytes * 2
function validOrder(o: any): o is RestingOrder {
  return o && o.outPoint && isHex(o.outPoint.txHash, 32) && Number.isInteger(o.outPoint.index) && o.outPoint.index >= 0
    && o.ownerLock && isHex(o.ownerLock.codeHash, 32)
    && (o.ownerLock.hashType === 'type' || o.ownerLock.hashType === 'data' || o.ownerLock.hashType === 'data1' || o.ownerLock.hashType === 'data2')
    && typeof o.ownerLock.args === 'string' && /^0x[0-9a-fA-F]*$/.test(o.ownerLock.args)
}

// Settle resting orders whose live price now reaches their limit. One successful fill per
// tick (a fill mutates pool cells; re-scan next tick on fresh state). NOT_FILLABLE orders
// simply rest; gone orders (settled elsewhere / cancelled) are dropped.
async function fillOrders(): Promise<void> {
  if (orders.size === 0) return
  // Drop orders that have rested past their TTL so forged / never-fillable orders can't linger forever.
  const nowTs = Date.now()
  let pruned = false
  for (const [id, o] of [...orders]) if (nowTs - o.placedAt > ORDER_TTL_MS) { orders.delete(id); pruned = true }
  if (pruned) saveOrders()
  for (const [id, o] of [...orders]) {
    try {
      const ownerLock = ccc.Script.from(o.ownerLock as any)
      const { txHash, amountOut } = await sdk.settleIntent(sdkSolver, o.outPoint as any, ownerLock)
      orders.delete(id); saveOrders()
      submitter.recordSettlement(1)
      console.log(`[limit] filled ${id.slice(0, 14)}… → ${txHash} (out=${amountOut})`)
      return   // pool state changed; let the next tick re-scan
    } catch (e) {
      const msg = (e as Error).message
      if (msg === 'NOT_FILLABLE') continue                       // resting; price not reached yet
      // Also drop orders that fail with a permanent settle error (forged owner lock, malformed
      // intent args, not a token order, no routable path). They can never fill, so resting them just
      // grows the store and burns one live RPC per tick. Only NOT_FILLABLE / transient errors rest.
      if (/not live|already settled|cancelled|gone|expired|does not match|malformed|no xudt|no direct or routed path/i.test(msg)) {
        orders.delete(id); saveOrders(); console.log(`[limit] dropped ${id.slice(0, 14)}… (${msg})`)
      } else {
        console.warn(`[limit] fill error ${id.slice(0, 14)}…: ${msg}`)
      }
    }
  }
}

const submitter = new Submitter(chain)
submitter.startHealthServer(Number(process.env.HEALTH_PORT ?? '3001'))

// ─── In-memory OTX queue ──────────────────────────────────────────────────
// Production: persist to Redis or PostgreSQL

const otxQueue: OTXPayload[] = []
// Hard cap so a flood of valid-signature OTXs can't grow the in-memory queue without bound
// (the per-IP/per-pubkey windows slow growth but don't bound it). Tune via env.
const MAX_QUEUE = Number(process.env.MAX_OTX_QUEUE ?? 5000)

// ─── Rate limiter ──────────────────────────────────────────────────────────
// Sliding-window limit per key (IP and pubkey). Rejects floods with HTTP 429.
const RL_WINDOW_MS  = 60_000
const RL_MAX_PER_IP = 30   // submissions / minute / IP
const RL_MAX_PER_PK = 10   // submissions / minute / pubkey
const MAX_BODY_BYTES = 16_384  // reject oversized payloads early

const rlHits = new Map<string, number[]>()
const MAX_RL_KEYS = Number(process.env.MAX_RL_KEYS ?? 50_000)  // cap limiter key cardinality (DoS backstop)

function rateLimited(key: string, max: number): boolean {
  const now = Date.now()
  // If the key space has grown large (e.g. a flood of distinct keys within a window), sweep expired
  // entries eagerly so memory stays bounded between the periodic sweeps below.
  if (rlHits.size > MAX_RL_KEYS) {
    for (const [k, ts] of rlHits) {
      const live = ts.filter(t => now - t < RL_WINDOW_MS)
      if (live.length === 0) rlHits.delete(k); else rlHits.set(k, live)
    }
  }
  const hits = (rlHits.get(key) ?? []).filter(t => now - t < RL_WINDOW_MS)
  if (hits.length >= max) { rlHits.set(key, hits); return true }
  hits.push(now)
  rlHits.set(key, hits)
  return false
}

// Periodically drop stale entries so the map can't grow unbounded
setInterval(() => {
  const now = Date.now()
  for (const [k, ts] of rlHits) {
    const live = ts.filter(t => now - t < RL_WINDOW_MS)
    if (live.length === 0) rlHits.delete(k); else rlHits.set(k, live)
  }
}, RL_WINDOW_MS).unref?.()

// ─── OTX submission endpoint ──────────────────────────────────────────────
// Users POST their signed OTX payloads here. Rate-limited + signature-verified.

const { server: otxServer, tls: otxTls } = createSecureServer(async (req, res) => {
  // CORS: the browser frontend (a different origin/port) POSTs OTX payloads + relays orders here.
  // Permissive by default for dev; set CORS_ORIGIN to an allowlist to lock it down (see security.ts).
  applyCors(req, res)
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  // ─── Gated tester access ────────────────────────────────────────────────────
  // Closed by default until the operator opens it. Applying (proves passkey control + an email)
  // does not itself grant access; only an admin approve plus the app being open does. See
  // testers.ts / verify-tester.ts / tester-session.ts. This gate covers the site UI and these
  // aggregator convenience routes; it does not and cannot restrict raw on-chain contract calls.

  if (req.method === 'GET' && req.url === '/testers/state') {
    const ip = clientIp(req)
    if (rateLimited(`ip:${ip}`, RL_MAX_PER_IP)) {
      res.writeHead(429, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'rate limit exceeded (ip)' })); return
    }
    const applicantCount = testersDb.count()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      open: testersDb.isOpen(), applicantCount, cap: TESTER_CAP,
      spotsRemaining: Math.max(0, TESTER_CAP - applicantCount),
    }))
    return
  }

  if (req.method === 'POST' && req.url === '/testers/apply') {
    const ip = clientIp(req)
    if (rateLimited(`ip:${ip}`, RL_MAX_PER_IP) || rateLimited(`tester-apply-ip:${ip}`, RL_MAX_TESTERS_PER_IP)) {
      res.writeHead(429, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'rate limit exceeded' })); return
    }
    let body = ''; let aborted = false
    req.on('data', (chunk: any) => {
      body += chunk
      if (body.length > MAX_BODY_BYTES && !aborted) {
        aborted = true
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'payload too large' })); req.destroy()
      }
    })
    req.on('end', async () => {
      if (aborted) return
      try {
        const parsed = JSON.parse(body)
        const email = typeof parsed.email === 'string' ? parsed.email.trim().toLowerCase() : ''
        const timestampMs = Number(parsed.timestampMs)
        const witness = typeof parsed.witness === 'string' ? parsed.witness : ''
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid email' })); return
        }
        if (!Number.isFinite(timestampMs) || !witness.startsWith('0x')) {
          res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid apply payload' })); return
        }
        const result = await verifyTesterWitness(witness, { kind: 'apply', email, timestampMs: BigInt(Math.trunc(timestampMs)) })
        if (!result.ok || !result.addressHash || !result.pubkeyHex) {
          res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: result.reason ?? 'signature invalid' })); return
        }
        if (rateLimited(`pk:${result.addressHash}`, RL_MAX_PER_PK)) {
          res.writeHead(429, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'rate limit exceeded (pubkey)' })); return
        }
        const existing = testersDb.getByAddress(result.addressHash)
        if (!existing && testersDb.count() >= TESTER_CAP) {
          res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'applications closed - cap reached' })); return
        }
        const row = testersDb.apply(result.addressHash, result.pubkeyHex, email)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, status: row.status }))
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid apply payload' }))
      }
    })
    return
  }

  if (req.method === 'POST' && req.url === '/testers/login') {
    const ip = clientIp(req)
    if (rateLimited(`ip:${ip}`, RL_MAX_PER_IP)) {
      res.writeHead(429, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'rate limit exceeded (ip)' })); return
    }
    let body = ''; let aborted = false
    req.on('data', (chunk: any) => {
      body += chunk
      if (body.length > MAX_BODY_BYTES && !aborted) {
        aborted = true
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'payload too large' })); req.destroy()
      }
    })
    req.on('end', async () => {
      if (aborted) return
      try {
        const parsed = JSON.parse(body)
        const timestampMs = Number(parsed.timestampMs)
        const witness = typeof parsed.witness === 'string' ? parsed.witness : ''
        if (!Number.isFinite(timestampMs) || !witness.startsWith('0x')) {
          res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid login payload' })); return
        }
        const result = await verifyTesterWitness(witness, { kind: 'login', timestampMs: BigInt(Math.trunc(timestampMs)) })
        if (!result.ok || !result.addressHash) {
          res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: result.reason ?? 'signature invalid' })); return
        }
        if (rateLimited(`pk:${result.addressHash}`, RL_MAX_PER_PK)) {
          res.writeHead(429, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'rate limit exceeded (pubkey)' })); return
        }
        const row = testersDb.getByAddress(result.addressHash)
        const open = testersDb.isOpen()
        const payload: { status: string; open: boolean; token?: string; expiresAt?: number } = {
          status: row?.status ?? 'unregistered', open,
        }
        if (row?.status === 'approved' && open) {
          const session = mintSession(result.addressHash)
          payload.token = session.token
          payload.expiresAt = session.expiresAt
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(payload))
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid login payload' }))
      }
    })
    return
  }

  // Admin: same AGGREGATOR_API_KEY gate as /queue. This also protects applicant emails (real PII)
  // and the open/close switch, not just operational telemetry; treat the key accordingly (rotate
  // if ever suspected exposed).
  if (req.method === 'GET' && (req.url === '/testers/list' || req.url?.startsWith('/testers/list?'))) {
    if (!authorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' })); return
    }
    const u = new URL(req.url, 'http://internal')
    const statusParam = u.searchParams.get('status')
    const status = statusParam && statusParam !== 'all' ? (statusParam as TesterStatus) : undefined
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ testers: testersDb.list(status) }))
    return
  }

  if (req.method === 'POST' && (req.url === '/testers/approve' || req.url === '/testers/reject')) {
    if (!authorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' })); return
    }
    let body = ''; let aborted = false
    req.on('data', (chunk: any) => {
      body += chunk
      if (body.length > MAX_BODY_BYTES && !aborted) {
        aborted = true
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'payload too large' })); req.destroy()
      }
    })
    req.on('end', () => {
      if (aborted) return
      try {
        const { addressHash } = JSON.parse(body)
        if (typeof addressHash !== 'string' || !addressHash) {
          res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'addressHash required' })); return
        }
        const changed = req.url === '/testers/approve' ? testersDb.approve(addressHash) : testersDb.reject(addressHash)
        if (!changed) {
          res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'no such applicant' })); return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid JSON' }))
      }
    })
    return
  }

  if (req.method === 'POST' && (req.url === '/testers/open' || req.url === '/testers/close')) {
    if (!authorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' })); return
    }
    testersDb.setOpen(req.url === '/testers/open')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, open: testersDb.isOpen() }))
    return
  }

  // Operator bypass pass: mint a session bound to the reserved operator identity, which
  // requireTesterSession honors without the open/approved checks (see tester-session.ts). With the
  // round open this is redundant (everyone is in), but it lets the operator into the full app while
  // the round is closed, using no tester slot. Same AGGREGATOR_API_KEY gate as the other admin
  // routes.
  if (req.method === 'POST' && req.url === '/testers/admin-session') {
    if (!authorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' })); return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(mintSession(OPERATOR_ADDRESS)))
    return
  }

  if (req.method === 'POST' && req.url === '/otx') {
    const ip = clientIp(req)
    if (rateLimited(`ip:${ip}`, RL_MAX_PER_IP)) {
      res.writeHead(429, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'rate limit exceeded (ip)' }))
      return
    }
    const session = requireAccess(req, testersDb)
    if (!session.ok) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'testing is currently closed' }))
      return
    }
    let body = ''
    let aborted = false
    req.on('data', chunk => {
      body += chunk
      if (body.length > MAX_BODY_BYTES && !aborted) {
        aborted = true
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'payload too large' }))
        req.destroy()
      }
    })
    req.on('end', async () => {
      if (aborted) return
      try {
        const payload: OTXPayload = JSON.parse(body, (k, v) =>
          // revive bigint fields encoded as strings
          (k === 'amountIn' || k === 'minAmountOut') && typeof v === 'string' ? BigInt(v) : v)

        // Validate the rate-limit key shape before using it as a map key, so malformed / rapidly
        // rotated lockArgs can't inflate the limiter's key cardinality (memory-DoS). verify-otx
        // re-checks this too; rejecting here also short-circuits obvious garbage. Lower-cased so
        // case variants of one key collapse into a single bucket.
        const lockArgs = typeof payload.lockArgs === 'string' ? payload.lockArgs.toLowerCase() : ''
        if (!/^0x[0-9a-f]{66}$/.test(lockArgs)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'malformed lockArgs' }))
          return
        }
        // Per-pubkey rate limit: one key can't flood the queue
        if (rateLimited(`pk:${lockArgs}`, RL_MAX_PER_PK)) {
          res.writeHead(429, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'rate limit exceeded (pubkey)' }))
          return
        }

        const result = await verifyOtxPayload(payload)
        if (!result.ok) {
          console.warn(`[otx] rejected: ${result.reason}`)
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: result.reason }))
          return
        }
        if (otxQueue.length >= MAX_QUEUE) {
          res.writeHead(503, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'settlement queue full, retry shortly' }))
          return
        }
        otxQueue.push(payload)
        console.log(`[otx] accepted from ${payload.ownerLockHash.slice(0, 10)}... queue=${otxQueue.length}`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, queueDepth: otxQueue.length }))
      } catch (e) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'Invalid OTX payload' }))
      }
    })
    return
  }

  if (req.url === '/queue') {
    // Operational telemetry: GET-only, and gated behind the API key (when one is configured) so the
    // live settlement-queue depth isn't world-readable. Matches the GET /orders gating.
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'method not allowed' })); return
    }
    if (!authorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' })); return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ depth: otxQueue.length }))
    return
  }

  // ─── Pool snapshot (read-only display accelerator) ─────────────────────────
  // Pre-aggregated pool list so the frontend paints instantly instead of reconstructing it from
  // raw cells. Advisory: the client uses it for display only; quotes and swaps build from live
  // chain state, so a stale/absent snapshot is harmless (the client falls back on-chain).
  if (req.method === 'GET' && req.url === '/pools') {
    const snap = poolsSnapshot()
    if (!snap) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'snapshot not ready' })); return
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(snap.json)
    return
  }

  // ─── Limit/async order relay ───────────────────────────────────────────────
  // The UI POSTs a placed resting order here with the owner's full lock script so the
  // fill loop can build the payout output (the on-chain cell only stores the hash).
  if (req.method === 'POST' && req.url === '/orders') {
    const ip = clientIp(req)
    if (rateLimited(`ip:${ip}`, RL_MAX_PER_IP)) {
      res.writeHead(429, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'rate limit exceeded (ip)' })); return
    }
    const session = requireAccess(req, testersDb)
    if (!session.ok) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'testing is currently closed' })); return
    }
    let body = ''; let aborted = false
    req.on('data', (chunk: any) => {
      body += chunk
      if (body.length > MAX_BODY_BYTES && !aborted) {
        aborted = true
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'payload too large' })); req.destroy()
      }
    })
    req.on('end', () => {
      if (aborted) return
      try {
        const o = JSON.parse(body)
        if (!validOrder(o)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid order' })); return
        }
        const key = orderKey(o.outPoint)
        if (!orders.has(key)) {
          // Bound the store: per-owner cap plus global oldest-first eviction so forged orders can't flood it.
          if (ordersForOwner(ownerKey(o.ownerLock)) >= MAX_ORDERS_PER_OWNER) {
            res.writeHead(429, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'too many resting orders for this owner' })); return
          }
          evictForRoom()
        }
        orders.set(key, { outPoint: o.outPoint, ownerLock: o.ownerLock, placedAt: Date.now() }); saveOrders()
        console.log(`[limit] order relayed ${key.slice(0, 14)}… resting=${orders.size}`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, resting: orders.size }))
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid JSON' }))
      }
    })
    return
  }

  if (req.method === 'GET' && req.url === '/orders') {
    // Enumerating every resting order's outpoint is a privacy leak, so the detailed listing
    // requires the API key when one is configured; otherwise only the aggregate count is public.
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (authorized(req)) {
      res.end(JSON.stringify({ resting: orders.size, orders: [...orders.values()].map(o => ({ outPoint: o.outPoint, placedAt: o.placedAt })) }))
    } else {
      res.end(JSON.stringify({ resting: orders.size }))
    }
    return
  }

  res.writeHead(404); res.end()
})

loadOrders()   // restore any resting orders persisted before a restart

logSecurityPosture('aggregator')
otxServer.listen(Number(process.env.OTX_PORT ?? '3002'), () => {
  console.log(`[otx] server on :${process.env.OTX_PORT ?? '3002'} (${otxTls ? 'https' : 'http'})`)
})

// ─── Pool snapshot refresh loop ────────────────────────────────────────────
// Warm the display cache now, then refresh on a short interval so GET /pools is always cheap.
const SNAPSHOT_MS = Number(process.env.SNAPSHOT_MS ?? '10000')
let lastSnapCount = -1
const warmSnapshot = () => refreshSnapshot(sdk)
  .then(() => { const s = poolsSnapshot(); if (s && s.count !== lastSnapCount) { lastSnapCount = s.count; console.log(`[snapshot] ${s.count} pools cached`) } })
  .catch(e => console.warn('[snapshot] refresh failed:', (e as Error).message))
warmSnapshot()
setInterval(warmSnapshot, SNAPSHOT_MS).unref?.()

// ─── Settlement loop ──────────────────────────────────────────────────────

let running = true
process.on('SIGTERM', () => { running = false })
process.on('SIGINT',  () => { running = false })

async function tick(): Promise<void> {
  if (!solverLock || otxQueue.length === 0) {
    submitter.updateMetrics(otxQueue.length, 0)
    return
  }

  const pools = await scanner.scanPools()
  if (!pools.length) return

  const router  = new Router(pools)
  const builder = new Builder(chain, config, solverLock)

  // Group OTXs by token pair → find matching pool
  const batches = groupByPool(otxQueue, pools)

  for (const [pool, batch] of batches) {
    try {
      const txHash = await builder.buildAndSubmitOtx(batch, pool, solverSigner)
      submitter.recordSettlement(batch.length)
      console.log(`[aggregator] settled ${batch.length} OTX(s) → ${txHash}`)
      // Remove settled OTXs from queue
      for (const otx of batch) {
        const idx = otxQueue.indexOf(otx)
        if (idx >= 0) otxQueue.splice(idx, 1)
      }
    } catch (e) {
      submitter.recordError()
      console.warn('[aggregator] settlement failed:', (e as Error).message)
    }
  }

  submitter.updateMetrics(otxQueue.length, 0)
}

function groupByPool(otxs: OTXPayload[], pools: Pool[]): Map<Pool, OTXPayload[]> {
  const map = new Map<Pool, OTXPayload[]>()
  // Prevent cross-count: within one settlement batch, no two intents may
  // share the same (ownerLockHash, tokenOut), otherwise one user's output could
  // satisfy another identical intent. Deferred duplicates wait for the next tick.
  const seen = new Set<string>()
  for (const otx of otxs) {
    const pool = pools.find(p =>
      !p.paused && (
        (p.tokenX === otx.tokenIn  && p.tokenY === otx.tokenOut) ||
        (p.tokenY === otx.tokenIn  && p.tokenX === otx.tokenOut)
      )
    )
    if (!pool) continue
    const key = `${otx.ownerLockHash}:${otx.tokenOut}`
    if (seen.has(key)) continue   // duplicate (owner, tokenOut); settle in a later batch
    seen.add(key)
    const batch = map.get(pool) ?? []
    batch.push(otx)
    map.set(pool, batch)
  }
  return map
}

// ─── Start ────────────────────────────────────────────────────────────────

;(async () => {
  console.log(`[aggregator] starting on ${network}`)

  try {
    const addr = await solverSigner.getRecommendedAddressObj()
    solverLock = {
      codeHash: addr.script.codeHash as `0x${string}`,
      hashType: addr.script.hashType as 'type',
      args:     addr.script.args as `0x${string}`,
    }
    console.log(`[aggregator] solver address: ${addr.toString()}`)
  } catch (e) {
    console.error('[aggregator] failed to derive solver lock:', e)
    process.exit(1)
  }

  while (running) {
    await tick().catch(e => console.error('[tick]', (e as Error).message))
    await fillOrders().catch(e => console.error('[limit]', (e as Error).message))
    await new Promise<void>(r => setTimeout(r, 2_000))
  }

  submitter.stopHealthServer()
  otxServer.close()
  db?.close()
  testersDb.close()
  console.log('[aggregator] stopped')
})()
