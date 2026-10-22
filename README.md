# Vortx Swap (CellSwap)

An intent-based AMM DEX on Nervos CKB. Users keep custody of their assets: every trade is
authorized by the user's own lock, including a secp256r1/WebAuthn lock for JoyID passkeys. Batched
trades are settled by an aggregator that is not trusted. It can censor a trade, but it cannot take
funds or settle below the user's signed minimum.

The product name is Vortx Swap. The code and packages use the original name, CellSwap
(`@cellswap/*`).

## Status

This code is published as is. It is not maintained, and issues and pull requests are not
monitored.

- It has only run on the CKB public testnet (Pudge). The mainnet script entries in
  `packages/config` are empty.
- It has not been audited by a third party. Read [SECURITY.md](SECURITY.md) for the trust
  boundaries and the known open issues.
- The contracts compile in testnet constants: the governance key, the treasury lock and the xUDT
  code hash. Rebuild them with your own values before deploying anywhere.
- Do not use it with real funds.

## Trade paths

| Path | How | Custody |
|------|-----|---------|
| Direct swap | The user signs the full transaction | User lock |
| Intent | The user locks an intent cell, the aggregator settles it | `intent-lock` |
| OTX | The user signs a commitment, the aggregator batches it | `cellswap-otx-lock` |

The OTX path is built for JoyID. The lock verifies a WebAuthn assertion on-chain over a commitment
to the input, the token pair, the minimum output, the payout lock and a deadline. The on-chain
verification has been tested with a P-256 key and a simulated authenticator, not with a live JoyID
`signChallenge`.

The repo also contains an optional LP time-lock, a token registry with a registration fee, xUDT
staking with CKB rewards, liquidity mining that mints a reward token (VTX), and a protocol-fee sink.

[ARCHITECTURE.md](ARCHITECTURE.md) describes the contracts, the cell layouts and the OTX flow.

## Layout

```
contracts/      CKB scripts (Rust, RISC-V)
shared/         amm-math, cell-utils, molecule-types
packages/       sdk, aggregator, router, chain-client, codec, config, token-registry, types
apps/frontend/  React + Vite app
schemas/        Molecule schemas
scripts/        deploy, e2e and testnet check scripts
tests/          integration (ckb-testtool) and logic (node) suites
```

## Build

Requirements: Node 20 or later, pnpm 9 or later, Rust stable with the
`riscv64imac-unknown-none-elf` target, and a RISC-V C cross compiler (`riscv64-unknown-elf-gcc`).

Contracts:

```bash
rustup target add riscv64imac-unknown-none-elf
make build          # builds every crate in contracts.list into build/release/
make test           # make build, then the ckb-testtool integration suite
cargo test -p amm-math
```

Use `make build`, not a plain `cargo build`. `pool-script/build.rs` reads the data hash of the
staged `factory-script` binary, so `factory-script` has to be built and staged first.

CKB-VM has no atomic instructions. `.cargo/config.toml` disables the `a` extension and `molecule` is
built with the `bytes_vec` feature so the `bytes` crate is never linked. If that breaks, the build
still succeeds and scripts fail at run time with `InvalidInstruction`.

Without a local toolchain, `docker-build.sh` installs the cross compiler and runs the same build
and tests in a `rust:latest` container:

```bash
docker run --rm -v "$PWD":/work -w /work rust:latest bash docker-build.sh
```

TypeScript:

```bash
pnpm install
pnpm -r build
pnpm -r typecheck
pnpm test           # workspace tests and the tests/logic suites
```

The aggregator depends on `better-sqlite3`, which compiles a native module on install. Without a
C++ toolchain, `pnpm install --ignore-scripts` is enough to build, typecheck and run the logic
tests.

## Run on a devnet

```bash
offckb node                         # local devnet
# deploy the contracts with `offckb deploy --type-id`, then:
node scripts/patch-devnet.mjs       # write the deployed scripts into packages/config

NETWORK=devnet DEPLOYER_PRIVATE_KEY=0x... CCC_SCRIPTS_JSON=./devnet-ccc-scripts.json \
  node scripts/e2e/run.mjs

SOLVER_PRIVATE_KEY=0x... NETWORK=devnet node packages/aggregator/dist/main.js
VITE_NETWORK=devnet pnpm --filter @cellswap/frontend dev
```

See [scripts/e2e/README.md](scripts/e2e/README.md) for the e2e options.

## License

[MIT](LICENSE)
