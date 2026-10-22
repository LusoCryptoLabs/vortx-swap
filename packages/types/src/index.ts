// @cellswap/types: single source of truth for shared types

export type HexString  = `0x${string}`
export type TypeHash   = HexString
export type LockHash   = HexString
export type TxHash     = HexString
export type OutPoint   = { txHash: TxHash; index: number }

export type Script = {
  codeHash: HexString
  hashType: 'type' | 'data' | 'data1' | 'data2'
  args:     HexString
}

export type Cell = {
  outPoint: OutPoint
  output:   { capacity: bigint; lock: Script; type?: Script }
  data:     HexString
}

// ─── Pool ─────────────────────────────────────────────────────────────────

export type FeeTier  = 'STABLE' | 'STANDARD' | 'EXOTIC'
export type PoolMode = 'XUDT_XUDT' | 'CKB_XUDT'

export const FEE_BPS: Record<FeeTier, number> = {
  STABLE: 5, STANDARD: 30, EXOTIC: 100,
}

export type Pool = {
  poolId:    bigint
  poolMode:  PoolMode
  tokenX:    TypeHash      // zero-hash for CKB-native pools
  tokenY:    TypeHash
  reserveX:  bigint        // CKB-native: capacity - MIN_POOL_CAPACITY; else from reserve cell X
  reserveY:  bigint        // from reserve cell Y
  feeBps:    number
  lpSupply:  bigint
  cell:      Cell          // the info cell (type = pool-script)
  reserveCellX?: Cell      // real xUDT reserve cell for tokenX (absent for CKB-native)
  reserveCellY?: Cell      // real xUDT reserve cell for tokenY
  paused:    boolean
}

export type PoolStats = Pool & {
  tvlCkb:    bigint        // total value in CKB (reserveX if CKB-native, else estimated)
  volume24h: bigint
  fees24h:   bigint
  apr:       number
}

// ─── Intent (two variants) ─────────────────────────────────────────────────

/** Preferred: intent encoded in the lock script. xUDT cell. Tokens inside. */
export type IntentLockCell = {
  variant:          'LOCK'
  ownerLockHash:    LockHash
  minAmountOut:     bigint
  tokenOut:         TypeHash
  deadlineEpoch:    bigint
  solverFeeBps:     number
  // The xUDT amount is in cell.data (first 16 bytes)
  // The token type is cell.output.type (xUDT script)
  amountIn:         bigint
  tokenIn:          TypeHash   // derived from cell.output.type
  cell:             Cell
}

/** Legacy: intent encoded in the type script. Separate xUDT cell needed. */
export type IntentTypeCell = {
  variant:          'TYPE'
  intentType:       'SWAP' | 'ADD_LIQUIDITY' | 'REMOVE_LIQUIDITY'
  tokenIn:          TypeHash
  amountIn:         bigint
  tokenOut:         TypeHash
  minAmountOut:     bigint
  deadlineEpoch:    bigint
  ownerLockHash:    LockHash
  poolTypeHash:     TypeHash
  solverFeeBps:     number
  cell:             Cell
}

export type Intent = IntentLockCell | IntentTypeCell

export type IntentStatus =
  | { status: 'PENDING' }
  | { status: 'SETTLED';   txHash: TxHash; amountReceived: bigint; settledAt: number }
  | { status: 'CANCELLED'; txHash: TxHash }
  | { status: 'EXPIRED' }

// ─── Quotes ───────────────────────────────────────────────────────────────

export type SwapRoute = {
  path:  TypeHash[]
  pools: Pool[]
  hops:  number
}

export type SwapQuote = {
  amountIn:       bigint
  amountOut:      bigint
  minAmountOut:   bigint
  priceImpact:    number    // 0 to 1
  fee:            bigint
  route:          SwapRoute
  executionPrice: number
  warning?:       'HIGH_IMPACT' | 'LOW_LIQUIDITY'
}

export type LiquidityQuote = {
  amountX:     bigint
  amountY:     bigint
  lpMinted:    bigint
  shareOfPool: number    // 0 to 1
}

// ─── LP Position ──────────────────────────────────────────────────────────

export type LpPosition = {
  pool:          Pool
  lpAmount:      bigint
  shareOfPool:   number    // 0 to 1
  valueX:        bigint    // claimable token X
  valueY:        bigint    // claimable token Y
  entryValueCkb: bigint    // value when deposited (for IL calculation)
  cell:          Cell
}

// ─── Cobuild OTX ──────────────────────────────────────────────────────────

export type LimitOrder = {
  type: 'LIMIT'; bidToken: TypeHash; bidAmount: bigint; askToken: TypeHash; askAmount: bigint
}
export type MarketOrder = {
  type: 'MARKET'; bidToken: TypeHash; bidAmount: bigint; askToken: TypeHash
}
export type LimitOrderWithDeadline = LimitOrder & { type: 'LIMIT_WITH_DEADLINE'; deadline: bigint }
export type Order = LimitOrder | MarketOrder | LimitOrderWithDeadline

// ─── Aggregator ───────────────────────────────────────────────────────────

export type SettlementResult = {
  txHash:     TxHash
  intentCount: number
  settledAt:  number
}

// ─── Config ───────────────────────────────────────────────────────────────

export type Network = 'mainnet' | 'testnet' | 'devnet'

export type ScriptInfo = {
  codeHash: HexString
  hashType: 'type' | 'data' | 'data1' | 'data2'
  txHash:   HexString
  index:    number
}

export type DeployedScripts = {
  poolScript:    ScriptInfo
  poolLock:      ScriptInfo  // guards reserve cells
  intentLock:    ScriptInfo   // async intent-lock path
  cellswapOtxLock: ScriptInfo // primary: secp256r1 WebAuthn + Cobuild OTX
  intentScript:  ScriptInfo   // legacy type script variant
  entityScript:  ScriptInfo
  factoryScript: ScriptInfo
  lpTokenScript: ScriptInfo
  timelockLock:  ScriptInfo  // optional LP commitment lock (epoch deadline + owner co-sign)
  tokenRegistry: ScriptInfo  // paid, owner-signed token registration (verified badge)
  stakePool:     ScriptInfo  // singleton staking accumulator (MasterChef acc, CKB reward vault)
  stakeGuard:    ScriptInfo  // delegation guard for stake receipt (type) + custody (lock) cells
  miningPool:    ScriptInfo  // liquidity-mining pool: stake CKB/xUDT LP, earn minted VTX
  emissionLock:  ScriptInfo  // VTX mint authority (only under a mining-pool spend)
  stakeTimelockGuard?: ScriptInfo // composed custody lock for locked (lock-boost) mining positions
  vtxSink?:            ScriptInfo // enforced VTX buy-back sink (25% team cap / burn floor)
  xudtScript:    ScriptInfo
  alwaysSuccess: ScriptInfo  // permissive lock for pool info cells (public, anyone-can-swap)
}

export type ChainConfig = {
  network:    Network
  rpcUrl:     string
  indexerUrl: string
  scripts:    DeployedScripts
  /** Optional paid token-registration: the platform fee (shannons) and the treasury lock it must be
   *  paid to. When set, sdk.registerToken charges `feeShannons` to `treasury` by default. token-registry
   *  also pins the floor and treasury on-chain, so a hand-built tx can't bypass it: `feeShannons` must be
   *  >= the contract's MIN_REGISTRATION_FEE and `treasury` must hash to the pinned PLATFORM_TREASURY. */
  registry?: {
    feeShannons: bigint
    treasury: { codeHash: string; hashType: 'type' | 'data' | 'data1'; args: string }
  }
  /** The canonical factory singleton's type script (enforces one pool per (pair, fee) on-chain). The
   *  registry cell is spent and recreated on every pool creation, so its outpoint changes; the SDK
   *  locates the live cell each time by this type. When set, sdk.createPool spends the factory and
   *  appends the (pair,fee) entry (pool_id from the registry's next_id) and pool-script requires that
   *  registration. codeHash must equal pool-script's baked FACTORY_CODE_HASH (the factory binary's
   *  data hash). */
  factoryCell?: { codeHash: HexString; hashType: 'type' | 'data' | 'data1' | 'data2'; args: HexString }
}

// ─── Constants ────────────────────────────────────────────────────────────

/** 61 CKBytes minimum for any cell */
export const MIN_CELL_CAPACITY    = 6_100_000_000n
/** Pool cells need extra for scripts and data. The info cell occupies ~378 CKB, and a CKB-native
 *  pool's reserveX = capacity - MIN_POOL_CAPACITY, so the floor must sit above occupied; it also acts
 *  as a dust floor. Must match cell-utils::MIN_POOL_CAPACITY. */
export const MIN_POOL_CAPACITY    = 40_000_000_000n  // 400 CKB
/** Intent-lock cells (xUDT cells with intent lock).
 *  Occupies ~260 CKB: intent-lock lock (138-byte args, including the OTX-hash field) + xUDT type
 *  + 16B data. The extra headroom lets swapAsync fund the cell. */
export const MIN_INTENT_CAPACITY  = 27_000_000_000n  // 270 CKB
/** Standard capacity parked in a user-owned xUDT output cell (144 CKB): xUDT type + owner lock +
 *  16-byte amount, with headroom above the 61 CKB floor. Centralized so an occupancy change is one
 *  edit across the SDK and the settlement builder. */
export const XUDT_CELL_CAPACITY   = 14_400_000_000n  // 144 CKB
/** Fee rate (shannons per 1000 bytes) passed to CCC's completeFeeBy across every built transaction.
 *  A fee-market spike is then a one-line change. */
export const DEFAULT_FEE_RATE     = 1000
/** Minimum swap amount to prevent dust attacks */
export const MIN_SWAP_AMOUNT      = 100n  // 100 base units (token-specific)
/** Price impact warning threshold */
export const HIGH_IMPACT_THRESHOLD = 0.05  // 5%
/** Zero hash, used as the tokenX identifier for CKB-native pools */
export const CKB_TYPE_HASH = ('0x' + '0'.repeat(64)) as TypeHash
