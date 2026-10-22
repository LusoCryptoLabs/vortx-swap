#!/usr/bin/env node
// Patch packages/config TESTNET_SCRIPTS from offckb testnet deployment records.
// Each contract has deployed/testnet/testnet/<dir>/migrations/<ts>.json with
// { cell_recipes: [{ tx_hash, index, type_id }] }. type_id is the type-id code hash.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'

const map = {
  // poolScript maps to the fee pool-script deploy (pool-script-fee), which has the current
  // read_reserves logic. The older 'pool-script' deploy predates it and is deliberately not mapped
  // here, so re-patching never points the config back at it.
  'pool-script-fee': 'poolScript', 'pool-lock': 'poolLock', 'cellswap-otx-lock': 'cellswapOtxLock',
  'intent-lock': 'intentLock', 'factory-script': 'factoryScript', 'lp-token': 'lpTokenScript',
  'timelock-lock': 'timelockLock', 'token-registry': 'tokenRegistry',
  'stake-pool': 'stakePool', 'stake-guard': 'stakeGuard',
  'mining-pool': 'miningPool', 'emission-lock': 'emissionLock', 'always-success': 'alwaysSuccess',
}
const base = 'deployed/testnet/testnet'
const cfgPath = 'packages/config/src/index.ts'
let cfg = readFileSync(cfgPath, 'utf8')

// Isolate the TESTNET_SCRIPTS block so we never touch DEVNET/MAINNET.
const startMarker = 'const TESTNET_SCRIPTS: DeployedScripts = {'
const start = cfg.indexOf(startMarker)
if (start < 0) throw new Error('TESTNET_SCRIPTS block not found')
const end = cfg.indexOf('\n}', start)
if (end < 0) throw new Error('TESTNET_SCRIPTS block end not found')
let block = cfg.slice(start, end)
const origBlock = block

for (const [dir, key] of Object.entries(map)) {
  const migDir = `${base}/${dir}/migrations`
  const files = readdirSync(migDir).filter(f => f.endsWith('.json')).sort()
  const j = JSON.parse(readFileSync(`${migDir}/${files[files.length - 1]}`, 'utf8'))
  const recipe = j.cell_recipes[0]
  const codeHash = recipe.type_id
  const txHash   = recipe.tx_hash
  const index    = recipe.index ?? 0
  const replacement =
    `${key}: { codeHash: '${codeHash}', hashType: 'type', txHash: '${txHash}', index: ${index} },`
  // Replace `key: { ...anything... },` (placeholder or previously filled) within the block.
  const re = new RegExp(`\\b${key}:\\s*\\{[^}]*\\},`)
  if (!re.test(block)) throw new Error(`testnet config line for ${key} not found`)
  block = block.replace(re, replacement)
  console.log(`  ${key.padEnd(16)} code ${codeHash.slice(0, 14)}…  tx ${txHash.slice(0, 14)}…`)
}

if (block === origBlock) throw new Error('no replacements made')
cfg = cfg.slice(0, start) + block + cfg.slice(end)
writeFileSync(cfgPath, cfg)
console.log('TESTNET_SCRIPTS patched')
