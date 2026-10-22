#![no_std]
#![no_main]

//! TokenRegistry: a type script for paid, owner-signed token registration.
//!
//! A project registers its xUDT (→ a "verified" badge + curated listing in the UI) by creating
//! a registration cell. The cell is per-token (its type-script args carry the token's type hash,
//! so each token has a distinct registry type and a clean create/update transition).
//!
//! Args (72 bytes):
//!   [0..32]   treasury_lock_hash   where the registration fee must be paid
//!   [32..40]  fee_shannons (u64 LE) minimum CKB that must reach the treasury on creation
//!   [40..72]  token_type_hash      the xUDT this registration is for (binds the cell to one token)
//!
//! Data (>= 32 bytes):
//!   [0..32]   owner_lock_hash      the registrant; must equal the xUDT's args (its owner lock
//!                                   hash), which the frontend verifies; the contract proves the
//!                                   registrant controls this lock (co-sign), i.e. is the issuer.
//!   [32..]    metadata (decimals/symbol/name/links), informational, not validated on-chain.
//!
//! Trust boundary: on-chain this contract proves that the controller of
//! `owner_lock_hash` paid the fee. At creation it also reconstructs the standard
//! xUDT type hash from `owner_lock_hash` (with the pinned xUDT code hash) and
//! requires it to equal `token_type_hash`. For a standard xUDT the token's args are the owner
//! lock hash, so controlling `owner_lock_hash` == being the issuer. Consumers should still
//! surface "verified" only when `data.owner_lock_hash` equals the token's xUDT args (the SDK
//! and frontend do this). We additionally reject a zero `token_type_hash` below as a cheap
//! sanity gate.
//!
//! Rules:
//!   Create (no input of this type): an input unlocked by `owner_lock_hash` must be present
//!     (proves issuer control), and the args must name the pinned `PLATFORM_TREASURY` with a
//!     `fee_shannons >= MIN_REGISTRATION_FEE`, and that fee must actually reach the platform
//!     treasury. The treasury + floor are pinned in this contract (not trusted from the
//!     registrant-chosen args), so a registration cannot be created without paying the platform.
//!   Update/remove (input of this type present): the same owner must co-sign; no new fee.
//!     owner_lock_hash is immutable across an update.

use ckb_std::{
    ckb_constants::Source,
    ckb_types::{
        packed::{Byte32, Script},
        prelude::*,
    },
    default_alloc, entry,
    error::SysError,
    high_level::{
        load_cell_capacity, load_cell_data, load_cell_lock_hash, load_cell_type, load_script,
    },
};

entry!(program_entry);
default_alloc!();

#[repr(i8)]
enum Error {
    Sys = 1,
    InvalidArgs = 2,
    InvalidData = 3,
    Unauthorized = 4,
    FeeNotPaid = 5,
    OwnerChanged = 6,
    BatchedRegistration = 7,
    WrongTreasury = 8,
    FeeTooLow = 9,
    TokenMismatch = 10,
}

const ARGS_LEN: usize = 72;
const TREASURY_OFF: usize = 0;
const FEE_OFF: usize = 32;
const TOKEN_HASH_OFF: usize = 40;
const ZERO32: [u8; 32] = [0u8; 32];

/// Platform treasury lock hash: every registration fee at creation must be paid here. Pinned on-chain
/// (not read from the registrant-chosen args) so a registrant can neither redirect the fee to
/// themselves nor set it to zero. The testnet value is the governance/deployer lock
/// (0x7a71afd7508ee603c6c219c66f32408c96b5a2e66af674772ca2da27486a680d).
/// For mainnet, rebuild this contract with the mainnet treasury/multisig lock hash before deploying.
const PLATFORM_TREASURY: [u8; 32] = [
    0x7a, 0x71, 0xaf, 0xd7, 0x50, 0x8e, 0xe6, 0x03, 0xc6, 0xc2, 0x19, 0xc6, 0x6f, 0x32, 0x40, 0x8c,
    0x96, 0xb5, 0xa2, 0xe6, 0x6a, 0xf6, 0x74, 0x77, 0x2c, 0xa2, 0xda, 0x27, 0x48, 0x6a, 0x68, 0x0d,
];
/// Minimum registration fee in shannons (5,000 CKB). Pinned so a fee-0 registration is rejected.
const MIN_REGISTRATION_FEE: u64 = 500_000_000_000;

/// Standard xUDT type-script code hash + hash-type, pinned so the registry can reconstruct a token's
/// type hash from its owner lock hash (xUDT args = owner lock hash) and bind owner → token on-chain.
/// Testnet xUDT (0x25c29dc3…, hash_type 'type' = 1).
/// For mainnet, rebuild with the mainnet xUDT code hash (0x50bd8d66…).
const XUDT_CODE_HASH: [u8; 32] = [
    0x25, 0xc2, 0x9d, 0xc3, 0x17, 0x81, 0x1a, 0x6f, 0x6f, 0x39, 0x85, 0xa7, 0xa9, 0xeb, 0xc4, 0x83,
    0x8b, 0xd3, 0x88, 0xd1, 0x9d, 0x0f, 0xee, 0xec, 0xf0, 0xbc, 0xd6, 0x0f, 0x6c, 0x09, 0x75, 0xbb,
];
const XUDT_HASH_TYPE: u8 = 1; // ScriptHashType::Type

// Compile-time guards against an accidental all-zero blanking of the pinned network constants. A zero
// PLATFORM_TREASURY would misroute the registration fee; a zero XUDT_CODE_HASH would break the
// owner->token binding. These do not catch a testnet-vs-mainnet mismatch: both values are
// testnet-specific and must be reset at the mainnet rebuild (see the mainnet notes above).
const _: () = assert!(
    !const_is_zero32(&PLATFORM_TREASURY),
    "PLATFORM_TREASURY must not be all-zero"
);
const _: () = assert!(
    !const_is_zero32(&XUDT_CODE_HASH),
    "XUDT_CODE_HASH must not be all-zero"
);

/// const-fn all-zero check for the compile-time guards above.
const fn const_is_zero32(h: &[u8; 32]) -> bool {
    let mut i = 0;
    while i < 32 {
        if h[i] != 0 {
            return false;
        }
        i += 1;
    }
    true
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
    if args.len() < ARGS_LEN {
        return Err(Error::InvalidArgs);
    }
    let mut treasury = [0u8; 32];
    treasury.copy_from_slice(&args[TREASURY_OFF..TREASURY_OFF + 32]);
    let mut fee_le = [0u8; 8];
    fee_le.copy_from_slice(&args[FEE_OFF..FEE_OFF + 8]);
    let fee = u64::from_le_bytes(fee_le);
    // The registration must name a concrete token (sanity gate).
    if args[TOKEN_HASH_OFF..TOKEN_HASH_OFF + 32] == ZERO32 {
        return Err(Error::InvalidArgs);
    }

    // A removal (output of this type absent) is allowed if the owner co-signs; fall through to
    // the owner check using the input cell's owner_lock_hash.
    let in_data = load_cell_data(0, Source::GroupInput);
    let out_data = load_cell_data(0, Source::GroupOutput);

    match (&in_data, &out_data) {
        // Create: no prior registration cell → require fee + owner co-sign.
        (Err(SysError::IndexOutOfBound), Ok(out)) => {
            let owner = owner_from(out)?;
            if !owner_authorizes(&owner)? {
                return Err(Error::Unauthorized);
            }
            // Bind owner_lock_hash → token_type_hash on-chain. The
            // args token_type_hash must equal hash(xUDT{pinned_code, args: owner_lock_hash}), i.e. the
            // registrant's owner lock must actually derive the token they claim. This rejects shadow
            // registrations (claiming a victim's token under the attacker's own owner) at creation,
            // on-chain rather than only dropping shadows in the reader.
            let mut claimed = [0u8; 32];
            claimed.copy_from_slice(&args[TOKEN_HASH_OFF..TOKEN_HASH_OFF + 32]);
            if token_type_hash_for(&owner) != claimed {
                return Err(Error::TokenMismatch);
            }
            // Cross-group fee double-count: each token's
            // registry is a distinct type script (token_type_hash in args), so N registrations are N
            // groups, each running verify() and each crediting the same whole-tx treasury output,
            // letting N tokens register for one fee. fee_to_treasury scans the whole tx, not the group.
            // So batching is forbidden: a create tx may hold exactly one token-registry-typed output, so
            // the fee cannot be shared. (The normal flow registers one token per tx.)
            if count_registry_outputs()? != 1 {
                return Err(Error::BatchedRegistration);
            }
            // The args `treasury`/`fee` are
            // registrant-chosen, so `fee_to_treasury(args.treasury) >= args.fee` alone is bypassable
            // (set treasury = self, fee = 0 → pay yourself nothing). Pin both: the cell must name the
            // platform treasury and declare a fee >= the floor, and that fee must actually reach the
            // platform treasury. So a registration cannot be created without paying the platform.
            if treasury != PLATFORM_TREASURY {
                return Err(Error::WrongTreasury);
            }
            if fee < MIN_REGISTRATION_FEE {
                return Err(Error::FeeTooLow);
            }
            if fee_to_treasury(&PLATFORM_TREASURY) < fee {
                return Err(Error::FeeNotPaid);
            }
            Ok(())
        }
        // Update: owner immutable + owner co-sign; no new fee.
        (Ok(inp), Ok(out)) => {
            // Like create, allow exactly one registry-typed output. Otherwise verify() (which
            // only checks GroupOutput[0]) would leave a second same-type output's data unvalidated:
            // a smuggled duplicate registration with a forged owner for the same token.
            if count_registry_outputs()? != 1 {
                return Err(Error::BatchedRegistration);
            }
            let owner_in = owner_from(inp)?;
            let owner_out = owner_from(out)?;
            if owner_in != owner_out {
                return Err(Error::OwnerChanged);
            }
            if !owner_authorizes(&owner_in)? {
                return Err(Error::Unauthorized);
            }
            Ok(())
        }
        // Remove: registration cell consumed, none recreated → owner co-sign.
        (Ok(inp), Err(SysError::IndexOutOfBound)) => {
            let owner = owner_from(inp)?;
            if !owner_authorizes(&owner)? {
                return Err(Error::Unauthorized);
            }
            Ok(())
        }
        _ => Err(Error::Sys),
    }
}

fn owner_from(data: &[u8]) -> Result<[u8; 32], Error> {
    if data.len() < 32 {
        return Err(Error::InvalidData);
    }
    let mut o = [0u8; 32];
    o.copy_from_slice(&data[0..32]);
    Ok(o)
}

/// True if any input is unlocked by `owner`, which proves the registrant controls that lock.
fn owner_authorizes(owner: &[u8; 32]) -> Result<bool, Error> {
    let mut i = 0usize;
    loop {
        if i > 1000 {
            break;
        }
        match load_cell_lock_hash(i, Source::Input) {
            Ok(h) if &h == owner => return Ok(true),
            Ok(_) => i += 1,
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => break,
        }
    }
    Ok(false)
}

/// Count output cells whose type script is this same token-registry code (any token). Used to forbid
/// batching multiple registrations into one tx (which would share a single fee).
fn count_registry_outputs() -> Result<usize, Error> {
    let self_script = load_script().map_err(|_| Error::Sys)?;
    let self_code = self_script.code_hash();
    let self_code = self_code.as_slice();
    let mut n = 0usize;
    let mut i = 0usize;
    loop {
        match load_cell_type(i, Source::Output) {
            Ok(Some(ty)) if ty.code_hash().as_slice() == self_code => {
                n += 1;
                i += 1;
            }
            Ok(_) => i += 1,
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(Error::Sys),
        }
    }
    Ok(n)
}

/// Reconstruct the standard xUDT type script for a token whose owner lock hash is `owner` (xUDT args =
/// owner lock hash) and return its script hash = the token's type hash, with the ckb-default-hash
/// personalization. Pins the xUDT code + hash-type so the registry binds owner → token on-chain.
fn token_type_hash_for(owner: &[u8; 32]) -> [u8; 32] {
    let code = Byte32::from_slice(&XUDT_CODE_HASH).unwrap();
    let script = Script::new_builder()
        .code_hash(code)
        .hash_type(XUDT_HASH_TYPE.into())
        .args(owner[..].pack())
        .build();
    let mut out = [0u8; 32];
    let mut b = blake2b_ref::Blake2bBuilder::new(32)
        .personal(b"ckb-default-hash")
        .build();
    b.update(script.as_slice());
    b.finalize(&mut out);
    out
}

/// Total CKB capacity sent to the treasury lock across all outputs.
fn fee_to_treasury(treasury: &[u8; 32]) -> u64 {
    let mut total: u64 = 0;
    let mut i = 0usize;
    loop {
        match load_cell_lock_hash(i, Source::Output) {
            Ok(h) => {
                if &h == treasury {
                    if let Ok(cap) = load_cell_capacity(i, Source::Output) {
                        total = total.saturating_add(cap);
                    }
                }
                i += 1;
            }
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => break,
        }
    }
    total
}
