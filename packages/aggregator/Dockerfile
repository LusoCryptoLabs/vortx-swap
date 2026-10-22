# Vortx/CellSwap aggregator: the OTX/intent solver and orders API (Node service).
# Separate deployable from the frontend SPA (which has its own root Dockerfile). docker-compose
# references this path; a PaaS can also build it directly.
#
# Built from the pnpm monorepo root (build context must be the repo root, e.g.
#   docker build -f packages/aggregator/Dockerfile -t cellswap-aggregator .
# ), scoped to @cellswap/aggregator + its workspace deps. better-sqlite3 is a native module, so the
# builder carries a C/C++ toolchain; the runtime copies the whole /repo (pnpm's symlinked node_modules
# + the built .node live under it) and only needs libc6-compat to run the native binding: no pnpm,
# no toolchain. (Avoids `pnpm deploy`, whose flags differ across pnpm versions.)

# ── Builder: install workspace deps + compile native better-sqlite3, tsc-build ──
FROM node:22-alpine AS builder
RUN apk add --no-cache python3 make g++ libc6-compat   # node-gyp toolchain for better-sqlite3
RUN npm install -g pnpm@10
WORKDIR /repo
COPY . .
# Build the aggregator and its workspace deps (types/chain-client/router/sdk/config) in dep order.
RUN pnpm install --frozen-lockfile --filter "@cellswap/aggregator..."
RUN pnpm --filter "@cellswap/aggregator..." build

# ── Runtime: slim, no toolchain, no pnpm ──
FROM node:22-alpine AS runtime
RUN apk add --no-cache libc6-compat
ENV NODE_ENV=production
# Default OTX/orders API port (override with PORT). Matches the dev default (AGGREGATOR_URL :3002).
ENV PORT=3002
COPY --from=builder /repo /repo
WORKDIR /repo/packages/aggregator
# StateDB (intent-lifecycle tracking, optional, see main.ts) opens ./data/cellswap.db relative to
# this workdir; without the directory it fails open and the aggregator runs with lifecycle tracking
# disabled. Create it here, and mount a volume at runtime so history survives a container restart.
RUN mkdir -p data
EXPOSE 3002
CMD ["node", "dist/main.js"]
