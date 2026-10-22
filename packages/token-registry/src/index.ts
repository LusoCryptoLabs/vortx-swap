// @cellswap/token-registry
// Resolves token name, symbol, decimals, and logo for any xUDT type hash.
// Sources: 1) on-chain registry cell, 2) curated fallback JSON, 3) unknown

import type { ChainConfig, TypeHash } from '@cellswap/types'

export interface TokenMetadata {
  typeHash: TypeHash
  symbol:   string
  name:     string
  decimals: number
  logoUrl?: string
}

// Curated fallback for known tokens before they register on-chain
const KNOWN_TOKENS: Record<string, Omit<TokenMetadata, 'typeHash'>> = {
  // CKB native: pseudo-entry for display consistency
  '0x0000000000000000000000000000000000000000000000000000000000000000': {
    symbol: 'CKB', name: 'CKByte', decimals: 8,
    logoUrl: 'https://cryptologos.cc/logos/nervos-network-ckb-logo.png',
  },
  // Add known testnet/mainnet token hashes here as they're deployed
}

export class TokenRegistry {
  private cache = new Map<string, TokenMetadata>()

  constructor(private config?: ChainConfig) {}

  async resolve(typeHash: TypeHash): Promise<TokenMetadata> {
    const cached = this.cache.get(typeHash)
    if (cached) return cached

    // 1. Try on-chain registry
    if (this.config) {
      const onChain = await this.fetchOnChain(typeHash)
      if (onChain) {
        this.cache.set(typeHash, onChain)
        return onChain
      }
    }

    // 2. Fallback to curated list
    const known = KNOWN_TOKENS[typeHash]
    if (known) {
      const meta = { typeHash, ...known }
      this.cache.set(typeHash, meta)
      return meta
    }

    // 3. Unknown: return placeholder
    const unknown: TokenMetadata = {
      typeHash,
      symbol:   typeHash.slice(0, 8) + '…',
      name:     'Unknown Token',
      decimals: 8, // safest default for CKB ecosystem
    }
    return unknown
  }

  /** Format a raw token amount for display */
  format(amount: bigint, decimals: number, maxDecimals = 4): string {
    const divisor = BigInt(10 ** decimals)
    const whole   = amount / divisor
    const frac    = amount % divisor
    if (frac === 0n) return whole.toString()
    const fracStr = frac.toString().padStart(decimals, '0').slice(0, maxDecimals).replace(/0+$/, '')
    return fracStr ? `${whole}.${fracStr}` : whole.toString()
  }

  /** Parse a display string to raw amount (handles decimals) */
  parse(display: string, decimals: number): bigint {
    const [whole = '0', frac = ''] = display.split('.')
    const fracPadded = frac.slice(0, decimals).padEnd(decimals, '0')
    return BigInt(whole) * BigInt(10 ** decimals) + BigInt(fracPadded)
  }

  /** Register a token (for use by pool creation UI) */
  register(meta: TokenMetadata): void {
    this.cache.set(meta.typeHash, meta)
  }

  private async fetchOnChain(typeHash: TypeHash): Promise<TokenMetadata | null> {
    // xUDT tokens publish metadata in a paired "info cell" using the standard
    // layout: decimals(u8) || name_len(u8) || name || symbol_len(u8) || symbol.
    // The registry is given a resolver that maps a token type hash to its info
    // cell data (an indexer or the token's deterministic Unique-type cell).
    if (!this.infoCellResolver) return null
    try {
      const data = await this.infoCellResolver(typeHash)
      if (!data) return null
      return { typeHash, ...decodeXudtInfoCell(data) }
    } catch {
      return null
    }
  }

  /** Inject a resolver that returns raw info-cell data for a token type hash. */
  setInfoCellResolver(fn: (typeHash: TypeHash) => Promise<Uint8Array | null>): void {
    this.infoCellResolver = fn
  }
  private infoCellResolver?: (typeHash: TypeHash) => Promise<Uint8Array | null>
}

/**
 * Decode the standard xUDT info cell data.
 * Layout: decimals(u8) || name_len(u8) || name(utf8) || symbol_len(u8) || symbol(utf8)
 * This is the widely-used sUDT/xUDT information cell format.
 */
export function decodeXudtInfoCell(data: Uint8Array): Omit<TokenMetadata, 'typeHash'> {
  if (data.length < 3) throw new Error('info cell too short')
  let off = 0
  const decimals = data[off++]!
  const nameLen  = data[off++]!
  if (data.length < off + nameLen + 1) throw new Error('info cell truncated (name)')
  const name = new TextDecoder().decode(data.slice(off, off + nameLen))
  off += nameLen
  const symbolLen = data[off++]!
  if (data.length < off + symbolLen) throw new Error('info cell truncated (symbol)')
  const symbol = new TextDecoder().decode(data.slice(off, off + symbolLen))
  return { decimals, name, symbol }
}

// Convenience singleton for use across packages
let _registry: TokenRegistry | null = null

export function getRegistry(config?: ChainConfig): TokenRegistry {
  if (!_registry) _registry = new TokenRegistry(config)
  return _registry
}

export type { TokenMetadata as Token }
