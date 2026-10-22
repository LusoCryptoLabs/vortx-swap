# Vortx Swap frontend

React and Vite single-page app for Vortx Swap, an AMM on Nervos CKB. It builds transactions with
`@cellswap/sdk` and connects wallets through `@ckb-ccc/connector-react` (JoyID passkeys and other
CCC wallets). Prices, TVL, APR and positions are computed in the browser from on-chain reads
(`src/lib/pricing.ts`, `src/lib/apr.ts`).

## Pages

- Swap: atomic swaps with multi-hop routing, limit orders, and Batch (OTX) mode when an aggregator
  is configured.
- Pools: create pools, add and remove liquidity.
- Positions: LP positions, open orders and recent activity.
- Staking: single-token staking for CKB rewards.
- Mining: stake LP tokens to mine VTX, with optional fixed-term locks on pools that support them.
- Explore and Wallet: token and pool overview, balances, send and receive.

## Environment

Vite inlines these at build time. Copy `.env.example` to `.env.local` to override.

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_NETWORK` | `testnet` | `testnet`, `mainnet` or `devnet`. |
| `VITE_AGGREGATOR_URL` | `http://localhost:3002` in dev, unset in production | Aggregator for OTX and the limit-order relay. In production it must be an `https://` URL or a same-origin path such as `/agg`. When unset, those features are off. |
| `VITE_EXPLORER_PROXY` | unset | Proxy for the CKB Explorer API in production, used as a fallback for token names and logos. In dev, Vite proxies it at `/__explorer`. |

A production build sends chain reads to `/rpc` and `/indexer` on its own origin, so the web server
must proxy those paths to a CKB node. `deploy/nginx` has an example.

## Run

```bash
pnpm install
pnpm --filter @cellswap/frontend dev         # http://localhost:5173
pnpm --filter @cellswap/frontend typecheck
pnpm --filter @cellswap/frontend build       # output in apps/frontend/dist
```
