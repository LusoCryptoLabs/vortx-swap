#!/usr/bin/env node
// Lock-boost testnet deploy: upgrades mining-pool in place (type-id unchanged, so existing positions
// keep resolving and emission-lock needs no re-key) and deploys stake-timelock-guard and vtx-sink-lock
// fresh. Patches TESTNET_SCRIPTS and rebuilds config + sdk. Leaves emission-lock untouched.
//   node scripts/deploy-lockboost-testnet.mjs
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'

const KEY = '.testnet-deployer.key'
const CFG = 'packages/config/src/index.ts'
const ALL_CONTRACTS = [
  { name: 'mining-pool',          field: 'miningPool' },          // in-place upgrade (existing type-id)
  { name: 'stake-timelock-guard', field: 'stakeTimelockGuard' },  // fresh
  { name: 'vtx-sink-lock',        field: 'vtxSink' },             // fresh
]
// Optional argv filter: `node deploy-lockboost-testnet.mjs stake-timelock-guard vtx-sink-lock`
// deploys only the named contracts (so a deployed mining-pool is not upgraded without need).
const only = process.argv.slice(2)
const CONTRACTS = only.length ? ALL_CONTRACTS.filter(c => only.includes(c.name)) : ALL_CONTRACTS
if (!CONTRACTS.length) throw new Error(`no matching contracts for: ${only.join(', ')}`)

if (!existsSync(KEY)) throw new Error(`${KEY} missing`)
const privkey = readFileSync(KEY, 'utf8').trim()
// Scrub the privkey from any string before it can reach a log/console (offckb requires it on argv,
// so it is briefly visible in the process list, but it must never land in captured output).
const scrub = s => String(s).split(privkey).join('<privkey>')

for (const { name, field } of CONTRACTS) {
  const BIN = `build/release/${name}`
  const MIG = `deployed/testnet/testnet/${name}/migrations`
  if (!existsSync(BIN)) throw new Error(`${BIN} missing; run docker-build.sh first`)

  console.log(`[deploy] offckb deploy --type-id ${name} → testnet`)
  try {
    execSync(`offckb deploy --type-id --network testnet --target ${BIN} -o deployed/testnet --privkey ${privkey} -y`, { stdio: 'inherit' })
  } catch (e) {
    throw new Error(scrub(`offckb deploy failed for ${name}: ${e.message}`))
  }

  const files = readdirSync(MIG).filter(f => f.endsWith('.json')).sort()
  if (!files.length) throw new Error(`no migration json in ${MIG}`)
  const recipe = JSON.parse(readFileSync(`${MIG}/${files[files.length - 1]}`, 'utf8')).cell_recipes[0]
  const { type_id: codeHash, tx_hash: txHash, index = 0 } = recipe
  console.log(`    ${field}: code ${codeHash}  tx ${txHash}  idx ${index}`)

  let cfg = readFileSync(CFG, 'utf8')
  const start = cfg.indexOf('const TESTNET_SCRIPTS: DeployedScripts = {')
  const end = cfg.indexOf('\n}', start)
  let block = cfg.slice(start, end)
  const re = new RegExp(`\\b${field}:\\s*\\{[^}]*\\},`)
  if (!re.test(block)) throw new Error(`${field} line not found in TESTNET_SCRIPTS`)
  block = block.replace(re, `${field}: { codeHash: '${codeHash}', hashType: 'type', txHash: '${txHash}', index: ${index} },`)
  writeFileSync(CFG, cfg.slice(0, start) + block + cfg.slice(end))
  console.log(`    config patched (${field})`)
}

console.log('[build] rebuild config + sdk')
execSync('pnpm --filter @cellswap/config --filter @cellswap/sdk build', { stdio: 'inherit' })
console.log('\nlock-boost contracts deployed and config wired.')
