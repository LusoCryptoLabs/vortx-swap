#![no_std]
#![no_main]

//! StakeTimelockGuard: the composed custody lock for lock-boosted
//! mining positions.
//!
//! It is the lock script of a boosted mining-stake custody cell (the xUDT cell holding the staked
//! LP principal). It requires both rules the lock-boost design needs, neither of which the existing
//! single-purpose locks can provide alone (a CKB cell has one lock slot):
//!
//!   1. Supervision (from `stake-guard`): the bound mining-pool singleton must be spent (present as
//!      an input type hash == args[0..32]). Because the mining-pool is a type script it then runs and
//!      performs the real accounting (weight == amount·boost(deadline−creation), receipt.unlock_epoch
//!      == this lock's deadline, conservation). This keeps the "lock-only hole" closed: a boosted
//!      custody cell can never be created or moved without the mining-pool validating it.
//!
//!   2. Commitment (from `timelock-lock`): the principal is consensus-frozen until the deadline:
//!      (a) the owner must co-sign (an input bearing `owner_lock_hash` == args[32..64]) so nobody
//!      else can move it, and (b) every input guarded by this lock must carry an absolute epoch-based
//!      `since` whose epoch number >= `deadline_epoch` (args[64..72]). CKB consensus refuses to mine
//!      a tx before `since` is satisfied, so the lock is real, not advisory: the owner cannot set
//!      `since = 0` and withdraw the principal early.
//!
//! Scope, harvest at unstake (no mid-lock harvest): this lock runs whenever the boosted custody
//! cell is spent, and the mining-pool requires the custody to be present on every position op
//! (stake / unstake / claim: `check_custody` rejects a reward op whose principal != 0 without a
//! matching custody input+output). So a locked position is frozen in full until the deadline: its
//! boosted reward accrues continuously into the pool accumulator (the position's `weight` stays in
//! `total_weight` the whole term) but is realized only at unstake, at/after the deadline. No mid-lock
//! harvest, no decay, no tier "roll": the boost is set once at creation and the position matures.
//! (Mid-lock harvest would require a claim path that reads the custody as a cell-dep instead of
//! spending it; intentionally not done here.)
//!
//! Args (72 bytes):
//!   [0..32]   mining_pool_type_hash   the bound mining-pool singleton (must be in inputs)
//!   [32..64]  owner_lock_hash         the owner (must co-sign to spend)
//!   [64..72]  deadline_epoch (u64 LE) epoch number the principal unlocks at; 0 = no time restriction

use ckb_std::{
    ckb_constants::Source,
    default_alloc, entry,
    error::SysError,
    high_level::{load_cell_lock_hash, load_cell_type_hash, load_input_since, load_script},
};

entry!(program_entry);
default_alloc!();

#[repr(i8)]
enum Error {
    Sys = 1,
    InvalidArgs = 2,
    PoolNotSpent = 3,
    Unauthorized = 4,
    StillLocked = 5,
    BadSince = 6,
}

const POOL_OFF: usize = 0;
const OWNER_OFF: usize = 32;
const DEADLINE_OFF: usize = 64;
const ARGS_LEN: usize = 72;

// CKB `since` bit layout (RFC 0017), identical to timelock-lock.
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
    let mut pool_type_hash = [0u8; 32];
    pool_type_hash.copy_from_slice(&raw[POOL_OFF..POOL_OFF + 32]);
    let mut owner = [0u8; 32];
    owner.copy_from_slice(&raw[OWNER_OFF..OWNER_OFF + 32]);
    let mut d = [0u8; 8];
    d.copy_from_slice(&raw[DEADLINE_OFF..DEADLINE_OFF + 8]);
    let deadline = u64::from_le_bytes(d);

    // (1) Supervision: the bound mining-pool singleton must be spent (forces the pool to run).
    if !pool_in_inputs(&pool_type_hash) {
        return Err(Error::PoolNotSpent);
    }
    // (2a) Custody: the owner must co-sign.
    if !owner_authorizes(&owner) {
        return Err(Error::Unauthorized);
    }
    // (2b) Commitment: principal not spendable before the deadline epoch.
    if deadline > 0 {
        enforce_deadline(deadline)?;
    }
    Ok(())
}

/// True if the bound mining-pool's type hash appears among the tx inputs (so it is being spent).
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

/// True if any input's lock hash equals the owner's, which proves the owner co-signed.
fn owner_authorizes(owner: &[u8; 32]) -> bool {
    let mut i = 0usize;
    loop {
        if i > 1000 {
            return false;
        }
        match load_cell_lock_hash(i, Source::Input) {
            Ok(h) if &h == owner => return true,
            Ok(_) => i += 1,
            Err(SysError::IndexOutOfBound) => return false,
            Err(_) => return false,
        }
    }
}

/// Every input guarded by this lock must carry an absolute epoch-based `since` whose epoch number
/// is >= the deadline. Rejecting any other form is what binds the deadline to consensus.
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
