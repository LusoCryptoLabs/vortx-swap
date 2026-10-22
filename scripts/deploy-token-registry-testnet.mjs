#!/usr/bin/env node
// Incremental testnet deploy for the token-registry contract: deploys it via Type ID, patches the
// single `tokenRegistry` line in TESTNET_SCRIPTS, and rebuilds config + sdk. After this,
// sdk.registryEnabled() returns true.  node scripts/deploy-token-registry-testnet.mjs
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'

const BIN = 'build/release/token-registry'
const KEY = '.testnet-deployer.key'
const CFG = 'packages/config/src/index.ts'
const MIG = 'deployed/testnet/testnet/token-registry/migrations'

if (!existsSync(BIN)) throw new Error(`${BIN} missing; run docker-build.sh first`)
if (!existsSync(KEY)) throw new Error(`${KEY} missing`)
const privkey = readFileSync(KEY, 'utf8').trim()
// offckb takes the deploy key on argv (--privkey), so it is briefly visible in the local process
// list while offckb runs. The key comes from the gitignored .testnet-deployer.key, is never
// hardcoded, and is testnet-only. The offckb CLI has no env-var alternative.

console.log('[1] offckb deploy --type-id token-registry → testnet')
execSync(`offckb deploy --type-id --network testnet --target ${BIN} -o deployed/testnet --privkey ${privkey} -y`, { stdio: 'inherit' })

console.log('[2] read Type-ID + tx hash from the migration record')
const files = readdirSync(MIG).filter(f => f.endsWith('.json')).sort()
if (!files.length) throw new Error(`no migration json in ${MIG}`)
const recipe = JSON.parse(readFileSync(`${MIG}/${files[files.length - 1]}`, 'utf8')).cell_recipes[0]
const { type_id: codeHash, tx_hash: txHash, index = 0 } = recipe
console.log(`    code ${codeHash}  tx ${txHash}  idx ${index}`)

console.log('[3] patch tokenRegistry in TESTNET_SCRIPTS')
let cfg = readFileSync(CFG, 'utf8')
const start = cfg.indexOf('const TESTNET_SCRIPTS: DeployedScripts = {')
const end = cfg.indexOf('\n}', start)
if (start < 0 || end < 0) throw new Error('TESTNET_SCRIPTS block not found')
let block = cfg.slice(start, end)
const re = /\btokenRegistry:\s*\{[^}]*\},/
if (!re.test(block)) throw new Error('tokenRegistry line not found in TESTNET_SCRIPTS')
block = block.replace(re, `tokenRegistry: { codeHash: '${codeHash}', hashType: 'type', txHash: '${txHash}', index: ${index} },`)
writeFileSync(CFG, cfg.slice(0, start) + block + cfg.slice(end))
console.log('    config patched')

console.log('[4] rebuild config + sdk')
execSync('pnpm --filter @cellswap/config --filter @cellswap/sdk build', { stdio: 'inherit' })
console.log('\ntoken-registry deployed and wired. Check it: node scripts/verify-token-registry-testnet.mjs')
