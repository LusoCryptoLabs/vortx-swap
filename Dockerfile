# syntax=docker/dockerfile:1.4
# Vortx Swap frontend: static SPA (Vite) served by nginx. Build with `docker build -t <tag> .` at the
# repo root; the container listens on port 80.
#
# Vite inlines VITE_* at build time, so env passed to the running container cannot change them. The
# build config comes from the ARG defaults below and is written to .env.production. To switch network
# or point at another aggregator, pass --build-arg (or change the defaults) and rebuild.
#
# The aggregator is a separate image (packages/aggregator/Dockerfile), run as a sibling container
# named `cellswap-aggregator` on a shared docker network and reached same-origin through this nginx's
# /agg/ proxy (see deploy/nginx/default.conf), so VITE_AGGREGATOR_URL is a relative path, not a
# hostname. Without an aggregator (VITE_AGGREGATOR_URL unset), direct swaps work; OTX and limit orders
# stay disabled.

# ── Build the SPA from the pnpm monorepo ──────────────────────────────────────
FROM node:22-alpine AS builder
RUN npm install -g pnpm@10
WORKDIR /repo

ARG VITE_NETWORK=testnet
ARG VITE_AGGREGATOR_URL=/agg

COPY . .
# Install only the frontend and its workspace deps. This skips the aggregator's native
# better-sqlite3 (node-gyp), which the SPA does not need and which does not compile on alpine.
RUN pnpm install --frozen-lockfile --filter "@cellswap/frontend..."
# Vite loads .env.production in production mode, so the build config is written there.
RUN printf 'VITE_NETWORK=%s\nVITE_AGGREGATOR_URL=%s\n' \
      "$VITE_NETWORK" "$VITE_AGGREGATOR_URL" > apps/frontend/.env.production
# Build the frontend and its workspace deps (@cellswap/sdk, config, types) in dependency order.
RUN pnpm --filter "@cellswap/frontend..." build

# ── Serve the static build with nginx (SPA fallback for react-router deep links), plus a same-origin
#    caching reverse proxy for CKB read traffic (/rpc, /indexer), so many polling browsers share one
#    upstream call to the public node. Config lives in deploy/nginx/*.conf and is copied in rather
#    than written by a heredoc, so the build works without BuildKit. ──
FROM nginx:alpine
COPY --from=builder /repo/apps/frontend/dist /usr/share/nginx/html
RUN mkdir -p /var/cache/nginx/ckb
COPY deploy/nginx/ckb-proxy.conf /etc/nginx/ckb-proxy.conf
COPY deploy/nginx/default.conf  /etc/nginx/conf.d/default.conf
EXPOSE 80
