#![no_std]
#![no_main]

//! StakeGuard: a small delegation guard used in two roles by the staking system:
//!
//!   * as the type script of a stake receipt cell (data = amount(16) || acc_at_touch(16)), and
//!   * as the lock script of a stake custody cell (an xUDT cell holding the staked principal).
//!
//! Its single rule is identical in both roles and is the whole point of the
//! "type-receipt + custody" design:
//!
//!   A guarded cell may only be created or spent in a transaction that also spends the
//!   StakePool singleton it is bound to (its type hash == this guard's args[0..32]).
//!
//! Because the StakePool is a type script, it runs on its own creation and consumption, and
//! it (not this guard) performs the real accounting: it checks that a newly-created receipt
//! pins `acc_at_touch == acc_now`, that the custody xUDT equals the receipt principal, and
//! that any reward released is exactly the accrued `pending`. This guard's only job is to make
//! that supervision unavoidable: a receipt or custody cell can never come into existence, nor
//! move, without the StakePool script validating the whole operation in the same transaction.
//!
//! That closes the lock-only hole: a lock runs only on spend, so a forged position could be
//! *created* unchecked. A type script (the StakePool) runs on output creation; forcing every
//! guarded cell through it means there is no unchecked creation path.
//!
//! Args (>= 64 bytes):
//!   [0..32]   stakepool_type_hash   the singleton this cell is bound to (must be in inputs)
//!   [32..64]  owner_lock_hash       informational binding (validated by the StakePool, not here)

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
    InvalidArgs = 2,
    PoolNotSpent = 3,
}

fn program_entry() -> i8 {
    match verify() {
        Ok(_) => 0,
        Err(e) => e as i8,
    }
}

fn verify() -> Result<(), Error> {
    let script = load_script().map_err(|_| Error::Sys)?;
    let args = script.args();
    let raw = args.raw_data();
    if raw.len() < 64 {
        return Err(Error::InvalidArgs);
    }
    let mut pool_type_hash = [0u8; 32];
    pool_type_hash.copy_from_slice(&raw[0..32]);

    // The bound StakePool singleton must be spent (present as an input type hash) in this tx.
    // Spending it forces the stake-pool type script to run and validate this cell's role.
    if pool_in_inputs(&pool_type_hash) {
        Ok(())
    } else {
        Err(Error::PoolNotSpent)
    }
}

fn pool_in_inputs(pool_type_hash: &[u8; 32]) -> bool {
    let mut i = 0usize;
    loop {
        match load_cell_type_hash(i, Source::Input) {
            Ok(Some(h)) if &h == pool_type_hash => return true,
            Ok(_) => i += 1,
            Err(SysError::IndexOutOfBound) => return false,
            Err(_) => return false,
        }
    }
}
