# End-to-end scripts

These scripts exercise the contracts, the SDK and the aggregator on a real chain, without the
frontend. `run.mjs` is the main suite; the others cover single paths.

## Devnet

Requirements: `offckb` (`npm i -g @offckb/cli`), Node 20 or later, pnpm, and the contracts built to
`build/release/` (`make build`, or `bash docker-build.sh`).

```bash
# 1. Start a local devnet (separate terminal, leave it running)
offckb node

# 2. Deploy the contracts (offckb deploy --type-id …), then patch and rebuild the config
node scripts/patch-devnet.mjs
pnpm install && pnpm -r build

# 3. Export the devnet system scripts for CCC (add NervosDao manually)
offckb system-scripts --export-style ccc > devnet-ccc-scripts.json

# 4. Run the suite
NETWORK=devnet \
DEPLOYER_PRIVATE_KEY=0x6109170b275a09ad54877b82f7d9930f88cab5717d484fb4741ae9d1dd078cd6 \
CCC_SCRIPTS_JSON=$(pwd)/devnet-ccc-scripts.json \
node scripts/e2e/run.mjs
```

The key above is offckb's public devnet account 0, pre-funded on every offckb devnet. Never fund it
on testnet or mainnet.

## Testnet

`run.mjs` also runs on testnet against `TESTNET_SCRIPTS` in `packages/config` (written by
`scripts/patch-testnet.mjs`). Both keys must be funded testnet accounts:

```bash
NETWORK=testnet DEPLOYER_PRIVATE_KEY=0x... SECOND_PRIVATE_KEY=0x... node scripts/e2e/run.mjs
```

Testnet confirmation can take longer than CCC's default 60 s wait. `otx-testnet.mjs` runs the OTX
step alone with a longer timeout. It reads the keys from `.testnet-deployer.key` and
`.testnet-acct1.key` in the repo root (both gitignored) and needs the A/B pool that `run.mjs`
creates, so run `run.mjs` first with `SECOND_PRIVATE_KEY` set to the acct1 key.

## Environment

| Variable | Used by | Meaning |
| --- | --- | --- |
| `NETWORK` | run, concurrency | `devnet` (default) or `testnet` |
| `DEPLOYER_PRIVATE_KEY` | run, aggregator-otx, concurrency | funded account that issues tokens and creates pools (required) |
| `SECOND_PRIVATE_KEY` | run | second funded account, owner of token B (default: offckb devnet account 1) |
| `CCC_SCRIPTS_JSON` | run, aggregator-otx, concurrency | devnet system-script export from step 3 (devnet only) |
| `OTX_PORT` | aggregator-otx | aggregator port (default 3002) |
| `N` | concurrency | number of simultaneous swaps (default 5) |
| `WAIT_MS` | otx-testnet | confirmation timeout in ms (default 240000) |
| `JOYID_CAPTURE` | otx-joyid-real | path to a captured JoyID response |

## What `run.mjs` covers

- Issues two distinct test xUDT tokens (two owners) and transfers one to the pool creator
- xUDT/xUDT pool: createPool, getPool, quote, direct atomic swap (≥ minAmountOut, reserves update,
  invariant holds), add liquidity, remove liquidity
- Async intent-lock path: creates the intent cell, then settles it through the pool
  (aggregator-style) so the owner is paid
- CKB/xUDT pool: createPool, swap CKB→token and token→CKB, add/remove liquidity
- OTX path (JoyID flow): migrates tokens into a `cellswap-otx-lock` cell, signs the commitment with
  a simulated JoyID P-256 key, and settles; the lock verifies the secp256r1 WebAuthn signature
  on-chain (step 13)
- A second account swaps against the first account's pool (step 14)

## Other scripts

- `aggregator-otx.mjs`: posts a signed OTX to a running aggregator's `/otx` endpoint and waits for
  settlement. Devnet only; run `run.mjs` first and start the aggregator with
  `SOLVER_PRIVATE_KEY=0x... NETWORK=devnet CCC_SCRIPTS_JSON=... node packages/aggregator/dist/main.js`.
- `concurrency.mjs`: fires `N` swaps at one pool at once to show pool-cell contention (at most one
  per block).
- `otx-testnet.mjs`: the OTX step on testnet, see above.
- `otx-joyid-real.mjs`: checks a captured real JoyID `signChallenge()` response against the
  verifier. The capture steps are in the file header. Exits 0 when `JOYID_CAPTURE` is unset.
- The on-chain OTX test is `run.mjs` step 13. A real JoyID popup can only be checked by hand on
  testnet.
