#!/usr/bin/env node
// Incremental testnet deploy for the LP time-lock contract: deploys only timelock-lock via Type ID,
// patches the single `timelockLock` line in TESTNET_SCRIPTS, and rebuilds config + sdk. After this,
// sdk.timelockEnabled() returns true and the frontend "Lock liquidity" toggle appears.
//
//   node scripts/deploy-timelock-testnet.mjs
//
// Prereqs: build/release/timelock-lock exists (run docker-build.sh first), offckb installed,
// and .testnet-deployer.key present (funded). Then check it with verify-timelock-testnet.mjs.
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'

const BIN = 'build/release/timelock-lock'
const KEY = '.testnet-deployer.key'
const CFG = 'packages/config/src/index.ts'
const MIG = 'deployed/testnet/testnet/timelock-lock/migrations'

if (!existsSync(BIN)) throw new Error(`${BIN} missing; run docker-build.sh first`)
if (!existsSync(KEY)) throw new Error(`${KEY} missing (the funded testnet deployer key)`)
const privkey = readFileSync(KEY, 'utf8').trim()
// offckb takes the deploy key on argv (--privkey), so it is briefly visible in the local process
// list while offckb runs. The key comes from the gitignored .testnet-deployer.key, is never
// hardcoded, and is testnet-only. The offckb CLI has no env-var alternative.

console.log('[1] offckb deploy --type-id timelock-lock → testnet')
execSync(
  `offckb deploy --type-id --network testnet --target ${BIN} -o deployed/testnet --privkey ${privkey} -y`,
  { stdio: 'inherit' },
)

console.log('[2] read the Type-ID + tx hash from the migration record')
const files = readdirSync(MIG).filter(f => f.endsWith('.json')).sort()
if (!files.length) throw new Error(`no migration json in ${MIG}`)
const recipe = JSON.parse(readFileSync(`${MIG}/${files[files.length - 1]}`, 'utf8')).cell_recipes[0]
const { type_id: codeHash, tx_hash: txHash, index = 0 } = recipe
console.log(`    code ${codeHash}  tx ${txHash}  idx ${index}`)

console.log('[3] patch timelockLock in TESTNET_SCRIPTS')
let cfg = readFileSync(CFG, 'utf8')
const start = cfg.indexOf('const TESTNET_SCRIPTS: DeployedScripts = {')
const end = cfg.indexOf('\n}', start)
if (start < 0 || end < 0) throw new Error('TESTNET_SCRIPTS block not found')
let block = cfg.slice(start, end)
const re = /\btimelockLock:\s*\{[^}]*\},/
if (!re.test(block)) throw new Error('timelockLock line not found in TESTNET_SCRIPTS')
block = block.replace(re, `timelockLock:  { codeHash: '${codeHash}', hashType: 'type', txHash: '${txHash}', index: ${index} },`)
writeFileSync(CFG, cfg.slice(0, start) + block + cfg.slice(end))
console.log('    config patched')

console.log('[4] rebuild config + sdk')
execSync('pnpm --filter @cellswap/config --filter @cellswap/sdk build', { stdio: 'inherit' })

console.log('\ntimelock-lock deployed and wired. Check it: node scripts/verify-timelock-testnet.mjs')
