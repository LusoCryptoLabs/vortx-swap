#!/usr/bin/env node
// Pure test for the multisig pause-authority helper and the governance wiring.
import { computeMultisigAuthority, encodeFactoryData, SECP256K1_MULTISIG_CODE_HASH, CellSwap } from '../../packages/sdk/dist/index.js'

let pass = 0, fail = 0
const ok = (n) => { console.log('  ok', n); pass++ }
const bad = (n, e) => { console.error('  FAIL', n, ':', e?.message ?? e); fail++ }
const check = (n, fn) => { try { fn(); ok(n) } catch (e) { bad(n, e) } }

// 20-byte blake160 stand-ins (each signer's standard lock args)
const A = '0x' + '11'.repeat(20)
const B = '0x' + '22'.repeat(20)
const C = '0x' + '33'.repeat(20)

check('2-of-3 produces 20-byte args + 32-byte lock hash', () => {
  const r = computeMultisigAuthority({ signerBlake160s: [A, B, C], threshold: 2 })
  if (r.multisigArgs.length !== 42) throw new Error('args not 20 bytes: ' + r.multisigArgs)
  if (r.lockHash.length !== 66) throw new Error('lockHash not 32 bytes: ' + r.lockHash)
  if (r.script.codeHash !== SECP256K1_MULTISIG_CODE_HASH) throw new Error('wrong code hash')
})

check('deterministic: same inputs give same lock hash', () => {
  const a = computeMultisigAuthority({ signerBlake160s: [A, B, C], threshold: 2 })
  const b = computeMultisigAuthority({ signerBlake160s: [A, B, C], threshold: 2 })
  if (a.lockHash !== b.lockHash) throw new Error('non-deterministic')
})

check('threshold and signer-set change the lock hash', () => {
  const m2 = computeMultisigAuthority({ signerBlake160s: [A, B, C], threshold: 2 }).lockHash
  const m3 = computeMultisigAuthority({ signerBlake160s: [A, B, C], threshold: 3 }).lockHash
  const m2ab = computeMultisigAuthority({ signerBlake160s: [A, B], threshold: 2 }).lockHash
  if (m2 === m3) throw new Error('threshold ignored')
  if (m2 === m2ab) throw new Error('signer set ignored')
})

check('rejects bad threshold', () => {
  try { computeMultisigAuthority({ signerBlake160s: [A, B], threshold: 3 }); throw new Error('did not reject') }
  catch (e) { if (!/threshold/.test(e.message)) throw e }
})

check('rejects non-20-byte signer', () => {
  try { computeMultisigAuthority({ signerBlake160s: ['0xdead'], threshold: 1 }); throw new Error('did not reject') }
  catch (e) { if (!/20-byte/.test(e.message)) throw e }
})

check('encodeFactoryData embeds the authority at [48..80]', () => {
  const { lockHash } = computeMultisigAuthority({ signerBlake160s: [A, B, C], threshold: 2 })
  const poolScriptHash = '0x' + 'ab'.repeat(32)
  const data = encodeFactoryData({ poolScriptHash, pauseAuthorityLockHash: lockHash, nextPoolId: 0n })
  const bytes = data.slice(2)
  const auth = '0x' + bytes.slice(48 * 2, 80 * 2)
  if (auth !== lockHash) throw new Error('authority not at [48..80]')
  const psh = '0x' + bytes.slice(16 * 2, 48 * 2)
  if (psh !== poolScriptHash) throw new Error('pool script hash not at [16..48]')
})

check('Phase 3: setMultisigGovernance wires the SAME multisig to emission + factory authority', () => {
  const sdk = new CellSwap({ network: 'testnet' })
  const m = sdk.setMultisigGovernance({ signerBlake160s: [A, B, C], threshold: 2 })
  // (1) governanceLockHash is the multisig lock hash
  if (sdk.governanceLockHash !== m.lockHash) throw new Error('governanceLockHash not set to multisig')
  if (m.lockHash !== computeMultisigAuthority({ signerBlake160s: [A, B, C], threshold: 2 }).lockHash) throw new Error('helper != standalone')
  // (2) emission-lock binds the multisig as VTX's owner authority (args = miningCode(32) || G(32))
  const emArgs = sdk.emissionLockScript().args
  const emHex = emArgs.startsWith('0x') ? emArgs.slice(2) : emArgs
  if ('0x' + emHex.slice(64, 128) !== m.lockHash) throw new Error('emission-lock does not bind the multisig authority')
  // (3) factory pause authority [48..80] = the same multisig
  const fdata = sdk.factoryGenesisData('0x' + 'ab'.repeat(32))
  if ('0x' + fdata.slice(2).slice(48 * 2, 80 * 2) !== m.lockHash) throw new Error('factory authority != multisig')
  // (4) the multisig config is recorded for the signing ceremony
  if (sdk.governanceMultisig?.threshold !== 2 || sdk.governanceMultisig?.signerBlake160s.length !== 3) throw new Error('multisig config not recorded')
})

check('Phase 3: factoryGenesisData requires an authority to be set', () => {
  const sdk = new CellSwap({ network: 'testnet' })
  try { sdk.factoryGenesisData('0x' + 'ab'.repeat(32)); throw new Error('did not require authority') }
  catch (e) { if (!/governance authority/.test(e.message)) throw e }
})

console.log(`\nmultisig-authority: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
