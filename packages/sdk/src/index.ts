// @cellswap/sdk
//
// Three swap paths, each with different custody guarantees:
//
// PATH 1: Direct atomic swap (primary: custody-free, works with JoyID)
//   swap() → user's xUDT stays in JoyID lock → user signs complete tx → broadcast
//   Flow: quote → build tx → JoyID signs → done
//   Custody: assets never leave the user's lock. No intermediate custody.
//   Tradeoff: if pool state changes before broadcast, tx fails → user retries
//
// PATH 2: Intent-lock (async: fire-and-forget, slight custody compromise)
//   swapAsync() → creates intent-lock cell → JoyID signs once → aggregator settles
//   Flow: sign once → wait for aggregator → receive token_out
//   Custody: assets move to the intent-lock contract
//   Tradeoff: 1-2 extra transactions, requires aggregator running
//
// PATH 3: Cobuild OTX (custom secp256r1 lock; exports at the end of this file)
//   JoyID signs the OTX hash via signChallenge(); the aggregator settles it
//   Same guarantee as PATH 1 but supports batching across multiple users

import { ccc }                        from '@ckb-ccc/core'
import { ChainClient }                from '@cellswap/chain-client'
import { Router, getAmountOut }       from '@cellswap/router'
import { getConfig, validateScripts } from '@cellswap/config'
import { TokenRegistry, getRegistry } from '@cellswap/token-registry'
import type {
  ChainConfig, Network, Pool, SwapQuote,
  TypeHash, TxHash, IntentStatus, Cell,
} from '@cellswap/types'
import { MIN_INTENT_CAPACITY, MIN_POOL_CAPACITY, CKB_TYPE_HASH } from '@cellswap/types'
import { XUDT_CELL_CAPACITY, DEFAULT_FEE_RATE } from '@cellswap/types'
import {
  stripHex, byteLen, readU8, readU16LE, readU64LE, readU128LE, readBytes32,
  writeU128LE, writeU64LE, writeU16LE, copyHexInto, hexToUint8Array, uint8ArrayToHex,
  encodeU128LE,
} from '@cellswap/codec'
import { computeMultisigAuthority, encodeFactoryData } from './factory.js'

// Pool data byte offsets (must match Rust pool-script layout)
// Info-cell layout (140 bytes); reserves live in the reserve cells
const POOL_TOKEN_X_OFF    = 0
const POOL_TOKEN_Y_OFF    = 32
const POOL_LP_SUPPLY_OFF  = 64
const POOL_FEE_BPS_OFF    = 80
const POOL_ID_OFF         = 82
const POOL_CUM_X_OFF      = 98
const POOL_CUM_Y_OFF      = 114
const POOL_LAST_EPOCH_OFF = 130
const POOL_MODE_OFF       = 138
const POOL_PAUSED_OFF     = 139
const POOL_K_LAST_OFF     = 140   // u128 LE √k at last protocol-fee collection (0 = fee off)
const POOL_DATA_SIZE      = 156   // new pools (pool-script with the protocol-fee k_last field)
const POOL_DATA_MIN       = 140   // pre-fee pools; read both

// stake-pool data layout (91 bytes, must match contracts/stake-pool/src/main.rs)
const SP_STAKE_TOKEN_OFF = 0
const SP_TOTAL_OFF       = 32
const SP_ACC_OFF         = 48
const SP_RESERVE_OFF     = 64
const SP_LAST_EPOCH_OFF  = 80
const SP_EMISSION_OFF    = 88
const SP_PAUSED_OFF      = 90
const SP_DATA_SIZE       = 91
const STAKE_ACC_PRECISION   = 1_000_000_000_000n // 1e12 (matches the contract)
const MIN_STAKEPOOL_CAPACITY = 30_000_000_000n   // 300 CKB floor (matches the contract)
/** Capacity parked in each new receipt / custody cell (returned to the owner on unstake). */
const STAKE_CELL_CAPACITY = 20_000_000_000n      // 200 CKB
/** A boosted (locked) receipt carries 56 bytes (weight + unlock_epoch) under a 64-byte stake-guard
 *  type → ~214 CKB occupied, above STAKE_CELL_CAPACITY. Size it with headroom. */
const LOCKED_RECEIPT_CAPACITY = 22_000_000_000n  // 220 CKB

// Intent-lock args layout (must match Rust intent-lock/src/main.rs)
const INTENT_OWNER_OFF     = 0
const INTENT_MIN_OUT_OFF   = 32
const INTENT_TOKEN_OUT_OFF = 48
const INTENT_DEADLINE_OFF  = 80
const INTENT_FEE_OFF       = 104
const INTENT_OTX_HASH_OFF  = 106   // cellswap-otx-lock code hash (cross-contract demand sum)
const INTENT_ARGS_SIZE     = 138

/** One swap hop: through `pool`, from token `inHash` to token `outHash` (its two sides). */
interface Hop { pool: Pool; inHash: TypeHash; outHash: TypeHash }

/** Parsed staking pool (singleton) state. `acc`/`reserve` are the on-chain values before folding. */
export interface StakePoolState {
  stakeToken:   TypeHash   // the staked xUDT's type hash
  total:        bigint     // total staked principal
  acc:          bigint     // acc_reward_per_share (scaled by 1e12)
  reserve:      bigint     // unstreamed CKB reward reserve (shannons)
  lastEpoch:    bigint
  emissionBps:  number     // per-epoch fraction of the reserve streamed
  paused:       boolean
  poolTypeHash: string     // this pool cell's own type hash (binds receipts/custody)
  cell:         Cell
}

/** An owner's stake position: principal + the pending CKB reward accrued to the tip. */
export interface StakePosition { amount: bigint; pending: bigint; pool: StakePoolState }

// ─── Liquidity mining (stake CKB/xUDT LP → earn minted VTX) ────────────────
const MP_STAKE_TOKEN_OFF = 0
const MP_TOTAL_OFF       = 32
const MP_ACC_OFF         = 48
const MP_LAST_EPOCH_OFF  = 64
const MP_EMISSION_OFF    = 72
const MP_PAUSED_OFF      = 80
const MP_DATA_SIZE       = 81
const MP_ARGS_BASE       = 193  // args without the optional lock-boost field
const MP_ARGS_BOOST      = 225  // args with stake_timelock_guard_code_hash at [193..225] (lock-boost on)
const MINING_ACC_PRECISION = 1_000_000_000_000n // 1e12 (matches the contract)

// ─── Lock-boost (fixed-term lock-weighted mining): must mirror contracts/mining-pool::boost_bps and
// the stake-timelock-guard args/since rules byte-for-byte, or built txs are rejected on chain. ──────
const BOOST_DENOM = 10_000n
/** 24-bit epoch ceiling: a deadline beyond this can never be satisfied by a since (RFC-0017). */
const MAX_UNLOCK_EPOCH = 0x00ff_ffffn
/** CKB `since` (RFC-0017): absolute (bit63=0) + epoch metric (bits62-61=0b01); epoch number in low 24 bits. */
const SINCE_EPOCH_ABS = 0x2000_0000_0000_0000n
/** Pinned tier schedule (epoch ≈ 4h → 6/day). 30/60/90/180/360 days. Rounds down to a tier; 2.5× cap. */
export const LOCK_BOOST_TIERS: ReadonlyArray<{ days: number; epochs: bigint; bps: bigint }> = [
  { days: 360, epochs: 2160n, bps: 25_000n },
  { days: 180, epochs: 1080n, bps: 20_000n },
  { days: 90,  epochs: 540n,  bps: 17_500n },
  { days: 60,  epochs: 360n,  bps: 15_000n },
  { days: 30,  epochs: 180n,  bps: 12_500n },
]
/** boost_bps(committed_term_epochs): basis points of principal counted as effective stake. 1.0× (10000)
 *  for unlocked / sub-30-day. Mirrors the contract's pinned table exactly. */
export function boostBps(termEpochs: bigint): bigint {
  for (const t of LOCK_BOOST_TIERS) if (termEpochs >= t.epochs) return t.bps
  return BOOST_DENOM
}
/** Capacity of the value-less emission-authority cell (recreated on every mint). */
// The emission-authority cell is locked by emission-lock, whose 64-byte args include the
// governance binding, so the cell occupies ~105 CKB. Fund above that.
const EMISSION_AUTH_CAPACITY = 12_000_000_000n  // 120 CKB

const HASH_TYPE_BYTE: Record<string, number> = { data: 0, type: 1, data1: 2, data2: 4 }

/** Parsed mining pool: stake a CKB/xUDT pool's LP token, earn VTX at `emissionPerEpoch`. */
export interface MiningPoolState {
  stakeToken:   TypeHash   // the LP token's type hash
  total:        bigint
  acc:          bigint     // ×1e12
  lastEpoch:    bigint
  emissionPerEpoch: bigint // VTX base units / epoch
  paused:       boolean
  poolTypeHash: string
  cell:         Cell
}
export interface MiningPosition {
  amount: bigint; pending: bigint; pool: MiningPoolState
  weight: bigint        // boosted effective stake (== amount for unlocked positions)
  unlockEpoch: bigint   // commitment deadline epoch; 0 = unlocked (withdraw any time)
}

/** An on-chain token registration (verified badge). Trustworthy iff ownerLockHash == token args. */
export interface TokenRegistration {
  tokenTypeHash: string
  ownerLockHash: string
  decimals: number
  symbol: string
  name: string
  link: string
  outPoint: { txHash: TxHash; index: number }
}

/** Shortest pool path inHash → … → outHash by BFS over the pool graph (nodes = token type
 *  hashes, edges = pools). Returns the ordered hops, or null if unreachable within `maxHops`. */
function findSwapPath(pools: Pool[], inHash: TypeHash, outHash: TypeHash, maxHops = 4): Hop[] | null {
  const adj = new Map<string, { other: TypeHash; pool: Pool }[]>()
  const push = (k: string, v: { other: TypeHash; pool: Pool }) => { const a = adj.get(k); if (a) a.push(v); else adj.set(k, [v]) }
  for (const p of pools) {
    if (p.paused) continue
    push(p.tokenX, { other: p.tokenY, pool: p })
    push(p.tokenY, { other: p.tokenX, pool: p })
  }
  const queue: { node: TypeHash; hops: Hop[] }[] = [{ node: inHash, hops: [] }]
  const visited = new Set<string>([inHash])
  while (queue.length) {
    const { node, hops } = queue.shift()!
    if (hops.length >= maxHops) continue
    for (const { other, pool } of adj.get(node) ?? []) {
      const next: Hop[] = [...hops, { pool, inHash: node, outHash: other }]
      if (other === outHash) return next
      if (visited.has(other)) continue
      visited.add(other)
      queue.push({ node: other, hops: next })
    }
  }
  return null
}

export class CellSwap {
  readonly chain:  ChainClient
  readonly config: ChainConfig
  readonly tokens: TokenRegistry
  /** Governance treasury lock hash: where the protocol fee (UniV2 _mintFee) LP is minted. Set
   *  once the treasury exists; new pools bind it into their args so the fee is enableable. */
  treasuryLockHash?: string
  /** Governance authority lock hash for VTX emissions. It is baked into emission-lock's args and
   *  every mining pool's authority, so emission-lock only authorizes a mint when the spent pool
   *  carries this authority. Set before any mining/VTX call. */
  governanceLockHash?: string
  /** When governance is an M-of-N multisig, the config needed to sign governance ops (set by
   *  setMultisigGovernance). The signing itself is an external M-of-N ceremony, so this carries the
   *  multisig script/threshold, not any keys. */
  governanceMultisig?: { signerBlake160s: string[]; threshold: number; requireFirstN: number; script: ccc.Script }

  constructor(opts: { network?: Network; config?: ChainConfig } = {}) {
    const network = opts.network ?? 'mainnet'
    this.config   = opts.config ?? getConfig(network)
    this.chain    = new ChainClient(this.config)
    this.tokens   = getRegistry(this.config)
    try { validateScripts(network) } catch (e) { console.warn('[sdk]', (e as Error).message) }
  }

  // ─── Pool Discovery ──────────────────────────────────────────────────────

  async getPools(opts: { excludeEmpty?: boolean } = {}): Promise<Pool[]> {
    const cells = await this.chain.getLiveCellsByType({
      codeHash: this.config.scripts.poolScript.codeHash,
      hashType:  this.config.scripts.poolScript.hashType,
      args: '0x',
    })
    const pools = cells.map(parseInfoCell)
      .filter((x): x is Pool => x !== null)
      // The pool-script enforces a 400 CKB MIN_POOL_CAPACITY floor. Legacy pools created under an
      // earlier 200 CKB floor sit below it: they are not spendable on the current binary, and a
      // CKB-native one would underflow reserveX = capacity - MIN. Drop them so the UI only surfaces
      // pools valid under the deployed contract (new pools are created via the factory).
      .filter(p => p.cell.output.capacity >= MIN_POOL_CAPACITY)
    // Reserves live in the reserve cells; hydrate them all in one scan.
    await this.hydrateAllReserves(pools)
    // Orphaned legacy pools (reserve cells stranded under an old pool-lock after a re-key)
    // hydrate to reserveX==0 or reserveY==0 with lpSupply>0. They can't be quoted or routed and only
    // pollute discovery, so callers building quotes/routes should pass { excludeEmpty: true }.
    return opts.excludeEmpty ? pools.filter(p => p.reserveX > 0n && p.reserveY > 0n) : pools
  }

  /** Fill every pool's reserveX/reserveY (and reserve cell refs) in a single indexer scan.
   *  Every reserve cell is locked by the same pool-lock code_hash; only the args (= the bound
   *  pool's info type hash) differ. So one prefix scan returns all reserve cells across all pools,
   *  and we route each to its pool by lock args instead of one exact scan per pool (N → 1). */
  private async hydrateAllReserves(pools: Pool[]): Promise<void> {
    if (pools.length === 0) return
    const byArgs = new Map<string, Pool>()   // pool-lock args (info type hash) → pool
    for (const p of pools) {
      byArgs.set(ccc.Script.from(p.cell.output.type!).hash().toLowerCase(), p)
      // CKB-native: reserveX rides on the info cell's capacity.
      if (p.poolMode === 'CKB_XUDT') p.reserveX = p.cell.output.capacity - MIN_POOL_CAPACITY
    }
    const poolLockPrefix = ccc.Script.from({
      codeHash: this.config.scripts.poolLock.codeHash as `0x${string}`,
      hashType:  this.config.scripts.poolLock.hashType as 'type',
      args:      '0x',
    })
    for await (const cell of this.chain.raw.findCells({
      script: poolLockPrefix, scriptType: 'lock', scriptSearchMode: 'prefix',
    })) {
      const pool = byArgs.get((cell.cellOutput.lock.args as string).toLowerCase())
      if (!pool) continue   // a pool-lock cell for some other (unloaded) pool
      const th = cell.cellOutput.type ? ccc.Script.from(cell.cellOutput.type).hash() : undefined
      const amt = readU128LE(stripHex(cell.outputData), 0)
      const asCell = this.toCell(cell)
      if (th === pool.tokenY) { pool.reserveY = amt; pool.reserveCellY = asCell }
      else if (pool.poolMode !== 'CKB_XUDT' && th === pool.tokenX) { pool.reserveX = amt; pool.reserveCellX = asCell }
    }
  }

  /** Normalize a ccc cell into the SDK Cell shape. */
  private toCell(c: any): Cell {
    return {
      outPoint: c.outPoint,
      output:   c.cellOutput,
      data:     c.outputData,
    } as unknown as Cell
  }

  // Per-token UDT script overrides (args → {codeHash, hashType}). Most tokens use the standard
  // xUDT script from config, but some (e.g. USDI, ccBTC) use their own UDT code hash. Register
  // those so the SDK builds the correct type script / type hash everywhere, keeping the public
  // args-based API unchanged.
  private udtRegistry = new Map<string, { codeHash: `0x${string}`; hashType: 'type' | 'data' | 'data1' }>()
  // codeHash → its on-chain code cell dep (USDI/ccBTC live at a different cell than standard xUDT).
  private udtCodeDeps = new Map<string, ccc.CellDep>()

  /** Register a token whose UDT script differs from the configured standard xUDT. Pass `dep` (the
   *  UDT code cell's outpoint) so swaps/liquidity/settlement that touch this token attach its dep. */
  registerUdt(args: TypeHash, codeHash: string, hashType: string, dep?: { txHash: string; index: number }): void {
    this.udtRegistry.set(args.toLowerCase(), { codeHash: codeHash as `0x${string}`, hashType: hashType as 'type' })
    if (dep) this.udtCodeDeps.set(codeHash.toLowerCase(),
      ccc.CellDep.from({ outPoint: { txHash: dep.txHash as `0x${string}`, index: BigInt(dep.index) }, depType: 'code' }))
  }

  /** Cell deps for any non-standard UDTs among the given type scripts (deduped by code hash). */
  private customUdtDeps(scripts: (ccc.Script | undefined)[]): ccc.CellDep[] {
    const seen = new Set<string>(), out: ccc.CellDep[] = []
    for (const s of scripts) {
      if (!s) continue
      const k = s.codeHash.toLowerCase()
      const dep = this.udtCodeDeps.get(k)
      if (dep && !seen.has(k)) { seen.add(k); out.push(dep) }
    }
    return out
  }

  /** Attach any custom-UDT code deps a built tx needs, inferred from its output type scripts. */
  private addCustomUdtDeps(tx: ccc.Transaction): void {
    for (const d of this.customUdtDeps(tx.outputs.map(o => o.type))) tx.addCellDeps(d)
  }

  /** The full UDT type script for a token (its registered code hash, else the standard xUDT). */
  udtScript(tokenArgs: TypeHash): ccc.Script {
    const o = this.udtRegistry.get(tokenArgs.toLowerCase())
    return ccc.Script.from({
      codeHash: (o?.codeHash ?? this.config.scripts.xudtScript.codeHash) as `0x${string}`,
      hashType: (o?.hashType ?? this.config.scripts.xudtScript.hashType) as 'type',
      args:     tokenArgs as `0x${string}`,
    })
  }

  /** Token identifier = an xUDT's args (its owner lock hash). This returns the xUDT
   *  type hash, which is what the pool info cell and pool-script compare on-chain.
   *  The CKB sentinel (zero) passes through unchanged for CKB-native pools. */
  udtHash(tokenArgs: TypeHash): TypeHash {
    if (tokenArgs === CKB_TYPE_HASH) return CKB_TYPE_HASH
    return this.udtScript(tokenArgs).hash() as TypeHash
  }

  /** Collect the owner's cells of `tokenType` until `needed` is covered. Returns the
   *  input refs and the surplus (`change`) to hand back as a change output. */
  private async collectUdtInputs(
    owner: ccc.Script, tokenType: ccc.Script, needed: bigint,
  ): Promise<{ inputs: any[]; change: bigint }> {
    const inputs: any[] = []
    let collected = 0n
    for await (const cell of this.chain.raw.findCells({
      script: owner, scriptType: 'lock', scriptSearchMode: 'exact',
      filter: { script: tokenType },
    })) {
      inputs.push({ previousOutput: cell.outPoint })
      collected += readU128LE(stripHex(cell.outputData), 0)
      if (collected >= needed) break
    }
    if (collected < needed) throw new Error(`Insufficient token: have ${collected}, need ${needed}`)
    return { inputs, change: collected - needed }
  }

  // ─── Optional LP time-lock (commitment) ───────────────────────────────────
  // An LP can lock their minted LP cell under the timelock-lock until a chosen epoch.
  // Lock args = owner_lock_hash(32) || deadline_epoch(8 LE). The contract requires the
  // owner to co-sign and the spending input's `since` to be an absolute epoch >= deadline.

  /** True once the timelock-lock has been deployed on this network. */
  timelockEnabled(): boolean {
    return this.config.scripts.timelockLock.codeHash !== '0x' + '0'.repeat(64)
  }

  /** Build the timelock lock script for an owner + deadline epoch. */
  private timelockScript(ownerLockHash: string, deadlineEpoch: bigint): ccc.Script {
    const s = this.config.scripts.timelockLock
    const owner = ownerLockHash.startsWith('0x') ? ownerLockHash.slice(2) : ownerLockHash
    const deadlineLE = deadlineEpoch.toString(16).padStart(16, '0').match(/../g)!.reverse().join('')
    return ccc.Script.from({
      codeHash: s.codeHash as `0x${string}`, hashType: s.hashType as 'type',
      args: ('0x' + owner + deadlineLE) as `0x${string}`,
    })
  }

  private timelockCellDep(): ccc.CellDep {
    const s = this.config.scripts.timelockLock
    return ccc.CellDep.from({ outPoint: { txHash: s.txHash as `0x${string}`, index: BigInt(s.index) }, depType: 'code' })
  }

  /** Collect the user's LP cells covering `needed`: first plain owner-locked LP, then any
   *  time-locked LP whose deadline has matured (deadline <= tipEpoch), tagging those inputs
   *  with the absolute-epoch `since` the timelock contract requires. */
  private async collectLpInputs(
    ownerScript: ccc.Script, lpToken: ccc.Script, needed: bigint, tipEpoch: bigint,
  ): Promise<{ inputs: any[]; change: bigint; usedTimelock: boolean }> {
    const SINCE_EPOCH_FLAG = 0x2000_0000_0000_0000n   // absolute, epoch-based since
    const inputs: any[] = []
    let collected = 0n
    for await (const cell of this.chain.raw.findCells({
      script: ownerScript, scriptType: 'lock', scriptSearchMode: 'exact', filter: { script: lpToken },
    })) {
      inputs.push({ previousOutput: cell.outPoint })
      collected += readU128LE(stripHex(cell.outputData), 0)
      if (collected >= needed) return { inputs, change: collected - needed, usedTimelock: false }
    }
    let usedTimelock = false
    if (this.timelockEnabled()) {
      const s = this.config.scripts.timelockLock
      const prefix = ccc.Script.from({   // args = owner lock hash → matches this owner's locked LP
        codeHash: s.codeHash as `0x${string}`, hashType: s.hashType as 'type', args: ownerScript.hash() as `0x${string}`,
      })
      for await (const cell of this.chain.raw.findCells({
        script: prefix, scriptType: 'lock', scriptSearchMode: 'prefix', filter: { script: lpToken },
      })) {
        const args = stripHex(cell.cellOutput.lock.args)
        const deadlineHex = args.slice(64, 80)   // bytes [32..40]
        const deadline = deadlineHex.length >= 2 ? BigInt('0x' + deadlineHex.match(/../g)!.reverse().join('')) : 0n
        if (deadline > tipEpoch) continue        // still locked; leave it
        inputs.push({ previousOutput: cell.outPoint, since: SINCE_EPOCH_FLAG | deadline })
        usedTimelock = true
        collected += readU128LE(stripHex(cell.outputData), 0)
        if (collected >= needed) break
      }
    }
    if (collected < needed) throw new Error(`Insufficient LP: have ${collected}, need ${needed} (time-locked LP can't be withdrawn before its deadline)`)
    return { inputs, change: collected - needed, usedTimelock }
  }

  /** All of the owner's plain (unlocked) LP cells for one pool, used to consolidate on add so a
   *  provider ends up with a single LP cell per pool instead of one per deposit (reclaims the
   *  ~144 CKB each extra cell ties up). Time-locked LP is excluded (it can't be moved). */
  private async collectAllOwnerLp(ownerScript: ccc.Script, lpToken: ccc.Script): Promise<{ inputs: any[]; total: bigint }> {
    const inputs: any[] = []
    let total = 0n
    for await (const cell of this.chain.raw.findCells({
      script: ownerScript, scriptType: 'lock', scriptSearchMode: 'exact', filter: { script: lpToken },
    })) {
      inputs.push({ previousOutput: cell.outPoint })
      total += readU128LE(stripHex(cell.outputData), 0)
    }
    return { inputs, total }
  }

  /** Permissive lock for pool info cells, so anyone can swap/add/remove against a pool
   *  (pool-script enforces the AMM rules regardless of who builds the tx). */
  private poolCellLock(): ccc.Script {
    const s = this.config.scripts.alwaysSuccess
    return ccc.Script.from({ codeHash: s.codeHash as `0x${string}`, hashType: s.hashType as 'type', args: '0x' })
  }

  async getPool(tokenX: TypeHash, tokenY: TypeHash): Promise<Pool | null> {
    const tx = this.udtHash(tokenX), ty = this.udtHash(tokenY)
    const pools = await this.getPools()
    // A pair can have duplicate pools (permissionless creation) incl. zero-reserve decoys/orphans.
    // Return the deepest one by reserve product so quoting doesn't land on an empty pool.
    const matches = pools.filter(p =>
      !p.paused && (
        (p.tokenX === tx && p.tokenY === ty) ||
        (p.tokenX === ty && p.tokenY === tx)
      )
    )
    if (matches.length === 0) return null
    return matches.reduce((best, p) =>
      (p.reserveX * p.reserveY) > (best.reserveX * best.reserveY) ? p : best)
  }

  async quoteSwap(
    tokenIn: TypeHash, amountIn: bigint, tokenOut: TypeHash, slippage = 0.005,
  ): Promise<SwapQuote> {
    return new Router(await this.getPools({ excludeEmpty: true })).quote(this.udtHash(tokenIn), this.udtHash(tokenOut), amountIn, slippage)
  }

  // ─── PATH 1: Direct atomic swap (custody-free, works with JoyID) ───────────
  //
  // The user signs the complete settlement transaction.
  // Their xUDT stays in their JoyID lock until the moment they approve.
  // The pool-script validates the AMM invariant on-chain.
  // No aggregator, no intermediate cells, no waiting.
  //
  // The pool cell's lock must be permissive (always-success or DEX admin lock).
  // This is safe because pool-script enforces all AMM rules regardless of who
  // builds the transaction, the same model as Uniswap's public swap() function.
  //
  // UX: "Swap" → review exact amounts → FaceID → done (~10s)

  async swap(
    signer: ccc.Signer,
    params: {
      tokenIn:      TypeHash
      amountIn:     bigint
      tokenOut:     TypeHash
      minAmountOut: bigint
      slippage?:    number
    },
  ): Promise<TxHash> {
    const pool = await this.getPool(params.tokenIn, params.tokenOut)
    // No direct pool → route through a base asset (CKB) in one atomic transaction.
    if (!pool) return this.swapRouted(signer, params)
    if (pool.paused) throw new Error('Pool is paused')

    // Compute exact output with current reserves
    const tokenInHash = this.udtHash(params.tokenIn)
    const [rIn, rOut] = pool.tokenX === tokenInHash
      ? [pool.reserveX, pool.reserveY]
      : [pool.reserveY, pool.reserveX]
    const amountOut = getAmountOut(params.amountIn, rIn, rOut, pool.feeBps)
    if (amountOut < params.minAmountOut) {
      throw new Error(`Slippage exceeded: expected ≥${params.minAmountOut}, got ${amountOut}`)
    }

    const epoch      = await this.chain.getTipEpoch()
    const newInfoData = encodeUpdatedInfo(pool.cell.data, epoch)

    const ownerAddr  = await signer.getRecommendedAddressObj()
    const ownerScript = ownerAddr.script

    // In a CKB/xUDT pool, the CKB side has no xUDT script or reserve cell; its value
    // rides on the info cell's capacity. The xUDT side behaves as in an xUDT/xUDT pool.
    const isCkbPool = pool.poolMode === 'CKB_XUDT'
    const inIsCkb   = isCkbPool && params.tokenIn  === CKB_TYPE_HASH
    const outIsCkb  = isCkbPool && params.tokenOut === CKB_TYPE_HASH

    const mkXudt = (args: TypeHash) => this.udtScript(args)
    const tokenInType  = inIsCkb  ? null : mkXudt(params.tokenIn)
    const tokenOutType = outIsCkb ? null : mkXudt(params.tokenOut)

    // Collect the user's tokenIn xUDT cells (unless paying in CKB, which rides on capacity).
    const xudtInputs: any[] = []
    let change = 0n
    if (tokenInType) {
      const r = await this.collectUdtInputs(ownerScript, tokenInType, params.amountIn)
      xudtInputs.push(...r.inputs)
      change = r.change
    }

    const { newInAmount, newOutAmount } =
      this.reserveDeltaForSwap(pool, params.tokenIn, params.amountIn, amountOut)

    const infoTypeHash = ccc.Script.from(pool.cell.output.type!).hash()
    const poolLock = ccc.Script.from({
      codeHash: this.config.scripts.poolLock.codeHash as `0x${string}`,
      hashType:  this.config.scripts.poolLock.hashType as 'type',
      args:      infoTypeHash as `0x${string}`,
    })

    // Inputs: info cell, pool reserve cells, user's tokenIn cells (if paying in xUDT).
    const inputs: any[] = [{ previousOutput: pool.cell.outPoint }]
    if (pool.reserveCellX) inputs.push({ previousOutput: pool.reserveCellX.outPoint })
    if (pool.reserveCellY) inputs.push({ previousOutput: pool.reserveCellY.outPoint })
    inputs.push(...xudtInputs)

    // Info cell: CKB-native reserve rides on its capacity, so adjust by the CKB delta.
    const infoCapacity = inIsCkb  ? pool.cell.output.capacity + params.amountIn
                       : outIsCkb ? pool.cell.output.capacity - amountOut
                       : pool.cell.output.capacity
    const outputs: any[] = [{
      capacity: infoCapacity,
      lock: pool.cell.output.lock as ccc.Script,
      type: pool.cell.output.type as ccc.Script,
    }]
    const outputsData: `0x${string}`[] = [newInfoData]

    // Reserve cells (xUDT sides only; the CKB side has no cell and is skipped).
    const reserveCellsOut = this.swapReserveOutputs(pool, poolLock, params.tokenIn, newInAmount, newOutAmount)
    for (const r of reserveCellsOut) { outputs.push(r.output); outputsData.push(r.data) }

    // tokenOut to the user (xUDT cell; if CKB out, the user receives CKB via the capacity drop).
    if (tokenOutType) {
      outputs.push({ capacity: XUDT_CELL_CAPACITY, lock: ownerScript, type: tokenOutType })
      outputsData.push(encodeU128LE(amountOut))
    }
    // xUDT change back to the user
    if (tokenInType && change > 0n) {
      outputs.push({ capacity: XUDT_CELL_CAPACITY, lock: ownerScript, type: tokenInType })
      outputsData.push(encodeU128LE(change))
    }

    const tx = ccc.Transaction.from({ inputs, outputs, outputsData, cellDeps: this.swapCellDeps() })
    this.addCustomUdtDeps(tx)
    await tx.completeInputsByCapacity(signer)
    await tx.completeFeeBy(signer, DEFAULT_FEE_RATE)
    return signer.sendTransaction(tx) as Promise<TxHash>
  }

  /**
   * Multi-hop swap when there's no direct pool: route tokenIn → CKB → tokenOut atomically.
   * Both hops are CKB-native pools; the intermediate CKB released by pool A's info-cell
   * capacity flows straight into pool B's info-cell capacity (net-zero between them), so the
   * whole route settles in one transaction. pool-script validates each pool independently.
   */
  async swapRouted(
    signer: ccc.Signer,
    params: { tokenIn: TypeHash; amountIn: bigint; tokenOut: TypeHash; minAmountOut: bigint; slippage?: number },
  ): Promise<TxHash> {
    const pools  = await this.getPools({ excludeEmpty: true })
    const inHash  = this.udtHash(params.tokenIn)
    const outHash = this.udtHash(params.tokenOut)
    const route = new Router(pools).quote(inHash, outHash, params.amountIn, params.slippage ?? 0.005)
    if (route.route.hops !== 2) throw new Error(`No route for ${params.tokenIn} → ${params.tokenOut}`)

    const [poolA, poolB] = route.route.pools
    const mid = route.route.path[1]
    if (!poolA || !poolB || !mid) throw new Error(`No route for ${params.tokenIn} → ${params.tokenOut}`)
    if (mid !== CKB_TYPE_HASH) throw new Error('Only CKB-routed multi-hop is supported')
    if (poolA.poolMode !== 'CKB_XUDT' || poolB.poolMode !== 'CKB_XUDT')
      throw new Error('Routed-hop pools must be CKB-native')

    // Hop A: tokenIn (xUDT) → CKB.   Hop B: CKB → tokenOut (xUDT).
    const aInIsX = poolA.tokenX === inHash
    const rAin  = aInIsX ? poolA.reserveX : poolA.reserveY
    const rAout = aInIsX ? poolA.reserveY : poolA.reserveX
    const midAmount = getAmountOut(params.amountIn, rAin, rAout, poolA.feeBps)

    const bMidIsX = poolB.tokenX === mid
    const rBin  = bMidIsX ? poolB.reserveX : poolB.reserveY      // CKB reserve
    const rBout = bMidIsX ? poolB.reserveY : poolB.reserveX      // tokenOut reserve
    const amountOut = getAmountOut(midAmount, rBin, rBout, poolB.feeBps)
    if (amountOut < params.minAmountOut)
      throw new Error(`Slippage exceeded: expected ≥${params.minAmountOut}, got ${amountOut} (routed via CKB)`)

    const owner = (await signer.getRecommendedAddressObj()).script
    const epoch = await this.chain.getTipEpoch()
    const poolLockOf = (p: Pool) => ccc.Script.from({
      codeHash: this.config.scripts.poolLock.codeHash as `0x${string}`,
      hashType: this.config.scripts.poolLock.hashType as 'type',
      args: ccc.Script.from(p.cell.output.type!).hash() as `0x${string}`,
    })
    const aType = this.udtScript(params.tokenIn)

    // The xUDT reserve cells (the non-CKB side of each CKB-native pool).
    const aResCell = (aInIsX ? poolA.reserveCellX : poolA.reserveCellY)!
    const bResCell = (bMidIsX ? poolB.reserveCellY : poolB.reserveCellX)!
    const bResAmt  = bMidIsX ? poolB.reserveY : poolB.reserveX

    // Collect the user's tokenIn cells.
    const { inputs: aInputs, change } = await this.collectUdtInputs(owner, aType, params.amountIn)

    const inputs: any[] = [
      { previousOutput: poolA.cell.outPoint },
      { previousOutput: aResCell.outPoint },
      { previousOutput: poolB.cell.outPoint },
      { previousOutput: bResCell.outPoint },
      ...aInputs,
    ]
    const outputs: any[] = [
      // pool A info: CKB out → capacity drops by midAmount
      { capacity: poolA.cell.output.capacity - midAmount, lock: poolA.cell.output.lock as ccc.Script, type: poolA.cell.output.type as ccc.Script },
      // pool A reserve (tokenIn): grows by amountIn
      { capacity: aResCell.output.capacity, lock: poolLockOf(poolA), type: aResCell.output.type as ccc.Script },
      // pool B info: CKB in → capacity rises by midAmount
      { capacity: poolB.cell.output.capacity + midAmount, lock: poolB.cell.output.lock as ccc.Script, type: poolB.cell.output.type as ccc.Script },
      // pool B reserve (tokenOut): shrinks by amountOut
      { capacity: bResCell.output.capacity, lock: poolLockOf(poolB), type: bResCell.output.type as ccc.Script },
      // tokenOut to the user
      { capacity: XUDT_CELL_CAPACITY, lock: owner, type: bResCell.output.type as ccc.Script },
    ]
    const outputsData: `0x${string}`[] = [
      encodeUpdatedInfo(poolA.cell.data, epoch),
      encodeU128LE(rAin + params.amountIn),
      encodeUpdatedInfo(poolB.cell.data, epoch),
      encodeU128LE(bResAmt - amountOut),
      encodeU128LE(amountOut),
    ]
    if (change > 0n) {
      outputs.push({ capacity: XUDT_CELL_CAPACITY, lock: owner, type: aType })
      outputsData.push(encodeU128LE(change))
    }

    const tx = ccc.Transaction.from({ inputs, outputs, outputsData, cellDeps: this.swapCellDeps() })
    this.addCustomUdtDeps(tx)
    await tx.completeInputsByCapacity(signer)
    await tx.completeFeeBy(signer, DEFAULT_FEE_RATE)
    return signer.sendTransaction(tx) as Promise<TxHash>
  }

  /** Compute which reserve grows/shrinks and to what amount, for a swap. */
  private reserveDeltaForSwap(pool: Pool, tokenIn: TypeHash, amountIn: bigint, amountOut: bigint) {
    const inIsX = pool.tokenX === this.udtHash(tokenIn)
    const rIn  = inIsX ? pool.reserveX : pool.reserveY
    const rOut = inIsX ? pool.reserveY : pool.reserveX
    return {
      inCell:  inIsX ? pool.reserveCellX : pool.reserveCellY,
      outCell: inIsX ? pool.reserveCellY : pool.reserveCellX,
      newInAmount:  rIn  + amountIn,
      newOutAmount: rOut - amountOut,
    }
  }

  /** Build updated reserve-cell outputs for a swap (CKB-native X handled via info capacity). */
  private swapReserveOutputs(
    pool: Pool, poolLock: ccc.Script, tokenIn: TypeHash, newInAmount: bigint, newOutAmount: bigint,
  ): Array<{ output: any; data: `0x${string}` }> {
    const out: Array<{ output: any; data: `0x${string}` }> = []
    const mk = (token: TypeHash, amount: bigint, cell?: Cell) => {
      if (!cell) return  // CKB-native side: no reserve cell, value tracked by info capacity
      out.push({
        output: { capacity: cell.output.capacity, lock: poolLock, type: cell.output.type as ccc.Script },
        data:   encodeU128LE(amount),
      })
    }
    const inIsX = pool.tokenX === this.udtHash(tokenIn)
    if (inIsX) { mk(pool.tokenX, newInAmount, pool.reserveCellX); mk(pool.tokenY, newOutAmount, pool.reserveCellY) }
    else       { mk(pool.tokenY, newInAmount, pool.reserveCellY); mk(pool.tokenX, newOutAmount, pool.reserveCellX) }
    return out
  }

  private swapCellDeps(): ccc.CellDep[] {
    const s = this.config.scripts
    return [
      ccc.CellDep.from({ outPoint: { txHash: s.poolScript.txHash as `0x${string}`, index: BigInt(s.poolScript.index) }, depType: 'code' }),
      ccc.CellDep.from({ outPoint: { txHash: s.poolLock.txHash   as `0x${string}`, index: BigInt(s.poolLock.index)   }, depType: 'code' }),
      ccc.CellDep.from({ outPoint: { txHash: s.xudtScript.txHash  as `0x${string}`, index: BigInt(s.xudtScript.index) }, depType: 'code' }),
      // pool info cell is always-success locked; its lock script must be available to spend it.
      ccc.CellDep.from({ outPoint: { txHash: s.alwaysSuccess.txHash as `0x${string}`, index: BigInt(s.alwaysSuccess.index) }, depType: 'code' }),
    ]
  }

  // ─── PATH 2: Async intent-lock swap ──────────────────────────────────────
  //
  // Creates an intent-lock cell, then waits for aggregator to settle.
  // Use this if user doesn't want to wait for pool availability
  // or if doing large/batched trades.

  async swapAsync(
    signer: ccc.Signer,
    params: {
      tokenIn:      TypeHash
      amountIn:     bigint
      tokenOut:     TypeHash
      minAmountOut: bigint
      deadlineEpochs?: number
    },
  ): Promise<TxHash> {
    const ownerAddr   = await signer.getRecommendedAddressObj()
    const ownerScript = ownerAddr.script
    const ownerLockHash = ccc.hashCkb(ownerScript.toBytes()) as TypeHash

    const epoch    = await this.chain.getTipEpoch()
    const deadline = params.deadlineEpochs ? epoch + BigInt(params.deadlineEpochs) : 0n

    const lockArgs = encodeIntentLockArgs({
      ownerLockHash,
      minAmountOut:     params.minAmountOut,
      tokenOutTypeHash: this.udtHash(params.tokenOut),
      deadlineEpoch:    deadline,
      solverFeeBps:     0,
      otxLockCodeHash:  this.config.scripts.cellswapOtxLock?.codeHash as TypeHash | undefined,
    })

    const intentLock = ccc.Script.from({
      codeHash: this.config.scripts.intentLock.codeHash as `0x${string}`,
      hashType:  this.config.scripts.intentLock.hashType as 'type',
      args:      lockArgs,
    })

    const xudtType = this.udtScript(params.tokenIn)

    // Lock the user's real tokenIn into the intent cell (collect inputs + return change),
    // rather than relying on xUDT owner-mode minting.
    const outputs: any[] = [{ capacity: MIN_INTENT_CAPACITY, lock: intentLock, type: xudtType }]
    const outputsData: `0x${string}`[] = [encodeU128LE(params.amountIn)]
    const { inputs: udtIns, change } = await this.collectUdtInputs(ownerScript, xudtType, params.amountIn)
    if (change > 0n) { outputs.push({ capacity: XUDT_CELL_CAPACITY, lock: ownerScript, type: xudtType }); outputsData.push(encodeU128LE(change)) }

    const tx = ccc.Transaction.from({ inputs: udtIns, outputs, outputsData })

    await tx.addCellDepsOfKnownScripts(signer.client, ccc.KnownScript.XUdt)
    tx.addCellDeps({
      outPoint: { txHash: this.config.scripts.intentLock.txHash as `0x${string}`, index: this.config.scripts.intentLock.index },
      depType: 'code',
    })
    this.addCustomUdtDeps(tx)
    await tx.completeInputsByCapacity(signer)
    await tx.completeFeeBy(signer, DEFAULT_FEE_RATE)
    return signer.sendTransaction(tx) as Promise<TxHash>
  }

  // ─── Create a new liquidity pool ─────────────────────────────────────────
  //
  // Creates a pool cell with initial liquidity. The creator becomes the first LP.
  // The info cell records the full lp_supply = sqrt(x*y), but the creator is minted only
  // sqrt(x*y) - MINIMUM_LIQUIDITY (1000); the locked 1000 has no backing LP cell, so it is
  // permanently unredeemable (the on-chain inflation guard).
  //
  // For xUDT/xUDT pools: provide both token amounts.
  // For CKB/xUDT pools: tokenX = CKB (zero hash), amountX = CKB amount.

  async createPool(
    signer: ccc.Signer,
    params: {
      tokenX:   TypeHash      // use CKB_TYPE_HASH (zero) for CKB-native pool
      tokenY:   TypeHash
      amountX:  bigint
      amountY:  bigint
      feeBps:   number        // 5 (stable), 30 (standard), 100 (exotic)
      poolId?:  bigint        // ignored when config.factoryCell is set (pool_id := registry next_id)
      treasuryLock?: ccc.Script  // where protocol-fee LP is minted (sets the pool's treasury arg)
      protocolFeeOn?: boolean    // start with the protocol fee enabled (k_last = √k of initial reserves)
    },
  ): Promise<TxHash> {
    // CKB-native pools must have CKB as tokenX (reserveX rides on the info-cell capacity).
    // Normalize if a caller passes CKB as tokenY so pool creation is order-agnostic.
    if (params.tokenY === CKB_TYPE_HASH && params.tokenX !== CKB_TYPE_HASH) {
      params = { ...params, tokenX: params.tokenY, tokenY: params.tokenX, amountX: params.amountY, amountY: params.amountX }
    }
    const ownerAddr = await signer.getRecommendedAddressObj()
    const scripts   = this.config.scripts
    const isCkbNative = params.tokenX === CKB_TYPE_HASH

    const initialLp = isqrt(params.amountX * params.amountY)
    if (initialLp <= 1000n) throw new Error('Initial liquidity too low (need sqrt(x*y) > 1000)')
    // pool-script rejects fee_bps >= 10000 on-chain (it would underflow the AMM fee math); guard early.
    if (params.feeBps >= 10000) throw new Error('feeBps must be < 10000 (10000 bps = 100%)')

    const treasuryHash = params.treasuryLock?.hash() ?? this.treasuryLockHash ?? ('0x' + '0'.repeat(64))
    const xudt = (token: TypeHash) => this.udtScript(token)

    // ── Collect the deposit token inputs first so input[0] is fixed before we derive the pool's
    //    type-id. The type-id depends on input[0], and the whole pool structure (pool-lock, lp-token,
    //    reserve cells) depends on the resulting info type hash, so the order matters. CCC's
    //    completeInputsByUdt adds no change output, so we collect manually and return the surplus.
    const udtInputs: any[] = []
    const changeOuts: { type: ccc.Script; amount: bigint }[] = []
    const collect = async (tokenType: ccc.Script, needed: bigint) => {
      let collected = 0n
      for await (const cell of this.chain.raw.findCells({
        script: ownerAddr.script, scriptType: 'lock', scriptSearchMode: 'exact',
        filter: { script: tokenType },
      })) {
        udtInputs.push({ previousOutput: cell.outPoint })
        collected += readU128LE(stripHex(cell.outputData), 0)
        if (collected >= needed) break
      }
      if (collected < needed) throw new Error(`Insufficient deposit token: have ${collected}, need ${needed}`)
      if (collected > needed) changeOuts.push({ type: tokenType, amount: collected - needed })
    }
    if (!isCkbNative) await collect(xudt(params.tokenX), params.amountX)
    await collect(xudt(params.tokenY), params.amountY)
    const firstInput = udtInputs[0]
    if (!firstInput) throw new Error('createPool: need at least one deposit token cell to anchor the pool type-id')

    // ── Cross-pool LP drain: the pool info cell must be a true type-id singleton, else two
    //    pools could share a type hash and their LP tokens would be the
    //    same fungible xUDT (cheap LP from a junk twin drains a valuable pool). Derive the type-id =
    //    blake2b("ckb-default-hash", first_input ‖ output_index 0) and place it in the pool args
    //    [96..128]; pool-script::verify_pool_creation enforces the match. completeInputsByCapacity
    //    only appends, so the info cell stays output 0 and udtInputs[0] stays input 0.
    const typeId = ccc.hashCkb(
      ccc.CellInput.from({ previousOutput: firstInput.previousOutput, since: 0n }).toBytes(),
      ccc.numLeToBytes(0n, 8),
    )
    // Info cell type args (128 bytes): pool_lock_code_hash(32) || lp_token_code_hash(32) ||
    // treasury_lock_hash(32) || type_id(32). pool-script reads [0..96] on every op and the type-id at
    // [96..128] only at creation. The 16-byte pool_id stays in the info data for display/routing.
    const poolArgs = stripHex(scripts.poolLock.codeHash) + stripHex(scripts.lpTokenScript.codeHash)
      + stripHex(treasuryHash) + stripHex(typeId)
    const poolType = ccc.Script.from({
      codeHash: scripts.poolScript.codeHash as `0x${string}`,
      hashType:  scripts.poolScript.hashType as 'type',
      args: ('0x' + poolArgs) as `0x${string}`,
    })
    const infoTypeHash = poolType.hash()

    // Reserve cells are locked by pool-lock bound to this info cell; LP is bound to it too.
    const poolLock = ccc.Script.from({
      codeHash: scripts.poolLock.codeHash as `0x${string}`,
      hashType:  scripts.poolLock.hashType as 'type',
      args:      infoTypeHash as `0x${string}`,
    })
    const lpToken = ccc.Script.from({
      codeHash: scripts.lpTokenScript.codeHash as `0x${string}`,
      hashType:  scripts.lpTokenScript.hashType as 'type',
      args:      infoTypeHash as `0x${string}`,
    })

    // Register the pool in the canonical factory singleton (on-chain one-pool-per-(pair,fee)).
    // Locate the live registry cell by its type, append our (pair,fee) entry, take pool_id from
    // next_id. pool-script::verify_pool_creation requires this exact registration, and factory-script
    // rejects a duplicate (pair,fee) on the spend. Null on networks without a configured factory.
    const txTokenHash = isCkbNative ? CKB_TYPE_HASH : this.udtHash(params.tokenX)
    const tyTokenHash = this.udtHash(params.tokenY)
    const reg = await this.buildFactoryRegistration(txTokenHash, tyTokenHash, params.feeBps)
    const poolId = reg ? reg.poolId : (params.poolId ?? 0n)

    const kLast = params.protocolFeeOn ? sqrtK(params.amountX, params.amountY) : 0n
    const infoData = encodeInfoData({
      tokenX: txTokenHash,
      tokenY: tyTokenHash,
      feeBps: params.feeBps, lpSupply: initialLp, poolId,
      poolMode: isCkbNative ? 1 : 0, kLast,
    })

    // Info-cell occupied capacity: with the 128-byte type-id args + 156B data + the permissive lock
    // the cell occupies ~378 CKB. Allocate above that. CKB-native: tokenX reserve rides on +amountX.
    const INFO_CELL_CAPACITY = 40_000_000_000n  // 400 CKB
    const poolCapacity = isCkbNative ? MIN_POOL_CAPACITY + params.amountX : INFO_CELL_CAPACITY
    const RESERVE_CELL_CAPACITY = 16_000_000_000n  // 160 CKB

    // Info cell uses a permissive lock so anyone can swap against the pool (public DEX). It is output 0.
    const outputs: any[] = [{ capacity: poolCapacity, lock: this.poolCellLock(), type: poolType }]
    const outputsData: `0x${string}`[] = [infoData]
    if (!isCkbNative) {
      outputs.push({ capacity: RESERVE_CELL_CAPACITY, lock: poolLock, type: xudt(params.tokenX) })
      outputsData.push(encodeU128LE(params.amountX))
    }
    outputs.push({ capacity: RESERVE_CELL_CAPACITY, lock: poolLock, type: xudt(params.tokenY) })
    outputsData.push(encodeU128LE(params.amountY))
    // The info cell records the full lp_supply (initialLp), but only initialLp - MINIMUM_LIQUIDITY
    // is minted to the creator. The locked 1000 has no backing LP cell, so it is permanently
    // unredeemable (pool-script + lp-token enforce circulating == lp_supply - 1000 at genesis).
    outputs.push({ capacity: XUDT_CELL_CAPACITY, lock: ownerAddr.script, type: lpToken })
    outputsData.push(encodeU128LE(initialLp - 1000n))
    for (const ch of changeOuts) {
      outputs.push({ capacity: RESERVE_CELL_CAPACITY, lock: ownerAddr.script, type: ch.type })
      outputsData.push(encodeU128LE(ch.amount))
    }
    // The recreated factory cell is appended last (info cell stays output 0 for the type-id), and
    // the factory input is appended after the deposit inputs (udtInputs[0] stays input 0).
    if (reg) { outputs.push(reg.output); outputsData.push(reg.outData) }

    const tx = ccc.Transaction.from({ inputs: reg ? [...udtInputs, reg.input] : udtInputs, outputs, outputsData })

    await tx.addCellDepsOfKnownScripts(signer.client, ccc.KnownScript.XUdt)
    tx.addCellDeps(
      ccc.CellDep.from({ outPoint: { txHash: scripts.poolScript.txHash as `0x${string}`, index: BigInt(scripts.poolScript.index) }, depType: 'code' }),
      ccc.CellDep.from({ outPoint: { txHash: scripts.poolLock.txHash   as `0x${string}`, index: BigInt(scripts.poolLock.index)   }, depType: 'code' }),
      ccc.CellDep.from({ outPoint: { txHash: scripts.lpTokenScript.txHash as `0x${string}`, index: BigInt(scripts.lpTokenScript.index) }, depType: 'code' }),
    )
    if (reg) {
      tx.addCellDeps(reg.dep)
      // The factory cell is spent here; its permissive (always-success) lock must resolve too.
      tx.addCellDeps(ccc.CellDep.from({ outPoint: { txHash: scripts.alwaysSuccess.txHash as `0x${string}`, index: BigInt(scripts.alwaysSuccess.index) }, depType: 'code' }))
    }
    this.addCustomUdtDeps(tx)
    await tx.completeInputsByCapacity(signer)
    await tx.completeFeeBy(signer, DEFAULT_FEE_RATE)
    return signer.sendTransaction(tx) as Promise<TxHash>
  }

  /** Build the canonical-factory register-pool transition (spend the singleton + recreate it with
   *  the appended (pool_id, tokenX, tokenY, fee) entry, next_id += 1). The recreated cell tops up +90
   *  CKB to cover the new entry's bytes, and keeps the same (permissive) lock so creation stays
   *  permissionless. Returns null when `config.factoryCell` is unset (legacy/devnet path). Throws on a
   *  duplicate (pair,fee), a client-side mirror of factory-script's on-chain rejection. */
  private async buildFactoryRegistration(
    txTokenHash: TypeHash, tyTokenHash: TypeHash, feeBps: number,
  ): Promise<{ input: any; output: any; outData: `0x${string}`; dep: ccc.CellDep; poolId: bigint } | null> {
    const facCfg = this.config.factoryCell
    if (!facCfg) return null
    const facType = ccc.Script.from(facCfg as any)
    let fac: any = null
    for await (const cell of this.chain.raw.findCells({ script: facType, scriptType: 'type', scriptSearchMode: 'exact' })) {
      fac = cell; break
    }
    if (!fac) throw new Error('createPool: canonical factory cell not found on-chain (genesis it first)')
    const data = stripHex(fac.outputData)
    const FAC_HEADER = 81, ENTRY = 90
    const nextId = readU128LE(data, 0)
    const dupTx = stripHex(txTokenHash), dupTy = stripHex(tyTokenHash)
    // client-side duplicate guard (factory-script also rejects this on-chain).
    for (let o = FAC_HEADER; o + ENTRY <= byteLen(data); o += ENTRY) {
      const exTx = data.slice((o + 16) * 2, (o + 48) * 2)
      const exTy = data.slice((o + 48) * 2, (o + 80) * 2)
      const exFee = readU16LE(data, o + 80)
      const samePair = (exTx === dupTx && exTy === dupTy) || (exTx === dupTy && exTy === dupTx)
      if (samePair && exFee === feeBps) {
        throw new Error(`createPool: a pool for this pair + ${feeBps}bps already exists (pool_id ${readU128LE(data, o)})`)
      }
    }
    // append the 90-byte entry: pool_id(16) || tokenX(32) || tokenY(32) || fee(2 LE) || reserved(8).
    const feeLo = (feeBps & 0xff).toString(16).padStart(2, '0')
    const feeHi = ((feeBps >> 8) & 0xff).toString(16).padStart(2, '0')
    const entryHex = stripHex(encodeU128LE(nextId)) + dupTx + dupTy + feeLo + feeHi + '00'.repeat(8)
    const outData = ('0x' + stripHex(encodeU128LE(nextId + 1n)) + data.slice(32) + entryHex) as `0x${string}`
    const dep = ccc.CellDep.from({
      outPoint: {
        txHash: this.config.scripts.factoryScript.txHash as `0x${string}`,
        index: BigInt(this.config.scripts.factoryScript.index),
      },
      depType: 'code',
    })
    return {
      input: { previousOutput: fac.outPoint },
      output: {
        capacity: BigInt(fac.cellOutput.capacity) + 9_000_000_000n, // +90 CKB for the appended entry
        lock: fac.cellOutput.lock,
        type: fac.cellOutput.type,
      },
      outData,
      dep,
      poolId: nextId,
    }
  }

  // ─── Add liquidity to an existing pool ────────────────────────────────────
  //
  // Deposits tokenX and tokenY, mints LP tokens.
  // LP minted = min(dx·lpSupply/reserveX, dy·lpSupply/reserveY), matching pool-script.

  async addLiquidity(
    signer: ccc.Signer,
    params: { tokenX: TypeHash; tokenY: TypeHash; amountX: bigint; amountY: bigint; minLpOut?: bigint; lockEpochs?: number },
  ): Promise<TxHash> {
    const pool = await this.getPool(params.tokenX, params.tokenY)
    if (!pool) throw new Error(`No pool for ${params.tokenX}/${params.tokenY}`)
    // Orient the caller's (tokenX, tokenY) amounts onto the pool's own (tokenX, tokenY) ordering.
    const [dx, dy] = pool.tokenX === this.udtHash(params.tokenX)
      ? [params.amountX, params.amountY] : [params.amountY, params.amountX]
    return this.addLiquidityToPool(signer, pool, {
      amountX: dx, amountY: dy, minLpOut: params.minLpOut, lockEpochs: params.lockEpochs,
    })
  }

  /** Add liquidity to an already-resolved pool. `amountX`/`amountY` are oriented to the pool's own
   *  tokenX/tokenY (amountX is the deposit for `pool.tokenX`). Reuses the pool's real reserve-cell
   *  type scripts, so it works for non-curated / unusual-args tokens, for the same reason as
   *  `removeLiquidityFromPool`. The frontend already holds the `Pool`, so pass it straight through. */
  async addLiquidityToPool(
    signer: ccc.Signer,
    pool: Pool,
    params: { amountX: bigint; amountY: bigint; minLpOut?: bigint; lockEpochs?: number },
  ): Promise<TxHash> {
    if (pool.paused) throw new Error('Pool is paused')
    const dx = params.amountX, dy = params.amountY

    const lpFromX = dx * pool.lpSupply / pool.reserveX
    const lpFromY = dy * pool.lpSupply / pool.reserveY
    const lpMinted = lpFromX < lpFromY ? lpFromX : lpFromY
    if (lpMinted === 0n) throw new Error('Deposit too small to mint LP')
    if (params.minLpOut && lpMinted < params.minLpOut)
      throw new Error(`LP slippage: would mint ${lpMinted}, min ${params.minLpOut}`)

    const owner   = await signer.getRecommendedAddressObj()
    const scripts = this.config.scripts
    const epoch   = await this.chain.getTipEpoch()
    // Fee-on pools advance k_last to √k of the post-deposit reserves on every liquidity event.
    const kLast = readKLast(pool.cell.data)
    let newKLast: bigint | undefined
    if (kLast !== 0n) {
      if (protocolFeeLp(pool.lpSupply, sqrtK(pool.reserveX, pool.reserveY), kLast) > 0n)
        throw new Error('Uncollected protocol fee: call collectFees before adding to this pool')
      newKLast = sqrtK(pool.reserveX + dx, pool.reserveY + dy)
    }
    const newInfoData = encodeInfoWithSupply(pool.cell.data, pool.lpSupply + lpMinted, epoch, newKLast)

    const infoTypeHash = ccc.Script.from(pool.cell.output.type!).hash()
    const poolLock = ccc.Script.from({
      codeHash: scripts.poolLock.codeHash as `0x${string}`,
      hashType:  scripts.poolLock.hashType as 'type', args: infoTypeHash as `0x${string}`,
    })
    const lpToken = ccc.Script.from({
      codeHash: scripts.lpTokenScript.codeHash as `0x${string}`,
      hashType:  scripts.lpTokenScript.hashType as 'type',
      args:      infoTypeHash as `0x${string}`,
    })

    // Inputs: info + reserve cells; deposit tokens collected by CCC.
    const inputs: any[] = [{ previousOutput: pool.cell.outPoint }]
    if (pool.reserveCellX) inputs.push({ previousOutput: pool.reserveCellX.outPoint })
    if (pool.reserveCellY) inputs.push({ previousOutput: pool.reserveCellY.outPoint })

    // Outputs: info', grown reserve cells, LP to user.
    const outputs: any[] = [
      { capacity: pool.cell.output.capacity + (pool.poolMode === 'CKB_XUDT' ? dx : 0n),
        lock: pool.cell.output.lock as ccc.Script, type: pool.cell.output.type as ccc.Script },
    ]
    const outputsData: `0x${string}`[] = [newInfoData]
    if (pool.reserveCellX) {  // xUDT/xUDT: grow reserve X
      outputs.push({ capacity: pool.reserveCellX.output.capacity, lock: poolLock, type: pool.reserveCellX.output.type as ccc.Script })
      outputsData.push(encodeU128LE(pool.reserveX + dx))
    }
    if (pool.reserveCellY) {
      outputs.push({ capacity: pool.reserveCellY.output.capacity, lock: poolLock, type: pool.reserveCellY.output.type as ccc.Script })
      outputsData.push(encodeU128LE(pool.reserveY + dy))
    }
    // Optional commitment: lock the minted LP under the timelock-lock until tipEpoch + lockEpochs.
    // The timelock cell carries 40-byte args (vs ~20 for the owner lock), so it needs a bit more
    // capacity than a plain owner-locked LP cell.
    let lpLock = owner.script
    let lpCapacity = XUDT_CELL_CAPACITY
    let lpOut = lpMinted
    if (params.lockEpochs && params.lockEpochs > 0) {
      if (!this.timelockEnabled()) throw new Error('LP time-lock is not available on this network yet')
      lpLock = this.timelockScript(owner.script.hash(), epoch + BigInt(params.lockEpochs))
      lpCapacity = 16_500_000_000n
    } else {
      // Consolidate: fold the owner's existing unlocked LP for this pool into the new mint, so they
      // keep one LP cell per pool (lp-token is delta-based, so output=existing+minted is a valid
      // mint of exactly `minted`). Skipped when locking, so unlocked LP isn't swept into a lock.
      const merge = await this.collectAllOwnerLp(owner.script, lpToken)
      inputs.push(...merge.inputs)
      lpOut += merge.total
    }
    outputs.push({ capacity: lpCapacity, lock: lpLock, type: lpToken })
    outputsData.push(encodeU128LE(lpOut))

    // Supply the deposit tokens as inputs (xUDT conservation: deposit in = reserve growth).
    // xUDT/xUDT: collect tokenX and tokenY from the user, returning any surplus as change.
    // CKB-native X: dx is CKB, supplied via completeInputsByCapacity into the info cell.
    const depositToken = async (reserveCell: Cell, amount: bigint) => {
      const type = reserveCell.output.type as ccc.Script
      const { inputs: ins, change } = await this.collectUdtInputs(owner.script, type, amount)
      inputs.push(...ins)
      if (change > 0n) { outputs.push({ capacity: XUDT_CELL_CAPACITY, lock: owner.script, type }); outputsData.push(encodeU128LE(change)) }
    }
    if (pool.reserveCellX) await depositToken(pool.reserveCellX, dx)
    if (pool.reserveCellY) await depositToken(pool.reserveCellY, dy)

    const tx = ccc.Transaction.from({ inputs, outputs, outputsData, cellDeps: this.swapCellDeps() })
    await tx.addCellDepsOfKnownScripts(signer.client, ccc.KnownScript.XUdt)
    tx.addCellDeps(ccc.CellDep.from({ outPoint: { txHash: scripts.lpTokenScript.txHash as `0x${string}`, index: BigInt(scripts.lpTokenScript.index) }, depType: 'code' }))
    this.addCustomUdtDeps(tx)
    await tx.completeInputsByCapacity(signer)
    await tx.completeFeeBy(signer, DEFAULT_FEE_RATE)
    return signer.sendTransaction(tx) as Promise<TxHash>
  }

  // ─── Remove liquidity from a pool ─────────────────────────────────────────
  //
  // Burns LP tokens, returns tokenX and tokenY proportional to share.

  async removeLiquidity(
    signer: ccc.Signer,
    params: { tokenX: TypeHash; tokenY: TypeHash; lpAmount: bigint; minAmountX?: bigint; minAmountY?: bigint },
  ): Promise<TxHash> {
    const pool = await this.getPool(params.tokenX, params.tokenY)
    if (!pool) throw new Error(`No pool for ${params.tokenX}/${params.tokenY}`)
    return this.removeLiquidityFromPool(signer, pool, params)
  }

  /** Remove liquidity from an already-resolved pool. Unlike `removeLiquidity`, this never rebuilds a
   *  token script from `args` + the pinned xUDT code; it reuses the pool's real reserve-cell type
   *  scripts, so it works even for pools whose token isn't a standard CellSwap xUDT (non-curated, or
   *  unusual args). The frontend already holds the `Pool` (from getLpPositions/getPools), so pass it
   *  straight through and skip the args→type-hash round-trip that can't resolve such pools. */
  async removeLiquidityFromPool(
    signer: ccc.Signer,
    pool: Pool,
    params: { lpAmount: bigint; minAmountX?: bigint; minAmountY?: bigint },
  ): Promise<TxHash> {
    if (pool.lpSupply === 0n) throw new Error('Pool has no liquidity')

    const outX = pool.reserveX * params.lpAmount / pool.lpSupply
    const outY = pool.reserveY * params.lpAmount / pool.lpSupply
    if (outX === 0n || outY === 0n) throw new Error('LP amount too small')
    if (params.minAmountX && outX < params.minAmountX) throw new Error(`X slippage: ${outX} < ${params.minAmountX}`)
    if (params.minAmountY && outY < params.minAmountY) throw new Error(`Y slippage: ${outY} < ${params.minAmountY}`)

    // CKB-native floor: the CKB reserve rides on the info cell's capacity, which can never drop
    // below the cell's own occupied size. Withdrawing past that → node InsufficientCellCapacity.
    if (pool.poolMode === 'CKB_XUDT') {
      const infoOccupied = occupiedCapacity(pool.cell)
      if (pool.cell.output.capacity - outX < infoOccupied) {
        const maxLp = this.maxRemovableLp(pool)
        throw new Error(`Withdrawal exceeds the pool's CKB floor (the pool cell must keep ${infoOccupied / 100_000_000n} CKB). Remove at most ${maxLp} LP.`)
      }
    }

    const owner   = await signer.getRecommendedAddressObj()
    const scripts = this.config.scripts
    const epoch   = await this.chain.getTipEpoch()
    // Fee-on pools advance k_last to √k of the post-removal reserves on every liquidity event. If
    // protocol fee has accrued since the last collection, sweep it first (collectFees); this path
    // doesn't mint to the treasury, so it must start from a freshly-collected k_last.
    const kLast = readKLast(pool.cell.data)
    let newKLast: bigint | undefined
    if (kLast !== 0n) {
      if (protocolFeeLp(pool.lpSupply, sqrtK(pool.reserveX, pool.reserveY), kLast) > 0n)
        throw new Error('Uncollected protocol fee: call collectFees before removing from this pool')
      newKLast = sqrtK(pool.reserveX - outX, pool.reserveY - outY)
    }
    const newInfoData = encodeInfoWithSupply(pool.cell.data, pool.lpSupply - params.lpAmount, epoch, newKLast)

    const infoTypeHash = ccc.Script.from(pool.cell.output.type!).hash()
    const poolLock = ccc.Script.from({
      codeHash: scripts.poolLock.codeHash as `0x${string}`,
      hashType:  scripts.poolLock.hashType as 'type', args: infoTypeHash as `0x${string}`,
    })
    const lpToken = ccc.Script.from({
      codeHash: scripts.lpTokenScript.codeHash as `0x${string}`,
      hashType:  scripts.lpTokenScript.hashType as 'type', args: infoTypeHash as `0x${string}`,
    })

    // Inputs: info + reserve cells + the user's LP token cells (burned).
    const inputs: any[] = [{ previousOutput: pool.cell.outPoint }]
    if (pool.reserveCellX) inputs.push({ previousOutput: pool.reserveCellX.outPoint })
    if (pool.reserveCellY) inputs.push({ previousOutput: pool.reserveCellY.outPoint })

    // Outputs: info', shrunk reserve cells, tokens returned to user.
    const outputs: any[] = [
      { capacity: pool.cell.output.capacity - (pool.poolMode === 'CKB_XUDT' ? outX : 0n),
        lock: pool.cell.output.lock as ccc.Script, type: pool.cell.output.type as ccc.Script },
    ]
    const outputsData: `0x${string}`[] = [newInfoData]
    if (pool.reserveCellX) {
      outputs.push({ capacity: pool.reserveCellX.output.capacity, lock: poolLock, type: pool.reserveCellX.output.type as ccc.Script })
      outputsData.push(encodeU128LE(pool.reserveX - outX))
    }
    if (pool.reserveCellY) {
      outputs.push({ capacity: pool.reserveCellY.output.capacity, lock: poolLock, type: pool.reserveCellY.output.type as ccc.Script })
      outputsData.push(encodeU128LE(pool.reserveY - outY))
    }
    // Return tokenX (skip for CKB-native: CKB returns via capacity/change) and tokenY,
    // using the reserve cells' real xUDT type scripts (can't rebuild them from a type hash).
    if (pool.poolMode !== 'CKB_XUDT' && pool.reserveCellX) {
      outputs.push({ capacity: XUDT_CELL_CAPACITY, lock: owner.script, type: pool.reserveCellX.output.type as ccc.Script })
      outputsData.push(encodeU128LE(outX))
    }
    if (pool.reserveCellY) {
      outputs.push({ capacity: XUDT_CELL_CAPACITY, lock: owner.script, type: pool.reserveCellY.output.type as ccc.Script })
      outputsData.push(encodeU128LE(outY))
    }

    // Burn LP: collect the user's LP cells covering lpAmount (plain owner-locked first, then any
    // matured time-locked LP), returning surplus as change. completeInputsByCapacity adds an
    // owner-locked fee input, which also satisfies the timelock contract's owner co-sign check.
    const { inputs: lpIns, change: lpChange, usedTimelock } = await this.collectLpInputs(owner.script, lpToken, params.lpAmount, epoch)
    inputs.push(...lpIns)
    if (lpChange > 0n) { outputs.push({ capacity: XUDT_CELL_CAPACITY, lock: owner.script, type: lpToken }); outputsData.push(encodeU128LE(lpChange)) }

    const tx = ccc.Transaction.from({ inputs, outputs, outputsData, cellDeps: this.swapCellDeps() })
    await tx.addCellDepsOfKnownScripts(signer.client, ccc.KnownScript.XUdt)
    tx.addCellDeps(ccc.CellDep.from({ outPoint: { txHash: scripts.lpTokenScript.txHash as `0x${string}`, index: BigInt(scripts.lpTokenScript.index) }, depType: 'code' }))
    if (usedTimelock) tx.addCellDeps(this.timelockCellDep())
    this.addCustomUdtDeps(tx)
    await tx.completeInputsByCapacity(signer)
    await tx.completeFeeBy(signer, DEFAULT_FEE_RATE)
    return signer.sendTransaction(tx) as Promise<TxHash>
  }

  /** The protocol-fee √k snapshot of a pool (0 = fee off). */
  poolKLast(pool: Pool): bigint { return readKLast(pool.cell.data) }

  /** Pending protocol fee LP a `collectFees` would mint to the treasury right now. */
  pendingProtocolFee(pool: Pool): bigint {
    const kLast = readKLast(pool.cell.data)
    return protocolFeeLp(pool.lpSupply, sqrtK(pool.reserveX, pool.reserveY), kLast)
  }

  /** Permissionlessly sweep a pool's accrued protocol fee to the treasury: mints the protocol's
   *  1/6 cut of √k growth as LP to a `treasuryLock`-locked cell and advances k_last. Reserves are
   *  untouched (a pure fee collection). Requires the pool to have the fee switch on (k_last != 0)
   *  and `treasuryLock` to match the pool's treasury arg. */
  async collectFees(signer: ccc.Signer, params: { tokenX: TypeHash; tokenY: TypeHash; treasuryLock: ccc.Script }): Promise<TxHash> {
    const pool = await this.getPool(params.tokenX, params.tokenY)
    if (!pool) throw new Error('No pool for that pair')
    const kLast = readKLast(pool.cell.data)
    if (kLast === 0n) throw new Error('Protocol fee is not enabled on this pool')
    const rootK = sqrtK(pool.reserveX, pool.reserveY)
    const feeLp = protocolFeeLp(pool.lpSupply, rootK, kLast)
    if (feeLp === 0n) throw new Error('No protocol fee accrued yet')

    const scripts = this.config.scripts
    const infoTypeHash = ccc.Script.from(pool.cell.output.type!).hash()
    const poolLock = ccc.Script.from({ codeHash: scripts.poolLock.codeHash as `0x${string}`, hashType: scripts.poolLock.hashType as 'type', args: infoTypeHash as `0x${string}` })
    const lpToken = ccc.Script.from({ codeHash: scripts.lpTokenScript.codeHash as `0x${string}`, hashType: scripts.lpTokenScript.hashType as 'type', args: infoTypeHash as `0x${string}` })

    // info + reserve cells in; same out (reserves unchanged), advancing lp_supply + k_last; plus the
    // newly minted treasury LP cell.
    const inputs: any[] = [{ previousOutput: pool.cell.outPoint }]
    if (pool.reserveCellX) inputs.push({ previousOutput: pool.reserveCellX.outPoint })
    if (pool.reserveCellY) inputs.push({ previousOutput: pool.reserveCellY.outPoint })

    const outputs: any[] = [{ capacity: pool.cell.output.capacity, lock: pool.cell.output.lock as ccc.Script, type: pool.cell.output.type as ccc.Script }]
    const outputsData: `0x${string}`[] = [encodeInfoCollect(pool.cell.data, pool.lpSupply + feeLp, rootK)]
    if (pool.reserveCellX) {
      outputs.push({ capacity: pool.reserveCellX.output.capacity, lock: poolLock, type: pool.reserveCellX.output.type as ccc.Script })
      outputsData.push(encodeU128LE(pool.reserveX))
    }
    if (pool.reserveCellY) {
      outputs.push({ capacity: pool.reserveCellY.output.capacity, lock: poolLock, type: pool.reserveCellY.output.type as ccc.Script })
      outputsData.push(encodeU128LE(pool.reserveY))
    }
    outputs.push({ capacity: 16_000_000_000n, lock: params.treasuryLock, type: lpToken })  // minted treasury LP
    outputsData.push(encodeU128LE(feeLp))

    const tx = ccc.Transaction.from({ inputs, outputs, outputsData, cellDeps: this.swapCellDeps() })
    await tx.addCellDepsOfKnownScripts(signer.client, ccc.KnownScript.XUdt)
    tx.addCellDeps(ccc.CellDep.from({ outPoint: { txHash: scripts.lpTokenScript.txHash as `0x${string}`, index: BigInt(scripts.lpTokenScript.index) }, depType: 'code' }))
    this.addCustomUdtDeps(tx)
    await tx.completeInputsByCapacity(signer)
    await tx.completeFeeBy(signer, DEFAULT_FEE_RATE)
    return signer.sendTransaction(tx) as Promise<TxHash>
  }

  /** Max LP that can be burned against a pool before the CKB-native info cell would drop
   *  below its on-chain occupied capacity. xUDT/xUDT pools have no such floor (reserves live
   *  in fixed-capacity cells), so the whole supply is removable. */
  maxRemovableLp(pool: Pool): bigint {
    if (pool.poolMode !== 'CKB_XUDT' || pool.reserveX === 0n) return pool.lpSupply
    const maxOutX = pool.cell.output.capacity - occupiedCapacity(pool.cell)
    if (maxOutX <= 0n) return 0n
    const lp = maxOutX * pool.lpSupply / pool.reserveX
    return lp > pool.lpSupply ? pool.lpSupply : lp
  }

  // ─── View a user's LP positions ───────────────────────────────────────────

  async getLpPositions(signer: ccc.Signer): Promise<Array<{
    pool: Pool; lpAmount: bigint; shareOfPool: number; valueX: bigint; valueY: bigint
    lockedUntilEpoch?: bigint; locked?: boolean
  }>> {
    const owner = await signer.getRecommendedAddressObj()
    const pools = await this.getPools()
    const tipEpoch = await this.chain.getTipEpoch()
    // Each addLiquidity mints a separate LP cell (UTXO model: no in-place increment), so a user
    // accumulates several LP cells per pool. Collect them per cell, then aggregate below.
    const raw: Array<{ pool: Pool; lpAmount: bigint; lockedUntilEpoch?: bigint; locked: boolean }> = []
    const lpScript = {
      codeHash: this.config.scripts.lpTokenScript.codeHash as `0x${string}`,
      hashType:  this.config.scripts.lpTokenScript.hashType as 'type',
      args: '0x' as `0x${string}`,
    }
    const collect = (cell: any, lockedUntilEpoch?: bigint) => {
      const lpAmount = readU128LE(stripHex(cell.outputData), 0)
      if (lpAmount === 0n) return
      const lpArgs = cell.cellOutput.type?.args ?? '0x'
      const pool = pools.find(p => p.cell.output.type && ccc.Script.from(p.cell.output.type).hash() === lpArgs) ?? pools[0]
      if (!pool || pool.lpSupply === 0n) return
      raw.push({ pool, lpAmount, lockedUntilEpoch, locked: lockedUntilEpoch != null && lockedUntilEpoch > tipEpoch })
    }

    // Plain owner-locked LP cells.
    for await (const cell of this.chain.raw.findCells({
      script: owner.script, scriptType: 'lock', scriptSearchMode: 'exact', filter: { script: lpScript },
    })) collect(cell)

    // Time-locked LP cells (commitment): read each one's unlock epoch.
    if (this.timelockEnabled()) {
      const s = this.config.scripts.timelockLock
      const prefix = ccc.Script.from({
        codeHash: s.codeHash as `0x${string}`, hashType: s.hashType as 'type', args: owner.script.hash() as `0x${string}`,
      })
      for await (const cell of this.chain.raw.findCells({
        script: prefix, scriptType: 'lock', scriptSearchMode: 'prefix', filter: { script: lpScript },
      })) {
        const args = stripHex(cell.cellOutput.lock.args)
        const deadlineHex = args.slice(64, 80)   // bytes [32..40]
        const deadline = deadlineHex.length >= 2 ? BigInt('0x' + deadlineHex.match(/../g)!.reverse().join('')) : 0n
        collect(cell, deadline)
      }
    }

    // Aggregate into logical positions: all removable cells of a pool (plain + matured locks)
    // merge into one; cells still locked stay split by unlock epoch (they mature independently).
    const groups = new Map<string, { pool: Pool; lpAmount: bigint; lockedUntilEpoch?: bigint; locked: boolean }>()
    for (const r of raw) {
      const key = r.pool.poolId.toString() + '|' + (r.locked ? r.lockedUntilEpoch!.toString() : 'open')
      const g = groups.get(key)
      if (g) g.lpAmount += r.lpAmount
      else groups.set(key, { pool: r.pool, lpAmount: r.lpAmount, lockedUntilEpoch: r.locked ? r.lockedUntilEpoch : undefined, locked: r.locked })
    }
    return [...groups.values()].map(g => ({
      pool: g.pool, lpAmount: g.lpAmount,
      shareOfPool: Number(g.lpAmount) / Number(g.pool.lpSupply),
      valueX: g.pool.reserveX * g.lpAmount / g.pool.lpSupply,
      valueY: g.pool.reserveY * g.lpAmount / g.pool.lpSupply,
      lockedUntilEpoch: g.lockedUntilEpoch, locked: g.locked,
    }))
  }

  /** Current tip epoch number (for time-lock countdowns / deadlines). */
  async tipEpoch(): Promise<bigint> {
    return this.chain.getTipEpoch()
  }

  // ─── Paid token registration (verified badge) ──────────────────────────────
  // A project registers its own xUDT, proving control of the owner lock (xUDT args = owner lock
  // hash) and paying a fee to the treasury, to earn a verified listing. Trading stays permissionless.

  /** True once the token-registry has been deployed on this network. */
  registryEnabled(): boolean {
    return this.config.scripts.tokenRegistry.codeHash !== '0x' + '0'.repeat(64)
  }

  /** Register the signer's own token (its xUDT args = the signer's lock hash), storing metadata
   *  on-chain for the verified badge. The contract enforces the owner co-sign; if a `treasuryLock`
   *  + `feeShannons` are given it also enforces that fee is paid (omit both for a free registration). */
  async registerToken(
    signer: ccc.Signer,
    params: { decimals: number; symbol: string; name: string; link?: string; treasuryLock?: ccc.Script; feeShannons?: bigint },
  ): Promise<TxHash> {
    if (!this.registryEnabled()) throw new Error('Token registry is not deployed on this network yet')
    const s = this.config.scripts.tokenRegistry
    const owner = await signer.getRecommendedAddressObj()
    const ownerHash = owner.script.hash()                                   // = the xUDT's args
    const tokenTypeHash = this.udtHash(ownerHash as TypeHash)               // the registered token's type hash
    // Platform registration fee → the protocol treasury (config.registry), unless the caller overrides.
    // token-registry pins the floor (MIN_REGISTRATION_FEE) and the PLATFORM_TREASURY on-chain, so a
    // hand-built tx cannot set fee=0 or redirect it. config.registry.feeShannons
    // must be >= the contract floor and .treasury must equal the pinned PLATFORM_TREASURY.
    const reg = this.config.registry
    const treasuryScript = params.treasuryLock ?? (reg ? ccc.Script.from(reg.treasury as any) : undefined)
    const fee = treasuryScript ? (params.feeShannons ?? reg?.feeShannons ?? 0n) : 0n
    const treasuryHash = treasuryScript ? treasuryScript.hash() : ('0x' + '0'.repeat(64))
    const feeLE = fee.toString(16).padStart(16, '0').match(/../g)!.reverse().join('')
    const args = ('0x' + stripHex(treasuryHash) + feeLE + stripHex(tokenTypeHash)) as `0x${string}`
    const regType = ccc.Script.from({ codeHash: s.codeHash as `0x${string}`, hashType: s.hashType as 'type', args })

    // data = owner_lock_hash(32) || decimals(1) || sym(len8‖bytes) || name(len8‖bytes) || link(len16LE‖bytes)
    const ascii = (str: string) => [...str].map(c => c.charCodeAt(0) & 0xff)
    const ownerBytes = stripHex(ownerHash).match(/../g)!.map(h => parseInt(h, 16))
    const sym = ascii(params.symbol), name = ascii(params.name), link = ascii(params.link ?? '')
    const bytes: number[] = [...ownerBytes, params.decimals & 0xff,
      sym.length & 0xff, ...sym, name.length & 0xff, ...name, link.length & 0xff, (link.length >> 8) & 0xff, ...link]
    const data = ('0x' + bytes.map(b => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`

    const outputs: any[] = [{ capacity: 25_000_000_000n, lock: owner.script, type: regType }] // registration cell
    const outputsData: `0x${string}`[] = [data]
    if (fee > 0n && treasuryScript) {
      outputs.push({ capacity: fee, lock: treasuryScript })                 // the fee → platform treasury
      outputsData.push('0x')
    }
    const tx = ccc.Transaction.from({
      outputs, outputsData,
      cellDeps: [ccc.CellDep.from({ outPoint: { txHash: s.txHash as `0x${string}`, index: BigInt(s.index) }, depType: 'code' })],
    })
    await tx.completeInputsByCapacity(signer)   // owner inputs satisfy both capacity and the co-sign
    await tx.completeFeeBy(signer, DEFAULT_FEE_RATE)
    return signer.sendTransaction(tx) as Promise<TxHash>
  }

  /** All on-chain token registrations (permissionless read), not keyed; the caller matches by
   *  tokenTypeHash. A registration is trustworthy iff ownerLockHash == the token's xUDT args. */
  async getRegistrations(): Promise<TokenRegistration[]> {
    if (!this.registryEnabled()) return []
    const s = this.config.scripts.tokenRegistry
    const prefix = ccc.Script.from({ codeHash: s.codeHash as `0x${string}`, hashType: s.hashType as 'type', args: '0x' })
    const out: TokenRegistration[] = []
    for await (const cell of this.chain.raw.findCells({ script: prefix, scriptType: 'type', scriptSearchMode: 'prefix' })) {
      const args = stripHex(cell.cellOutput.type!.args)
      if (args.length < 144) continue
      const tokenTypeHash = '0x' + args.slice(80, 144)              // bytes [40..72]
      const d = stripHex(cell.outputData)
      if (d.length < 64) continue
      const b = d.match(/../g)!.map(h => parseInt(h, 16))
      const str = (arr: number[]) => arr.map(c => String.fromCharCode(c)).join('')
      let o = 32
      const ownerLockHash = '0x' + d.slice(0, 64)
      const decimals = b[o] ?? 8; o += 1
      const symLen = b[o] ?? 0; o += 1
      const symbol = str(b.slice(o, o + symLen)); o += symLen
      const nameLen = b[o] ?? 0; o += 1
      const name = str(b.slice(o, o + nameLen)); o += nameLen
      const linkLen = (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8); o += 2
      const link = str(b.slice(o, o + linkLen))
      // Verified-badge shadowing: the token-registry create path does not bind owner_lock_hash to
      // token_type_hash, so anyone can mint a shadow registration claiming a victim's token_type_hash
      // with their own owner_lock_hash. A last-write-wins reader would let that shadow strip the
      // genuine issuer's paid badge. Drop self-inconsistent cells
      // here: a genuine registration's owner_lock_hash (= the token's xUDT args) must derive the
      // claimed token_type_hash. udtHash(owner_lock_hash) != token_type_hash ⇒ a shadow ⇒ ignore.
      if (this.udtHash(ownerLockHash as TypeHash).toLowerCase() !== tokenTypeHash.toLowerCase()) continue
      out.push({
        tokenTypeHash, ownerLockHash, decimals, symbol, name, link,
        outPoint: { txHash: cell.outPoint.txHash as TxHash, index: Number(cell.outPoint.index) },
      })
    }
    return out
  }

  // ─── xUDT staking (receipt + custody, self-advancing accumulator) ───────────
  // Users stake an xUDT and earn CKB rewards streamed from the pool's reward reserve, distributed
  // pro-rata + time-weighted via a MasterChef accumulator. Security: positions are receipt+custody
  // cells forced (by stake-guard) through the stake-pool type script, which pins acc_at_touch at
  // creation and bounds every reward release to the accrued pending.

  /** True once both staking scripts are deployed on this network. */
  stakingEnabled(): boolean {
    const empty = '0x' + '0'.repeat(64)
    return this.config.scripts.stakePool.codeHash !== empty
        && this.config.scripts.stakeGuard.codeHash !== empty
  }

  private stakePoolDep(): ccc.CellDep {
    const s = this.config.scripts.stakePool
    return ccc.CellDep.from({ outPoint: { txHash: s.txHash as `0x${string}`, index: BigInt(s.index) }, depType: 'code' })
  }
  private stakeGuardDep(): ccc.CellDep {
    const s = this.config.scripts.stakeGuard
    return ccc.CellDep.from({ outPoint: { txHash: s.txHash as `0x${string}`, index: BigInt(s.index) }, depType: 'code' })
  }
  /** Cell dep for the pool cell's always-success lock, needed to spend the pool. */
  private poolCellLockDep(): ccc.CellDep {
    const s = this.config.scripts.alwaysSuccess
    return ccc.CellDep.from({ outPoint: { txHash: s.txHash as `0x${string}`, index: BigInt(s.index) }, depType: 'code' })
  }
  /** Cell deps shared by every staking op that spends the pool: pool, guard, pool-lock. */
  private stakeOpDeps(): ccc.CellDep[] {
    return [this.stakePoolDep(), this.stakeGuardDep(), this.poolCellLockDep()]
  }

  /** The stake-guard script (used as a receipt type and a custody lock), bound to a pool + owner. */
  private stakeGuardScript(poolTypeHash: string, ownerLockHash: string): ccc.Script {
    const s = this.config.scripts.stakeGuard
    return ccc.Script.from({
      codeHash: s.codeHash as `0x${string}`, hashType: s.hashType as 'type',
      args: ('0x' + stripHex(poolTypeHash) + stripHex(ownerLockHash)) as `0x${string}`,
    })
  }

  /** True once the lock-boost composed custody lock (stake-timelock-guard) is deployed on this network. */
  lockBoostEnabled(): boolean {
    const g = this.config.scripts.stakeTimelockGuard
    return !!g && g.codeHash !== '0x' + '0'.repeat(64)
  }
  private stakeTimelockGuardDep(): ccc.CellDep {
    const s = this.config.scripts.stakeTimelockGuard!
    return ccc.CellDep.from({ outPoint: { txHash: s.txHash as `0x${string}`, index: BigInt(s.index) }, depType: 'code' })
  }
  /** The composed timelock custody lock for a locked position: pool_type_hash(32) || owner_lock_hash(32)
   *  || deadline_epoch(8 LE). Matches stake-timelock-guard args and mining-pool::find_custody. */
  private stakeTimelockGuardScript(poolTypeHash: string, ownerLockHash: string, deadlineEpoch: bigint): ccc.Script {
    const s = this.config.scripts.stakeTimelockGuard!
    const d = new Uint8Array(8); writeU64LE(d, deadlineEpoch, 0)
    return ccc.Script.from({
      codeHash: s.codeHash as `0x${string}`, hashType: s.hashType as 'type',
      args: ('0x' + stripHex(poolTypeHash) + stripHex(ownerLockHash) + uint8ArrayToHex(d)) as `0x${string}`,
    })
  }

  /** Advance the accumulator off-chain exactly as the contract does (so built outputs match). */
  private foldStakePool(p: StakePoolState, now: bigint): { acc: bigint; reserve: bigint } {
    if (p.paused || p.total === 0n || now <= p.lastEpoch) return { acc: p.acc, reserve: p.reserve }
    const elapsed = now - p.lastEpoch
    let streamed = p.reserve * BigInt(p.emissionBps) * elapsed / 10_000n
    if (streamed > p.reserve) streamed = p.reserve
    return { acc: p.acc + streamed * STAKE_ACC_PRECISION / p.total, reserve: p.reserve - streamed }
  }

  private parseStakePool(cell: any): StakePoolState {
    const d = stripHex(cell.outputData)
    return {
      stakeToken:  readBytes32(d, SP_STAKE_TOKEN_OFF),
      total:       readU128LE(d, SP_TOTAL_OFF),
      acc:         readU128LE(d, SP_ACC_OFF),
      reserve:     readU128LE(d, SP_RESERVE_OFF),
      lastEpoch:   readU64LE(d, SP_LAST_EPOCH_OFF),
      emissionBps: readU16LE(d, SP_EMISSION_OFF),
      paused:      readU8(d, SP_PAUSED_OFF) !== 0,
      poolTypeHash: ccc.Script.from(cell.cellOutput.type).hash(),
      cell:        this.toCell(cell),
    }
  }

  /** The (v1: single) staking pool. Optionally filter by the staked token (its SDK args id). */
  async getStakePool(stakeToken?: TypeHash): Promise<StakePoolState | null> {
    if (!this.stakingEnabled()) return null
    const s = this.config.scripts.stakePool
    const wantHash = stakeToken ? this.udtHash(stakeToken) : undefined
    const prefix = ccc.Script.from({ codeHash: s.codeHash as `0x${string}`, hashType: s.hashType as 'type', args: '0x' })
    for await (const cell of this.chain.raw.findCells({ script: prefix, scriptType: 'type', scriptSearchMode: 'prefix' })) {
      if (stripHex(cell.outputData).length < SP_DATA_SIZE * 2) continue
      const p = this.parseStakePool(cell)
      if (!wantHash || p.stakeToken === wantHash) return p
    }
    return null
  }

  /** Find the stake pool in which `ownerLockHash` actually holds a position. Stake pools are
   *  per-token, so resolving the owner's position via "the first pool found" (getStakePool()'s
   *  default) is wrong when more than one stake pool exists: the owner's receipt lives in exactly
   *  one of them, and a position staked into a non-first pool would be invisible (un-readable,
   *  un-claimable, un-unstakeable) through the SDK. With `stakeToken` given, only that token's pool
   *  is considered; otherwise every pool is scanned and the first one carrying the owner's receipt is
   *  returned. Returns null if the owner has no position in any (matching) pool. */
  private async findOwnerStakePosition(
    ownerLockHash: string, stakeToken?: TypeHash,
  ): Promise<{
    pool: StakePoolState
    found: { amount: bigint; accAtTouch: bigint; receipt: any; custody: any; tokenScript: ccc.Script }
  } | null> {
    if (!this.stakingEnabled()) return null
    const s = this.config.scripts.stakePool
    const wantHash = stakeToken ? this.udtHash(stakeToken) : undefined
    const prefix = ccc.Script.from({ codeHash: s.codeHash as `0x${string}`, hashType: s.hashType as 'type', args: '0x' })
    for await (const cell of this.chain.raw.findCells({ script: prefix, scriptType: 'type', scriptSearchMode: 'prefix' })) {
      if (stripHex(cell.outputData).length < SP_DATA_SIZE * 2) continue
      const pool = this.parseStakePool(cell)
      if (wantHash && pool.stakeToken !== wantHash) continue
      const found = await this.findPositionCells(pool, ownerLockHash)
      if (found) return { pool, found }
    }
    return null
  }

  /** Create the staking pool (genesis): seeds the reward reserve with `initialRewardCkb` CKB and
   *  sets the emission rate. `stakeToken` is the xUDT (SDK args id) users will stake. */
  async createStakePool(
    signer: ccc.Signer,
    params: { stakeToken: TypeHash; emissionBps: number; initialRewardCkb: bigint; seed?: string },
  ): Promise<TxHash> {
    if (!this.stakingEnabled()) throw new Error('Staking is not deployed on this network yet')
    const s = this.config.scripts.stakePool
    const stakeTokenHash = this.udtHash(params.stakeToken)
    // The stake-pool requires args[32..64] to be the canonical CKB type-id of the genesis cell,
    // blake2b("ckb-default-hash", first_input ‖ output_index_LE), so its type hash is globally
    // unique and no "twin" pool can collide with it
    // (see contracts/stake-pool::check_type_id). We build the cell with a placeholder type-id, fix
    // the inputs, then compute the real type-id from input[0] + output index 0 and write it back. The
    // placeholder and real args are both 96 bytes, so the occupied capacity is unchanged.
    // Governance: args[64..96] = the governance authority lock hash. A reward-emitting stake-pool
    // is created only under that authority, so the signer here must be the governance authority (its
    // funding inputs satisfy the on-chain authority_cosigns check).
    const guard = stripHex(this.config.scripts.stakeGuard.codeHash)
    const gov = this.governanceLockHash
    if (!gov || gov === '0x' + '0'.repeat(64)) {
      throw new Error('createStakePool: set a governance authority first (setMultisigGovernance); reward pools are governance-gated')
    }
    const govHex = stripHex(gov)
    const placeholder = ('0x' + guard + '0'.repeat(64) + govHex) as `0x${string}`
    const now = await this.chain.getTipEpoch()
    const data = encodeStakePoolData({
      stakeToken: stakeTokenHash, total: 0n, acc: 0n, reserve: params.initialRewardCkb,
      lastEpoch: now, emissionBps: params.emissionBps, paused: 0,
    })
    const tx = ccc.Transaction.from({
      outputs: [{
        capacity: MIN_STAKEPOOL_CAPACITY + params.initialRewardCkb,
        lock: this.poolCellLock(),
        type: ccc.Script.from({ codeHash: s.codeHash as `0x${string}`, hashType: s.hashType as 'type', args: placeholder }),
      }],
      outputsData: [data],
      cellDeps: [this.stakePoolDep()],
    })
    await tx.completeInputsByCapacity(signer)
    // The genesis pool cell is output 0; input[0] is now fixed. completeFeeBy only appends, so neither
    // index shifts. hashCkb concatenates its args, matching the contract's blake2b over (input‖index).
    const firstInput = tx.inputs[0]
    if (!firstInput) throw new Error('stake-pool genesis: no input cell after completion')
    const typeId = ccc.hashCkb(firstInput.toBytes(), ccc.numLeToBytes(0n, 8))
    tx.outputs[0]!.type = ccc.Script.from({
      codeHash: s.codeHash as `0x${string}`, hashType: s.hashType as 'type',
      args: ('0x' + guard + stripHex(typeId) + govHex) as `0x${string}`,
    })
    await tx.completeFeeBy(signer, DEFAULT_FEE_RATE)
    return signer.sendTransaction(tx) as Promise<TxHash>
  }

  /** Permissionlessly add CKB to the reward reserve (treasury keeper or anyone). */
  async fundStakePool(signer: ccc.Signer, amountCkb: bigint): Promise<TxHash> {
    const pool = await this.getStakePool()
    if (!pool) throw new Error('No staking pool')
    const header = await this.chain.raw.getTipHeader()
    const now = BigInt((header as any).epoch[0])
    const { acc, reserve } = this.foldStakePool(pool, now)
    const data = encodeStakePoolData({
      stakeToken: pool.stakeToken, total: pool.total, acc, reserve: reserve + amountCkb,
      lastEpoch: now, emissionBps: pool.emissionBps, paused: pool.paused ? 1 : 0,
    })
    const tx = ccc.Transaction.from({
      inputs: [{ previousOutput: pool.cell.outPoint }],
      outputs: [{ capacity: pool.cell.output.capacity + amountCkb, lock: pool.cell.output.lock as ccc.Script, type: pool.cell.output.type as ccc.Script }],
      outputsData: [data],
      cellDeps: [this.stakePoolDep(), this.poolCellLockDep()],
      headerDeps: [(header as any).hash as `0x${string}`],
    })
    await tx.completeInputsByCapacity(signer)
    await tx.completeFeeBy(signer, DEFAULT_FEE_RATE)
    return signer.sendTransaction(tx) as Promise<TxHash>
  }

  /** The owner's stake position (if any): principal + the pending CKB reward accrued to the tip. */
  async getStakePosition(signer: ccc.Signer, stakeToken?: TypeHash): Promise<StakePosition | null> {
    const owner = await signer.getRecommendedAddressObj()
    const res = await this.findOwnerStakePosition(owner.script.hash(), stakeToken)
    if (!res) return null
    const { pool, found } = res
    const now = await this.chain.getTipEpoch()
    const { acc } = this.foldStakePool(pool, now)
    const pending = found.amount * (acc - found.accAtTouch) / STAKE_ACC_PRECISION
    return { amount: found.amount, pending: pending > 0n ? pending : 0n, pool }
  }

  /** Locate the owner's receipt + custody cells for a pool. */
  private async findPositionCells(
    pool: StakePoolState, ownerLockHash: string,
  ): Promise<{ amount: bigint; accAtTouch: bigint; receipt: any; custody: any; tokenScript: ccc.Script } | null> {
    const guard = this.stakeGuardScript(pool.poolTypeHash, ownerLockHash)
    const guardHash = guard.hash()
    // Receipt: lock = owner lock hash, type = guard. We search by type=guard (prefix) and match owner.
    let receipt: any = null, amount = 0n, accAtTouch = 0n
    for await (const cell of this.chain.raw.findCells({ script: guard, scriptType: 'type', scriptSearchMode: 'exact' })) {
      if (ccc.Script.from(cell.cellOutput.lock).hash() !== ownerLockHash) continue
      receipt = cell
      const d = stripHex(cell.outputData)
      amount = readU128LE(d, 0); accAtTouch = readU128LE(d, 16)
      break
    }
    if (!receipt) return null
    // Custody: lock = guard, type hash = pool.stakeToken.
    let custody: any = null, tokenScript: ccc.Script | null = null
    for await (const cell of this.chain.raw.findCells({ script: guard, scriptType: 'lock', scriptSearchMode: 'exact' })) {
      const ty = cell.cellOutput.type
      if (!ty || ccc.Script.from(ty).hash() !== pool.stakeToken) continue
      custody = cell; tokenScript = ccc.Script.from(ty); break
    }
    if (!custody || !tokenScript) return null
    void guardHash
    return { amount, accAtTouch, receipt, custody, tokenScript }
  }

  /** Stake `amount` of the pool's token. Creates a fresh position or adds to an existing one
   *  (harvesting any pending reward to the owner in the same tx). */
  async stake(signer: ccc.Signer, params: { token: TypeHash; amount: bigint }): Promise<TxHash> {
    const pool = await this.getStakePool(params.token)
    if (!pool) throw new Error('No staking pool for this token')
    if (params.amount <= 0n) throw new Error('amount must be positive')
    const owner = await signer.getRecommendedAddressObj()
    const ownerHash = owner.script.hash()
    const tokenScript = this.udtScript(params.token)

    const header = await this.chain.raw.getTipHeader()
    const now = BigInt((header as any).epoch[0])
    const { acc, reserve } = this.foldStakePool(pool, now)

    const existing = await this.findPositionCells(pool, ownerHash)
    const oldAmount = existing?.amount ?? 0n
    const newAmount = oldAmount + params.amount
    const pending = existing ? oldAmount * (acc - existing.accAtTouch) / STAKE_ACC_PRECISION : 0n

    const guard = this.stakeGuardScript(pool.poolTypeHash, ownerHash)
    const inputs: any[] = [{ previousOutput: pool.cell.outPoint }]
    if (existing) { inputs.push({ previousOutput: existing.receipt.outPoint }); inputs.push({ previousOutput: existing.custody.outPoint }) }

    // Outputs: pool' (cap drops by harvested pending), receipt', custody'.
    const outputs: any[] = [{
      capacity: pool.cell.output.capacity - pending,
      lock: pool.cell.output.lock as ccc.Script, type: pool.cell.output.type as ccc.Script,
    }]
    const outputsData: `0x${string}`[] = [encodeStakePoolData({
      stakeToken: pool.stakeToken, total: pool.total + params.amount, acc, reserve,
      lastEpoch: now, emissionBps: pool.emissionBps, paused: pool.paused ? 1 : 0,
    })]
    outputs.push({ capacity: STAKE_CELL_CAPACITY, lock: owner.script, type: guard })
    outputsData.push(encodeReceiptData(newAmount, acc))
    outputs.push({ capacity: STAKE_CELL_CAPACITY, lock: guard, type: tokenScript })
    outputsData.push(encodeU128LE(newAmount))

    // Supply the new principal as xUDT inputs (the old custody, if any, already covers oldAmount).
    const { inputs: tokIns, change } = await this.collectUdtInputs(owner.script, tokenScript, params.amount)
    inputs.push(...tokIns)
    if (change > 0n) { outputs.push({ capacity: XUDT_CELL_CAPACITY, lock: owner.script, type: tokenScript }); outputsData.push(encodeU128LE(change)) }

    const tx = ccc.Transaction.from({ inputs, outputs, outputsData,
      cellDeps: this.stakeOpDeps(), headerDeps: [(header as any).hash as `0x${string}`] })
    await tx.addCellDepsOfKnownScripts(signer.client, ccc.KnownScript.XUdt)
    this.addCustomUdtDeps(tx)
    await tx.completeInputsByCapacity(signer)
    await tx.completeFeeBy(signer, DEFAULT_FEE_RATE)
    return signer.sendTransaction(tx) as Promise<TxHash>
  }

  /** Unstake `amount` (or all) of the owner's position, returning principal + pending reward. */
  async unstake(signer: ccc.Signer, params: { amount: bigint; token?: TypeHash }): Promise<TxHash> {
    const owner = await signer.getRecommendedAddressObj()
    const ownerHash = owner.script.hash()
    const res = await this.findOwnerStakePosition(ownerHash, params.token)
    if (!res) throw new Error('No stake position')
    const { pool, found: existing } = res
    if (params.amount <= 0n || params.amount > existing.amount) throw new Error('Invalid unstake amount')

    const header = await this.chain.raw.getTipHeader()
    const now = BigInt((header as any).epoch[0])
    const { acc, reserve } = this.foldStakePool(pool, now)
    const pending = existing.amount * (acc - existing.accAtTouch) / STAKE_ACC_PRECISION
    const remaining = existing.amount - params.amount
    const tokenScript = existing.tokenScript
    const guard = this.stakeGuardScript(pool.poolTypeHash, ownerHash)

    const inputs: any[] = [
      { previousOutput: pool.cell.outPoint },
      { previousOutput: existing.receipt.outPoint },
      { previousOutput: existing.custody.outPoint },
    ]
    const outputs: any[] = [{
      capacity: pool.cell.output.capacity - pending,
      lock: pool.cell.output.lock as ccc.Script, type: pool.cell.output.type as ccc.Script,
    }]
    const outputsData: `0x${string}`[] = [encodeStakePoolData({
      stakeToken: pool.stakeToken, total: pool.total - params.amount, acc, reserve,
      lastEpoch: now, emissionBps: pool.emissionBps, paused: pool.paused ? 1 : 0,
    })]
    // Recreate the position only if some principal remains.
    if (remaining > 0n) {
      outputs.push({ capacity: STAKE_CELL_CAPACITY, lock: owner.script, type: guard })
      outputsData.push(encodeReceiptData(remaining, acc))
      outputs.push({ capacity: STAKE_CELL_CAPACITY, lock: guard, type: tokenScript })
      outputsData.push(encodeU128LE(remaining))
    }
    // Return the withdrawn principal as xUDT to the owner.
    outputs.push({ capacity: XUDT_CELL_CAPACITY, lock: owner.script, type: tokenScript })
    outputsData.push(encodeU128LE(params.amount))

    const tx = ccc.Transaction.from({ inputs, outputs, outputsData,
      cellDeps: this.stakeOpDeps(), headerDeps: [(header as any).hash as `0x${string}`] })
    await tx.addCellDepsOfKnownScripts(signer.client, ccc.KnownScript.XUdt)
    this.addCustomUdtDeps(tx)
    await tx.completeInputsByCapacity(signer)
    await tx.completeFeeBy(signer, DEFAULT_FEE_RATE)
    return signer.sendTransaction(tx) as Promise<TxHash>
  }

  /** Harvest the pending reward, leaving the principal staked (= unstake of 0 principal). */
  async claim(signer: ccc.Signer, stakeToken?: TypeHash): Promise<TxHash> {
    const owner = await signer.getRecommendedAddressObj()
    const ownerHash = owner.script.hash()
    const res = await this.findOwnerStakePosition(ownerHash, stakeToken)
    if (!res) throw new Error('No stake position')
    const { pool, found: existing } = res

    const header = await this.chain.raw.getTipHeader()
    const now = BigInt((header as any).epoch[0])
    const { acc, reserve } = this.foldStakePool(pool, now)
    const pending = existing.amount * (acc - existing.accAtTouch) / STAKE_ACC_PRECISION
    if (pending <= 0n) throw new Error('Nothing to claim yet')
    const tokenScript = existing.tokenScript
    const guard = this.stakeGuardScript(pool.poolTypeHash, ownerHash)

    const inputs: any[] = [
      { previousOutput: pool.cell.outPoint },
      { previousOutput: existing.receipt.outPoint },
      { previousOutput: existing.custody.outPoint },
    ]
    const outputs: any[] = [{
      capacity: pool.cell.output.capacity - pending,
      lock: pool.cell.output.lock as ccc.Script, type: pool.cell.output.type as ccc.Script,
    }]
    const outputsData: `0x${string}`[] = [encodeStakePoolData({
      stakeToken: pool.stakeToken, total: pool.total, acc, reserve,
      lastEpoch: now, emissionBps: pool.emissionBps, paused: pool.paused ? 1 : 0,
    })]
    outputs.push({ capacity: STAKE_CELL_CAPACITY, lock: owner.script, type: guard })
    outputsData.push(encodeReceiptData(existing.amount, acc))   // acc_at_touch advanced; principal kept
    outputs.push({ capacity: STAKE_CELL_CAPACITY, lock: guard, type: tokenScript })
    outputsData.push(encodeU128LE(existing.amount))

    const tx = ccc.Transaction.from({ inputs, outputs, outputsData,
      cellDeps: this.stakeOpDeps(), headerDeps: [(header as any).hash as `0x${string}`] })
    await tx.addCellDepsOfKnownScripts(signer.client, ccc.KnownScript.XUdt)
    this.addCustomUdtDeps(tx)
    await tx.completeInputsByCapacity(signer)
    await tx.completeFeeBy(signer, DEFAULT_FEE_RATE)
    return signer.sendTransaction(tx) as Promise<TxHash>
  }

  /** Pool-wide staking stats: total staked, reward reserve, and the CKB streamed per epoch. */
  async getStakeStats(): Promise<{ totalStaked: bigint; rewardReserve: bigint; emissionBps: number; rewardPerEpochCkb: bigint } | null> {
    const pool = await this.getStakePool()
    if (!pool) return null
    const now = await this.chain.getTipEpoch()
    const { reserve } = this.foldStakePool(pool, now)
    return {
      totalStaked: pool.total, rewardReserve: reserve, emissionBps: pool.emissionBps,
      rewardPerEpochCkb: reserve * BigInt(pool.emissionBps) / 10_000n,
    }
  }

  // ─── Liquidity mining (stake CKB/xUDT LP → earn minted VTX) ────────────────
  // Reuses stake-guard for receipt+custody. Reward is VTX minted at an absolute emission rate;
  // a claim mints exactly the accrued pending, authorized by spending the emission-authority cell
  // (whose emission-lock requires a mining pool in the tx). Governance (the authority lock) gates
  // pool creation + emission changes.

  miningEnabled(): boolean {
    const empty = '0x' + '0'.repeat(64)
    return this.config.scripts.miningPool.codeHash !== empty
        && this.config.scripts.emissionLock.codeHash !== empty
  }

  private miningPoolDep(): ccc.CellDep {
    const s = this.config.scripts.miningPool
    return ccc.CellDep.from({ outPoint: { txHash: s.txHash as `0x${string}`, index: BigInt(s.index) }, depType: 'code' })
  }
  private emissionLockDep(): ccc.CellDep {
    const s = this.config.scripts.emissionLock
    return ccc.CellDep.from({ outPoint: { txHash: s.txHash as `0x${string}`, index: BigInt(s.index) }, depType: 'code' })
  }

  /** Governance: make the protocol authority an M-of-N secp256k1-multisig. Sets
   *  `governanceLockHash` to the multisig lock hash, so emission-lock (→ VTX's owner), every mining
   *  pool's authority, `setEmission` (halving/de-list), and the factory pause-authority all bind to
   *  the same multisig. Also records the config needed to build (externally M-of-N-signed) governance
   *  ops. The actual signing is a ceremony with the real keys, not done here.
   *  This lock hash determines VTX's identity, so on mainnet it must be the multisig chosen at
   *  genesis; changing it later re-keys VTX. Returns the authority script/hash for factory genesis. */
  setMultisigGovernance(params: { signerBlake160s: string[]; threshold: number; requireFirstN?: number }):
    { lockHash: `0x${string}`; script: ccc.Script; multisigArgs: `0x${string}` } {
    const m = computeMultisigAuthority(params)
    this.governanceLockHash = m.lockHash
    this.governanceMultisig = {
      signerBlake160s: params.signerBlake160s, threshold: params.threshold,
      requireFirstN: params.requireFirstN ?? 0, script: m.script,
    }
    return m
  }

  /** The FactoryData header that binds the current governance authority as the factory's pause
   *  authority. Use at factory genesis so pause/global-pause is M-of-N-gated by the same
   *  multisig as emissions. Requires a governance authority to be set (setMultisigGovernance). */
  factoryGenesisData(poolScriptHash: string, nextPoolId = 0n): `0x${string}` {
    if (!this.governanceLockHash) throw new Error('set a governance authority first (setMultisigGovernance)')
    return encodeFactoryData({
      poolScriptHash: poolScriptHash as `0x${string}`,
      pauseAuthorityLockHash: this.governanceLockHash as `0x${string}`,
      nextPoolId,
    })
  }

  /** The VTX mint authority lock (its hash = VTX's owner). Bound to the mining-pool code. */
  emissionLockScript(): ccc.Script {
    const s = this.config.scripts.emissionLock
    // emission-lock takes 64-byte args = mining_pool_code_hash(32) || governance_authority_lock_hash(32),
    // and authorizes a mint only when the spent mining pool carries that same governance authority
    // (which mining-pool genesis requires to co-sign). A forged pool either carries a different
    // authority (rejected) or the real one, for which an attacker cannot obtain a genesis co-sign.
    // These args determine emission-lock's hash = VTX's owner, so changing `governanceLockHash`
    // re-keys VTX (a coordinated cutover).
    const g = this.governanceLockHash
    if (!g) throw new Error('emission-lock needs a governance authority: set sdk.governanceLockHash first')
    return ccc.Script.from({
      codeHash: s.codeHash as `0x${string}`, hashType: s.hashType as 'type',
      args: ('0x' + stripHex(this.config.scripts.miningPool.codeHash) + stripHex(g)) as `0x${string}`,
    })
  }
  /** The VTX reward token (a standard xUDT owned by emission-lock). */
  vtxTypeScript(): ccc.Script {
    const x = this.config.scripts.xudtScript
    return ccc.Script.from({
      codeHash: x.codeHash as `0x${string}`, hashType: x.hashType as 'type',
      args: this.emissionLockScript().hash() as `0x${string}`,
    })
  }
  vtxTypeHash(): TypeHash { return this.vtxTypeScript().hash() as TypeHash }

  /** The VTX token identifier (its xUDT args), for swaps/transfers via the standard token paths. */
  vtxArgs(): TypeHash { return this.emissionLockScript().hash() as TypeHash }

  /** An unspendable burn lock (secp256k1-blake160 with all-zero args; no key produces it). Tokens
   *  sent here are provably removed from circulation. */
  burnLockScript(): ccc.Script {
    return ccc.Script.from({
      codeHash: '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8',
      hashType: 'type', args: ('0x' + '00'.repeat(20)) as `0x${string}`,
    })
  }

  // ─── VTX buy-back-and-burn (the value sink, off-chain keeper) ──────────────
  // Treasury fee income (collected as LP, redeemed to CKB/xUDT via removeLiquidity) is used to buy
  // VTX on a VTX pool and burn it, sending circulating VTX to an unspendable lock, so the
  // protocol's trading revenue removes supply. Composes existing ops (swap + transfer).

  /** Buy VTX with `ckbIn` CKB on the VTX/CKB pool (a normal swap to the keeper). */
  async buyVtx(keeper: ccc.Signer, params: { ckbIn: bigint; minVtxOut?: bigint }): Promise<TxHash> {
    return this.swap(keeper, { tokenIn: CKB_TYPE_HASH, tokenOut: this.vtxArgs(), amountIn: params.ckbIn, minAmountOut: params.minVtxOut ?? 0n })
  }

  /** Burn `amount` VTX (or the keeper's whole VTX balance) by sending it to the burn lock. */
  async burnVtx(keeper: ccc.Signer, params?: { amount?: bigint }): Promise<TxHash> {
    const owner = await keeper.getRecommendedAddressObj()
    const vtx = this.vtxTypeScript()
    // Sum the keeper's VTX if no amount given.
    let have = 0n
    const cells: any[] = []
    for await (const c of this.chain.raw.findCells({ script: owner.script, scriptType: 'lock', scriptSearchMode: 'exact', filter: { script: vtx } })) {
      cells.push({ previousOutput: c.outPoint }); have += readU128LE(stripHex(c.outputData), 0)
    }
    const burn = params?.amount ?? have
    if (burn <= 0n || burn > have) throw new Error(`Not enough VTX to burn (have ${have})`)

    const outputs: any[] = [{ capacity: XUDT_CELL_CAPACITY, lock: this.burnLockScript(), type: vtx }]
    const outputsData: `0x${string}`[] = [encodeU128LE(burn)]
    if (have > burn) { outputs.push({ capacity: XUDT_CELL_CAPACITY, lock: owner.script, type: vtx }); outputsData.push(encodeU128LE(have - burn)) }

    const tx = ccc.Transaction.from({ inputs: cells, outputs, outputsData })
    await tx.addCellDepsOfKnownScripts(keeper.client, ccc.KnownScript.XUdt)
    await tx.completeInputsByCapacity(keeper)
    await tx.completeFeeBy(keeper, DEFAULT_FEE_RATE)
    return keeper.sendTransaction(tx) as Promise<TxHash>
  }

  /** Sink bought-back VTX per the protocol's buy-back policy: vest `teamSplitBps` (0..10000) of it
   *  to the team treasury (a timelock-lock cell owned by `teamLockHash` that unlocks only at
   *  tipEpoch + `vestEpochs`) and burn the remainder to the unspendable lock. With teamSplitBps = 0
   *  (the default) this is identical to burnVtx (burn 100%): the revenue-funded team-split path is
   *  inert until governance sets a nonzero split. The burn keeps the rounding remainder
   *  (deflation-favoring).
   *  Each call mints a fresh vesting tranche (a timelock cell can't be topped up before its deadline),
   *  so a vesting ladder = repeated calls with staggered `vestEpochs`. */
  async sinkVtx(keeper: ccc.Signer, params?: {
    amount?: bigint; teamSplitBps?: number; teamLockHash?: string; vestEpochs?: bigint
  }): Promise<TxHash> {
    const owner = await keeper.getRecommendedAddressObj()
    const vtx = this.vtxTypeScript()
    let have = 0n
    const cells: any[] = []
    for await (const c of this.chain.raw.findCells({ script: owner.script, scriptType: 'lock', scriptSearchMode: 'exact', filter: { script: vtx } })) {
      cells.push({ previousOutput: c.outPoint }); have += readU128LE(stripHex(c.outputData), 0)
    }
    const total = params?.amount ?? have
    if (total <= 0n || total > have) throw new Error(`Not enough VTX to sink (have ${have})`)

    // Keeper-side guardrail: cap the team-directed share at 25%. This is not a guarantee (an attacker
    // writing their own tx isn't bound by the SDK); it is a fat-finger stop for the keeper/governance
    // operator. Raise MAX_TEAM_SPLIT_BPS only deliberately.
    const MAX_TEAM_SPLIT_BPS = 2500
    const requestedBps = Math.floor(params?.teamSplitBps ?? 0)
    if (requestedBps > MAX_TEAM_SPLIT_BPS) {
      throw new Error(`teamSplitBps ${requestedBps} exceeds the keeper guardrail MAX_TEAM_SPLIT_BPS=${MAX_TEAM_SPLIT_BPS} (25%); raise this only deliberately`)
    }
    const splitBps = BigInt(Math.max(0, requestedBps))
    const teamAmount = total * splitBps / 10000n     // rounds down → burn keeps the remainder
    const burnAmount = total - teamAmount

    const outputs: any[] = []
    const outputsData: `0x${string}`[] = []
    if (burnAmount > 0n) {
      outputs.push({ capacity: XUDT_CELL_CAPACITY, lock: this.burnLockScript(), type: vtx })
      outputsData.push(encodeU128LE(burnAmount))
    }
    if (teamAmount > 0n) {
      if (!params?.teamLockHash) throw new Error('teamSplitBps > 0 requires teamLockHash (team treasury owner lock hash)')
      if (!this.timelockEnabled()) throw new Error('Team vesting needs the timelock-lock deployed on this network')
      const deadline = (await this.chain.getTipEpoch()) + (params?.vestEpochs ?? 0n)
      outputs.push({ capacity: 16_500_000_000n, lock: this.timelockScript(params.teamLockHash, deadline), type: vtx })
      outputsData.push(encodeU128LE(teamAmount))
    }
    if (have > total) {
      outputs.push({ capacity: XUDT_CELL_CAPACITY, lock: owner.script, type: vtx })
      outputsData.push(encodeU128LE(have - total))
    }

    const tx = ccc.Transaction.from({ inputs: cells, outputs, outputsData })
    await tx.addCellDepsOfKnownScripts(keeper.client, ccc.KnownScript.XUdt)
    await tx.completeInputsByCapacity(keeper)
    await tx.completeFeeBy(keeper, DEFAULT_FEE_RATE)
    return keeper.sendTransaction(tx) as Promise<TxHash>
  }

  /** Team CKB ops slice (keeper policy): pay `ckbAmount` of redeemed protocol-fee revenue to the
   *  team treasury as liquid CKB. Unlike `sinkVtx` (which vests VTX), this keeps the team slice in
   *  CKB: it funds ops/gas/cell-capacity and never sell-pressures VTX. `teamLock` must be a designated
   *  treasury lock separate from the keeper/governance key (the caller enforces separation; see the
   *  keeper guardrail). This is a plain CKB transfer; enforcing it on-chain (cap + min-burn +
   *  at-collection routing) needs a contract change. */
  async payTeamCkb(keeper: ccc.Signer, params: { teamLock: ccc.Script; ckbAmount: bigint }): Promise<TxHash> {
    // A plain (no-type) CKB cell occupies ~61 CKB; a smaller output is uncreatable on CKB.
    if (params.ckbAmount < 61_00000000n) throw new Error(`team CKB slice ${params.ckbAmount} shannons is below the ~61 CKB cell minimum; accumulate more fee revenue before paying out`)
    const tx = ccc.Transaction.from({ outputs: [{ capacity: params.ckbAmount, lock: params.teamLock }], outputsData: ['0x'] })
    await tx.completeInputsByCapacity(keeper)
    await tx.completeFeeBy(keeper, DEFAULT_FEE_RATE)
    return keeper.sendTransaction(tx) as Promise<TxHash>
  }

  /** LP-token script for an AMM pool (args = its info type hash). */
  private lpTokenScriptFor(infoTypeHash: string): ccc.Script {
    const s = this.config.scripts.lpTokenScript
    return ccc.Script.from({ codeHash: s.codeHash as `0x${string}`, hashType: s.hashType as 'type', args: infoTypeHash as `0x${string}` })
  }

  /** Resolve the CKB/xUDT AMM pool for a pair + its LP token (the mining stake token). */
  private async resolveLp(tokenX: TypeHash, tokenY: TypeHash) {
    const pool = await this.getPool(tokenX, tokenY)
    if (!pool) throw new Error('No pool for that pair')
    if (pool.poolMode !== 'CKB_XUDT') throw new Error('Liquidity mining requires a CKB/xUDT pool')
    const infoTypeHash = ccc.Script.from(pool.cell.output.type!).hash()
    const lpToken = this.lpTokenScriptFor(infoTypeHash)
    return { pool, infoTypeHash, lpToken, stakeToken: lpToken.hash() as TypeHash }
  }

  private foldMining(p: MiningPoolState, now: bigint): bigint {
    if (p.paused || p.total === 0n || now <= p.lastEpoch) return p.acc
    const elapsed = now - p.lastEpoch
    return p.acc + p.emissionPerEpoch * elapsed * MINING_ACC_PRECISION / p.total
  }

  private parseMiningPool(cell: any): MiningPoolState {
    const d = stripHex(cell.outputData)
    return {
      stakeToken: readBytes32(d, MP_STAKE_TOKEN_OFF),
      total:      readU128LE(d, MP_TOTAL_OFF),
      acc:        readU128LE(d, MP_ACC_OFF),
      lastEpoch:  readU64LE(d, MP_LAST_EPOCH_OFF),
      emissionPerEpoch: readU64LE(d, MP_EMISSION_OFF),
      paused:     readU8(d, MP_PAUSED_OFF) !== 0,
      poolTypeHash: ccc.Script.from(cell.cellOutput.type).hash(),
      cell:       this.toCell(cell),
    }
  }

  /** All mining pools. Optionally filter by the LP token (a CKB/xUDT pair via resolveLp). */
  async getMiningPools(): Promise<MiningPoolState[]> {
    if (!this.miningEnabled()) return []
    const s = this.config.scripts.miningPool
    const prefix = ccc.Script.from({ codeHash: s.codeHash as `0x${string}`, hashType: s.hashType as 'type', args: '0x' })
    const out: MiningPoolState[] = []
    for await (const cell of this.chain.raw.findCells({ script: prefix, scriptType: 'type', scriptSearchMode: 'prefix' })) {
      if (stripHex(cell.outputData).length >= MP_DATA_SIZE * 2) out.push(this.parseMiningPool(cell))
    }
    return out
  }

  /** The mining pool whose stake token is the LP of the given CKB/xUDT pair. */
  async getMiningPool(tokenX: TypeHash, tokenY: TypeHash): Promise<MiningPoolState | null> {
    const { stakeToken } = await this.resolveLp(tokenX, tokenY)
    const pools = await this.getMiningPools()
    return pools.find(p => p.stakeToken === stakeToken) ?? null
  }

  /** Locate the owner's receipt + custody cells for a mining pool (custody holds the LP token). The
   *  receipt type is always stake-guard; a 56-byte receipt carries weight + unlock_epoch (lock-boost),
   *  a 32-byte one is the unlocked base case (weight == amount, unlock_epoch == 0). The custody lock is
   *  the plain stake-guard for unlocked positions and the composed stake-timelock-guard for locked ones. */
  private async findMiningPosition(
    pool: MiningPoolState, ownerLockHash: string,
  ): Promise<{ amount: bigint; accAtTouch: bigint; weight: bigint; unlockEpoch: bigint; receipt: any; custody: any; lpScript: ccc.Script } | null> {
    const guard = this.stakeGuardScript(pool.poolTypeHash, ownerLockHash)
    let receipt: any = null, amount = 0n, accAtTouch = 0n, weight = 0n, unlockEpoch = 0n
    for await (const cell of this.chain.raw.findCells({ script: guard, scriptType: 'type', scriptSearchMode: 'exact' })) {
      if (ccc.Script.from(cell.cellOutput.lock).hash() !== ownerLockHash) continue
      receipt = cell
      const d = stripHex(cell.outputData)
      amount = readU128LE(d, 0); accAtTouch = readU128LE(d, 16)
      // 56-byte (boosted) receipt = 112 hex chars; otherwise unlocked base case (weight == amount).
      if (d.length >= 112) { weight = readU128LE(d, 32); unlockEpoch = readU64LE(d, 48) }
      else { weight = amount; unlockEpoch = 0n }
      break
    }
    if (!receipt) return null
    // The custody lock is the plain guard (unlocked) or the timelock guard bound to this exact deadline.
    const custodyLock = unlockEpoch > 0n && this.lockBoostEnabled()
      ? this.stakeTimelockGuardScript(pool.poolTypeHash, ownerLockHash, unlockEpoch)
      : guard
    let custody: any = null, lpScript: ccc.Script | null = null
    for await (const cell of this.chain.raw.findCells({ script: custodyLock, scriptType: 'lock', scriptSearchMode: 'exact' })) {
      const ty = cell.cellOutput.type
      if (!ty || ccc.Script.from(ty).hash() !== pool.stakeToken) continue
      custody = cell; lpScript = ccc.Script.from(ty); break
    }
    if (!custody || !lpScript) return null
    return { amount, accAtTouch, weight, unlockEpoch, receipt, custody, lpScript }
  }

  /** The owner's mining position: staked LP + pending VTX reward (accrued to the tip). */
  async getMiningPosition(signer: ccc.Signer, tokenX: TypeHash, tokenY: TypeHash): Promise<MiningPosition | null> {
    const pool = await this.getMiningPool(tokenX, tokenY)
    if (!pool) return null
    return this.getMiningPositionForPool(signer, pool)
  }

  /** Owner's mining position for an already-resolved mining pool: no token-args→type-hash lookup,
   *  so it works for non-curated / unusual-args tokens (the frontend already holds the MiningPoolState). */
  async getMiningPositionForPool(signer: ccc.Signer, pool: MiningPoolState): Promise<MiningPosition | null> {
    const owner = await signer.getRecommendedAddressObj()
    const found = await this.findMiningPosition(pool, owner.script.hash())
    if (!found) return null
    const now = await this.chain.getTipEpoch()
    const acc = this.foldMining(pool, now)
    // Reward accrues per unit of weight (the accumulator's denominator is total_weight).
    const pending = found.weight * (acc - found.accAtTouch) / MINING_ACC_PRECISION
    return {
      amount: found.amount, pending: pending > 0n ? pending : 0n, pool,
      weight: found.weight, unlockEpoch: found.unlockEpoch,
    }
  }

  /** Governance: create a mining pool for a CKB/xUDT pair's LP token. The signer is the authority
   *  (its co-sign authorizes genesis), and the AMM info cell is attached so the contract verifies
   *  on-chain that the LP belongs to a CKB/xUDT pool. */
  async createMiningPool(
    signer: ccc.Signer,
    params: { tokenX: TypeHash; tokenY: TypeHash; emissionPerEpoch: bigint; seed?: string },
  ): Promise<TxHash> {
    if (!this.miningEnabled()) throw new Error('Liquidity mining is not deployed on this network yet')
    const { pool } = await this.resolveLp(params.tokenX, params.tokenY)
    return this.createMiningPoolFromPool(signer, pool, { emissionPerEpoch: params.emissionPerEpoch, seed: params.seed })
  }

  /** Create a mining pool from an already-resolved CKB/xUDT AMM pool. Skips the args→type-hash lookup,
   *  so it works for non-curated / unusual-args tokens (same rationale as removeLiquidityFromPool). The
   *  stake token is the pool's LP, rebuilt from the pinned lp-token code + the pool's info type hash
   *  (the LP cell is always standard, so this reconstruction is always valid). */
  async createMiningPoolFromPool(
    signer: ccc.Signer,
    pool: Pool,
    params: { emissionPerEpoch: bigint; seed?: string },
  ): Promise<TxHash> {
    if (!this.miningEnabled()) throw new Error('Liquidity mining is not deployed on this network yet')
    if (pool.poolMode !== 'CKB_XUDT') throw new Error('Liquidity mining requires a CKB/xUDT pool')
    const stakeToken = this.lpTokenScriptFor(ccc.Script.from(pool.cell.output.type!).hash()).hash() as TypeHash
    const owner = await signer.getRecommendedAddressObj()
    // The pool's authority must equal emission-lock's governance authority, else
    // emission-lock will refuse to authorize this pool's mints. Genesis requires that authority to
    // co-sign, so the signer must control it.
    const authorityHash = this.governanceLockHash ?? owner.script.hash()
    const s = this.config.scripts.miningPool
    const now = await this.chain.getTipEpoch()
    const data = encodeMiningData({ stakeToken, total: 0n, acc: 0n, lastEpoch: now, emissionPerEpoch: params.emissionPerEpoch, paused: 0 })

    // Defense in depth: the mining pool's seed (args[161..193]) must be the canonical CKB type-id
    // of this genesis so its type hash is globally unique. Build with a
    // placeholder seed, fix inputs, then back-fill the type-id (same args length → capacity unchanged).
    const placeholder = ccc.Script.from({ codeHash: s.codeHash as `0x${string}`, hashType: s.hashType as 'type', args: this.miningArgs(authorityHash, '0'.repeat(64)) })
    // Type args are 193B (legacy) or 225B (lock-boost) → the cell occupies ~350-385 CKB; fund generously.
    const tx = ccc.Transaction.from({
      outputs: [{ capacity: 45_000_000_000n, lock: this.poolCellLock(), type: placeholder }],
      outputsData: [data],
      cellDeps: [this.miningPoolDep(), ccc.CellDep.from({ outPoint: pool.cell.outPoint as any, depType: 'code' })],
    })
    await tx.completeInputsByCapacity(signer)   // the authority's inputs satisfy the genesis co-sign
    const firstInput = tx.inputs[0]
    if (!firstInput) throw new Error('createMiningPool: no input to anchor the pool type-id')
    const typeId = ccc.hashCkb(firstInput.toBytes(), ccc.numLeToBytes(0n, 8))
    tx.outputs[0]!.type = ccc.Script.from({
      codeHash: s.codeHash as `0x${string}`, hashType: s.hashType as 'type',
      args: this.miningArgs(authorityHash, stripHex(typeId)),
    })
    await tx.completeFeeBy(signer, DEFAULT_FEE_RATE)
    return signer.sendTransaction(tx) as Promise<TxHash>
  }

  /** Governance: change a mining pool's emission rate (re-weight, or 0 to de-list). */
  async setEmission(signer: ccc.Signer, params: { tokenX: TypeHash; tokenY: TypeHash; emissionPerEpoch: bigint }): Promise<TxHash> {
    const pool = await this.getMiningPool(params.tokenX, params.tokenY)
    if (!pool) throw new Error('No mining pool for that pair')
    return this.setEmissionForCell(signer, pool, params.emissionPerEpoch)
  }

  /** Governance: set the emission rate of a specific mining-pool cell (0 = de-list). Operates on the
   *  given pool's own cell by outpoint. Unlike `setEmission`, this can target a duplicate cell of the
   *  same stake token, or a cell whose LP no longer maps to a live AMM pool (both un-addressable by
   *  the pair-keyed lookup). De-listing only zeroes emission; staked principal stays withdrawable. */
  async setEmissionForCell(signer: ccc.Signer, mp: MiningPoolState, emissionPerEpoch: bigint): Promise<TxHash> {
    const header = await this.chain.raw.getTipHeader()
    const now = BigInt((header as any).epoch[0])
    const acc = this.foldMining(mp, now)   // fold uses the old rate, then the new rate takes effect
    const data = encodeMiningData({
      stakeToken: mp.stakeToken, total: mp.total, acc, lastEpoch: now,
      emissionPerEpoch, paused: mp.paused ? 1 : 0,
    })
    const tx = ccc.Transaction.from({
      inputs: [{ previousOutput: mp.cell.outPoint }],
      outputs: [{ capacity: mp.cell.output.capacity, lock: mp.cell.output.lock as ccc.Script, type: mp.cell.output.type as ccc.Script }],
      outputsData: [data],
      cellDeps: [this.miningPoolDep(), this.poolCellLockDep()],
      headerDeps: [(header as any).hash as `0x${string}`],
    })
    await tx.completeInputsByCapacity(signer)   // authority co-sign
    await tx.completeFeeBy(signer, DEFAULT_FEE_RATE)
    return signer.sendTransaction(tx) as Promise<TxHash>
  }

  /** Governance: seed the value-less emission-authority cell (locked by emission-lock). One-time. */
  async setupEmissionAuthority(signer: ccc.Signer): Promise<TxHash> {
    if (!this.miningEnabled()) throw new Error('Liquidity mining is not deployed on this network yet')
    const tx = ccc.Transaction.from({
      outputs: [{ capacity: EMISSION_AUTH_CAPACITY, lock: this.emissionLockScript() }],
      outputsData: ['0x'],
    })
    await tx.completeInputsByCapacity(signer)
    await tx.completeFeeBy(signer, DEFAULT_FEE_RATE)
    return signer.sendTransaction(tx) as Promise<TxHash>
  }

  private async findEmissionAuthority(): Promise<any | null> {
    for await (const cell of this.chain.raw.findCells({ script: this.emissionLockScript(), scriptType: 'lock', scriptSearchMode: 'exact' })) {
      return cell
    }
    return null
  }

  /** If `pending > 0`, spend+recreate the emission-authority cell and mint exactly `pending` VTX
   *  to `owner`. Returns whether the mint was appended (so callers add the VTX/emission deps). */
  private async appendEmissionMint(
    inputs: any[], outputs: any[], outputsData: `0x${string}`[], owner: ccc.Script, pending: bigint,
  ): Promise<boolean> {
    if (pending <= 0n) return false
    const auth = await this.findEmissionAuthority()
    if (!auth) throw new Error('Emission authority not set up: governance must call setupEmissionAuthority first')
    inputs.push({ previousOutput: auth.outPoint })
    outputs.push({ capacity: BigInt(auth.cellOutput.capacity), lock: this.emissionLockScript() }) // recreate
    outputsData.push('0x')
    outputs.push({ capacity: XUDT_CELL_CAPACITY, lock: owner, type: this.vtxTypeScript() })          // minted VTX
    outputsData.push(encodeU128LE(pending))
    return true
  }

  private miningArgs(authorityHash: string, seed?: string): `0x${string}` {
    const sc = this.config.scripts
    const lpHashByte = (HASH_TYPE_BYTE[sc.lpTokenScript.hashType] ?? 1).toString(16).padStart(2, '0')
    const s = (seed ? stripHex(seed) : randomHex32()).padStart(64, '0').slice(0, 64)
    // [193..225] optional stake_timelock_guard_code_hash; present ⇒ lock-boost enabled for this pool.
    // Appended whenever the guard is deployed; backward-compatible (unlocked positions still 1.0×).
    const boost = this.lockBoostEnabled() ? stripHex(this.config.scripts.stakeTimelockGuard!.codeHash) : ''
    return ('0x'
      + stripHex(sc.stakeGuard.codeHash)
      + stripHex(this.vtxTypeHash())
      + stripHex(authorityHash)
      + stripHex(sc.lpTokenScript.codeHash)
      + lpHashByte
      + stripHex(sc.poolScript.codeHash)
      + s
      + boost) as `0x${string}`
  }

  /** Stake `amount` of a CKB/xUDT pair's LP token to mine VTX (fresh position or add; adding
   *  harvests any pending reward in the same tx). */
  async stakeMining(signer: ccc.Signer, params: { tokenX: TypeHash; tokenY: TypeHash; amount: bigint }): Promise<TxHash> {
    const { pool: ammPool } = await this.resolveLp(params.tokenX, params.tokenY)
    const mp = await this.getMiningPool(params.tokenX, params.tokenY)
    if (!mp) throw new Error('No mining pool for that pair')
    return this.stakeMiningToPool(signer, ammPool, mp, params.amount)
  }

  /** Stake LP to an already-resolved mining pool. `ammPool` = the CKB/xUDT AMM pool (used only to
   *  reconstruct the LP token script from the pinned lp-token code + its info type hash); `pool` = the
   *  mining pool. No token-args lookup → works for non-curated / unusual-args tokens. */
  async stakeMiningToPool(signer: ccc.Signer, ammPool: Pool, pool: MiningPoolState, amount: bigint): Promise<TxHash> {
    if (amount <= 0n) throw new Error('amount must be positive')
    const params = { amount }
    const lpToken = this.lpTokenScriptFor(ccc.Script.from(ammPool.cell.output.type!).hash())
    const owner = await signer.getRecommendedAddressObj()
    const ownerHash = owner.script.hash()

    const header = await this.chain.raw.getTipHeader()
    const now = BigInt((header as any).epoch[0])
    const acc = this.foldMining(pool, now)
    const existing = await this.findMiningPosition(pool, ownerHash)
    // A locked position is frozen until its deadline (its custody can't be spent), so it cannot be
    // added to. Use stakeMiningLocked for a fresh lock, or unstake at/after the deadline first.
    if (existing && existing.unlockEpoch > 0n) {
      throw new Error(`Position is locked until epoch ${existing.unlockEpoch}; unlocked add is not allowed`)
    }
    const oldAmount = existing?.amount ?? 0n
    const newAmount = oldAmount + params.amount
    // Unlocked add: weight == amount, so the pending uses the principal (== weight here).
    const pending = existing ? existing.weight * (acc - existing.accAtTouch) / MINING_ACC_PRECISION : 0n

    const guard = this.stakeGuardScript(pool.poolTypeHash, ownerHash)
    const inputs: any[] = [{ previousOutput: pool.cell.outPoint }]
    if (existing) { inputs.push({ previousOutput: existing.receipt.outPoint }); inputs.push({ previousOutput: existing.custody.outPoint }) }
    const outputs: any[] = [{ capacity: pool.cell.output.capacity, lock: pool.cell.output.lock as ccc.Script, type: pool.cell.output.type as ccc.Script }]
    const outputsData: `0x${string}`[] = [encodeMiningData({
      stakeToken: pool.stakeToken, total: pool.total + params.amount, acc, lastEpoch: now,
      emissionPerEpoch: pool.emissionPerEpoch, paused: pool.paused ? 1 : 0,
    })]
    outputs.push({ capacity: STAKE_CELL_CAPACITY, lock: owner.script, type: guard })
    outputsData.push(encodeReceiptData(newAmount, acc))
    outputs.push({ capacity: STAKE_CELL_CAPACITY, lock: guard, type: lpToken })
    outputsData.push(encodeU128LE(newAmount))

    const { inputs: lpIns, change } = await this.collectUdtInputs(owner.script, lpToken, params.amount)
    inputs.push(...lpIns)
    if (change > 0n) { outputs.push({ capacity: XUDT_CELL_CAPACITY, lock: owner.script, type: lpToken }); outputsData.push(encodeU128LE(change)) }

    const minted = await this.appendEmissionMint(inputs, outputs, outputsData, owner.script, pending)
    return this.sendMiningTx(signer, inputs, outputs, outputsData, (header as any).hash, minted)
  }

  /** Lock-boost: stake `amount` of LP committed until `now + termEpochs` for a boosted mining rate.
   *  Opens a fresh locked position (the principal is frozen by stake-timelock-guard until the deadline;
   *  reward is realized at unstake, on/after the deadline: harvest-at-unstake). The boost tier is fixed
   *  at creation; longer commitments earn a bigger slice of the same emission (redistributive, no extra
   *  mint). Use the 30/60/90/180/360-day tiers in LOCK_BOOST_TIERS. */
  async stakeMiningLocked(
    signer: ccc.Signer, params: { tokenX: TypeHash; tokenY: TypeHash; amount: bigint; termEpochs: bigint },
  ): Promise<TxHash> {
    const { pool: ammPool } = await this.resolveLp(params.tokenX, params.tokenY)
    const mp = await this.getMiningPool(params.tokenX, params.tokenY)
    if (!mp) throw new Error('No mining pool for that pair')
    return this.stakeMiningLockedToPool(signer, ammPool, mp, params.amount, params.termEpochs)
  }

  /** Stake LP with a fixed-term lock to an already-resolved mining pool (see stakeMiningLocked). */
  async stakeMiningLockedToPool(
    signer: ccc.Signer, ammPool: Pool, pool: MiningPoolState, amount: bigint, termEpochs: bigint,
  ): Promise<TxHash> {
    if (!this.lockBoostEnabled()) throw new Error('Lock-boost is not deployed on this network')
    if (amount <= 0n) throw new Error('amount must be positive')
    if (termEpochs <= 0n) throw new Error('term must be positive')
    // The pool must itself be lock-boost-enabled (225-byte args) or its contract cannot bind the locked
    // custody; legacy pools (193-byte args) only support unlocked staking.
    if (stripHex((pool.cell.output.type as any).args).length < MP_ARGS_BOOST * 2) {
      throw new Error('This mining pool does not support lock-boost (legacy 193-byte args)')
    }
    const lpToken = this.lpTokenScriptFor(ccc.Script.from(ammPool.cell.output.type!).hash())
    const owner = await signer.getRecommendedAddressObj()
    const ownerHash = owner.script.hash()

    const existing = await this.findMiningPosition(pool, ownerHash)
    if (existing) throw new Error('Close your existing position in this pool before opening a locked one')

    const header = await this.chain.raw.getTipHeader()
    const now = BigInt((header as any).epoch[0])
    const acc = this.foldMining(pool, now)
    const unlockEpoch = now + termEpochs
    if (unlockEpoch > MAX_UNLOCK_EPOCH) throw new Error('Lock term too long (deadline exceeds the 24-bit epoch ceiling)')
    // weight = amount · boost_bps(term)/10000, rounded down, exactly as the contract recomputes it
    // (term = unlock_epoch − header_epoch). The header dep pins the same epoch the contract sees.
    const weight = amount * boostBps(termEpochs) / BOOST_DENOM
    if (weight === 0n) throw new Error('amount too small for the chosen term (weight rounds to zero)')

    const receiptType = this.stakeGuardScript(pool.poolTypeHash, ownerHash)              // receipt type = stake-guard
    const custodyLock = this.stakeTimelockGuardScript(pool.poolTypeHash, ownerHash, unlockEpoch)

    const inputs: any[] = [{ previousOutput: pool.cell.outPoint }]
    const outputs: any[] = [{ capacity: pool.cell.output.capacity, lock: pool.cell.output.lock as ccc.Script, type: pool.cell.output.type as ccc.Script }]
    const outputsData: `0x${string}`[] = [encodeMiningData({
      stakeToken: pool.stakeToken, total: pool.total + weight, acc, lastEpoch: now,   // total_weight += weight
      emissionPerEpoch: pool.emissionPerEpoch, paused: pool.paused ? 1 : 0,
    })]
    outputs.push({ capacity: LOCKED_RECEIPT_CAPACITY, lock: owner.script, type: receiptType })  // 56B receipt → larger cell
    outputsData.push(encodeReceiptData56(amount, acc, weight, unlockEpoch))
    outputs.push({ capacity: STAKE_CELL_CAPACITY, lock: custodyLock, type: lpToken })
    outputsData.push(encodeU128LE(amount))

    const { inputs: lpIns, change } = await this.collectUdtInputs(owner.script, lpToken, amount)
    inputs.push(...lpIns)
    if (change > 0n) { outputs.push({ capacity: XUDT_CELL_CAPACITY, lock: owner.script, type: lpToken }); outputsData.push(encodeU128LE(change)) }

    // Fresh stake mints nothing (pending == 0). Custody is an output here, so the guard does not run yet.
    const minted = await this.appendEmissionMint(inputs, outputs, outputsData, owner.script, 0n)
    return this.sendMiningTx(signer, inputs, outputs, outputsData, (header as any).hash, minted)
  }

  /** Unstake `amount` of LP (harvests pending reward), returning the LP to the owner. */
  async unstakeMining(signer: ccc.Signer, params: { tokenX: TypeHash; tokenY: TypeHash; amount: bigint }): Promise<TxHash> {
    const pool = await this.getMiningPool(params.tokenX, params.tokenY)
    if (!pool) throw new Error('No mining pool for that pair')
    return this.unstakeMiningFromPool(signer, pool, params.amount)
  }

  /** Unstake LP from an already-resolved mining pool (no token-args lookup → non-curated tokens work). */
  async unstakeMiningFromPool(signer: ccc.Signer, pool: MiningPoolState, amount: bigint): Promise<TxHash> {
    const params = { amount }
    const owner = await signer.getRecommendedAddressObj()
    const ownerHash = owner.script.hash()
    const existing = await this.findMiningPosition(pool, ownerHash)
    if (!existing) throw new Error('No mining position')
    if (params.amount <= 0n || params.amount > existing.amount) throw new Error('Invalid unstake amount')

    const header = await this.chain.raw.getTipHeader()
    const now = BigInt((header as any).epoch[0])
    const acc = this.foldMining(pool, now)
    // Reward accrues per unit of weight (== amount for unlocked positions).
    const pending = existing.weight * (acc - existing.accAtTouch) / MINING_ACC_PRECISION
    const remaining = existing.amount - params.amount
    const lpToken = existing.lpScript
    const guard = this.stakeGuardScript(pool.poolTypeHash, ownerHash)
    const locked = existing.unlockEpoch > 0n

    // Locked positions mature whole (harvest-at-unstake): no partial unstake, and not spendable before
    // the deadline. The consensus `since` enforces the deadline on chain; this is a friendlier pre-check.
    if (locked) {
      if (remaining > 0n) throw new Error('A locked position can only be unstaked in full (at/after its deadline)')
      if (now < existing.unlockEpoch) throw new Error(`Locked until epoch ${existing.unlockEpoch} (now ${now})`)
    }

    // total_weight' = total_weight − weight_in + weight_out. Unlocked remainder keeps weight == amount,
    // so this reduces to (total − unstaked) for the unlocked path; for a full locked unstake weight_out = 0.
    const weightOut = locked ? 0n : remaining
    const inputs: any[] = [
      { previousOutput: pool.cell.outPoint },
      { previousOutput: existing.receipt.outPoint },
      // The locked custody is timelock-guarded: its input must carry an absolute epoch-based `since`
      // whose epoch number >= the deadline, or both the guard and consensus reject the spend.
      locked
        ? { previousOutput: existing.custody.outPoint, since: SINCE_EPOCH_ABS | existing.unlockEpoch }
        : { previousOutput: existing.custody.outPoint },
    ]
    const outputs: any[] = [{ capacity: pool.cell.output.capacity, lock: pool.cell.output.lock as ccc.Script, type: pool.cell.output.type as ccc.Script }]
    const outputsData: `0x${string}`[] = [encodeMiningData({
      stakeToken: pool.stakeToken, total: pool.total - existing.weight + weightOut, acc, lastEpoch: now,
      emissionPerEpoch: pool.emissionPerEpoch, paused: pool.paused ? 1 : 0,
    })]
    if (remaining > 0n) {
      outputs.push({ capacity: STAKE_CELL_CAPACITY, lock: owner.script, type: guard })
      outputsData.push(encodeReceiptData(remaining, acc))
      outputs.push({ capacity: STAKE_CELL_CAPACITY, lock: guard, type: lpToken })
      outputsData.push(encodeU128LE(remaining))
    }
    outputs.push({ capacity: XUDT_CELL_CAPACITY, lock: owner.script, type: lpToken })   // LP returned
    outputsData.push(encodeU128LE(params.amount))

    const minted = await this.appendEmissionMint(inputs, outputs, outputsData, owner.script, pending)
    return this.sendMiningTx(signer, inputs, outputs, outputsData, (header as any).hash, minted, false, locked)
  }

  /** Harvest the pending VTX reward, leaving the LP staked. */
  async claimMining(signer: ccc.Signer, params: { tokenX: TypeHash; tokenY: TypeHash }): Promise<TxHash> {
    const pool = await this.getMiningPool(params.tokenX, params.tokenY)
    if (!pool) throw new Error('No mining pool for that pair')
    return this.claimMiningFromPool(signer, pool)
  }

  /** Harvest pending VTX from an already-resolved mining pool (no token-args lookup). */
  async claimMiningFromPool(
    signer: ccc.Signer, pool: MiningPoolState,
    // Genesis only: when set, the claim also creates the minted token's Spore/Omiga "Unique cell"
    // (decimals|name|symbol) so JoyID / CKB Explorer / other DEXes recognize it. Pass this on the
    // token's first mint so the info cell sits in its issuance tx (where indexers look). Normal claims
    // omit it. The Unique args are a type-id over the mining-pool input (inputs[0]).
    tokenInfo?: { decimals: number; name: string; symbol: string },
  ): Promise<TxHash> {
    const owner = await signer.getRecommendedAddressObj()
    const ownerHash = owner.script.hash()
    const existing = await this.findMiningPosition(pool, ownerHash)
    if (!existing) throw new Error('No mining position')
    // Harvest-at-unstake: a locked position cannot mid-lock harvest (claiming would have to spend the
    // timelock-frozen custody). Its reward is realized when it is unstaked, at/after the deadline.
    if (existing.unlockEpoch > 0n) {
      throw new Error(`Locked position realizes its reward at unstake (on/after epoch ${existing.unlockEpoch}); mid-lock claim is not allowed`)
    }

    const header = await this.chain.raw.getTipHeader()
    const now = BigInt((header as any).epoch[0])
    const acc = this.foldMining(pool, now)
    const pending = existing.weight * (acc - existing.accAtTouch) / MINING_ACC_PRECISION
    if (pending <= 0n) throw new Error('Nothing to claim yet')
    const lpToken = existing.lpScript
    const guard = this.stakeGuardScript(pool.poolTypeHash, ownerHash)

    const inputs: any[] = [
      { previousOutput: pool.cell.outPoint },
      { previousOutput: existing.receipt.outPoint },
      { previousOutput: existing.custody.outPoint },
    ]
    const outputs: any[] = [{ capacity: pool.cell.output.capacity, lock: pool.cell.output.lock as ccc.Script, type: pool.cell.output.type as ccc.Script }]
    const outputsData: `0x${string}`[] = [encodeMiningData({
      stakeToken: pool.stakeToken, total: pool.total, acc, lastEpoch: now,
      emissionPerEpoch: pool.emissionPerEpoch, paused: pool.paused ? 1 : 0,
    })]
    outputs.push({ capacity: STAKE_CELL_CAPACITY, lock: owner.script, type: guard })
    outputsData.push(encodeReceiptData(existing.amount, acc))   // acc advanced; principal kept
    outputs.push({ capacity: STAKE_CELL_CAPACITY, lock: guard, type: lpToken })
    outputsData.push(encodeU128LE(existing.amount))

    await this.appendEmissionMint(inputs, outputs, outputsData, owner.script, pending)

    // Genesis: attach the token-info (Unique) cell to this first mint so the new VTX is recognized
    // ecosystem-wide. inputs[0] is the mining-pool cell, so the Unique args = type-id(inputs[0], idx).
    if (tokenInfo) {
      const unique = await this.chain.raw.getKnownScript(ccc.KnownScript.UniqueType)
      const idx = outputs.length
      const typeId = ccc.hashTypeId({ previousOutput: pool.cell.outPoint as any, since: 0n }, idx)
      const uniqueArgs = ('0x' + stripHex(typeId).slice(0, 40)) as `0x${string}`
      const enc = (str: string) => [...new TextEncoder().encode(str)]
      const nm = enc(tokenInfo.name), sy = enc(tokenInfo.symbol)
      const info = ('0x' + [tokenInfo.decimals & 0xff, nm.length & 0xff, ...nm, sy.length & 0xff, ...sy]
        .map(b => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`
      outputs.push({ capacity: XUDT_CELL_CAPACITY, lock: owner.script, type: ccc.Script.from({ codeHash: unique.codeHash, hashType: unique.hashType, args: uniqueArgs }) })
      outputsData.push(info)
    }

    return this.sendMiningTx(signer, inputs, outputs, outputsData, (header as any).hash, true, !!tokenInfo)
  }

  /** Finalize a mining tx: assemble deps (pool, guard, pool-lock; + emission-lock & xUDT when VTX
   *  was minted), fund, and send. */
  private async sendMiningTx(
    signer: ccc.Signer, inputs: any[], outputs: any[], outputsData: `0x${string}`[],
    headerHash: string, mintedVtx: boolean, withUnique = false, lockedCustody = false,
  ): Promise<TxHash> {
    const cellDeps = [this.miningPoolDep(), this.stakeGuardDep(), this.poolCellLockDep()]
    if (mintedVtx) cellDeps.push(this.emissionLockDep())
    // A locked custody is an input here, so the stake-timelock-guard lock script must run → needs its dep.
    if (lockedCustody) cellDeps.push(this.stakeTimelockGuardDep())
    const tx = ccc.Transaction.from({ inputs, outputs, outputsData, cellDeps, headerDeps: [headerHash as `0x${string}`] })
    if (withUnique) await tx.addCellDepsOfKnownScripts(signer.client, ccc.KnownScript.UniqueType)
    if (mintedVtx) await tx.addCellDepsOfKnownScripts(signer.client, ccc.KnownScript.XUdt)
    await tx.addCellDepsOfKnownScripts(signer.client, ccc.KnownScript.XUdt)   // LP token is xUDT-compatible
    this.addCustomUdtDeps(tx)
    tx.addCellDeps(ccc.CellDep.from({ outPoint: { txHash: this.config.scripts.lpTokenScript.txHash as `0x${string}`, index: BigInt(this.config.scripts.lpTokenScript.index) }, depType: 'code' }))
    await tx.completeInputsByCapacity(signer)
    await tx.completeFeeBy(signer, DEFAULT_FEE_RATE)
    return signer.sendTransaction(tx) as Promise<TxHash>
  }

  /** Protocol-wide locked liquidity: scan every LP cell under the timelock-lock (any owner) and
   *  aggregate per pool: a public, permissionless transparency read. Keyed by the pool's info
   *  type hash (= the LP token's args). Each entry has the total locked LP and the individual
   *  locks (amount + unlock epoch), so callers can show "% of LP locked" + an unlock schedule. */
  async getLockedLiquidity(): Promise<Map<string, { totalLp: bigint; locks: Array<{ lpAmount: bigint; deadlineEpoch: bigint }> }>> {
    const out = new Map<string, { totalLp: bigint; locks: Array<{ lpAmount: bigint; deadlineEpoch: bigint }> }>()
    if (!this.timelockEnabled()) return out
    const s = this.config.scripts.timelockLock
    const lpCode = this.config.scripts.lpTokenScript.codeHash.toLowerCase()
    const anyTimelock = ccc.Script.from({ codeHash: s.codeHash as `0x${string}`, hashType: s.hashType as 'type', args: '0x' })
    const lpFilter = {
      codeHash: this.config.scripts.lpTokenScript.codeHash as `0x${string}`,
      hashType: this.config.scripts.lpTokenScript.hashType as 'type', args: '0x' as `0x${string}`,
    }
    for await (const cell of this.chain.raw.findCells({
      script: anyTimelock, scriptType: 'lock', scriptSearchMode: 'prefix', filter: { script: lpFilter },
    })) {
      const type = cell.cellOutput.type
      if (!type || type.codeHash.toLowerCase() !== lpCode) continue
      const lpAmount = readU128LE(stripHex(cell.outputData), 0)
      if (lpAmount === 0n) continue
      const args = stripHex(cell.cellOutput.lock.args)
      const deadlineHex = args.slice(64, 80)   // bytes [32..40]
      const deadlineEpoch = deadlineHex.length >= 2 ? BigInt('0x' + deadlineHex.match(/../g)!.reverse().join('')) : 0n
      const key = type.args.toLowerCase()       // LP args = pool info type hash
      const e = out.get(key) ?? { totalLp: 0n, locks: [] }
      e.totalLp += lpAmount
      e.locks.push({ lpAmount, deadlineEpoch })
      out.set(key, e)
    }
    return out
  }

  /** Preview LP minted for a deposit (no transaction). */
  async quoteAddLiquidity(tokenX: TypeHash, tokenY: TypeHash, amountX: bigint, amountY: bigint): Promise<{
    lpMinted: bigint; shareOfPool: number; optimalAmountY: bigint
  }> {
    const pool = await this.getPool(tokenX, tokenY)
    if (!pool) throw new Error('No pool')
    const [dx, dy] = pool.tokenX === tokenX ? [amountX, amountY] : [amountY, amountX]
    const lpFromX = dx * pool.lpSupply / pool.reserveX
    const lpFromY = dy * pool.lpSupply / pool.reserveY
    const lpMinted = lpFromX < lpFromY ? lpFromX : lpFromY
    const optimalY = dx * pool.reserveY / pool.reserveX
    return {
      lpMinted,
      shareOfPool: Number(lpMinted) / Number(pool.lpSupply + lpMinted),
      optimalAmountY: pool.tokenX === tokenX ? optimalY : (dx * pool.reserveX / pool.reserveY),
    }
  }

  private poolCellDeps(): ccc.CellDep[] {
    const s = this.config.scripts
    return [
      ccc.CellDep.from({ outPoint: { txHash: s.poolScript.txHash as `0x${string}`, index: BigInt(s.poolScript.index) }, depType: 'code' }),
      ccc.CellDep.from({ outPoint: { txHash: s.lpTokenScript.txHash as `0x${string}`, index: BigInt(s.lpTokenScript.index) }, depType: 'code' }),
      ccc.CellDep.from({ outPoint: { txHash: s.xudtScript.txHash as `0x${string}`, index: BigInt(s.xudtScript.index) }, depType: 'code' }),
    ]
  }

  async cancelIntent(signer: ccc.Signer, intentCell: Cell): Promise<TxHash> {
    const ownerAddr = await signer.getRecommendedAddressObj()
    const tx = ccc.Transaction.from({
      inputs:      [{ previousOutput: intentCell.outPoint }],
      outputs:     [{ capacity: intentCell.output.capacity, lock: ownerAddr.script, type: intentCell.output.type }],
      outputsData: [intentCell.data],
    })
    await tx.addCellDepsOfKnownScripts(signer.client, ccc.KnownScript.XUdt)
    tx.addCellDeps({
      outPoint: { txHash: this.config.scripts.intentLock.txHash as `0x${string}`, index: this.config.scripts.intentLock.index },
      depType: 'code',
    })
    this.addCustomUdtDeps(tx)
    await tx.completeInputsByCapacity(signer)
    await tx.completeFeeBy(signer, DEFAULT_FEE_RATE)
    return signer.sendTransaction(tx) as Promise<TxHash>
  }

  // ─── Settle a resting async / limit order (keeper / solver path) ───────────
  //
  // The intent cell holds tokenIn xUDT and rests until fillable. A keeper (the
  // aggregator's solver) calls this to swap it and pay the owner >= minAmountOut of
  // tokenOut. The intent-lock validates on-chain that the owner is paid, so the keeper
  // cannot cheat: it can only settle correctly or not at all.
  //
  // The owner's full lock script must be supplied (relayed off-chain at order time):
  // the intent cell stores only its hash, but building the payout output needs the script.
  //
  // Routing: prefers a direct xUDT/xUDT pool; otherwise routes tokenIn → CKB → tokenOut
  // through two CKB-native pools. Both tokenIn and tokenOut must be xUDT (CKB-side outputs
  // are untyped, so intent-lock's typed-output check can't validate a CKB payout).
  // Throws `Error('NOT_FILLABLE')` when the live price doesn't yet reach the limit (the
  // keeper catches this and waits for the next tick).

  async settleIntent(
    solver: ccc.Signer,
    intentOutPoint: { txHash: TxHash; index: number },
    ownerLock: ccc.Script,
  ): Promise<{ txHash: TxHash; amountOut: bigint }> {
    const intent = await this.chain.getLiveCell(intentOutPoint as any)
    if (!intent) throw new Error('Intent cell not live (already settled or cancelled)')
    if (!intent.output.type) throw new Error('Intent cell has no xUDT type: not a token order')

    // Decode the intent from the lock args (must match encodeIntentLockArgs / the contract).
    const args = stripHex((intent.output.lock as ccc.Script).args)
    if (byteLen(args) < INTENT_ARGS_SIZE) throw new Error('Malformed intent args')
    const ownerLockHash = readBytes32(args, INTENT_OWNER_OFF)
    const minAmountOut  = readU128LE(args, INTENT_MIN_OUT_OFF)
    const tokenOutHash  = readBytes32(args, INTENT_TOKEN_OUT_OFF)
    const deadline      = readU64LE(args, INTENT_DEADLINE_OFF)

    // The relayed owner lock must hash to the one the user committed to, else we'd pay
    // the wrong recipient (and the intent-lock would reject the tx anyway).
    if ((ownerLock.hash() as string).toLowerCase() !== ('0x' + stripHex(ownerLockHash)).toLowerCase())
      throw new Error('Relayed owner lock does not match the order owner')

    // Deadline orders: the intent-lock reads HeaderDep[0]'s epoch and rejects if it's past the
    // deadline. So bail early if expired, and attach the tip header so the lock can read the epoch.
    let headerDep: string | undefined
    if (deadline > 0n) {
      if ((await this.chain.getTipEpoch()) > deadline) throw new Error('ORDER_EXPIRED')
      headerDep = (await this.chain.raw.getTipHeader()).hash as string
    }

    const tokenInHash = ccc.Script.from(intent.output.type as any).hash() as TypeHash
    const amountIn    = readU128LE(stripHex(intent.data), 0)
    if (amountIn <= 0n) throw new Error('Intent cell holds no tokenIn')

    // tokenOut must be an xUDT: the payout to the owner is a typed output the intent-lock checks.
    if (tokenOutHash.toLowerCase() === ('0x' + '0'.repeat(64)))
      throw new Error('Routed fill needs an xUDT tokenOut (CKB payouts are untyped)')

    // Find the shortest pool path tokenIn → … → tokenOut (length 1 = direct, ≥2 = routed via
    // intermediaries incl. CKB). One unified settlement builder handles any length.
    const pools = await this.getPools({ excludeEmpty: true })
    const path = findSwapPath(pools, tokenInHash, tokenOutHash, 4)
    if (!path) throw new Error('No direct or routed path for this order (auto-fill needs one)')
    return path.length === 1
      ? this.settleDirect(solver, intent, path[0]!.pool, tokenInHash, amountIn, minAmountOut, ownerLock, headerDep)
      : this.settlePath(solver, intent, path, amountIn, minAmountOut, ownerLock, headerDep)
  }

  /** Direct settlement: swap tokenIn → tokenOut through one xUDT/xUDT pool, pay owner ≥ minOut. */
  private async settleDirect(
    solver: ccc.Signer, intent: Cell, pool: Pool, tokenInHash: TypeHash,
    amountIn: bigint, minAmountOut: bigint, ownerLock: ccc.Script, headerDep?: string,
  ): Promise<{ txHash: TxHash; amountOut: bigint }> {
    if (!pool.reserveCellX || !pool.reserveCellY) throw new Error('Pool reserves not hydrated')
    const inIsX = pool.tokenX === tokenInHash
    const amountOut = getAmountOut(amountIn, inIsX ? pool.reserveX : pool.reserveY, inIsX ? pool.reserveY : pool.reserveX, pool.feeBps)
    if (amountOut < minAmountOut) throw new Error('NOT_FILLABLE')

    const epoch = await this.chain.getTipEpoch()
    const infoTypeHash = ccc.Script.from(pool.cell.output.type!).hash()
    const poolLock = ccc.Script.from({
      codeHash: this.config.scripts.poolLock.codeHash as `0x${string}`,
      hashType: this.config.scripts.poolLock.hashType as 'type', args: infoTypeHash as `0x${string}`,
    })
    const outCell = inIsX ? pool.reserveCellY : pool.reserveCellX
    const tokenOutType = ccc.Script.from(outCell.output.type as any)
    const newReserveX = pool.tokenX === tokenInHash ? pool.reserveX + amountIn : pool.reserveX - amountOut
    const newReserveY = pool.tokenY === tokenInHash ? pool.reserveY + amountIn : pool.reserveY - amountOut

    const inputs: any[] = [
      { previousOutput: intent.outPoint },
      { previousOutput: pool.cell.outPoint },
      { previousOutput: pool.reserveCellX.outPoint },
      { previousOutput: pool.reserveCellY.outPoint },
    ]
    const outputs: any[] = [
      { capacity: pool.cell.output.capacity, lock: pool.cell.output.lock as ccc.Script, type: pool.cell.output.type as ccc.Script },
      { capacity: pool.reserveCellX.output.capacity, lock: poolLock, type: pool.reserveCellX.output.type as ccc.Script },
      { capacity: pool.reserveCellY.output.capacity, lock: poolLock, type: pool.reserveCellY.output.type as ccc.Script },
      { capacity: intent.output.capacity, lock: ownerLock, type: tokenOutType },  // tokenOut → owner; refund the intent cell's full CKB capacity (rent)
    ]
    const outputsData: `0x${string}`[] = [encodeUpdatedInfo(pool.cell.data, epoch), encodeU128LE(newReserveX), encodeU128LE(newReserveY), encodeU128LE(amountOut)]
    return { txHash: await this.sendSettlement(solver, inputs, outputs, outputsData, headerDep), amountOut }
  }

  /** General N-hop routed settlement: chain the swap through every pool in `path` (each hop's
   *  output feeds the next), update all pool cells in one tx, and pay the owner the final tokenOut.
   *  Intermediate tokens are conserved across the tx (one pool emits, the next absorbs); the
   *  intent-lock still validates the owner payout, so the keeper can't cheat. */
  private async settlePath(
    solver: ccc.Signer, intent: Cell, path: Hop[],
    amountIn: bigint, minAmountOut: bigint, ownerLock: ccc.Script, headerDep?: string,
  ): Promise<{ txHash: TxHash; amountOut: bigint }> {
    const epoch = await this.chain.getTipEpoch()
    const poolLockOf = (p: Pool) => ccc.Script.from({
      codeHash: this.config.scripts.poolLock.codeHash as `0x${string}`,
      hashType: this.config.scripts.poolLock.hashType as 'type',
      args: ccc.Script.from(p.cell.output.type!).hash() as `0x${string}`,
    })
    const inputs: any[] = [{ previousOutput: intent.outPoint }]
    const outputs: any[] = []
    const outputsData: `0x${string}`[] = []

    let amt = amountIn
    for (const hop of path) {
      const p = hop.pool
      const ckbNative = p.poolMode === 'CKB_XUDT'
      if (ckbNative ? !p.reserveCellY : (!p.reserveCellX || !p.reserveCellY)) throw new Error('Routed pool not hydrated')
      const inIsX = p.tokenX === hop.inHash                          // CKB-native: tokenX = CKB
      const amtOut = getAmountOut(amt, inIsX ? p.reserveX : p.reserveY, inIsX ? p.reserveY : p.reserveX, p.feeBps)
      if (amtOut <= 0n) throw new Error('NOT_FILLABLE')
      const newRx = inIsX ? p.reserveX + amt : p.reserveX - amtOut
      const newRy = inIsX ? p.reserveY - amtOut : p.reserveY + amt

      inputs.push({ previousOutput: p.cell.outPoint })
      if (ckbNative) {
        // reserveX is CKB and rides on the info-cell capacity (= MIN + reserveX).
        if (newRx < occupiedCapacity(p.cell) - MIN_POOL_CAPACITY) throw new Error('NOT_FILLABLE')  // CKB floor
        outputs.push({ capacity: MIN_POOL_CAPACITY + newRx, lock: p.cell.output.lock as ccc.Script, type: p.cell.output.type as ccc.Script })
        outputsData.push(encodeUpdatedInfo(p.cell.data, epoch))
        inputs.push({ previousOutput: p.reserveCellY!.outPoint })
        outputs.push({ capacity: p.reserveCellY!.output.capacity, lock: poolLockOf(p), type: p.reserveCellY!.output.type as ccc.Script })
        outputsData.push(encodeU128LE(newRy))
      } else {
        outputs.push({ capacity: p.cell.output.capacity, lock: p.cell.output.lock as ccc.Script, type: p.cell.output.type as ccc.Script })
        outputsData.push(encodeUpdatedInfo(p.cell.data, epoch))
        inputs.push({ previousOutput: p.reserveCellX!.outPoint })
        outputs.push({ capacity: p.reserveCellX!.output.capacity, lock: poolLockOf(p), type: p.reserveCellX!.output.type as ccc.Script })
        outputsData.push(encodeU128LE(newRx))
        inputs.push({ previousOutput: p.reserveCellY!.outPoint })
        outputs.push({ capacity: p.reserveCellY!.output.capacity, lock: poolLockOf(p), type: p.reserveCellY!.output.type as ccc.Script })
        outputsData.push(encodeU128LE(newRy))
      }
      amt = amtOut
    }

    if (amt < minAmountOut) throw new Error('NOT_FILLABLE')
    // Pay the owner the final tokenOut (the out-side reserve of the last hop's pool).
    const last = path[path.length - 1]!
    const outIsX = last.pool.tokenX === last.outHash
    const tokenOutType = ccc.Script.from((outIsX ? last.pool.reserveCellX! : last.pool.reserveCellY!).output.type as any)
    outputs.push({ capacity: intent.output.capacity, lock: ownerLock, type: tokenOutType })  // refund the intent cell's capacity
    outputsData.push(encodeU128LE(amt))
    return { txHash: await this.sendSettlement(solver, inputs, outputs, outputsData, headerDep), amountOut: amt }
  }

  /** Shared: attach pool + intent-lock (+ custom-UDT) cell deps and an optional header dep (for
   *  deadline orders), let the solver fund the payout + fee, send. */
  private async sendSettlement(solver: ccc.Signer, inputs: any[], outputs: any[], outputsData: `0x${string}`[], headerDep?: string): Promise<TxHash> {
    const cellDeps = this.swapCellDeps()
    cellDeps.push(ccc.CellDep.from({
      outPoint: { txHash: this.config.scripts.intentLock.txHash as `0x${string}`, index: BigInt(this.config.scripts.intentLock.index) },
      depType: 'code',
    }))
    // Any non-standard UDT (USDI/ccBTC) involved needs its own code cell dep.
    for (const dep of this.customUdtDeps(outputs.map(o => o.type).filter(Boolean))) cellDeps.push(dep)
    const tx = ccc.Transaction.from({ inputs, outputs, outputsData, cellDeps, headerDeps: headerDep ? [headerDep as `0x${string}`] : [] })
    await tx.completeInputsByCapacity(solver)   // solver funds the payout cell + fee
    await tx.completeFeeBy(solver, DEFAULT_FEE_RATE)
    return solver.sendTransaction(tx) as Promise<TxHash>
  }

  // ─── Poll intent status ───────────────────────────────────────────────────

  async waitForSettlement(
    outpoint: { txHash: TxHash; index: number },
    timeoutMs = 300_000, pollMs = 5_000,
  ): Promise<IntentStatus> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const cell = await this.chain.getLiveCell(outpoint)
      if (!cell) return { status: 'SETTLED', txHash: '0x' as TxHash, amountReceived: 0n, settledAt: Date.now() }
      await new Promise<void>(r => setTimeout(r, pollMs))
    }
    return { status: 'EXPIRED' }
  }

  calculateIL(priceRatio: number): number {
    if (priceRatio <= 0) return 0
    return (2 * Math.sqrt(priceRatio) / (1 + priceRatio)) - 1
  }
}

// ─── Cell parsing ─────────────────────────────────────────────────────────────

/**
 * Parse an info cell into a Pool with reserves unset (0n). Reserves live in the
 * reserve cells; call hydrateReserves() to fill them. Synchronous so it can
 * map over a cell list; the SDK hydrates afterward.
 */
function parseInfoCell(cell: Cell): Pool | null {
  try {
    const data = stripHex(cell.data)
    // Accept both the pre-fee 140-byte layout and the 156-byte k_last layout.
    if (byteLen(data) < POOL_DATA_MIN) return null
    return {
      poolId:   readU128LE(data, POOL_ID_OFF),
      poolMode: readU8(data, POOL_MODE_OFF) === 1 ? 'CKB_XUDT' : 'XUDT_XUDT',
      tokenX:   readBytes32(data, POOL_TOKEN_X_OFF),
      tokenY:   readBytes32(data, POOL_TOKEN_Y_OFF),
      reserveX: 0n,   // filled by hydrateReserves()
      reserveY: 0n,
      feeBps:   readU16LE(data, POOL_FEE_BPS_OFF),
      lpSupply: readU128LE(data, POOL_LP_SUPPLY_OFF),
      cell,
      paused:   readU8(data, POOL_PAUSED_OFF) !== 0,
    }
  } catch { return null }
}

// ─── Pool data encoding ───────────────────────────────────────────────────────

/** Re-encode info data for a swap: reserves are not stored here, so we only
 *  advance the TWAP accumulator + epoch. lp_supply unchanged. */
function encodeUpdatedInfo(
  original: string, epoch: bigint, cumX?: bigint, cumY?: bigint,
): `0x${string}` {
  const hex = original.startsWith('0x') ? original.slice(2) : original
  // Preserve the original cell's length (140 pre-fee, 156 with k_last); never grow it.
  const buf = hexToUint8Array(hex.padEnd(Math.max(hex.length, POOL_DATA_MIN * 2), '0'))
  if (cumX !== undefined) writeU128LE(buf, cumX, POOL_CUM_X_OFF)
  if (cumY !== undefined) writeU128LE(buf, cumY, POOL_CUM_Y_OFF)
  writeU64LE(buf, epoch, POOL_LAST_EPOCH_OFF)
  return ('0x' + uint8ArrayToHex(buf)) as `0x${string}`
}

/** Re-encode info data for add/remove: update lp_supply + epoch. Reserves move
 *  in the reserve cells, not here. */
function encodeInfoWithSupply(
  original: string, newLpSupply: bigint, epoch: bigint, kLast?: bigint,
): `0x${string}` {
  const hex = original.startsWith('0x') ? original.slice(2) : original
  // Preserve the original cell's length (140 pre-fee, 156 with k_last); never grow it.
  const buf = hexToUint8Array(hex.padEnd(Math.max(hex.length, POOL_DATA_MIN * 2), '0'))
  writeU128LE(buf, newLpSupply, POOL_LP_SUPPLY_OFF)
  writeU64LE (buf, epoch,       POOL_LAST_EPOCH_OFF)
  // Fee-on pools (k_last != 0) must advance k_last to √k of the new reserves on every liquidity event.
  if (kLast !== undefined && byteLen(hex) >= POOL_DATA_SIZE) writeU128LE(buf, kLast, POOL_K_LAST_OFF)
  return ('0x' + uint8ArrayToHex(buf)) as `0x${string}`
}

// ─── Intent-lock arg encoding ─────────────────────────────────────────────────

function encodeIntentLockArgs(p: {
  ownerLockHash: TypeHash; minAmountOut: bigint; tokenOutTypeHash: TypeHash
  deadlineEpoch: bigint; solverFeeBps: number; otxLockCodeHash?: TypeHash
}): `0x${string}` {
  const buf = new Uint8Array(INTENT_ARGS_SIZE)
  copyHexInto(buf, p.ownerLockHash,    INTENT_OWNER_OFF)
  writeU128LE(buf, p.minAmountOut,     INTENT_MIN_OUT_OFF)
  copyHexInto(buf, p.tokenOutTypeHash, INTENT_TOKEN_OUT_OFF)
  writeU64LE (buf, p.deadlineEpoch,    INTENT_DEADLINE_OFF)
  writeU16LE (buf, p.solverFeeBps,     INTENT_FEE_OFF)
  // The intent cell must carry the real cellswap-otx-lock code hash so settlement counts OTX
  // sibling demand on the shared owner payout. A zero/absent hash disables that defense: a solver
  // could co-settle this cell with an OTX cell under one underpaying payout (drain 2, pay once). So
  // refuse to build an unprotected intent cell (the contract also rejects settling one). Callers
  // without the OTX lock configured must use the direct swap().
  const otx = p.otxLockCodeHash
  if (!otx || BigInt(otx) === 0n) {
    throw new Error('swapAsync: cellswap-otx-lock is not configured for this network (config.scripts.cellswapOtxLock); refusing to build an intent-lock cell without its code hash. Use the direct swap() path.')
  }
  copyHexInto(buf, otx, INTENT_OTX_HASH_OFF)
  return ('0x' + uint8ArrayToHex(buf)) as `0x${string}`
}

/** Encode the 91-byte stake-pool cell data; must match contracts/stake-pool/src/main.rs. */
function encodeStakePoolData(p: {
  stakeToken: TypeHash; total: bigint; acc: bigint; reserve: bigint
  lastEpoch: bigint; emissionBps: number; paused: number
}): `0x${string}` {
  const b = new Uint8Array(SP_DATA_SIZE)
  copyHexInto(b, p.stakeToken, SP_STAKE_TOKEN_OFF)
  writeU128LE(b, p.total,   SP_TOTAL_OFF)
  writeU128LE(b, p.acc,     SP_ACC_OFF)
  writeU128LE(b, p.reserve, SP_RESERVE_OFF)
  writeU64LE (b, p.lastEpoch, SP_LAST_EPOCH_OFF)
  writeU16LE (b, p.emissionBps, SP_EMISSION_OFF)
  b[SP_PAUSED_OFF] = p.paused & 0xff
  return ('0x' + uint8ArrayToHex(b)) as `0x${string}`
}

/** Encode the 81-byte mining-pool cell data; must match contracts/mining-pool/src/main.rs. */
function encodeMiningData(p: {
  stakeToken: TypeHash; total: bigint; acc: bigint; lastEpoch: bigint; emissionPerEpoch: bigint; paused: number
}): `0x${string}` {
  const b = new Uint8Array(MP_DATA_SIZE)
  copyHexInto(b, p.stakeToken, MP_STAKE_TOKEN_OFF)
  writeU128LE(b, p.total, MP_TOTAL_OFF)
  writeU128LE(b, p.acc, MP_ACC_OFF)
  writeU64LE (b, p.lastEpoch, MP_LAST_EPOCH_OFF)
  writeU64LE (b, p.emissionPerEpoch, MP_EMISSION_OFF)
  b[MP_PAUSED_OFF] = p.paused & 0xff
  return ('0x' + uint8ArrayToHex(b)) as `0x${string}`
}

/** Encode a 32-byte stake receipt: amount(16) || acc_at_touch(16). */
function encodeReceiptData(amount: bigint, accAtTouch: bigint): `0x${string}` {
  const b = new Uint8Array(32); writeU128LE(b, amount, 0); writeU128LE(b, accAtTouch, 16)
  return ('0x' + uint8ArrayToHex(b)) as `0x${string}`
}

/** Encode a 56-byte boosted mining receipt: amount(16) || acc_at_touch(16) || weight(16) || unlock_epoch(8 LE).
 *  The contract reads weight at [32..48] and unlock_epoch at [48..56]; a 32-byte receipt is the unlocked
 *  base case (weight == amount, unlock_epoch == 0). */
function encodeReceiptData56(amount: bigint, accAtTouch: bigint, weight: bigint, unlockEpoch: bigint): `0x${string}` {
  const b = new Uint8Array(56)
  writeU128LE(b, amount, 0); writeU128LE(b, accAtTouch, 16)
  writeU128LE(b, weight, 32); writeU64LE(b, unlockEpoch, 48)
  return ('0x' + uint8ArrayToHex(b)) as `0x${string}`
}

/** A random 32-byte hex string (64 hex chars, no 0x) for the stake-pool uniqueness seed. */
function randomHex32(): string {
  const c = (globalThis as any).crypto
  if (c?.getRandomValues) {
    const a = new Uint8Array(32); c.getRandomValues(a); return uint8ArrayToHex(a)
  }
  // Fallback for engines without WebCrypto (node>=20 always has globalThis.crypto). Mix
  // Math.random per byte so the seed varies call to call; a constant seed would collide every
  // stake-pool uniqueness seed.
  const a = new Uint8Array(32)
  for (let i = 0; i < 32; i++) a[i] = Math.floor(Math.random() * 256)
  return uint8ArrayToHex(a)
}

/** Integer square root (matches Rust isqrt for initial LP). */
function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error('negative')
  if (n < 2n) return n
  let x = n, y = (x + 1n) / 2n
  while (y < x) { x = y; y = (x + n / x) / 2n }
  return x
}

/** Encode info-cell data (140 bytes); must match the Rust pool-script layout.
 *  Reserves are not included; they live in the reserve cells. */
function encodeInfoData(p: {
  tokenX: TypeHash; tokenY: TypeHash
  feeBps: number; lpSupply: bigint; poolId: bigint; poolMode: number; kLast?: bigint
}): `0x${string}` {
  const buf = new Uint8Array(POOL_DATA_SIZE)
  copyHexInto(buf, p.tokenX,   POOL_TOKEN_X_OFF)
  copyHexInto(buf, p.tokenY,   POOL_TOKEN_Y_OFF)
  writeU128LE(buf, p.lpSupply, POOL_LP_SUPPLY_OFF)
  writeU16LE (buf, p.feeBps,   POOL_FEE_BPS_OFF)
  writeU128LE(buf, p.poolId,   POOL_ID_OFF)
  buf[POOL_MODE_OFF]   = p.poolMode
  buf[POOL_PAUSED_OFF] = 0
  if (p.kLast) writeU128LE(buf, p.kLast, POOL_K_LAST_OFF)  // protocol fee on (√k snapshot)
  return ('0x' + uint8ArrayToHex(buf)) as `0x${string}`
}

/** Re-encode info for a collect / fee-enable: set lp_supply + k_last, preserve everything else
 *  (reserves are in the reserve cells; this is a reserves-unchanged op). */
function encodeInfoCollect(original: string, newLpSupply: bigint, newKLast: bigint): `0x${string}` {
  const hex = original.startsWith('0x') ? original.slice(2) : original
  const buf = hexToUint8Array(hex.padEnd(Math.max(hex.length, POOL_DATA_SIZE * 2), '0'))
  writeU128LE(buf, newLpSupply, POOL_LP_SUPPLY_OFF)
  writeU128LE(buf, newKLast, POOL_K_LAST_OFF)
  return ('0x' + uint8ArrayToHex(buf)) as `0x${string}`
}

/** √(rx·ry) as a bigint: the "root k" of the protocol-fee accumulator (matches amm-math::sqrt_k). */
function sqrtK(rx: bigint, ry: bigint): bigint { return isqrt(rx * ry) }

/** LP minted to the treasury (UniV2 _mintFee): the protocol's 1/6 share of √k growth since the last
 *  collection. Mirrors amm-math::compute_protocol_fee_lp (rounds down). 0 ⇒ fee off / no growth. */
function protocolFeeLp(lpSupply: bigint, rootK: bigint, rootKLast: bigint): bigint {
  if (rootKLast === 0n || rootK <= rootKLast) return 0n
  const PROTOCOL_FEE_DENOM = 6n
  const num = lpSupply * (rootK - rootKLast)
  const den = rootK * (PROTOCOL_FEE_DENOM - 1n) + rootKLast
  return den === 0n ? 0n : num / den
}

/** Read the protocol-fee k_last (√k snapshot; 0 = fee off) from an info cell, if present. */
function readKLast(data: string): bigint {
  const d = stripHex(data)
  return byteLen(d) >= POOL_DATA_SIZE ? readU128LE(d, POOL_K_LAST_OFF) : 0n
}

/** On-chain occupied capacity of a cell (shannons): the minimum its `capacity` may be.
 *  = 8 (capacity field) + lock script + type script + data bytes, ×10^8 shannons/byte. */
function occupiedCapacity(cell: Cell): bigint {
  const argBytes = (a?: string) => (a && a !== '0x') ? BigInt((a.length - 2) / 2) : 0n
  const lock = cell.output.lock as any
  const type = cell.output.type as any
  const dataBytes = BigInt((stripHex(cell.data).length) / 2)
  const bytes = 8n + (32n + 1n + argBytes(lock?.args))
    + (type ? 32n + 1n + argBytes(type.args) : 0n) + dataBytes
  return bytes * 100_000_000n
}

// Byte-codec helpers (readU128LE, writeU128LE, stripHex, ...) live in @cellswap/codec
// so their offsets and encodings can't drift from the aggregator and deploy scripts.

export type { SwapQuote, Pool, IntentStatus } from '@cellswap/types'
export { TokenRegistry } from '@cellswap/token-registry'
// Multisig pause authority + factory-data encoder
export { computeMultisigAuthority, encodeFactoryData,
         SECP256K1_MULTISIG_CODE_HASH, FACTORY_HEADER } from './factory.js'

// ─── PATH 3: Cobuild OTX with custom secp256r1 lock ────────────────────────────
//
// Uses cellswap-otx-lock contract: secp256r1 + WebAuthn + Cobuild OTX.
// User's xUDT lives under cellswap-otx-lock.
// JoyID signs the OTX hash via signChallenge() (no OTX-specific API needed).
// Assets never leave the user's lock.
//
// Requires one-time setup: user migrates xUDT to CellSwap OTX address.

export { computeSwapCommitment, encodeWebAuthnWitness, parseJoyIDOtxResponse,
         buildOtxLockArgs, buildMigrationTx, type JoyIDSignResponse,
         type JoyIDConnectResponse, type SwapIntent, type OTXPayload } from './otx.js'

// ─── Gated tester access (apply to test / log in once approved) ──────────────
//
// Shared by the frontend (builds the signed request) and the aggregator (verifies it) so the
// two sides can never diverge on byte order. See tester-auth.ts for why this is not the OTX
// witness format (no 120-byte trade-intent tail: a login/apply signature has only one consumer,
// the aggregator's own handler, which already has the cleartext body).

export { computeApplyCommitment, computeLoginCommitment, addressHashFromPubkey,
         encodeTesterWitness, decodeTesterWitness, parseJoyIDTesterResponse,
         type DecodedTesterWitness } from './tester-auth.js'
