# CellSwap Logic Tests

Pure logic and crypto suites. They need no Rust toolchain and no chain, but several import the
built packages, so run `pnpm -r build` first.
Run all of them with `node scripts/run-logic-tests.mjs` (also part of `pnpm test`), or one with
`node tests/logic/test_<name>.mjs`.

| Suite | Covers |
|---|---|
| test_amm | AMM math, invariant, inflation-attack guard, fees |
| test_offsets | Rust↔TS byte-offset consistency across all layouts |
| test_liquidity | add/remove liquidity math vs pool-script bounds |
| test_webauthn | P-256 WebAuthn sign/verify, tamper/forgery/replay |
| test_joyid_real | against JoyID's verifyNativeKeySignature logic |
| test_newfeatures | lp-token mint/burn, createPool, entity OTX ranges, deploy |
| test_aggregator_guards | aggregator settlement guards / safety checks |
| test_multisig_authority | multisig governance authority wiring |
| test_router_multihop | BFS swap-path routing / multi-hop settlement |
| test_otx_commitment | self-contained OTX commitment model + security |
| test_verify_otx | aggregator OTX payload verification + rejections |
| test_quantum_resistance | real-SDK buildOtxLockArgs parity: pubkey-at-rest hashing + scheme-version byte |
| test_lockboost | lock-boost SDK↔contract parity: boostBps tiers, 56B receipt, 72B guard args, 225B mining args |
| test_tester_gate | tester-access signature scheme and session tokens |

Requires `@noble/hashes` (a dependency of `@cellswap/sdk`). The blake2b-using suites import it
bare first, then fall back to the SDK's installed copy at
`packages/sdk/node_modules/@noble/hashes/blake2b.js` so they resolve under pnpm's non-hoisted
`node_modules` layout (where `@noble/hashes` is not hoisted to the repo root). Uses Node's native
P-256 crypto otherwise.
