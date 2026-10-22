#!/usr/bin/env node
// Buy-back-and-burn keeper loop. Runs scripts/buyback-keeper-testnet.mjs once every
// VTX_KEEPER_INTERVAL_EPOCHS chain epochs (default 6, about 1 day at ~4h/epoch). Each cycle is a
// fresh child process, so a failed or slow cycle is logged and the loop retries at the next interval
// instead of hanging. The child inherits the keeper env vars (VTX_TEAM_CKB_BPS, VTX_TEAM_VEST_BPS,
// VTX_TEAM_CKB_ADDR, VTX_FEE_BUDGET_CKB, VTX_TEAM_LOCK, VTX_VEST_EPOCHS). Run from the repo root;
// stop with Ctrl-C (the signal reaches the running cycle through the inherited stdio).
//
// This is off-chain keeper policy for testnet. On mainnet, run the keeper from a supervised cron or
// systemd timer, and enforce the team cap and minimum burn on-chain.
//   node scripts/buyback-keeper-loop.mjs
import { ccc } from '@ckb-ccc/core'
import { getConfig } from '@cellswap/config'
import { spawn } from 'node:child_process'

const INTERVAL = BigInt(Math.max(1, Math.round(Number(process.env.VTX_KEEPER_INTERVAL_EPOCHS ?? 6))))
const POLL_MS = Math.max(30_000, Number(process.env.VTX_KEEPER_POLL_MS ?? 120_000))
const KEEPER = 'scripts/buyback-keeper-testnet.mjs'
const client = new ccc.ClientPublicTestnet({ url: getConfig('testnet').rpcUrl })

const tipEpoch = async () => BigInt((await client.getTipHeader()).epoch[0])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const runCycle = () => new Promise((resolve) => {
  const child = spawn(process.execPath, [KEEPER], { stdio: 'inherit', env: process.env })
  child.on('exit', (code) => resolve(code ?? 0))
  child.on('error', (e) => { console.error('   spawn error:', e.message); resolve(-1) })
})

console.log(`buy-back keeper loop: one cycle every ${INTERVAL} epoch(s); polling tip every ${POLL_MS / 1000}s. Ctrl-C to stop.`)
let last = -1n
for (;;) {
  let epoch
  try { epoch = await tipEpoch() }
  catch (e) { console.error('   tip fetch failed:', e.message, '(retrying)'); await sleep(POLL_MS); continue }

  if (last < 0n || epoch >= last + INTERVAL) {
    console.log(`\n════════ buy-back cycle @ epoch ${epoch} ════════`)
    const code = await runCycle()
    console.log(code === 0 ? `cycle ok @ epoch ${epoch}` : `warning: cycle exited ${code} @ epoch ${epoch}, retrying next interval`)
    last = epoch
    console.log(`   next cycle at epoch ≥ ${last + INTERVAL}`)
  }
  await sleep(POLL_MS)
}
