import { NETWORK } from './cellswap'

const base = NETWORK === 'mainnet'
  ? 'https://explorer.nervos.org'
  : 'https://testnet.explorer.nervos.org'

export const explorerTx = (hash: string) => `${base}/transaction/${hash}`
export const explorerAddr = (address: string) => `${base}/address/${address}`

/** "3m ago" style relative time from a unix-seconds timestamp. */
export function timeAgo(unixSec: number | bigint): string {
  // Coerce defensively: a bigint timestamp here would otherwise throw
  // "Cannot mix BigInt and other types" on the subtraction below.
  const s = Math.max(0, Math.floor(Date.now() / 1000) - Number(unixSec))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
