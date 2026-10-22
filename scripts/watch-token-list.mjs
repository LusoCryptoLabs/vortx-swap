#!/usr/bin/env node
// Token-list drift watcher. Re-checks every curated mainnet token in
// apps/frontend/src/lib/tokens.ts against the CKB explorer, catching an rgbpp-sdk
// or issuer code redeploy, a spoof or look-alike, or a wrong config byte before it
// reaches users. Identity is the full xUDT type hash (code_hash + hash_type +
// args), the only safe anti-spoof key (never name/symbol). Flags any drift in
// code_hash / hash_type / args / decimals, and any entry whose type hash no longer
// resolves to a live token.
//
// For RGB++ tokens the paid verified badge does not apply, so the curated list is
// the only anti-spoof check. Run this before any mainnet listing change, and on a
// timer while listed.
//
//   node scripts/watch-token-list.mjs              # check once; exit 1 if any drift
//   node scripts/watch-token-list.mjs --watch 600  # re-check every 600s
import { ccc } from '@ckb-ccc/core'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const API = 'https://mainnet-api.explorer.nervos.org/api/v1/udts/'
const HDRS = { Accept: 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json' }

// Pull a single top-level object literal's fields by brace-matching (handles the
// nested `dep: { ... }`), so we never bleed one entry's code hash into the next.
function extractObjects(s) {
  const out = []; let depth = 0, start = -1
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '{') { if (depth === 0) start = i; depth++ }
    else if (c === '}') { if (depth > 0 && --depth === 0) out.push(s.slice(start, i + 1)) }
  }
  return out
}
const sField = (o, k) => (new RegExp(k + ":\\s*'([^']+)'").exec(o) || [])[1]
const nField = (o, k) => (new RegExp(k + ':\\s*(\\d+)').exec(o) || [])[1]

// Standard mainnet xUDT = the default code hash for entries without an override.
const cfg = readFileSync(join(ROOT, 'packages/config/src/index.ts'), 'utf8')
const stdBlk = cfg.slice(cfg.indexOf('XUDT_MAINNET'))
const STD_CODE = sField(stdBlk, 'codeHash'), STD_HT = sField(stdBlk, 'hashType')

// Curated mainnet token entries.
const toks = readFileSync(join(ROOT, 'apps/frontend/src/lib/tokens.ts'), 'utf8')
const mStart = toks.indexOf('mainnet: [')
const mBlk = toks.slice(mStart, toks.indexOf('\n  ],', mStart))
const entries = extractObjects(mBlk).map(o => ({
  symbol: sField(o, 'symbol'), args: sField(o, 'args'),
  decimals: nField(o, 'decimals'), codeHash: sField(o, 'codeHash'), hashType: sField(o, 'hashType'),
})).filter(e => e.args && e.args.startsWith('0x')) // skip CKB-native (args = CKB constant)

async function check(e) {
  const codeHash = e.codeHash || STD_CODE, hashType = e.hashType || STD_HT
  const typeHash = ccc.Script.from({ codeHash, hashType, args: e.args }).hash()
  let r
  try { r = await fetch(API + typeHash, { headers: HDRS }) } catch (err) { return { e, typeHash, status: 'FETCH-ERR', detail: err.message } }
  if (!r.ok) return { e, typeHash, status: 'NOT-FOUND', detail: `explorer ${r.status} for ${typeHash}` }
  const a = (await r.json())?.data?.attributes
  if (!a) return { e, typeHash, status: 'NOT-FOUND', detail: 'no token at this type hash' }
  const ts = a.type_script || {}, d = []
  if ((ts.code_hash || '').toLowerCase() !== codeHash.toLowerCase()) d.push(`code_hash chain=${ts.code_hash}`)
  if ((ts.hash_type || '') !== hashType) d.push(`hash_type chain=${ts.hash_type} cfg=${hashType}`)
  if ((ts.args || '').toLowerCase() !== e.args.toLowerCase()) d.push(`args chain=${ts.args}`)
  if (String(a.decimal) !== String(e.decimals)) d.push(`decimals chain=${a.decimal} cfg=${e.decimals}`)
  return { e, typeHash, chainSymbol: a.symbol, status: d.length ? 'DRIFT' : 'OK', detail: d.join('; ') }
}

async function runOnce() {
  console.log(`\n[token-watch] ${new Date().toISOString()}  checking ${entries.length} mainnet tokens vs live explorer (std xUDT ${STD_CODE?.slice(0, 12)}.../${STD_HT})`)
  let bad = 0
  for (const e of entries) {
    const r = await check(e)
    if (r.status !== 'OK') bad++
    console.log(`  ${r.status.padEnd(10)} ${(e.symbol || '?').padEnd(7)} chain="${r.chainSymbol ?? '-'}"  ${r.typeHash.slice(0, 18)}...  ${r.detail || ''}`)
    await new Promise(res => setTimeout(res, 150)) // be polite to the public API
  }
  console.log(`[token-watch] ${entries.length - bad}/${entries.length} OK, ${bad} flagged`)
  return bad
}

const wi = process.argv.indexOf('--watch')
if (wi >= 0) {
  const sec = Number(process.argv[wi + 1]) || 600
  console.log(`[token-watch] watch mode: every ${sec}s (Ctrl-C to stop)`)
  for (;;) { await runOnce(); await new Promise(r => setTimeout(r, sec * 1000)) }
} else {
  process.exit((await runOnce()) ? 1 : 0)
}
