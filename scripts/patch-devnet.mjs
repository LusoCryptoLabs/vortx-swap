#!/usr/bin/env node
// Patch packages/config DEVNET_SCRIPTS from offckb deployment records (type-id + tx hash).
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'

const map = {
  'pool-script': 'poolScript', 'pool-lock': 'poolLock', 'cellswap-otx-lock': 'cellswapOtxLock',
  'intent-lock': 'intentLock', 'factory-script': 'factoryScript', 'lp-token': 'lpTokenScript',
  'always-success': 'alwaysSuccess',
}
const base = 'deployed/devnet/devnet'
const cfgPath = 'packages/config/src/index.ts'
let cfg = readFileSync(cfgPath, 'utf8')

for (const [dir, key] of Object.entries(map)) {
  const migDir = `${base}/${dir}/migrations`
  const files = readdirSync(migDir).filter(f => f.endsWith('.json')).sort()
  const j = readFileSync(`${migDir}/${files[files.length - 1]}`, 'utf8')
  const codeHash = j.match(/"type_id"\s*:\s*"(0x[0-9a-fA-F]+)"/)[1]
  const txHash = j.match(/"tx_hash"\s*:\s*"(0x[0-9a-fA-F]+)"/)[1]
  const re = new RegExp(`(${key}:\\s*\\{ codeHash: ')0x[0-9a-fA-F]+(', hashType: 'type', txHash: ')0x[0-9a-fA-F]+(', index: 0 \\},)`)
  if (!re.test(cfg)) throw new Error(`config line for ${key} not found`)
  cfg = cfg.replace(re, `$1${codeHash}$2${txHash}$3`)
  console.log(`  ${key.padEnd(16)} code ${codeHash.slice(0, 14)}…  tx ${txHash.slice(0, 14)}…`)
}
writeFileSync(cfgPath, cfg)
console.log('DEVNET_SCRIPTS patched')
