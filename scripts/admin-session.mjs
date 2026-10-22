#!/usr/bin/env node
// Mint an operator bypass pass and print a browser-console snippet that stores it in the site's
// localStorage. The pass gives the full app even while the tester round is closed, and does not use
// a tester slot. It is an ordinary HMAC session token (see packages/aggregator/src/tester-session.ts)
// bound to the reserved '__operator__' identity, which requireTesterSession accepts without the
// open/approved checks. Only a holder of AGGREGATOR_API_KEY can mint one.
//
// usage:
//   AGGREGATOR_ADMIN_URL=https://<host>/agg AGGREGATOR_API_KEY=... node scripts/admin-session.mjs
//   AGGREGATOR_ADMIN_URL is the aggregator base URL, e.g. the frontend's /agg proxy.

const ADMIN_URL = process.env.AGGREGATOR_ADMIN_URL
if (!ADMIN_URL) { console.error('Set AGGREGATOR_ADMIN_URL (usage: AGGREGATOR_ADMIN_URL=https://<host>/agg AGGREGATOR_API_KEY=... node scripts/admin-session.mjs)'); process.exit(1) }
const BASE = ADMIN_URL.replace(/\/$/, '')
const KEY = process.env.AGGREGATOR_API_KEY
if (!KEY) { console.error('Set AGGREGATOR_API_KEY'); process.exit(1) }

const res = await fetch(`${BASE}/testers/admin-session`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
})
const json = await res.json().catch(() => ({}))
if (!res.ok) { console.error(`admin-session -> ${res.status}: ${json.error ?? 'request failed'}`); process.exit(1) }

const origin = BASE.replace(/\/agg$/, '')
const snippet = `localStorage.setItem('cs:testerSession', JSON.stringify({token:${JSON.stringify(json.token)},expiresAt:${json.expiresAt}}));location.reload()`

console.log(`Operator pass minted. Expires ${new Date(json.expiresAt).toISOString()} (14 days).`)
console.log(`\n1. Open ${origin} in your browser.`)
console.log('2. Open the devtools console (F12 -> Console) and paste this, then Enter:\n')
console.log(snippet)
console.log('\n3. The full app loads and stays yours until the pass expires, open or closed. Run this again to refresh it.')
