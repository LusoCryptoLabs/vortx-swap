#!/usr/bin/env node
// inject-config.mjs: patches deployed script addresses into @cellswap/config
// Usage: node scripts/inject-config.mjs <network> <manifest.json> <config.ts>
//
// Reads the deployment manifest produced by deploy.sh and replaces the
// corresponding *_SCRIPTS block in packages/config/src/index.ts.

import { readFileSync, writeFileSync } from 'node:fs'

const [, , network, manifestPath, configPath] = process.argv

if (!network || !manifestPath || !configPath) {
  console.error('Usage: node inject-config.mjs <network> <manifest.json> <config.ts>')
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const s = manifest.scripts
let config = readFileSync(configPath, 'utf8')

const blockName = {
  devnet:  'DEVNET_SCRIPTS',
  testnet: 'TESTNET_SCRIPTS',
  mainnet: 'MAINNET_SCRIPTS',
}[network]

if (!blockName) {
  console.error(`Unknown network: ${network}`)
  process.exit(1)
}

// Build the replacement block
function entry(name, info) {
  const i = info ?? { codeHash: '0x' + '0'.repeat(64), hashType: 'type', txHash: '0x' + '0'.repeat(64), index: 0 }
  return `    ${name}: { codeHash: '${i.codeHash}', hashType: '${i.hashType}', txHash: '${i.txHash}', index: ${i.index} },`
}

const xudtLine = network === 'mainnet' ? 'XUDT_MAINNET' : 'XUDT_TESTNET'

const newBlock = `const ${blockName}: DeployedScripts = {
${entry('poolScript',    s.poolScript)}
${entry('poolLock',      s.poolLock)}
${entry('intentLock',    s.intentLock)}
    intentScript:  { ...EMPTY_SCRIPT },
${entry('entityScript',  s.entityScript)}
${entry('factoryScript', s.factoryScript)}
${entry('lpTokenScript', s.lpTokenScript)}
    cellswapOtxLock: { codeHash: '${s.cellswapOtxLock.codeHash}', hashType: '${s.cellswapOtxLock.hashType}', txHash: '${s.cellswapOtxLock.txHash}', index: ${s.cellswapOtxLock.index} },
    xudtScript:    ${xudtLine},
}`

// Replace the existing block (from `const BLOCKNAME: DeployedScripts = {` to the closing `}`)
const re = new RegExp(`const ${blockName}: DeployedScripts = \\{[\\s\\S]*?\\n\\}`, 'm')
if (!re.test(config)) {
  console.error(`Could not find ${blockName} block in ${configPath}`)
  process.exit(1)
}
config = config.replace(re, newBlock)

writeFileSync(configPath, config)
console.log(`  Patched ${blockName} in ${configPath}`)
