//! Build-time derivation of FACTORY_CODE_HASH.
//!
//! pool-script identifies the canonical factory singleton by the CKB *data hash* of the
//! factory-script binary it is deployed alongside (the factory is deployed by data-hash, so a
//! cell's type code_hash under Data1 == that binary's data hash). A hardcoded hash would
//! silently go stale whenever factory-script is recompiled with a different toolchain/lockfile,
//! which breaks the pool-creation integration tests (FactoryMissing) on any machine that does not
//! byte-reproduce the original deploy build. Deriving it from the freshly built binary keeps
//! test == build == deploy by construction, on any toolchain.
//!
//! Prerequisite: factory-script must be built and staged to build/release/ before pool-script.
//! The contract build order (CI) and `make build` enforce this.

use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let bin = manifest.join("../../build/release/factory-script");
    println!("cargo:rerun-if-changed={}", bin.display());

    let bytes = std::fs::read(&bin).unwrap_or_else(|e| {
        panic!(
            "pool-script build.rs: cannot read {} ({e}).\n\
             factory-script must be built and staged to build/release/ BEFORE pool-script, because \
             pool-script bakes its CKB data hash (the canonical-factory identifier). Run `make build` \
             (which builds factory-script first), or `cargo build -p factory-script` + stage it, then \
             rebuild pool-script.",
            bin.display()
        )
    });

    // CKB data hash = blake2b-256 personalized with "ckb-default-hash".
    let mut hasher = blake2b_ref::Blake2bBuilder::new(32)
        .personal(b"ckb-default-hash")
        .build();
    hasher.update(&bytes);
    let mut hash = [0u8; 32];
    hasher.finalize(&mut hash);

    let body = hash
        .iter()
        .map(|b| format!("0x{b:02x}"))
        .collect::<Vec<_>>()
        .join(", ");
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("factory_code_hash_array.rs");
    std::fs::write(&out, format!("[{body}]")).unwrap();
}
