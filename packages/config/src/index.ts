// @cellswap/config
// Single source of truth for all deployed contract addresses.
// Includes the real system script code hashes for xUDT on testnet and mainnet.

import type { ChainConfig, DeployedScripts, Network } from '@cellswap/types'

// ─── System script code hashes (do not change these) ──────────────────────

// xUDT: deployed on both mainnet and testnet, data1 hash type
// Source: https://docs.nervos.org/docs/common-scripts/xudt
// Authoritative mainnet xUDT (from CCC KnownScript.XUdt).
const XUDT_MAINNET: DeployedScripts['xudtScript'] = {
  codeHash: '0x50bd8d6680b8b9cf98b73f3c08faf8b2a21914311954118ad6609be6e78a1b95',
  hashType: 'data1' as const,
  txHash:   '0xc07844ce21b38e4b071dd0e1ee3b0e27afd8d7532491327f39b786343f558ab7',
  index: 0,
}

// Authoritative values from CCC's KnownScript.XUdt on testnet (so the SDK's xUDT
// cellDep resolves exactly as CCC expects). Note: hashType is 'type', not 'data1'.
const XUDT_TESTNET: DeployedScripts['xudtScript'] = {
  codeHash: '0x25c29dc317811a6f6f3985a7a9ebc4838bd388d19d0feeecf0bcd60f6c0975bb',
  hashType: 'type' as const,
  txHash:   '0xbf6fb538763efec2a70a6a3dcb7242787087e1030c4e7d86585bc63a9d337f5f',
  index: 0,
}

// offckb local devnet xUDT (from `offckb system-scripts --export-style ccc`).
const XUDT_DEVNET: DeployedScripts['xudtScript'] = {
  codeHash: '0x1a1e4fef34f5982906f745b048fe7b1089647e82346074e0f32c2ece26cf6b1e',
  hashType: 'type' as const,
  txHash:   '0x1bb87da347a776a927ab6593e1e10304ca195f8e24279f039008d5e3115b1bf7',
  index: 6,
}

// secp256k1-blake160 (standard CKB lock), for reference
export const SECP256K1_MAINNET_CODE_HASH =
  '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8'
export const SECP256K1_TESTNET_CODE_HASH =
  '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8' // same

// ─── Deployed CellSwap script addresses ───────────────────────────────────
// These are filled in by scripts/deploy.sh after each deployment.
// Never use the 0x placeholder in production; the tx will silently fail.

const EMPTY_SCRIPT: DeployedScripts['poolScript'] = { codeHash: ('0x' + '0'.repeat(64)) as `0x${string}`, hashType: 'type' as const, txHash: ('0x' + '0'.repeat(64)) as `0x${string}`, index: 0 }

// Upgrade-key trust boundary: read before treating any 'type' hashType below as immutable.
// Every script with hashType 'type' resolves by Type-ID: cells lock to the code cell's type hash,
// not to a fixed bytecode hash. Whoever holds the Type-ID's owner lock (on testnet, a single deployer
// key; on mainnet, an M-of-N multisig) can spend that code cell and replace the bytecode in place,
// and the new code governs all existing cells already locked to it. That includes value-bearing
// scripts: the user's own at-rest fund lock (cellswapOtxLock), intentLock, poolScript reserves,
// stakePool principal, timelockLock vests. So "funds stay locked to the user's own key" holds only
// modulo this upgrade key: an M-of-N key can rewrite the user's lock. Scripts pinned by
// 'data'/'data1' (e.g. the data-hash-pinned testnet poolLock) are content-addressed and are not
// upgradeable this way. See SECURITY.md for the upgrade-key threat model.

// Local offckb devnet deployment (type-id / upgradeable).
const DEVNET_SCRIPTS: DeployedScripts = {
  poolScript:    { codeHash: '0x6b7258aa30ebdd5de1af3c92c80e675309f75175661f194f87344c386f22d76b', hashType: 'type', txHash: '0x93c7cfe78e62978d1b9149a34c486887bee56adc1bf1c079937e9269e3758f73', index: 0 },
  poolLock:      { codeHash: '0xc6294de6e84c5fdb8845e87b672d69cbc3f2074400f0c211817a9025db1ff16c', hashType: 'type', txHash: '0x16075dcdb83e6b6b83e5e103fba9f4668a0bdc02ba665a0644bfa919c1bdc2cf', index: 0 },
  intentLock:    { codeHash: '0x16142c0222943c38f65cd4f0525f1f588258be050af7cf52eeab31f6f98efa47', hashType: 'type', txHash: '0x4a32b64df7a5c78905d1396c7c063fc3b168def451abf9c5f6293a75400fda60', index: 0 },
  cellswapOtxLock: { codeHash: '0xb28d25cbbc5663b911039b85364e9e35b7d0da8979b259f7b4e00465845bb1c5', hashType: 'type', txHash: '0xb999f8c76cb6f533734fa2896679a4adbd84f07c0d225c5657db33092dc8fa20', index: 0 },
  intentScript:  { ...EMPTY_SCRIPT },  // not deployed (legacy type-script variant)
  entityScript:  { ...EMPTY_SCRIPT },  // not deployed (V2, needs cobuild API port)
  factoryScript: { codeHash: '0x4a417e9b5ef89f21acfb05895b745a17a1c6941cc9eac1c692798c8d7b487652', hashType: 'type', txHash: '0xd97c9438759fba969ac0bf5806b35d7b4dd5e4a175d1ea0c8d4fbb1b9a09bc9a', index: 0 },
  lpTokenScript: { codeHash: '0xcc2ca7db5e742564fc02c1708f93d83b870b09f077decc7dc2c0dfbe4fa05e7c', hashType: 'type', txHash: '0x4d9bc621fbe703b39434df374158af18073a56648d36e1b0479d890fcbbb7360', index: 0 },
  timelockLock:  { ...EMPTY_SCRIPT },  // not deployed yet (optional LP commitment lock)
  tokenRegistry: { ...EMPTY_SCRIPT },  // not deployed yet (paid token registration)
  stakePool:     { ...EMPTY_SCRIPT },  // not deployed yet (secure xUDT staking)
  stakeGuard:    { ...EMPTY_SCRIPT },  // not deployed yet (staking receipt+custody guard)
  miningPool:    { ...EMPTY_SCRIPT },  // not deployed yet (liquidity mining)
  emissionLock:  { ...EMPTY_SCRIPT },  // not deployed yet (VTX mint authority)
  alwaysSuccess: { codeHash: '0xc6ee910e2a22b5a76a372d0bc5822398fb5edd6fc7f6dc0f0694897fb7b6289b', hashType: 'type', txHash: '0x7ab15b9e4635476f99551cf70e506ebd5ab2538ba6c48c805e8f9d5adbceb371', index: 0 },
  xudtScript:    XUDT_DEVNET,
}

const TESTNET_SCRIPTS: DeployedScripts = {
  // Canonical pool-script (type-id 0x965b278f). Pool creation requires registration in the canonical
  // factory, and MIN_POOL_CAPACITY is 400 CKB. Pools created under an earlier 200 CKB floor sit below
  // it (unspendable and unsurfaced; getPools drops capacity < 400). New pools are created via the
  // factory. The legacy pool-script 0xb4ab32ba is also unsurfaced.
  poolScript: { codeHash: '0x965b278f9bb972240c7b71182524d8178dd4b58001ebf8a4352f62e4a394069b', hashType: 'type', txHash: '0xfe97b5d3378b635c201e5161b4b04a5577098af519f083b6537fc73dd88915ae', index: 0 },
  // Deployed by data hash. The code cell is held under a dedicated custody lock (0xf5f68910…) that
  // only holds deploy cells and is never used to fund txs, so it can't be grief-spent (not
  // always-success) and can't be swept as a funding input (not the deployer/funding account).
  // Dep-referenced by data hash.
  poolLock: { codeHash: '0x31a9bc6236d05966fc68f734563b7b3dfc3312180d42dddd438f5c216f1c1974', hashType: 'data1', txHash: '0xc62f7ce5bb5cf4bac871a802339c9bbbffa571667be4411b74f785e233fce6a7', index: 0 },
  intentLock: { codeHash: '0xeec21d0ff3ae9b4ba430ef4d14afc04a3030c13b1b1ff3600a4875bf24a17171', hashType: 'type', txHash: '0x94edf3b8a44e5b3663e9e1919bcdbc9e5ac612c5472b48efa3c6291651ac556a', index: 0 },
  cellswapOtxLock: { codeHash: '0x8df806ca1a84a0aed142f8b63cda6372c916396093dae80d41a916654d9013d4', hashType: 'type', txHash: '0x253fd9c1b44cc47f4303dea8ee04da243ae2db6c39e55918789207bc67de717c', index: 0 },
  intentScript:  { ...EMPTY_SCRIPT },
  entityScript:  { ...EMPTY_SCRIPT },
  // factory-script (gov-gated genesis). Factory cells reference it by data hash (0x3dfe1c61 ==
  // pool-script's baked FACTORY_CODE_HASH), so they resolve to this code by data hash.
  factoryScript: { codeHash: '0xfc2bc80eb463c1bcc86fc3066d35ccbddd7d4379384364fab497ba7bca502d09', hashType: 'type', txHash: '0x18f0d6b8fba809032a3fd85e55a82fcc6c1e538d3ed2e0214f90213392bb61c7', index: 0 },
  // lp-token script: genesis mints lp_supply - MINIMUM_LIQUIDITY.
  lpTokenScript: { codeHash: '0x2d072ac3a23a97b691fa7183dd301d529824ba3c2bd147c64bb74b0e65961470', hashType: 'type', txHash: '0xb3b84b0cef484f382d4fb6c67ef63055eb0145a04039731707278a48ecfd8ed5', index: 0 },
  timelockLock: { codeHash: '0xd94a25ecdfa9b59109b9783cfc03e66be1a7908c279e3c844eec5918d0878cbd', hashType: 'type', txHash: '0x90aaa47c617ae1d2d5167c93354b995caf0dc0280872da513cb80f3ff8122a48', index: 0 },  // optional LP commitment lock
  tokenRegistry: { codeHash: '0x0955d77cbceee036641fb7f753661efb791a89e2ff6be04d6d9ae0eb88279b57', hashType: 'type', txHash: '0x9f795aa43752830626d810f34009ca1fad7e5c839cb6f46e066cd27b79a17e21', index: 0 },  // paid token registration
  stakePool: { codeHash: '0xdc8353ed49eb3167343643c8fa65ac26c062fb6e9926b2e2eba718a894e14025', hashType: 'type', txHash: '0xe1b0338ee1b28a9266e9a409eb3dd9bcbc5e2ec0e3b366393edf6bb8b98e7265', index: 0 },  // xUDT staking
  stakeGuard: { codeHash: '0x59a61ef69edf3a946aa8941c0f475a235bc15e355d5f3b9e45941f522bb8029f', hashType: 'type', txHash: '0x67037d1acdb1f79c9d31eeb62415888dca5c470c295e998f77d36bfbacb52b1d', index: 0 },  // staking receipt+custody guard
  miningPool: { codeHash: '0x9fec726bd729f4ccc11f18b59fd33108ae0f6f736ab9fc3e073151b0d7f6b902', hashType: 'type', txHash: '0xc42cadef881ecbaf929b47c8cadcab668868a0d35da85d8c6af7c0608f9b4d3d', index: 0 },  // liquidity mining
  emissionLock: { codeHash: '0x7cd858a4c5b8b06a83c3188251b8a4166a13d02424d6f65a83afb1d250ce045d', hashType: 'type', txHash: '0xe6e0353a7dc4076d9f678a0d7af5762a6d6f27c09a81c987243324cf6f4f612e', index: 0 },  // VTX mint authority
  stakeTimelockGuard: { codeHash: '0xd127c0158cf555cfc6bd36b04bfdf82bb11af5c852ce225f0f037daeb5d4f41b', hashType: 'type', txHash: '0xff2ded72f3895b60953b0b50b583bbce6e2d69115354b1f84cfde9be2e052ebe', index: 0 },  // lock-boost composed custody lock (patched on deploy)
  vtxSink: { codeHash: '0xe91840b8197f0364750658a64412275b9f1b41656bb4b9d2542566b04054201b', hashType: 'type', txHash: '0x32aca73c0ea286d292efb62679d0efec2f51c23ce54f1ab1ea61f492e4667426', index: 0 },  // VTX buy-back sink (patched on deploy)
  alwaysSuccess: { codeHash: '0xd8c2346649752dc03e8e747ae6152fe13675be36b3c77e459d6f841988c2d06e', hashType: 'type', txHash: '0x9fcec326fbc25dce302fa4d05727cb2ea43435f9d58ced246adc933fad9a7c59', index: 0 },
  xudtScript:    XUDT_TESTNET,
}

const MAINNET_SCRIPTS: DeployedScripts = {
  poolScript:    { ...EMPTY_SCRIPT },
  poolLock:      { ...EMPTY_SCRIPT },
  intentLock:    { ...EMPTY_SCRIPT },
  cellswapOtxLock: { ...EMPTY_SCRIPT },
  intentScript:  { ...EMPTY_SCRIPT },
  entityScript:  { ...EMPTY_SCRIPT },
  factoryScript: { ...EMPTY_SCRIPT },
  lpTokenScript: { ...EMPTY_SCRIPT },
  timelockLock:  { ...EMPTY_SCRIPT },
  tokenRegistry: { ...EMPTY_SCRIPT },
  stakePool:     { ...EMPTY_SCRIPT },
  stakeGuard:    { ...EMPTY_SCRIPT },
  stakeTimelockGuard: { ...EMPTY_SCRIPT },
  vtxSink:       { ...EMPTY_SCRIPT },
  miningPool:    { ...EMPTY_SCRIPT },
  emissionLock:  { ...EMPTY_SCRIPT },
  alwaysSuccess: { ...EMPTY_SCRIPT },
  xudtScript:    XUDT_MAINNET,
}

// ─── Chain configs ────────────────────────────────────────────────────────

export const CONFIGS: Record<Network, ChainConfig> = {
  devnet: {
    network:    'devnet',
    rpcUrl:     'http://127.0.0.1:28114',
    indexerUrl: 'http://127.0.0.1:28116',
    scripts:    DEVNET_SCRIPTS,
  },
  testnet: {
    network:    'testnet',
    rpcUrl:     'https://testnet.ckb.dev/rpc',
    indexerUrl: 'https://testnet.ckb.dev/indexer',
    scripts:    TESTNET_SCRIPTS,
    // Paid token registration: 5,000 CKB to the platform treasury (the governance-controlled lock:
    // the deployer secp256k1 lock on testnet; swap to a multisig/treasury lock for mainnet).
    // These must match token-registry's pinned constants (MIN_REGISTRATION_FEE + PLATFORM_TREASURY):
    // feeShannons >= the floor, and treasury must hash to PLATFORM_TREASURY. Changing either requires
    // rebuilding + redeploying token-registry (the constants are pinned in the contract bytecode).
    registry: {
      feeShannons: 500_000_000_000n, // 5,000 CKB
      treasury: {
        codeHash: '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8',
        hashType: 'type',
        args:     '0xc91c40bfd171b5cfff8b04d21e4d3175be75806e',
      },
    },
    // The canonical factory singleton's type script (a type-id created by the gov-gated genesis). The
    // cell is spent and recreated on every pool creation (outpoint changes), so the SDK locates the live
    // cell by this type each time. codeHash == pool-script's baked FACTORY_CODE_HASH (the factory data hash).
    factoryCell: {
      codeHash: '0x3dfe1c6155a30d38c076c8a65f043d96be791fdb24306d0f60c06d7a8ae8016b',
      hashType: 'data1',
      args:     '0x699e7cc6fc463c2b17e01e2c3e5931994a1ff957135a3d56e452152fda2d4f55',
    },
  },
  mainnet: {
    network:    'mainnet',
    rpcUrl:     'https://mainnet.ckb.dev/rpc',
    indexerUrl: 'https://mainnet.ckb.dev/indexer',
    scripts:    MAINNET_SCRIPTS,
  },
}

export function getConfig(network: Network = 'testnet'): ChainConfig {
  return CONFIGS[network]
}

export function getScripts(network: Network = 'testnet'): DeployedScripts {
  return CONFIGS[network].scripts
}

/** Validate that all script addresses have been filled in (not placeholder 0x).
 *  Call this on aggregator startup to catch misconfiguration early. */
export function validateScripts(network: Network): void {
  const scripts = getScripts(network)
  const empty   = '0x' + '0'.repeat(64)
  const missing: string[] = []
  // xudtScript is a system script (always set); intentScript (legacy type-script variant)
  // and entityScript (V2, pending cobuild API port) are not on the critical path.
  const optional = new Set(['xudtScript', 'intentScript', 'entityScript', 'alwaysSuccess', 'timelockLock', 'tokenRegistry', 'stakePool', 'stakeGuard', 'miningPool', 'emissionLock'])
  for (const [name, script] of Object.entries(scripts) as [string, { codeHash: string }][]) {
    if (optional.has(name)) continue
    if (script.codeHash === empty) missing.push(name)
  }
  if (missing.length > 0) {
    throw new Error(
      `[config] Missing deployed scripts for ${network}: ${missing.join(', ')}\n` +
      `Run: bash scripts/deploy.sh ${network}`
    )
  }
}

export type { ChainConfig, DeployedScripts, Network } from '@cellswap/types'
