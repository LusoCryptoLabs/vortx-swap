#!/usr/bin/env bash
# Build CellSwap CKB contracts inside rust:latest, stage binaries, run test gate.
set -uo pipefail

TARGET="riscv64imac-unknown-none-elf"

echo "Installing RISC-V C cross-compiler + lld"
apt-get update -qq >/dev/null
if ! apt-get install -y -qq gcc-riscv64-unknown-elf lld >/dev/null 2>&1; then
  apt-get install -y -qq gcc-riscv64-linux-gnu binutils-riscv64-linux-gnu lld >/dev/null 2>&1
  ln -sf "$(command -v riscv64-linux-gnu-gcc)" /usr/bin/riscv64-unknown-elf-gcc
  ln -sf "$(command -v riscv64-linux-gnu-ar)"  /usr/bin/riscv64-unknown-elf-ar
fi
echo "  gcc: $(command -v riscv64-unknown-elf-gcc || echo MISSING)"

echo "Ensuring target $TARGET"
rustup target add "$TARGET"

# Contract set (single source shared with Makefile + ci.yml). First entry is factory-script,
# which must be built and staged before the rest (pool-script build.rs reads its data hash).
CONTRACTS=$(grep -vE '^[[:space:]]*(#|$)' contracts.list)
FACTORY=$(echo "$CONTRACTS" | head -1)
REST=$(echo "$CONTRACTS" | tail -n +2)

echo "Building contracts"
mkdir -p build/release
cargo build -p "$FACTORY" --target "$TARGET" --release --locked || { echo "BUILD FAILED"; exit 1; }
cp "target/$TARGET/release/$FACTORY" "build/release/$FACTORY"

PKGS=""
for c in $REST; do PKGS="$PKGS -p $c"; done
cargo build $PKGS --target "$TARGET" --release --locked || { echo "BUILD FAILED"; exit 1; }

echo "Staging binaries -> build/release/"
for c in $CONTRACTS; do
  cp "target/$TARGET/release/$c" "build/release/$c"
  printf '  %-20s %8d bytes\n' "$c" "$(wc -c < build/release/$c)"
done

echo "Running test gate (cargo test)"
# Scope to integration-tests: the contract bin crates are no_main RISC-V scripts and
# must not be compiled for the host (their entry!-defined _start collides with libc).
# --features otx-tests also runs the secp256r1 WebAuthn OTX-lock tests (host p256 signing).
cargo test -p integration-tests --release --features otx-tests 2>&1 | tail -50
