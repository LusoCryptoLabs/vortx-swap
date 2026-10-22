// scanner.ts: reads live pool cells from ckb-indexer.
// Byte offsets must match the PoolData layout in contracts/pool-script/src/main.rs.
// The offsets live in @cellswap/codec.

import { ccc }         from '@ckb-ccc/core'
import { ChainClient } from '@cellswap/chain-client'
import type { Cell, ChainConfig, Pool, TypeHash, OutPoint } from '@cellswap/types'
import { MIN_POOL_CAPACITY } from '@cellswap/types'
import {
  stripHex, byteLen, readU8, readU16LE, readU32LE, readU128LE, readBytes32,
  POOL_TOKEN_X_OFF, POOL_TOKEN_Y_OFF, POOL_LP_SUPPLY_OFF, POOL_FEE_BPS_OFF, POOL_ID_OFF,
  POOL_POOL_MODE_OFF, POOL_PAUSED_OFF, POOL_DATA_SIZE,
} from '@cellswap/codec'

// xUDT extension flags: lower 29 bits of u32 at byte offset 16 in xUDT data
const XUDT_FLAGS_OFFSET = 16
const XUDT_EXTENSION_MASK = 0x1FFFFFFF

export class Scanner {
  constructor(private chain: ChainClient, private config: ChainConfig) {}

  async scanPools(): Promise<Pool[]> {
    const cells = await this.chain.getLiveCellsByType({
      codeHash: this.config.scripts.poolScript.codeHash,
      hashType: 'type',
      args: '0x',
    })
    const pools = cells
      .map(c => this.parsePool(c))
      .filter((x): x is Pool & { paused: boolean } => x !== null)
      .filter(p => !p.paused)
    // Reserves live in the reserve cells; hydrate each before settling.
    await Promise.all(pools.map(p => this.hydrateReserves(p)))
    return pools
  }

  /** Fill reserveX/reserveY (+ cell refs) from the real xUDT reserve cells,
   *  which are locked by pool-lock bound to this info cell. Mirrors SDK.hydrateReserves. */
  private async hydrateReserves(pool: Pool): Promise<void> {
    const infoTypeHash = ccc.Script.from(pool.cell.output.type!).hash()
    const poolLock = {
      codeHash: this.config.scripts.poolLock.codeHash as `0x${string}`,
      hashType: this.config.scripts.poolLock.hashType as 'type',
      args:     infoTypeHash as `0x${string}`,
    }
    if (pool.poolMode === 'CKB_XUDT') {
      pool.reserveX = pool.cell.output.capacity - MIN_POOL_CAPACITY
    }
    const reserveCells = await this.chain.getLiveCellsByLock(poolLock)
    for (const cell of reserveCells) {
      if (!cell.output.type) continue
      const th  = ccc.Script.from(cell.output.type).hash()
      const amt = readU128LE(stripHex(cell.data), 0)
      if (th === pool.tokenY) { pool.reserveY = amt; pool.reserveCellY = cell }
      else if (pool.poolMode !== 'CKB_XUDT' && th === pool.tokenX) { pool.reserveX = amt; pool.reserveCellX = cell }
    }
  }

  /** Detect xUDT extension scripts. Aggregator should reject intents
   *  involving extension-using tokens until extension support is implemented. */
  hasXudtExtension(cellData: string): boolean {
    const data = cellData.startsWith('0x') ? cellData.slice(2) : cellData
    if (data.length < (XUDT_FLAGS_OFFSET + 4) * 2) return false
    const flags = readU32LE(data, XUDT_FLAGS_OFFSET)
    return (flags & XUDT_EXTENSION_MASK) !== 0
  }

  private parsePool(cell: Cell): (Pool & { paused: boolean }) | null {
    try {
      const data = stripHex(cell.data)
      if (byteLen(data) < POOL_DATA_SIZE) return null
      return {
        poolId:   readU128LE(data, POOL_ID_OFF),
        tokenX:   readBytes32(data, POOL_TOKEN_X_OFF),
        tokenY:   readBytes32(data, POOL_TOKEN_Y_OFF),
        reserveX: 0n,   // reserves live in reserve cells; hydrate before settling
        reserveY: 0n,   // (mirrors SDK CellSwap.hydrateReserves; see ARCHITECTURE.md)
        feeBps:   readU16LE(data, POOL_FEE_BPS_OFF),
        lpSupply: readU128LE(data, POOL_LP_SUPPLY_OFF),
        cell,
        poolMode: readU8(data, POOL_POOL_MODE_OFF) === 1 ? 'CKB_XUDT' : 'XUDT_XUDT',
        paused:   readU8(data, POOL_PAUSED_OFF) !== 0,
      }
    } catch { return null }
  }
}

// Byte/hex helpers and the pool/intent layout constants live in @cellswap/codec
// so the offsets can't drift between the scanner, the SDK, and the deploy scripts.
