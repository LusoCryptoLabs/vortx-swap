#!/usr/bin/env node
// Incremental testnet deploy for the staking contracts (stake-pool + stake-guard): deploys each via
// Type ID, patches the two lines in TESTNET_SCRIPTS, and rebuilds config + sdk. After this,
// sdk.stakingEnabled() returns true.  node scripts/deploy-staking-testnet.mjs
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'

const KEY = '.testnet-deployer.key'
const CFG = 'packages/config/src/index.ts'
const CONTRACTS = [
  { name: 'stake-pool',  field: 'stakePool'  },
  { name: 'stake-guard', field: 'stakeGuard' },
]

if (!existsSync(KEY)) throw new Error(`${KEY} missing`)
const privkey = readFileSync(KEY, 'utf8').trim()
// offckb takes the deploy key on argv (--privkey), so it is briefly visible in the local process
// list while offckb runs. The key comes from the gitignored .testnet-deployer.key, is never
// hardcoded, and is testnet-only. The offckb CLI has no env-var alternative.

for (const { name, field } of CONTRACTS) {
  const BIN = `build/release/${name}`
  const MIG = `deployed/testnet/testnet/${name}/migrations`
  if (!existsSync(BIN)) throw new Error(`${BIN} missing; run docker-build.sh first`)

  console.log(`[deploy] offckb deploy --type-id ${name} → testnet`)
  execSync(`offckb deploy --type-id --network testnet --target ${BIN} -o deployed/testnet --privkey ${privkey} -y`, { stdio: 'inherit' })

  const files = readdirSync(MIG).filter(f => f.endsWith('.json')).sort()
  if (!files.length) throw new Error(`no migration json in ${MIG}`)
  const recipe = JSON.parse(readFileSync(`${MIG}/${files[files.length - 1]}`, 'utf8')).cell_recipes[0]
  const { type_id: codeHash, tx_hash: txHash, index = 0 } = recipe
  console.log(`    ${field}: code ${codeHash}  tx ${txHash}  idx ${index}`)

  let cfg = readFileSync(CFG, 'utf8')
  const start = cfg.indexOf('const TESTNET_SCRIPTS: DeployedScripts = {')
  const end = cfg.indexOf('\n}', start)
  if (start < 0 || end < 0) throw new Error('TESTNET_SCRIPTS block not found')
  let block = cfg.slice(start, end)
  const re = new RegExp(`\\b${field}:\\s*\\{[^}]*\\},`)
  if (!re.test(block)) throw new Error(`${field} line not found in TESTNET_SCRIPTS`)
  block = block.replace(re, `${field}: { codeHash: '${codeHash}', hashType: 'type', txHash: '${txHash}', index: ${index} },`)
  writeFileSync(CFG, cfg.slice(0, start) + block + cfg.slice(end))
  console.log(`    config patched (${field})`)
}

console.log('[build] rebuild config + sdk')
execSync('pnpm --filter @cellswap/config --filter @cellswap/sdk build', { stdio: 'inherit' })
console.log('\nstaking deployed and wired. Check it: node scripts/verify-staking-testnet.mjs')
