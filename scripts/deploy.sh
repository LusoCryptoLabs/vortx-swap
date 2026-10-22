#!/usr/bin/env bash
# Deploy all CellSwap contracts to a CKB network and update @cellswap/config.
# Usage: bash scripts/deploy.sh [devnet|testnet|mainnet]
#
# Requires: offckb (https://github.com/ckb-devrel/offckb), cargo, jq
# Prereq: a funded deployer account configured in offckb

set -euo pipefail

NETWORK="${1:-devnet}"
BUILD_DIR="build/release"
DEPLOY_OUT="deployed/$NETWORK"
CONFIG_FILE="packages/config/src/index.ts"

echo "═══════════════════════════════════════════"
echo " CellSwap deployment → $NETWORK"
echo "═══════════════════════════════════════════"

# ── 1. Build all contracts ──────────────────────────────────────────────────
echo ""
echo "[1/4] Building contracts (release, RISC-V)..."
cargo build --target riscv64imac-unknown-none-elf --release
mkdir -p "$DEPLOY_OUT"

# Contracts in dependency order. cellswap-otx-lock is the primary lock for JoyID.
CONTRACTS=(
  pool-lock
  pool-script
  cellswap-otx-lock
  intent-lock
  entity-script
  factory-script
  lp-token
)

# ── 2. Deploy each with Type ID (upgradeable) ───────────────────────────────
echo ""
echo "[2/4] Deploying contracts with Type ID..."
declare -A CODE_HASH
declare -A TX_HASH

for contract in "${CONTRACTS[@]}"; do
  echo "  → $contract"
  RESULT=$(offckb deploy \
    --type-id \
    --network "$NETWORK" \
    --target "$BUILD_DIR/$contract" \
    --output "$DEPLOY_OUT" \
    --json)
  CODE_HASH[$contract]=$(echo "$RESULT" | jq -r '.typeIdHash // .codeHash')
  TX_HASH[$contract]=$(echo "$RESULT"   | jq -r '.txHash')
  echo "    codeHash: ${CODE_HASH[$contract]}"
  echo "    txHash:   ${TX_HASH[$contract]}"
done

# ── 3. Generate config snippet ──────────────────────────────────────────────
echo ""
echo "[3/4] Writing deployment manifest..."
MANIFEST="$DEPLOY_OUT/manifest.json"
cat > "$MANIFEST" <<JSON
{
  "network": "$NETWORK",
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "scripts": {
    "poolScript":    { "codeHash": "${CODE_HASH[pool-script]}",       "hashType": "type", "txHash": "${TX_HASH[pool-script]}",       "index": 0 },
    "poolLock":      { "codeHash": "${CODE_HASH[pool-lock]}",         "hashType": "type", "txHash": "${TX_HASH[pool-lock]}",         "index": 0 },
    "cellswapOtxLock": { "codeHash": "${CODE_HASH[cellswap-otx-lock]}", "hashType": "type", "txHash": "${TX_HASH[cellswap-otx-lock]}", "index": 0 },
    "intentLock":    { "codeHash": "${CODE_HASH[intent-lock]}",       "hashType": "type", "txHash": "${TX_HASH[intent-lock]}",       "index": 0 },
    "entityScript":  { "codeHash": "${CODE_HASH[entity-script]}",     "hashType": "type", "txHash": "${TX_HASH[entity-script]}",     "index": 0 },
    "factoryScript": { "codeHash": "${CODE_HASH[factory-script]}",    "hashType": "type", "txHash": "${TX_HASH[factory-script]}",    "index": 0 },
    "lpTokenScript": { "codeHash": "${CODE_HASH[lp-token]}",          "hashType": "type", "txHash": "${TX_HASH[lp-token]}",          "index": 0 }
  }
}
JSON
echo "  Wrote $MANIFEST"

# ── 4. Patch config ─────────────────────────────────────────────────────────
echo ""
echo "[4/4] Updating $CONFIG_FILE..."
node scripts/inject-config.mjs "$NETWORK" "$MANIFEST" "$CONFIG_FILE"

echo ""
echo "═══════════════════════════════════════════"
echo " Deployment complete."
echo "═══════════════════════════════════════════"
echo ""
echo " Verify:  cat $MANIFEST"
echo " Build:   pnpm -r build"
echo ""
echo " Before mainnet: transfer all Type ID ownership to a 3-of-5 multisig."
echo " Commit the updated $CONFIG_FILE before using this deployment."
