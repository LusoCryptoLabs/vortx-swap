#![no_std]
#![no_main]

//! pool-lock: guards a pool's xUDT reserve cells.
//!
//! A reserve cell (a real xUDT cell holding tokenX or tokenY for a pool) is locked
//! by this script. It delegates all economic validation to the pool's info cell:
//! the reserve may move only if the matching info cell is present in both the
//! transaction inputs and outputs (a swap/liquidity op consumes and recreates it).
//! If the info cell is present, its pool-script already validated the reserve change.
//!
//! Args (32 bytes): the info cell's own type-script hash (the pool instance id).
//!
//! Security:
//!   - Match on the info cell's full type-script hash, not a code hash. Otherwise a
//!     counterfeit info cell with the same code but different state could authorize a drain.
//!   - Require the info cell in both inputs and outputs, so reserves can't be moved
//!     while the pool is being created or destroyed out from under them.
//!   - All of a pool's reserve cells reference the same info type hash, so they move
//!     together under one pool-script execution.

use ckb_std::{
    ckb_constants::Source,
    default_alloc, entry,
    error::SysError,
    high_level::{load_cell_type_hash, load_script},
};

entry!(program_entry);
default_alloc!();

#[repr(i8)]
enum Error {
    Sys = 1,
    BadArgs = 2,
    InfoCellMissing = 3,
}

impl From<SysError> for Error {
    fn from(_: SysError) -> Self {
        Error::Sys
    }
}

fn program_entry() -> i8 {
    match verify() {
        Ok(_) => 0,
        Err(e) => e as i8,
    }
}

fn verify() -> Result<(), Error> {
    let script = load_script()?;
    let args = script.args();
    let args_raw = args.raw_data();
    if args_raw.len() != 32 {
        return Err(Error::BadArgs);
    }
    let mut info_type_hash = [0u8; 32];
    info_type_hash.copy_from_slice(&args_raw[0..32]);

    // The info cell (type hash == args) must be present in both inputs and outputs.
    if !has_cell_with_type_hash(Source::Input, &info_type_hash) {
        return Err(Error::InfoCellMissing);
    }
    if !has_cell_with_type_hash(Source::Output, &info_type_hash) {
        return Err(Error::InfoCellMissing);
    }
    Ok(())
}

fn has_cell_with_type_hash(source: Source, target: &[u8; 32]) -> bool {
    let mut i = 0usize;
    loop {
        match load_cell_type_hash(i, source) {
            Ok(Some(th)) if &th == target => return true,
            Ok(_) => {}
            Err(SysError::IndexOutOfBound) => return false,
            Err(_) => return false,
        }
        i += 1;
    }
}
