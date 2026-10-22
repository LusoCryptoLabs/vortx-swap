#![no_std]
#![no_main]

//! EmissionLock: the mint authority for the VTX reward token (liquidity-mining emissions).
//!
//! VTX is a standard xUDT whose owner (args = owner lock hash) is this script's hash. xUDT
//! owner-mode minting is permitted when an input cell is unlocked by the owner lock, so VTX can
//! only be minted in a transaction that spends a small "emission authority" cell locked by
//! emission-lock. This script's single rule makes that mint safe by delegation:
//!
//!   The emission-authority cell may only be spent in a transaction that also spends a mining
//!   stake-pool whose type code hash == this lock's first arg and whose embedded
//!   `authority_lock_hash` == this lock's second arg (the governance authority). The mining
//!   stake-pool's type script (which runs because it is spent) enforces that the total VTX minted
//!   in the tx equals the reward `pending` it just accrued to a real staker, so emission-lock does
//!   not need to re-derive the amount. It only guarantees that minting never happens without a
//!   governance-approved mining pool present to bound it.
//!
//! Unbounded mint: matching the mining pool by code hash alone is
//! insufficient, because a mining pool reads its `authority_lock_hash` from its own args. An attacker
//! could self-genesis a fake pool carrying the genuine code hash but an attacker-chosen authority and
//! an arbitrarily high `emission_per_epoch`, then mint unbounded VTX. We close this by also pinning
//! the governance authority here (in emission-lock's args) and requiring the spent pool to carry it.
//! Mining-pool genesis requires that same authority to co-sign, so a forged pool either carries a
//! different authority (rejected below) or carries the real one, which an attacker cannot obtain a
//! genesis co-sign for. Permissionless staker claims are unaffected (no signature needed at claim;
//! only the pool's embedded authority is checked, which all genuine pools share).
//!
//! Accepted governance-trust assumption: this lock does not verify that
//! the authorized pool's `vtx_type_hash` (pool args[32..64]) is the real VTX. A pool only bounds
//! the mint of the token it names, so a governance-deployed pool that names a decoy token would leave
//! real VTX's mint unbounded in that same tx. This is not permissionlessly exploitable: creating a
//! qualifying pool requires the governance authority's genesis co-sign (above), so it reduces to
//! "trust governance not to deploy a malicious pool." A fully on-chain binding is blocked by a
//! circularity (VTX's type hash derives from this lock's own script hash, so it cannot be embedded
//! in these args). The accepted mitigation is governance discipline: only ever genesis mining pools
//! whose `vtx_type_hash` is the canonical VTX. Documented here and in SECURITY.md so it is
//! not mistaken for an enforced invariant.
//!
//! Args (64 bytes):
//!   [0..32]  mining_pool_code_hash      the type code hash of the mining stake-pool
//!   [32..64] governance_authority_hash  the lock hash that must equal the pool's authority_lock_hash

use ckb_std::{
    ckb_constants::Source,
    ckb_types::prelude::Entity,
    default_alloc, entry,
    error::SysError,
    high_level::{load_cell_type, load_script},
};

entry!(program_entry);
default_alloc!();

/// Byte offset of `authority_lock_hash` inside the mining-pool type args (see the mining-pool args doc).
const POOL_AUTHORITY_OFF: usize = 64;

#[repr(i8)]
enum Error {
    Sys = 1,
    InvalidArgs = 2,
    NoMiningPool = 3,
}

fn program_entry() -> i8 {
    match verify() {
        Ok(_) => 0,
        Err(e) => e as i8,
    }
}

fn verify() -> Result<(), Error> {
    let script = load_script().map_err(|_| Error::Sys)?;
    let raw = script.args();
    let args = raw.raw_data();
    if args.len() < 64 {
        return Err(Error::InvalidArgs);
    }
    let mut mining_pool_code_hash = [0u8; 32];
    mining_pool_code_hash.copy_from_slice(&args[0..32]);
    let mut governance_authority = [0u8; 32];
    governance_authority.copy_from_slice(&args[32..64]);

    if authorized_mining_pool_in_inputs(&mining_pool_code_hash, &governance_authority) {
        Ok(())
    } else {
        Err(Error::NoMiningPool)
    }
}

/// True if any input is a mining pool whose type code hash == `code_hash` and whose embedded
/// `authority_lock_hash` (type args [64..96]) == the governance `authority`. Such a pool's type
/// script runs (it is spent) and bounds the mint to the accrued reward.
fn authorized_mining_pool_in_inputs(code_hash: &[u8; 32], authority: &[u8; 32]) -> bool {
    let mut i = 0usize;
    loop {
        match load_cell_type(i, Source::Input) {
            Ok(Some(ty)) if ty.code_hash().as_slice() == &code_hash[..] => {
                let ty_args = ty.args();
                let aa = ty_args.raw_data();
                if aa.len() >= POOL_AUTHORITY_OFF + 32
                    && &aa[POOL_AUTHORITY_OFF..POOL_AUTHORITY_OFF + 32] == &authority[..]
                {
                    return true;
                }
                i += 1;
            }
            Ok(_) => i += 1,
            Err(SysError::IndexOutOfBound) => return false,
            Err(_) => return false,
        }
    }
}
