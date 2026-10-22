#!/usr/bin/env node
// Generate a fresh testnet deployer account (throwaway, testnet coins only).
// Prints the private key + testnet address. Writes the key to .testnet-deployer.key (gitignored).
import { ccc } from '@ckb-ccc/core'
import { writeFileSync, existsSync, readFileSync } from 'node:fs'

const keyFile = '.testnet-deployer.key'

// Reuse an existing key if present so reruns don't strand funds on a new address.
let priv
if (existsSync(keyFile)) {
  priv = readFileSync(keyFile, 'utf8').trim()
  console.log('Reusing existing', keyFile)
} else {
  // 32 random bytes → secp256k1 private key
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  priv = '0x' + Buffer.from(bytes).toString('hex')
  writeFileSync(keyFile, priv + '\n')
  console.log('Wrote new key to', keyFile)
}

const client = new ccc.ClientPublicTestnet()
const signer = new ccc.SignerCkbPrivateKey(client, priv)
const addr = await signer.getRecommendedAddress()

console.log('\n=== TESTNET DEPLOYER ===')
console.log('private key :', priv)
console.log('address     :', addr)
console.log('\nFund this address (≈300k CKB) at https://faucet.nervos.org , then run the deploy scripts.')
