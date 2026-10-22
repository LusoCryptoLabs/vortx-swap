# Security

This project is not maintained. There is no security contact, no bounty, and no fixes are planned.
The code has only run on the CKB testnet and has not been audited by a third party. Anything below
describes the intent of the code and the results of internal review, not a guarantee.

## Threat model

- Anyone can build a transaction that spends public cells. Every pool, lock and registry script
  validates its own rules against an arbitrary transaction.
- The aggregator that batches OTX and intent trades is assumed hostile. It may censor, reorder or try
  to change trade parameters. The goal is that it can censor but not steal.
- Out of scope: CKB itself, the xUDT standard, JoyID and WebAuthn authenticators, and anything about
  hosting the frontend or the aggregator.

## What the contracts check

- User funds move only with the user's own signature or lock (`cellswap-otx-lock`, `intent-lock`).
- The OTX commitment covers the first input outpoint, the total input amount, `min_amount_out`,
  `token_out`, `owner_lock_hash`, `token_in` and `deadline_epoch`. The lock recomputes it and checks
  that every input in its group is of the committed `token_in` type, so a solver cannot change the
  tokens, pay out less than the minimum, or redirect the payout.
- `k` cannot decrease across a swap. Fee rounding favors the pool. Zero reserves are rejected
  (`shared/amm-math`).
- `lp_supply` changes only with a matching lp-token mint or burn, and `MINIMUM_LIQUIDITY` stays locked.
- Each pool has a canonical type id. Decoy or duplicate reserve cells are rejected, and reserves stay
  under `pool-lock`.
- The protocol fee `k_last` does not decrease on collect.
- Staked funds and rewards are bound to the owner lock and capacity cannot be skimmed. Accumulator
  math is clamped against overflow.
- Reward emission cannot be minted early or above the schedule through a permissionless path.

Many of the integration tests in `tests/integration` reproduce the attack a check was added for.

## Trust boundaries

- **Upgrade keys.** Every contract is deployed as a Type ID cell. Whoever holds a Type ID cell can
  replace that script's code, including the user custody locks `cellswap-otx-lock` and `intent-lock`.
  On testnet this is one deployer key. A real deployment should reference the custody locks by data
  hash, and put the other upgrade keys behind a multisig and timelock or burn them.
- **Governance key.** `GOVERNANCE_AUTHORITY`, the treasury and the emission locks are a single
  testnet key compiled into the contracts.
- **Reward token supply.** `emission-lock` cannot bind the canonical VTX type hash (the hash depends on
  the lock). Supply integrity depends on governance only enabling mining pools that name the canonical
  VTX type hash.
- **Deadlines are best effort.** A header dep proves that a block of that epoch exists, not that it is
  the tip, so a solver can settle a little after the deadline using an old header. `min_amount_out`
  still holds, and the user can cancel by spending the input.
- **secp256r1 verification** has been checked against JoyID's own verifier and with simulated P-256
  keys, but not with a live JoyID `signChallenge` round trip.
- **Non-standard tokens.** An xUDT with freeze, blacklist or rebase behavior can make reserves
  impossible to withdraw. The token registry's owner binding covers only standard xUDT.
- **Signatures are classical ECC.** Lock args store `blake2b256(pubkey)`, not the key, so a key is only
  exposed when it is used. The `scheme_version` byte in the lock args leaves room for another
  signature scheme. No post-quantum scheme is implemented.

## Known open issues

- The pool info cell offsets and `MINIMUM_LIQUIDITY` are copied by hand in `pool-script`, `lp-token`
  and `factory-script`. They agree today. A layout change has to update all three.
- `token-registry` scans at most 1000 inputs for the authorizing input. A registration whose
  authorizing input is past index 1000 is rejected.
- `pool-script` counts LP cells by `code_hash` and 32-byte `args`, not by `hash_type`. This is not
  exploitable with a single Type ID deployment, but pinning `hash_type` would remove the assumption.
- On a liquidity event `k_last` is set to `sqrt(k)` of the new reserves without the clamp used on
  collect. This is safe only because the fee mint before the event uses the pre-event `k`. A refactor
  that changes that order would reopen a phantom fee.
- `mining-pool` picks the lock-boost tier from `unlock_epoch - now`, where `now` comes from a header
  dep. A staker can use an old header to get a higher tier and a larger share of emission. The gap is
  bounded by how long the pool has gone untouched, because `now` cannot be below the pool's
  `last_epoch`. A full fix needs an absolute `since` equal to `now` when a locked position is created.
- An OTX trade whose output token is CKB cannot be settled. The lock fails closed, so the trade
  never fills and nothing is lost.
- `stake-guard` is matched by `code_hash` only. Same reasoning as the LP cells: pin `hash_type`.
- Mining pool genesis does not bound `last_epoch` or `emission_bps`. Only the creator sets them, and
  bad values only hurt the creator.
- Anyone can register a pool in the factory. No script trusts factory entries today, so this only
  matters if a future script does.
- `getStakeStats` in the SDK reports the first staking pool only.

## Before any mainnet use

- An independent audit of the contracts and the secp256r1/WebAuthn code.
- A multisig and timelock for governance, treasury and emission.
- A decision on every Type ID upgrade key, as above.
- Mainnet constants in `token-registry` (`PLATFORM_TREASURY`, `XUDT_CODE_HASH`, `XUDT_HASH_TYPE`) and
  the other contracts, and a reproducible build whose hashes match the audited source.
- A live JoyID test of the OTX challenge encoding.
- Frontend headers (CSP, frame options), a scoped `CORS_ORIGIN` on the aggregator, and proper custody
  of `SOLVER_PRIVATE_KEY`.
