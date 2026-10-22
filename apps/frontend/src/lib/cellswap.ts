// src/lib/cellswap.ts: SDK and chain client singletons
import { ccc } from '@ckb-ccc/core'
import { CellSwap } from '@cellswap/sdk'
import { getConfig } from '@cellswap/config'
import type { Network } from '@cellswap/types'

// Network from VITE_NETWORK; defaults to 'testnet'.
export const NETWORK: Network = (import.meta.env.VITE_NETWORK as Network) ?? 'testnet'

export const config = getConfig(NETWORK)

// In a production build, route all chain reads through the same-origin caching proxy that the
// app's nginx exposes at /rpc and /indexer (see deploy/nginx). The proxy caches identical
// JSON-RPC/indexer polls for a few seconds and coalesces concurrent ones, so many browsers
// collapse to about one upstream call instead of each hitting the shared public node.
// Same origin means no CORS, no mixed content, and it follows whatever host and scheme serve the
// page without a rebuild. Mutating calls (send_transaction) are not cached by the proxy. Dev
// (vite serve, PROD=false) talks straight to the public node. Setting both fields here, before the
// ccc client, the SDK's ChainClient, and history/lpHistory/tokenMeta read them, reroutes every
// consumer at once.
if (import.meta.env.PROD && typeof window !== 'undefined') {
  config.rpcUrl = `${window.location.origin}/rpc`
  config.indexerUrl = `${window.location.origin}/indexer`
}

// Honor the configured RPC URL (devnet → 127.0.0.1:28114, etc.). On a local devnet the
// system-script deps differ from testnet's, so pass them if exposed on window (a dev build
// can set window.__CCC_SCRIPTS__ from offckb's `system-scripts --export-style ccc`).
const devScripts = (globalThis as any).__CCC_SCRIPTS__ as Record<string, unknown> | undefined
export const client = NETWORK === 'mainnet'
  ? new ccc.ClientPublicMainnet({ url: config.rpcUrl })
  : new ccc.ClientPublicTestnet({ url: config.rpcUrl, ...(devScripts ? { scripts: devScripts as any } : {}) })

export const sdk = new CellSwap({ network: NETWORK, config })

// Wire the VTX governance authority: emissionLockScript()/vtxArgs() derive VTX's identity from it.
// Testnet uses a dedicated issuer whose VTX was minted with a Unique (token-info) cell at genesis,
// so JoyID, CKB Explorer and other DEXes display it by name. Other networks use the treasury.
if (NETWORK === 'testnet') {
  sdk.governanceLockHash = '0x2b9f579fb54f6f23cc809c183dfb940eb4a7f97769803e607f77c6ed5bc55e21'
} else if (config.registry?.treasury) {
  sdk.governanceLockHash = ccc.Script.from(config.registry.treasury as any).hash()
}

// Aggregator endpoint for the OTX path (custody-free async swaps). A production build requires
// either an explicit https:// URL or a same-origin relative path (e.g. /agg, proxied by the site's
// nginx to the aggregator, see deploy/nginx/default.conf). It never falls back to the
// http://localhost dev default, which would be mixed content on an https site and would send OTX
// payloads and order relays in cleartext. Dev keeps the localhost default. If unset in production
// it returns '' (OTX and orders disabled) and logs an error.
const _aggEnv = import.meta.env.VITE_AGGREGATOR_URL as string | undefined
export const AGGREGATOR_URL: string = (() => {
  if (_aggEnv) {
    if (import.meta.env.PROD && !_aggEnv.startsWith('https://') && !_aggEnv.startsWith('/'))
      console.error('[cellswap] VITE_AGGREGATOR_URL should be https:// or a same-origin path in production:', _aggEnv)
    return _aggEnv
  }
  if (import.meta.env.PROD) {
    console.error('[cellswap] VITE_AGGREGATOR_URL is not set; OTX/orders disabled in this production build')
    return ''
  }
  return 'http://localhost:3002'
})()
