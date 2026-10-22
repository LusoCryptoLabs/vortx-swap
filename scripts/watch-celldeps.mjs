#!/usr/bin/env node
// cellDep liveness watcher.
//
// Every entry in a network's TESTNET_SCRIPTS / MAINNET_SCRIPTS is a cellDep: a (txHash, index)
// pointing at an on-chain code cell. If that cell is consumed (an in-place upgrade, or an offckb
// deploy that swept a deployer-locked code cell as funding), the dep goes dead and every tx that
// attaches it fails to resolve. Nothing else watches for this, so a dead dep stays silent until a
// swap, liquidity or settlement tx fails.
//
// This probe asks the node `get_live_cell` for each configured dep and reports LIVE or DEAD.
//
// Usage:
//   node scripts/watch-celldeps.mjs [network] [intervalSeconds]
//     network        : testnet (default) | mainnet | devnet
//     intervalSeconds : omit for a one-shot run (exit 1 if any dep is dead, 0 otherwise);
//                       pass a number to loop and log a line each round.
//
// Examples:
//   node scripts/watch-celldeps.mjs                 # one-shot testnet check (good for CI / pre-deploy)
//   node scripts/watch-celldeps.mjs testnet 300     # poll testnet every 5 minutes
import { getConfig } from '@cellswap/config'

const network = process.argv[2] || process.env.NETWORK || 'testnet'
const intervalS = Number(process.argv[3] || 0)
const cfg = getConfig(network)
const RPC = cfg.rpcUrl || (network === 'mainnet' ? 'https://mainnet.ckb.dev/' : 'https://testnet.ckb.dev/')

async function isLive(txHash, index) {
  const body = {
    id: 1, jsonrpc: '2.0', method: 'get_live_cell',
    params: [{ tx_hash: txHash, index: '0x' + Number(index).toString(16) }, false],
  }
  const res = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const json = await res.json()
  if (json.error) throw new Error(json.error.message || 'rpc error')
  return json.result && json.result.status === 'live'
}

async function checkOnce() {
  const entries = Object.entries(cfg.scripts).filter(([, s]) => s && s.txHash && !/^0x0+$/.test(s.txHash))
  let dead = 0
  for (const [name, s] of entries) {
    let live = false, note = ''
    try { live = await isLive(s.txHash, s.index || 0) }
    catch (e) { note = '  (rpc: ' + e.message + ')' }
    if (!live) dead++
    console.log(`  ${live ? 'LIVE' : 'DEAD'}  ${name.padEnd(16)} ${s.txHash.slice(0, 14)}:${s.index || 0}  ${s.hashType}${note}`)
  }
  const stamp = new Date().toISOString()
  console.log(`[${stamp}] ${network}: ${entries.length - dead}/${entries.length} cellDeps live${dead ? `  >> ${dead} DEAD <<` : ''}`)
  return dead
}

if (intervalS > 0) {
  console.log(`watching ${network} cellDeps via ${RPC} every ${intervalS}s (Ctrl-C to stop)`)
  // eslint-disable-next-line no-constant-condition
  for (;;) {
    try { await checkOnce() } catch (e) { console.error('check failed:', e.message) }
    await new Promise(r => setTimeout(r, intervalS * 1000))
  }
} else {
  const dead = await checkOnce()
  process.exit(dead ? 1 : 0)
}
