# Architecture

## Contracts

All scripts are in `contracts/` and build to RISC-V for CKB-VM. The build set and its order are in
`contracts.list`. Each `main.rs` starts with a header that documents its args, data layout and rules.

| Script | Kind | Role |
|--------|------|------|
| `pool-script` | type | Pool info cell. Checks the constant-product invariant against the real reserve cells, LP supply, TWAP, and the optional protocol fee (`k_last`). |
| `pool-lock` | lock | Holds the reserve cells of one pool. Requires that pool's info cell in the inputs and outputs. |
| `factory-script` | type | Pool registry and pause authority. Its data hash is compiled into `pool-script`. |
| `lp-token` | type | xUDT-compatible LP token. Mint and burn follow the pool's `lp_supply`. |
| `cellswap-otx-lock` | lock | secp256r1/WebAuthn lock for OTX trades. Verifies the signed commitment and the minimum output. |
| `intent-lock` | lock | Resting intent (swap or limit order) that a solver can settle or the owner can cancel. |
| `timelock-lock` | lock | LP lock until an absolute epoch, with an owner co-sign. |
| `token-registry` | type | Token metadata with a registration fee to a treasury. Binds the registering owner to the token. |
| `stake-pool`, `stake-guard` | type, lock | xUDT staking with CKB rewards: a receipt cell plus a custody lock. |
| `stake-timelock-guard` | lock | Custody for time-locked stakes (higher reward weight). |
| `mining-pool`, `emission-lock` | type, lock | Liquidity mining: stake LP, earn the reward token (VTX). `emission-lock` allows minting only under a mining pool spend. |
| `vtx-sink-lock` | lock | Destination for the protocol fee buy-back: burn or vest to a team lock. |
| `always-success` | lock | Test helper. |

Shared crates in `shared/`: `amm-math` (invariant, LP mint, protocol fee, `no_std`), `cell-utils`
(byte readers, capacity floor) and `molecule-types` (generated from `schemas/`).

`schemas/cellswap_types.mol` is older than the contracts. Its `PoolData` still has reserve fields and
it has unused Cobuild tables. The contract headers are the reference for the current layouts.

## Pools

A pool is a group of cells:

- the info cell, typed by `pool-script`, 156 bytes of data (token type hashes, `lp_supply`,
  `fee_bps`, `pool_id`, TWAP accumulators, mode, pause flag, `k_last`);
- one or two reserve cells, real xUDT cells locked by `pool-lock` with the info cell's type hash as
  args.

Mode `0x00` is xUDT/xUDT. Mode `0x01` is CKB/xUDT, where the CKB reserve is the info cell's capacity
minus `MIN_POOL_CAPACITY` (400 CKB). The first deposit locks `MINIMUM_LIQUIDITY` (1000) LP forever.

When `k_last` is non-zero, every add, remove and collect first mints the protocol's share of fee
growth as LP to the treasury lock, following Uniswap V2 `_mintFee`.

## OTX flow

1. The user moves xUDT to a `cellswap-otx-lock` address. The lock args are
   `scheme_version (1) || blake2b256(pubkey) (32)`.
2. The SDK computes a commitment over the input outpoint, the total input amount and the intent:
   `min_amount_out (16) || token_out (32) || owner_lock_hash (32) || token_in (32) || deadline_epoch (8)`.
   JoyID signs it with `signChallenge`.
3. The signed payload goes to the aggregator's `/otx` endpoint, which checks the signature and rate
   limits the caller.
4. The aggregator builds one transaction with many OTX inputs and the pool cells. Each OTX lock
   recomputes the commitment, verifies the WebAuthn signature and checks that the owner receives at
   least `min_amount_out` of `token_out`.

The witness is `sig (64) || pubkey (64) || authenticatorData || clientDataJSON || intent (120)`.
Replay is not possible because the input cell is consumed.

## Off-chain

- `packages/sdk`: transaction builders for every path above (`CellSwap` class), quotes and LP
  positions.
- `packages/aggregator`: chain scanner, OTX and intent intake, batch builder and settlement, an
  and an optional tester access gate.
- `packages/router`: multi-hop path finding and slippage.
- `packages/chain-client`: RPC and CCC calls.
- `packages/config`: deployed script references per network. Testnet values point at the original
  deployment, mainnet is empty.
- `apps/frontend`: React app on top of the SDK, using `@ckb-ccc/connector-react` for wallets.

## Tests

- `tests/integration`: ckb-testtool runs the compiled contracts. Needs `make build` first. The OTX
  lock tests are behind `--features otx-tests`.
- `tests/logic`: node suites for the AMM math, byte offsets, WebAuthn and OTX commitments, and the
  aggregator guards. `node scripts/run-logic-tests.mjs` runs them all.
- `scripts/e2e` and `scripts/verify-*-testnet.mjs`: scripts that send real transactions to a devnet or
  testnet. They take keys from `*_PRIVATE_KEY` env vars or from `.testnet-*.key` files, which are git
  ignored.
