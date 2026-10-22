import { useEffect, useMemo, useState } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { ccc } from '@ckb-ccc/connector-react'
import { sdk, client, config } from '../lib/cellswap'
import { CKB, TOKEN_LIST, tokenByArgs, isVerifiedToken, type TokenInfo } from '../lib/tokens'
import { fetchTokenMeta } from '../lib/tokenMeta'
import { fetchPoolHistory, type PricePoint } from '../lib/history'
import { fetchUserLpTxHashes } from '../lib/lpHistory'
import { enrichPools, buildAnchoring, tokenByTypeHash, type EnrichedPool } from '../lib/pricing'
import { fetchPoolsSnapshot } from '../lib/poolSnapshot'
import { computePoolApr, type AprStat } from '../lib/apr'
import { deriveTxns, type Txn } from '../lib/txns'
import { readU128LE } from '../lib/utils'
import type { Pool, SwapQuote } from '@cellswap/sdk'

/** All pools (info cells), reserves hydrated. Polls so reserves/price stay fresh.
 *  Prefers the aggregator's pre-aggregated snapshot for an instant list (display only); falls
 *  back to the live on-chain scan if the snapshot is absent/stale. Quotes + swaps always build
 *  from live chain state inside the SDK, so the snapshot can never affect correctness. */
export function usePools() {
  return useQuery({
    queryKey: ['pools', config.network],
    queryFn: async () => (await fetchPoolsSnapshot()) ?? sdk.getPools(),
    refetchInterval: 12_000,
  })
}

/** A single pool for a token pair (args = owner lock hashes). */
export function usePool(tokenXArgs?: string, tokenYArgs?: string) {
  return useQuery({
    queryKey: ['pool', config.network, tokenXArgs, tokenYArgs],
    queryFn: () => sdk.getPool(tokenXArgs as any, tokenYArgs as any),
    enabled: !!tokenXArgs && !!tokenYArgs && tokenXArgs !== tokenYArgs,
    refetchInterval: 12_000,
  })
}

/** Live swap quote. */
export function useQuote(tokenIn?: string, amountIn?: bigint, tokenOut?: string, slippage = 0.005) {
  return useQuery<SwapQuote | null>({
    queryKey: ['quote', config.network, tokenIn, amountIn?.toString(), tokenOut, slippage],
    queryFn: async () => {
      if (!tokenIn || !tokenOut || !amountIn || amountIn <= 0n || tokenIn === tokenOut) return null
      return sdk.quoteSwap(tokenIn as any, amountIn, tokenOut as any, slippage)
    },
    enabled: !!tokenIn && !!tokenOut && !!amountIn && amountIn > 0n && tokenIn !== tokenOut,
    refetchInterval: 10_000,
  })
}

/** The connected account's lock hash, resolved once and used to scope every wallet-derived query
 *  key. Keyed on the signer object identity (which CCC swaps out on an account switch), so switching
 *  accounts changes the key and forces a refetch instead of serving the previous account's cache.
 *  Returns undefined until it resolves (queries stay disabled/keyed on undefined until then). */
export function useSignerAddress(signer?: ccc.Signer): string | undefined {
  const [lockHash, setLockHash] = useState<string>()
  useEffect(() => {
    if (!signer) { setLockHash(undefined); return }
    let alive = true
    signer.getRecommendedAddressObj().then(a => { if (alive) setLockHash(a.script.hash()) }).catch(() => {})
    return () => { alive = false }
  }, [signer])
  return lockHash
}

/** One scan of every live cell under the connected wallet's lock. Every wallet-derived hook
 *  (balances, wallet tokens, …) reads from this shared query instead of running its own
 *  `findCellsByLock` pass, so a heavily used account is scanned once per poll, not 5 or 6 times.
 *  findCellsByLock returns cellOutput + outputData (withData defaults true), so consumers can
 *  read capacity, type, and the xUDT amount straight off the cached cells. */
export function useWalletCells(signer?: ccc.Signer) {
  const account = useSignerAddress(signer)
  return useQuery({
    queryKey: ['wallet-cells', config.network, account],
    enabled: !!signer && !!account,
    refetchInterval: 15_000,
    queryFn: async () => {
      if (!signer) return [] as ccc.Cell[]
      const addr = await signer.getRecommendedAddressObj()
      const cells: ccc.Cell[] = []
      for await (const cell of client.findCellsByLock(addr.script)) cells.push(cell)
      return cells
    },
  })
}

/** Read the little-endian u128 xUDT amount off a cell's data (first 16 bytes), or 0n. */
function udtAmountOf(cell: ccc.Cell): bigint {
  return readU128LE(cell.outputData as string)
}

/** Connected wallet balances for the curated token list (symbol → base units).
 *  Derived from the shared wallet-cells scan, with no per-token indexer round-trips. */
export function useBalances(signer?: ccc.Signer) {
  const q = useWalletCells(signer)
  const data = useMemo(() => {
    const out: Record<string, bigint> = {}
    if (!q.data) return out
    for (const t of TOKEN_LIST) {
      if (t.args === CKB) {
        let cap = 0n
        for (const cell of q.data) if (!cell.cellOutput.type) cap += cell.cellOutput.capacity
        out[t.symbol] = cap
        continue
      }
      const code = (t.codeHash ?? config.scripts.xudtScript.codeHash).toLowerCase()
      const hashType = t.hashType ?? config.scripts.xudtScript.hashType
      const argsLc = t.args.toLowerCase()
      let amt = 0n
      for (const cell of q.data) {
        const ty = cell.cellOutput.type
        if (!ty || ty.codeHash.toLowerCase() !== code || ty.hashType !== hashType || ty.args.toLowerCase() !== argsLc) continue
        amt += udtAmountOf(cell)
      }
      out[t.symbol] = amt
    }
    return out
  }, [q.data])
  return { ...q, data }
}

/** Reconstructed price history for a pool (cell-chain scan). */
export function usePoolHistory(pool?: Pool | null, decimalsX = 8, decimalsY = 8) {
  const q = useQuery<PricePoint[]>({
    queryKey: ['history', config.network, pool ? ccc.Script.from(pool.cell.output.type as any).hash() : null],
    enabled: !!pool?.cell?.output?.type,
    staleTime: 60_000,
    queryFn: async () => {
      if (!pool?.cell?.output?.type) return []
      const t = pool.cell.output.type as any
      return fetchPoolHistory({
        poolType: { codeHash: t.codeHash, hashType: t.hashType, args: t.args },
        poolLockCodeHash: config.scripts.poolLock.codeHash,
        tokenXHash: pool.tokenX,
        tokenYHash: pool.tokenY,
        decimalsX, decimalsY,
        ckbNative: pool.poolMode === 'CKB_XUDT',
      })
    },
  })
  // The ['history'] cache is shared with the APR/feed hooks, which fetch at nominal 8 decimals.
  // Recompute price from the raw reserves with these decimals so the chart is always correct.
  const data = (q.data ?? []).map(p => {
    const rx = Number(p.reserveX) / 10 ** decimalsX
    return { ...p, price: rx > 0 ? (Number(p.reserveY) / 10 ** decimalsY) / rx : p.price }
  })
  return { ...q, data }
}

/** Resolve names for pool tokens not in the curated list. A pool stores only the token's
 *  type hash, but its reserve cell carries the full xUDT script (with args), so we read the
 *  args off the reserve cell and resolve the real name on-chain (Unique cell) / Explorer.
 *  Returns typeHash(lower) → TokenInfo. */
function usePoolTokenNames(pools: Pool[]) {
  const xudtCode = config.scripts.xudtScript.codeHash
  const xudtHashType = config.scripts.xudtScript.hashType
  const targets = new Map<string, string>()   // unknown token typeHash → its xUDT args
  for (const p of pools) {
    const sides: [string, any][] = [[p.tokenX, (p as any).reserveCellX], [p.tokenY, (p as any).reserveCellY]]
    for (const [th, cell] of sides) {
      const k = th.toLowerCase()
      if (k === CKB || tokenByTypeHash(k)) continue          // CKB or curated → already named
      const args = cell?.output?.type?.args
      if (args && !targets.has(k)) targets.set(k, args)
    }
  }
  const entries = [...targets.entries()]
  const results = useQueries({
    queries: entries.map(([th, args]) => ({
      queryKey: ['tokenmeta', config.network, th],
      staleTime: Infinity,
      queryFn: async () => ({ th, args, meta: await fetchTokenMeta({ codeHash: xudtCode, hashType: xudtHashType, args }) }),
    })),
  })
  // Memoize so the Map identity is stable between renders while the resolved names are unchanged
  // (usePoolViews / useLpHistory depend on this Map; a fresh identity each render re-runs their work).
  const sig = entries.map(([th]) => th).join('|') + '::' + results.map(r => r.data?.meta?.symbol ?? (r.isFetched ? 'f' : '')).join('|')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => {
    const map = new Map<string, TokenInfo>()
    results.forEach((r, i) => {
      const [th, args] = entries[i]
      const m = r.data?.meta
      if (m) map.set(th, { symbol: m.symbol, name: m.name, args: args as `0x${string}`, decimals: m.decimals })
      else if (r.isFetched) map.set(th, { symbol: args.slice(2, 6).toUpperCase() + '…', name: 'Unknown token', args: args as `0x${string}`, decimals: 8 })
    })
    return map
  }, [sig])
}

/** All pools, enriched with token metadata, spot price, and CKB-denominated TVL.
 *  Non-curated tokens get their on-chain names filled in instead of "???". */
export function usePoolViews() {
  const q = usePools()
  const names = usePoolTokenNames(q.data ?? [])
  const views: EnrichedPool[] = (q.data ? enrichPools(q.data) : []).map(v =>
    v.tokenX && v.tokenY ? v : {
      ...v,
      tokenX: v.tokenX ?? names.get(v.pool.tokenX.toLowerCase()),
      tokenY: v.tokenY ?? names.get(v.pool.tokenY.toLowerCase()),
    })
  return { ...q, views }
}

/** Best-effort fee APR per pool, keyed by poolId. Reuses the same per-pool history queries
 *  the detail page uses (shared ['history', …] cache), then values realized swap fees against
 *  the live anchoring. Pools that can't be priced or have no swap history are simply absent. */
export function usePoolAprs(): Map<string, AprStat> {
  const { data: pools = [] } = usePools()
  const anchor = buildAnchoring(pools)
  const results = useQueries({
    queries: pools.map(p => ({
      queryKey: ['history', config.network, ccc.Script.from(p.cell.output.type as any).hash()],
      staleTime: 60_000,
      queryFn: async (): Promise<PricePoint[]> => {
        const t = p.cell.output.type as any
        return fetchPoolHistory({
          poolType: { codeHash: t.codeHash, hashType: t.hashType, args: t.args },
          poolLockCodeHash: config.scripts.poolLock.codeHash,
          tokenXHash: p.tokenX, tokenYHash: p.tokenY,
          decimalsX: 8, decimalsY: 8,            // reserves are raw; price field is unused here
          ckbNative: p.poolMode === 'CKB_XUDT',
        })
      },
    })),
  })
  const map = new Map<string, AprStat>()
  results.forEach((r, i) => {
    const p = pools[i]
    if (!p || !r.data) return
    const dx = tokenByTypeHash(p.tokenX)?.decimals ?? 8
    const dy = tokenByTypeHash(p.tokenY)?.decimals ?? 8
    const priceX = anchor.get(p.tokenX.toLowerCase())?.price ?? NaN
    const priceY = anchor.get(p.tokenY.toLowerCase())?.price ?? NaN
    const tvlCkb = (Number(p.reserveX) / 10 ** dx) * priceX + (Number(p.reserveY) / 10 ** dy) * priceY
    const stat = computePoolApr({
      history: r.data, feeBps: p.feeBps,
      priceXckb: priceX, priceYckb: priceY, decimalsX: dx, decimalsY: dy, tvlCkb,
    })
    if (stat) map.set(p.poolId.toString(), stat)
  })
  return map
}

/** Reconstructed price history for every pool, keyed by poolId. Reuses the same per-pool
  *  ['history', …] cache the detail page / APR / feed hooks fill, so it adds no network calls;
  *  it surfaces the series for sparklines and windowed change. */
export function usePoolHistories(): Map<string, PricePoint[]> {
  const { data: pools = [] } = usePools()
  const results = useQueries({
    queries: pools.map(p => ({
      queryKey: ['history', config.network, ccc.Script.from(p.cell.output.type as any).hash()],
      staleTime: 60_000,
      queryFn: async (): Promise<PricePoint[]> => {
        const t = p.cell.output.type as any
        return fetchPoolHistory({
          poolType: { codeHash: t.codeHash, hashType: t.hashType, args: t.args },
          poolLockCodeHash: config.scripts.poolLock.codeHash,
          tokenXHash: p.tokenX, tokenYHash: p.tokenY,
          decimalsX: 8, decimalsY: 8,         // price field is reserveY/reserveX shape, scale-invariant
          ckbNative: p.poolMode === 'CKB_XUDT',
        })
      },
    })),
  })
  // Memoize the returned Map so its identity is stable between renders while the underlying data is
  // unchanged. Consumers (useLpHistory) list it in useMemo deps, so a fresh Map each render would
  // silently defeat their memoization. The signature captures each query's last-updated stamp.
  const sig = results.map(r => r.dataUpdatedAt ?? 0).join(',')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => {
    const map = new Map<string, PricePoint[]>()
    results.forEach((r, i) => { const p = pools[i]; if (p && r.data) map.set(p.poolId.toString(), r.data) })
    return map
  }, [pools, sig])
}

/** Transaction feed for one pool (derived from its cell-chain history). */
export function usePoolTxns(pool?: Pool | null) {
  const { data: history = [], ...rest } = usePoolHistory(pool)
  const names = usePoolTokenNames(pool ? [pool] : [])
  const resolve = (th: string) => names.get(th.toLowerCase()) ?? tokenByTypeHash(th)
  let txns: Txn[] = pool ? deriveTxns(history, resolve(pool.tokenX), resolve(pool.tokenY)) : []
  // 80 = fetchPoolHistory's default window. A full window means older txns exist, so the
  // oldest point is a baseline; drop deriveTxns' synthetic 'create' row.
  if (history.length >= 80) txns = txns.filter(x => x.kind !== 'create')
  return { ...rest, txns }
}

/** A merged recent-transaction feed across all pools. */
export function useAllTxns(limitPerPool = 40) {
  const { data: pools = [] } = usePools()
  // Resolve non-curated token names (the same on-chain resolution usePoolViews uses), so the
  // feed shows real symbols instead of "?". Applied at render (not inside the query) so the
  // rows re-label when names resolve, without re-fetching each pool's history.
  const names = usePoolTokenNames(pools)
  const resolve = (th: string) => names.get(th.toLowerCase()) ?? tokenByTypeHash(th)
  // This query must return the same shape (PricePoint[], asc) as usePoolHistory /
  // usePoolAprs: they share the ['history', …] cache key. Returning Txn[] here would poison the
  // chart's cache (different shape + reversed order → the chart expects ascending time). So we
  // fetch PricePoint[] and derive Txn[] at render.
  const results = useQueries({
    queries: pools.map(p => ({
      queryKey: ['history', config.network, ccc.Script.from(p.cell.output.type as any).hash()],
      queryFn: async (): Promise<PricePoint[]> => {
        const t = p.cell.output.type as any
        return fetchPoolHistory({
          poolType: { codeHash: t.codeHash, hashType: t.hashType, args: t.args },
          poolLockCodeHash: config.scripts.poolLock.codeHash,
          tokenXHash: p.tokenX, tokenYHash: p.tokenY,
          decimalsX: 8, decimalsY: 8,   // reserves are raw; the feed derives from them, not price
          ckbNative: p.poolMode === 'CKB_XUDT', limit: limitPerPool,
        })
      },
      staleTime: 60_000,
    })),
  })
  const txns = results.flatMap((r, i) => {
    const p = pools[i]
    const pts = (r.data ?? []) as PricePoint[]
    let rows = deriveTxns(pts)
    // If the window is full, its oldest point is a baseline (not the pool's genuine creation), so
    // drop the synthetic 'create' row deriveTxns adds so we don't show a fake full-reserves event.
    if (pts.length >= limitPerPool) rows = rows.filter(x => x.kind !== 'create')
    if (!p) return rows
    const tx = resolve(p.tokenX), ty = resolve(p.tokenY)
    return rows.map(t => ({ ...t, tokenX: tx, tokenY: ty }))
  }).sort((a, b) => Number(b.time) - Number(a.time))
  const isLoading = results.some(r => r.isLoading)
  return { txns, isLoading }
}

export interface WalletAsset {
  args: string            // xUDT args (owner lock hash): token identity; CKB = zero hash
  amount: bigint
  symbol: string
  name: string
  decimals: number
  verified: boolean
  icon?: string
}

/** Discover all tokens the connected wallet holds by grouping the shared wallet-cells scan by
 *  xUDT type script, not just the curated list. Unknown xUDTs show up as unverified. Names for
 *  non-curated tokens resolve via per-token cached queries (staleTime Infinity), so the 15s poll
 *  re-groups the (already-cached) cells without ever re-hitting the Explorer for a known name. */
export function useWalletTokens(signer?: ccc.Signer) {
  const cellsQ = useWalletCells(signer)

  // Group the shared scan into free CKB + per-token UDT amounts. Accept the standard xUDT code
  // hash and any curated token's own UDT code hash (USDI, ccBTC) so non-standard tokens show up.
  const { ckb, udt } = useMemo(() => {
    const knownUdtCodes = new Set([
      config.scripts.xudtScript.codeHash.toLowerCase(),
      ...TOKEN_LIST.filter(t => t.codeHash).map(t => t.codeHash!.toLowerCase()),
    ])
    let ckb = 0n
    const udt = new Map<string, bigint>()   // token args → amount held
    for (const cell of cellsQ.data ?? []) {
      const type = cell.cellOutput.type
      if (!type) { ckb += cell.cellOutput.capacity; continue }       // free CKB
      if (!knownUdtCodes.has(type.codeHash.toLowerCase())) continue   // skip LP/other types
      const k = type.args.toLowerCase()
      udt.set(k, (udt.get(k) ?? 0n) + udtAmountOf(cell))
    }
    return { ckb, udt }
  }, [cellsQ.data])

  // Non-curated tokens need an on-chain name. Resolve each via a cached query keyed by its args
  // with staleTime Infinity: fetched once, never re-fetched on a poll.
  const unknownArgs = useMemo(
    () => [...udt.entries()].filter(([args, amt]) => amt > 0n && !tokenByArgs(args)).map(([args]) => args),
    [udt],
  )
  const metaQs = useQueries({
    queries: unknownArgs.map(args => ({
      queryKey: ['tokenmeta-wallet', config.network, args],
      staleTime: Infinity,
      queryFn: () => fetchTokenMeta({
        codeHash: config.scripts.xudtScript.codeHash, hashType: config.scripts.xudtScript.hashType, args,
      }),
    })),
  })
  const metaByArgs = new Map(unknownArgs.map((args, i) => [args, metaQs[i]?.data ?? null]))
  // Stable signature so the assembly memo recomputes exactly when a name resolves.
  const metaSig = unknownArgs.map((_, i) => metaQs[i]?.data?.symbol ?? '').join('|')

  const data = useMemo<WalletAsset[]>(() => {
    if (!cellsQ.data) return []
    const assets: WalletAsset[] = [
      { args: CKB, amount: ckb, symbol: 'CKB', name: 'Nervos CKB', decimals: 8, verified: true },
    ]
    for (const [args, amount] of udt.entries()) {
      if (amount <= 0n) continue
      const known = tokenByArgs(args)
      if (known) { assets.push({ args, amount, symbol: known.symbol, name: known.name, decimals: known.decimals, verified: isVerifiedToken(args) }); continue }
      const meta = metaByArgs.get(args)
      assets.push(meta
        ? { args, amount, symbol: meta.symbol, name: meta.name, decimals: meta.decimals, verified: false, icon: meta.icon }
        : { args, amount, symbol: args.slice(2, 6).toUpperCase(), name: 'Unknown token', decimals: 8, verified: false })
    }
    return assets.sort((a, b) => (a.args === CKB ? -1 : b.args === CKB ? 1 : 0))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellsQ.data, ckb, udt, metaSig])

  return { ...cellsQ, data, isLoading: cellsQ.isLoading }
}

/** A lookup `(tokenArgs) => heldBalance` over all tokens the wallet holds (curated or not). */
export function useHeldBalance(signer?: ccc.Signer): (args: string) => bigint {
  const { data: assets = [] } = useWalletTokens(signer)
  const map = new Map(assets.map(a => [a.args.toLowerCase(), a.amount]))
  return (args: string) => map.get(args.toLowerCase()) ?? 0n
}

/** Current tip epoch number, for time-lock countdowns. Polls slowly (epochs are ~4h). */
export function useTipEpoch() {
  return useQuery({
    queryKey: ['tip-epoch', config.network],
    queryFn: () => sdk.tipEpoch(),
    refetchInterval: 120_000,
  })
}

/** On-chain token registrations (verified badge), keyed by token type hash (lowercased). Only
 *  registrations whose ownerLockHash == the token's xUDT args are a valid issuer-ownership proof. */
export function useRegistrations() {
  return useQuery({
    queryKey: ['registrations', config.network],
    queryFn: async () => {
      const map = new Map<string, Awaited<ReturnType<typeof sdk.getRegistrations>>[number]>()
      for (const r of await sdk.getRegistrations()) map.set(r.tokenTypeHash.toLowerCase(), r)
      return map
    },
    refetchInterval: 60_000,
    enabled: sdk.registryEnabled(),
  })
}

/** Protocol-wide locked liquidity, keyed by pool info type hash (permissionless on-chain scan). */
export function useLockedLiquidity() {
  return useQuery({
    queryKey: ['locked-liq', config.network],
    queryFn: () => sdk.getLockedLiquidity(),
    refetchInterval: 30_000,
  })
}

/** All liquidity-mining pools (stake CKB/xUDT LP → earn VTX). Keyed by the LP token hash. */
export function useMiningPools() {
  return useQuery({
    queryKey: ['mining-pools', config.network],
    queryFn: () => sdk.getMiningPools(),
    refetchInterval: 30_000,
    enabled: sdk.miningEnabled(),
  })
}

/** The (v1: single) staking pool's stats: total staked, reward reserve, CKB streamed per epoch. */
export function useStakeStats() {
  return useQuery({
    queryKey: ['stake-stats', config.network],
    queryFn: () => sdk.getStakeStats(),
    refetchInterval: 30_000,
    enabled: sdk.stakingEnabled(),
  })
}

/** The staking pool object (stake token, emission, reserve), for token resolution and APR.
 *  There can be more than one stake pool (e.g. a curated token and an unrecognized one). The bare
 *  sdk.getStakePool() returns the first pool found, which may be the unrecognized one, and then
 *  StakingPage dead-ends in its !token branch even though a usable curated pool exists. So prefer a
 *  pool whose stakeToken resolves to a curated token, and fall back to the first found if none do. */
export function useStakePool() {
  return useQuery({
    queryKey: ['stake-pool', config.network],
    queryFn: async () => {
      const first = await sdk.getStakePool()
      if (first && tokenByTypeHash(first.stakeToken)) return first
      for (const t of TOKEN_LIST) {
        if (t.args === CKB) continue
        const p = await sdk.getStakePool(t.args)
        if (p && tokenByTypeHash(p.stakeToken)) return p
      }
      return first
    },
    refetchInterval: 30_000,
    enabled: sdk.stakingEnabled(),
  })
}

/** The connected wallet's stake position: principal + pending CKB reward (accrued to the tip). */
export function useStakePosition(signer?: ccc.Signer) {
  const account = useSignerAddress(signer)
  return useQuery({
    queryKey: ['stake-position', config.network, account],
    enabled: !!signer && !!account && sdk.stakingEnabled(),
    refetchInterval: 20_000,
    queryFn: () => (signer ? sdk.getStakePosition(signer) : Promise.resolve(null)),
  })
}

/** LP positions for the connected wallet. */
export function usePositions(signer?: ccc.Signer) {
  const account = useSignerAddress(signer)
  return useQuery({
    queryKey: ['positions', config.network, account],
    enabled: !!signer && !!account,
    refetchInterval: 15_000,
    queryFn: () => (signer ? sdk.getLpPositions(signer) : Promise.resolve([])),
  })
}

/** Set of tx hashes where the connected wallet's LP cells were minted/burned (its add/remove
 *  events), across both the plain lock and the timelock lock. */
export function useUserLpTxHashes(signer?: ccc.Signer) {
  const account = useSignerAddress(signer)
  return useQuery<Set<string>>({
    queryKey: ['user-lp-txs', config.network, account],
    enabled: !!signer && !!account,
    refetchInterval: 30_000,
    queryFn: async () => {
      if (!signer) return new Set<string>()
      const addr = await signer.getRecommendedAddressObj()
      const s = addr.script
      const lp = config.scripts.lpTokenScript
      const tl = config.scripts.timelockLock
      return fetchUserLpTxHashes({
        userLock: { code_hash: s.codeHash, hash_type: s.hashType, args: s.args },
        lpScript: { code_hash: lp.codeHash, hash_type: lp.hashType, args: '0x' },
        timelock: sdk.timelockEnabled() ? { code_hash: tl.codeHash, hash_type: tl.hashType, args: s.hash() } : null,
      })
    },
  })
}

export interface LpHistoryEntry {
  pool: Pool
  tokenX?: TokenInfo
  tokenY?: TokenInfo
  events: Txn[]                 // newest-first add/remove (initial create counts as an add)
  depX: bigint; depY: bigint    // lifetime deposited per side
  wdX: bigint; wdY: bigint      // lifetime withdrawn per side
  netX: bigint; netY: bigint    // withdrawn − deposited (exact; captures fees + IL in token terms)
  closed: boolean
  lastTime: number
}

/** The connected wallet's LP lifecycle, per pool: its add/remove events (reconstructed from the
 *  cell chain) and an exact per-token net. Includes fully-closed positions. Bounded to each pool's
 *  recent history window. */
export function useLpHistory(signer?: ccc.Signer): LpHistoryEntry[] {
  const { data: pools = [] } = usePools()
  const histories = usePoolHistories()
  const names = usePoolTokenNames(pools)
  const { data: positions = [] } = usePositions(signer)
  const { data: userTxs } = useUserLpTxHashes(signer)
  return useMemo(() => {
    if (!userTxs || userTxs.size === 0) return []
    const resolve = (th: string) => names.get(th.toLowerCase()) ?? tokenByTypeHash(th)
    const openPoolIds = new Set(positions.map(p => p.pool.poolId.toString()))
    const out: LpHistoryEntry[] = []
    for (const p of pools) {
      const pts = histories.get(p.poolId.toString()) ?? []
      if (pts.length === 0) continue
      const tx = resolve(p.tokenX), ty = resolve(p.tokenY)
      // A full window means the oldest point is a baseline, not the genuine creation, so only
      // trust a 'create' event (initial liquidity) when the window captured the real start.
      const windowFull = pts.length >= 80
      const events = deriveTxns(pts, tx, ty).filter(e =>
        userTxs.has(e.txHash) && (e.kind === 'add' || e.kind === 'remove' || (e.kind === 'create' && !windowFull)))
      if (events.length === 0) continue
      let depX = 0n, depY = 0n, wdX = 0n, wdY = 0n
      for (const e of events) {
        const ax = e.dx < 0n ? -e.dx : e.dx, ay = e.dy < 0n ? -e.dy : e.dy
        if (e.kind === 'remove') { wdX += ax; wdY += ay } else { depX += ax; depY += ay }
      }
      out.push({
        pool: p, tokenX: tx, tokenY: ty, events,
        depX, depY, wdX, wdY, netX: wdX - depX, netY: wdY - depY,
        closed: !openPoolIds.has(p.poolId.toString()),
        lastTime: events[0]?.time ?? 0,
      })
    }
    return out.sort((a, b) => b.lastTime - a.lastTime)
  }, [pools, histories, names, positions, userTxs])
}

export interface PendingOrder {
  outPoint: { txHash: string; index: number }
  cell: any
  amountIn: bigint
  tokenInArgs?: string
  tokenOutHash: string
  minOut: bigint
}

const hexAt = (args: string, start: number, len: number) =>
  '0x' + (args.startsWith('0x') ? args.slice(2) : args).slice(start * 2, (start + len) * 2)

/** Pending async (intent-lock) orders awaiting settlement, for the connected owner.
 *  intent-lock args = ownerLockHash(32) || minOut(16) || tokenOut(32) || deadline(…). */
export function usePendingOrders(signer?: ccc.Signer) {
  const account = useSignerAddress(signer)
  return useQuery<PendingOrder[]>({
    queryKey: ['pending', config.network, account],
    enabled: !!signer && !!account && config.scripts.intentLock.codeHash !== '0x' + '0'.repeat(64),
    refetchInterval: 12_000,
    queryFn: async () => {
      if (!signer) return []
      const addr = await signer.getRecommendedAddressObj()
      const ownerLockHash = addr.script.hash().toLowerCase()
      const search = {
        script: { codeHash: config.scripts.intentLock.codeHash, hashType: config.scripts.intentLock.hashType, args: ownerLockHash },
        scriptType: 'lock', scriptSearchMode: 'prefix',
      }
      const out: PendingOrder[] = []
      try {
        for await (const cell of client.findCells(search as any)) {
          const args = (cell.cellOutput.lock.args as string).toLowerCase()
          if (!args.startsWith(ownerLockHash)) continue
          const minOut = readU128LE(hexAt(args, 32, 16))
          const tokenOutHash = hexAt(args, 48, 32)
          const amountIn = readU128LE(cell.outputData)
          out.push({
            outPoint: { txHash: cell.outPoint.txHash, index: Number(cell.outPoint.index) },
            cell, amountIn, tokenOutHash,
            tokenInArgs: cell.cellOutput.type?.args, minOut,
          })
        }
      } catch { /* indexer/script unavailable */ }
      return out
    },
  })
}

export type { Pool, SwapQuote, TokenInfo, EnrichedPool, Txn, AprStat }
