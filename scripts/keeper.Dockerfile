# Vortx/CellSwap buy-back-and-burn keeper: runs the VTX keeper loop.
# A separate image from the frontend (root Dockerfile) and the aggregator
# (packages/aggregator/Dockerfile). It is a background job with no HTTP surface, so it needs no docker
# network wiring to the frontend or aggregator, only outbound access to the public CKB RPC.
#
# Build from the pnpm monorepo root (the build context must be the repo root):
#   docker build -f scripts/keeper.Dockerfile -t cellswap-keeper .
# The install is scoped to @cellswap/sdk and @cellswap/config (no native modules, unlike the aggregator).
#
# Keys (.testnet-deployer.key, .testnet-acct2.key) are not baked into the image: mount them into /repo
# at runtime. Team-split env vars (VTX_TEAM_CKB_BPS/VTX_TEAM_VEST_BPS, both default 0, which burns
# everything) and VTX_KEEPER_INTERVAL_EPOCHS are read from the container environment.

FROM node:22-alpine AS builder
RUN npm install -g pnpm@10
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter "@cellswap/sdk..." --filter "@cellswap/config..."
RUN pnpm --filter "@cellswap/sdk..." --filter "@cellswap/config..." build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
COPY --from=builder /repo /repo
WORKDIR /repo
CMD ["node", "scripts/buyback-keeper-loop.mjs"]
