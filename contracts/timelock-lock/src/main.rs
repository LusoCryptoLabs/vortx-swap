#![no_std]
#![no_main]

//! TimelockLock: an optional commitment lock for LP cells.
//!
//! An LP provider can lock their minted LP token cell until a chosen epoch, as a
//! public commitment not to pull liquidity early. The cell is spendable only when
//! both hold:
//!
//!   1. The owner authorizes: an input unlocked by `owner_lock_hash` is present in
//!      the tx (same delegation pattern as intent-lock cancellation: producing such
//!      an input requires the owner's own lock to sign, so it proves authorization).
//!      This keeps custody with the owner; nobody else can move the cell, ever.
//!
//!   2. The deadline has passed: the spending input's `since` is an absolute,
//!      epoch-based since whose epoch number is >= `deadline_epoch`. CKB consensus
//!      refuses to mine a tx before an input's `since` is satisfied, so binding the
//!      deadline to `since` here makes the lock real (not advisory): the owner
//!      cannot set `since = 0` and spend early, because this script rejects any `since`
//!      that doesn't encode an absolute epoch >= the deadline.
//!
//! Args (40 bytes):
//!   [0..32]  owner_lock_hash  (bytes32)
//!   [32..40] deadline_epoch   (u64 LE), epoch number; 0 = no time restriction
//!
//! Only the epoch number (low 24 bits of the since value) is compared, so the
//! lock opens at the start of `deadline_epoch` regardless of intra-epoch fraction.
//! Epoch granularity (~4h) is the intended resolution for a "lock for N days" feature.

use ckb_std::{
    ckb_constants::Source,
    default_alloc, entry,
    error::SysError,
    high_level::{load_cell_lock_hash, load_input_since, load_script},
};

entry!(program_entry);
default_alloc!();

#[repr(i8)]
enum Error {
    Sys = 1,
    InvalidArgs = 2,
    Unauthorized = 3,
    StillLocked = 4,
    BadSince = 5,
}

const OWNER_OFF: usize = 0;
const DEADLINE_OFF: usize = 32;
const ARGS_LEN: usize = 40;

// CKB `since` bit layout (RFC 0017).
const SINCE_RELATIVE: u64 = 0x8000_0000_0000_0000; // bit 63: 1 = relative, 0 = absolute
const SINCE_METRIC_MASK: u64 = 0x6000_0000_0000_0000; // bits 62-61: metric flag
const SINCE_EPOCH_FLAG: u64 = 0x2000_0000_0000_0000; // metric = 0b01 → epoch-based
const EPOCH_NUMBER_MASK: u64 = 0x0000_0000_00ff_ffff; // epoch number = low 24 bits of value

fn program_entry() -> i8 {
    match verify() {
        Ok(_) => 0,
        Err(e) => e as i8,
    }
}

fn verify() -> Result<(), Error> {
    let script = load_script().map_err(|_| Error::Sys)?;
    let raw = script.args().raw_data();
    if raw.len() < ARGS_LEN {
        return Err(Error::InvalidArgs);
    }
    let mut owner = [0u8; 32];
    owner.copy_from_slice(&raw[OWNER_OFF..OWNER_OFF + 32]);
    let mut d = [0u8; 8];
    d.copy_from_slice(&raw[DEADLINE_OFF..DEADLINE_OFF + 8]);
    let deadline = u64::from_le_bytes(d);

    // (1) Custody: the owner must co-sign (an input bearing their lock hash).
    if !owner_authorizes(&owner)? {
        return Err(Error::Unauthorized);
    }

    // (2) Commitment: not spendable before the deadline epoch.
    if deadline > 0 {
        enforce_deadline(deadline)?;
    }
    Ok(())
}

/// True if any input's lock hash equals the owner's, which proves the owner co-signed.
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

/// Every input guarded by this lock must carry an absolute epoch-based `since`
/// whose epoch number is >= the deadline. Rejecting any other form is what binds
/// the deadline to consensus (so the owner can't bypass it with `since = 0`).
fn enforce_deadline(deadline: u64) -> Result<(), Error> {
    let mut i = 0usize;
    loop {
        match load_input_since(i, Source::GroupInput) {
            Ok(since) => {
                if since & SINCE_RELATIVE != 0 {
                    return Err(Error::BadSince); // must be absolute
                }
                if since & SINCE_METRIC_MASK != SINCE_EPOCH_FLAG {
                    return Err(Error::BadSince); // must be epoch-based
                }
                if since & EPOCH_NUMBER_MASK < deadline {
                    return Err(Error::StillLocked);
                }
                i += 1;
            }
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(Error::Sys),
        }
    }
    Ok(())
}
