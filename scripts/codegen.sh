#!/usr/bin/env bash
# Run after any .mol schema change
# Generates Rust bindings and TypeScript types from Molecule schemas

set -e

SCHEMA_DIR="schemas"
RUST_OUT="shared/molecule-types/src"
TS_OUT="packages/types/src/molecule"

echo "Generating Molecule bindings..."

# Rust bindings
for mol_file in "$SCHEMA_DIR"/*.mol; do
  name=$(basename "$mol_file" .mol)
  echo "  → Rust: $name"
  moleculec --language rust --schema-file "$mol_file" > "$RUST_OUT/${name}.rs"
done

# TypeScript bindings (using moleculec-es or manual mapping)
# For now, TypeScript types are maintained manually in @cellswap/types
# TODO: add moleculec-es once stable

echo "Codegen complete."
echo "Run 'cargo check' to verify Rust bindings compile."
