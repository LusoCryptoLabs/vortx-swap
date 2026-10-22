#!/usr/bin/env node
// Admin CLI for the gated tester-access whitelist. The whitelist lives in the aggregator's SQLite
// database, so this script talks to the aggregator's HTTP API (through the /agg/ proxy path) rather
// than to the chain or the SDK.
//
// usage:
//   AGGREGATOR_API_KEY=... node scripts/admin-testers.mjs state
//   AGGREGATOR_API_KEY=... node scripts/admin-testers.mjs list [--status=pending|approved|rejected]
//   AGGREGATOR_API_KEY=... node scripts/admin-testers.mjs approve <addressHash>
//   AGGREGATOR_API_KEY=... node scripts/admin-testers.mjs reject <addressHash>
//   AGGREGATOR_API_KEY=... node scripts/admin-testers.mjs open
//   AGGREGATOR_API_KEY=... node scripts/admin-testers.mjs close
//
// AGGREGATOR_ADMIN_URL is required: the aggregator base URL, e.g. https://<host>/agg through the
// frontend's same-origin proxy. Applicant emails returned by `list` are real PII; handle the output
// accordingly.

const ADMIN_URL = process.env.AGGREGATOR_ADMIN_URL
if (!ADMIN_URL) { console.error('Set AGGREGATOR_ADMIN_URL (usage: AGGREGATOR_ADMIN_URL=https://<host>/agg AGGREGATOR_API_KEY=... node scripts/admin-testers.mjs <command>)'); process.exit(1) }
const BASE = ADMIN_URL.replace(/\/$/, '')
const KEY = process.env.AGGREGATOR_API_KEY
if (!KEY) { console.error('Set AGGREGATOR_API_KEY'); process.exit(1) }

const headers = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${json.error ?? 'request failed'}`)
  return json
}

const [, , cmd, arg1] = process.argv
const statusFlag = process.argv.find(a => a.startsWith('--status='))?.split('=')[1]

switch (cmd) {
  case 'state': {
    const s = await call('GET', '/testers/state')
    console.log(`open: ${s.open}`)
    console.log(`applicants: ${s.applicantCount}/${s.cap} (${s.spotsRemaining} spots remaining)`)
    break
  }
  case 'list': {
    const q = statusFlag ? `?status=${encodeURIComponent(statusFlag)}` : ''
    const { testers } = await call('GET', `/testers/list${q}`)
    console.table(testers.map(t => ({
      addressHash: t.addressHash.slice(0, 14) + '…',
      email: t.email,
      status: t.status,
      appliedAt: new Date(t.appliedAt).toISOString(),
    })))
    console.log(`${testers.length} row(s)`)
    break
  }
  case 'approve':
  case 'reject': {
    if (!arg1) { console.error(`usage: node scripts/admin-testers.mjs ${cmd} <addressHash>`); process.exit(1) }
    await call('POST', `/testers/${cmd}`, { addressHash: arg1 })
    console.log(`${cmd === 'approve' ? 'approved' : 'rejected'} ${arg1}`)
    break
  }
  case 'open':
  case 'close': {
    const r = await call('POST', `/testers/${cmd}`)
    console.log(`testing is now ${r.open ? 'OPEN' : 'CLOSED'}`)
    break
  }
  default:
    console.error('usage: node scripts/admin-testers.mjs <state|list|approve|reject|open|close> [addressHash] [--status=pending|approved|rejected]')
    process.exit(1)
}
