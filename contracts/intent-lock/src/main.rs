#![no_std]
#![no_main]

//! IntentLock: a lock script for an intent-based DEX.
//!
//! Why a lock, not a type:
//! A cell can only have one type script. If the intent cell holds xUDT
//! (type = xUDT script), the intent logic must go in the lock script.
//! This allows the cell to hold the actual tokens being sold.
//!
//! Cell structure:
//!   lock: IntentLock { args: <owner_lock_hash:32> || <intent_args:74> }
//!   type: xUDT script (token being sold)
//!   data: <amount: uint128> (the xUDT amount, the standard xUDT data field)
//!
//! Intent args layout (74 bytes after owner_lock_hash):
//!   [0..16]   min_amount_out        (u128 LE)   slippage protection
//!   [16..48]  token_out_type_hash   (bytes32)   expected output token
//!   [48..56]  deadline_epoch        (u64 LE)    0 = no deadline
//!   [56..72]  pool_type_hash_prefix (bytes16)   first 16 bytes of pool type hash
//!   [72..74]  solver_fee_bps        (u16 LE)    optional solver tip
//!
//! Modes:
//!   Settlement: aggregator builds settlement tx. Lock validates:
//!     - Output to owner_lock_hash contains >= min_amount_out of token_out
//!     - Deadline not exceeded
//!   Cancellation: owner includes their own signed cell in the same tx.
//!     Any input with owner_lock_hash present = cancellation allowed.

use cell_utils::{get_xudt_amount, parse_otx_intent, read_u128, read_u16, read_u64};
use ckb_std::{
    ckb_constants::Source,
    ckb_types::prelude::*,
    default_alloc, entry,
    error::SysError,
    high_level::{
        load_cell_capacity, load_cell_lock, load_cell_lock_hash, load_cell_type_hash,
        load_header_epoch_number, load_script, load_witness_args,
    },
};

entry!(program_entry);
default_alloc!();

#[repr(i8)]
enum Error {
    Sys = 1,
    InvalidArgs = 2,
    Expired = 3,
    InsufficientOut = 4,
    Unprotected = 6,
    RentNotRefunded = 7,
}

const BPS_DENOM: u128 = 10_000;

// Args layout
const OWNER_LOCK_HASH_OFF: usize = 0;
const MIN_AMOUNT_OUT_OFF: usize = 32;
const TOKEN_OUT_HASH_OFF: usize = 48;
const DEADLINE_EPOCH_OFF: usize = 80;
const SOLVER_FEE_OFF: usize = 104;
const TOTAL_ARGS_LEN: usize = 106;
// Optional extension against cross-contract double-satisfaction: the cellswap-otx-lock code
// hash. When present, settlement also counts OTX sibling demand on the shared owner payout, so an
// OTX cell and this intent cell can't be satisfied by one underpaying output (drain 2, pay once).
// 106-byte args omit it and are not settleable (see verify_settlement); the SDK writes 138-byte args.
const OTX_CODE_HASH_OFF: usize = 106;
const TOTAL_ARGS_LEN_EXT: usize = 138;

struct IntentArgs {
    owner_lock_hash: [u8; 32],
    min_amount_out: u128,
    token_out_type_hash: [u8; 32],
    deadline_epoch: u64,
    solver_fee_bps: u16,
    otx_code_hash: Option<[u8; 32]>,
}

impl IntentArgs {
    fn load() -> Result<Self, Error> {
        let script = load_script().map_err(|_| Error::Sys)?;
        let args = script.args();
        let raw = args.raw_data();
        if raw.len() < TOTAL_ARGS_LEN {
            return Err(Error::InvalidArgs);
        }

        let mut owner = [0u8; 32];
        let mut tout = [0u8; 32];
        owner.copy_from_slice(&raw[OWNER_LOCK_HASH_OFF..OWNER_LOCK_HASH_OFF + 32]);
        tout.copy_from_slice(&raw[TOKEN_OUT_HASH_OFF..TOKEN_OUT_HASH_OFF + 32]);

        let otx_code_hash = if raw.len() >= TOTAL_ARGS_LEN_EXT {
            let mut h = [0u8; 32];
            h.copy_from_slice(&raw[OTX_CODE_HASH_OFF..OTX_CODE_HASH_OFF + 32]);
            Some(h)
        } else {
            None
        };

        Ok(IntentArgs {
            owner_lock_hash: owner,
            min_amount_out: read_u128(&raw, MIN_AMOUNT_OUT_OFF).map_err(|_| Error::InvalidArgs)?,
            token_out_type_hash: tout,
            deadline_epoch: read_u64(&raw, DEADLINE_EPOCH_OFF).map_err(|_| Error::InvalidArgs)?,
            solver_fee_bps: read_u16(&raw, SOLVER_FEE_OFF).map_err(|_| Error::InvalidArgs)?,
            otx_code_hash,
        })
    }
}

fn program_entry() -> i8 {
    match verify() {
        Ok(_) => 0,
        Err(e) => e as i8,
    }
}

fn verify() -> Result<(), Error> {
    let args = IntentArgs::load()?;

    // Cancellation first: if any input cell's lock hash matches the owner, the owner is co-signing and
    // may always reclaim their own funds, including after the deadline. Checking this before the
    // deadline means a post-deadline cancel does not need the owner to hand-pick a
    // stale header.
    if is_owner_authorizing(&args.owner_lock_hash)? {
        return Ok(());
    }

    // Settlement deadline, best-effort only. A HeaderDep proves only that some block with this epoch
    // exists in the chain, not that it is the tip, so a solver can attach a stale header (epoch ≤
    // deadline) to settle after the true deadline. CKB `since` cannot enforce this either: it is a
    // lower-bound ("not before"), whereas a deadline is an upper bound ("not after"), which is not
    // cheaply provable on-chain. The real protections against an unwanted late fill are the owner's
    // `min_amount_out` (they never receive less) and prompt cancellation (above). Treat this as
    // advisory.
    if args.deadline_epoch > 0 {
        let epoch = load_header_epoch_number(0, Source::HeaderDep).map_err(|_| Error::Sys)?;
        if epoch > args.deadline_epoch {
            return Err(Error::Expired);
        }
    }

    // Settlement: verify output to owner has >= the sum of sibling min_amount_out of token_out.
    verify_settlement(&args)
}

/// Returns true if the owner's lock hash appears in any input (other than the group).
/// This means the owner is cosigning this transaction, which authorizes cancellation.
fn is_owner_authorizing(owner_lock_hash: &[u8; 32]) -> Result<bool, Error> {
    let mut i = 0usize;
    loop {
        if i > 1000 {
            break;
        }
        match load_cell_lock_hash(i, Source::Input) {
            Ok(hash) if &hash == owner_lock_hash => return Ok(true),
            Ok(_) => i += 1,
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => break,
        }
    }
    Ok(false)
}

/// Settlement: the owner must receive at least the sum of `min_amount_out` across all intent-lock
/// inputs that share this owner_lock_hash + token_out_type_hash.
///
/// Cross-cell double-satisfaction: comparing the summed owner
/// outputs against this intent's own min only is not enough. Every intent-lock input runs its own
/// instance of this check over the same outputs, so a solver could batch N sibling intents (same
/// owner, same token_out) and satisfy them all with one shared payout, draining N cells while
/// paying once. We instead sum the obligations of every sibling consumed in this tx. Because every
/// sibling computes the identical sum over the identical input set, the payout is forced to cover
/// each consumed intent; underpaying fails every sibling's lock.
fn verify_settlement(args: &IntentArgs) -> Result<(), Error> {
    let script = load_script().map_err(|_| Error::Sys)?;
    let code_hash = script.code_hash();
    let my_code = code_hash.as_slice();

    // An intent cell is settleable only if its args carry a real,
    // non-zero cellswap-otx-lock code hash, so the cross-contract OTX-demand sum below always runs.
    // A legacy 106-byte (otx_code_hash = None) or zeroed-hash cell would otherwise let a solver
    // co-settle it with an OTX cell under one underpaying owner output (drain 2, pay once), because
    // cellswap-otx-lock never counts intent-lock demand. Such cells are not settleable; they
    // remain owner-cancellable (is_owner_authorizing is checked before settlement in verify()), so no
    // funds are ever stranded. The owner's intent cell carries the real OTX hash in its own args, so a
    // malicious solver cannot forge it away.
    let otx_code = match args.otx_code_hash {
        Some(h) if h != [0u8; 32] => h,
        _ => return Err(Error::Unprotected),
    };

    // Required payout = Σ min_amount_out over all sibling intent-lock inputs (same lock code, same
    // owner, same token_out). This intent is itself one of them, so `required >= args.min_amount_out`.
    let mut required: u128 = 0;
    // Owner rent refund: accumulate the consumed sibling intent capacity and the max declared
    // solver fee, so the owner is refunded their cell rent (minus the bounded fee).
    let mut consumed_cap: u128 = 0;
    let mut max_fee: u128 = 0;
    let mut i = 0usize;
    loop {
        let lock = match load_cell_lock(i, Source::Input) {
            Ok(l) => l,
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(Error::Sys),
        };
        if lock.code_hash().as_slice() == my_code {
            let la = lock.args();
            let raw = la.raw_data();
            if raw.len() >= TOTAL_ARGS_LEN
                && raw[OWNER_LOCK_HASH_OFF..OWNER_LOCK_HASH_OFF + 32] == args.owner_lock_hash[..]
                && raw[TOKEN_OUT_HASH_OFF..TOKEN_OUT_HASH_OFF + 32] == args.token_out_type_hash[..]
            {
                let m = read_u128(&raw, MIN_AMOUNT_OUT_OFF).map_err(|_| Error::InvalidArgs)?;
                required = required.saturating_add(m);
                let cap = load_cell_capacity(i, Source::Input).map_err(|_| Error::Sys)? as u128;
                let fee_bps = read_u16(&raw, SOLVER_FEE_OFF).unwrap_or(0) as u128;
                consumed_cap = consumed_cap.saturating_add(cap);
                max_fee = max_fee.saturating_add(cap.saturating_mul(fee_bps) / BPS_DENOM);
            }
        }
        i += 1;
    }

    // Cross-contract double-satisfaction: also add the demand of every cellswap-otx-lock
    // input that targets the same (owner, token_out). Both locks pay the owner from the same output
    // set, so without this an OTX cell + this intent cell could share one underpaying payout (drain
    // 2, pay once), since each lock counts only its own code hash. This is unconditional: `otx_code` is the
    // required non-zero hash checked at the top of this function.
    required = required.saturating_add(sum_otx_demand(
        &otx_code,
        &args.owner_lock_hash,
        &args.token_out_type_hash,
    )?);

    // Sum all outputs going to owner_lock_hash with token_out type, plus the total CKB capacity of
    // every owner-locked output (for the rent-refund floor below).
    let mut total: u128 = 0;
    let mut owner_cap_out: u128 = 0;
    let mut j = 0usize;
    loop {
        match load_cell_lock_hash(j, Source::Output) {
            Ok(hash) if hash == args.owner_lock_hash => {
                if let Ok(c) = load_cell_capacity(j, Source::Output) {
                    owner_cap_out = owner_cap_out.saturating_add(c as u128);
                }
                if let Ok(Some(th)) = load_cell_type_hash(j, Source::Output) {
                    if th == args.token_out_type_hash {
                        if let Ok(amt) = get_xudt_amount(j, Source::Output) {
                            total = total.saturating_add(amt);
                        }
                    }
                }
            }
            Ok(_) => {}
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => break,
        }
        j += 1;
    }
    if total < required {
        return Err(Error::InsufficientOut);
    }
    // Owner rent refund: the owner must also be refunded the consumed intent cell(s)' CKB
    // capacity, minus a bounded declared solver fee (solver_fee_bps of that capacity). Without this a
    // solver silently keeps the ~270 CKB intent rent, outside the min_amount_out guard.
    if owner_cap_out < consumed_cap.saturating_sub(max_fee) {
        return Err(Error::RentNotRefunded);
    }
    Ok(())
}

/// Sum `min_amount_out` over every cellswap-otx-lock input (lock code == `otx_code`) whose committed
/// intent targets the same (owner, token_out). Mirrors cellswap-otx-lock's own `sum_demand_for`: the
/// intent is revealed only in the witness at the group's first input index, so non-first members are
/// naturally skipped (their witness has no parseable intent), counting each OTX group exactly once.
fn sum_otx_demand(
    otx_code: &[u8; 32],
    owner_lock_hash: &[u8; 32],
    token_out: &[u8; 32],
) -> Result<u128, Error> {
    let mut total: u128 = 0;
    let mut i = 0usize;
    loop {
        let lock = match load_cell_lock(i, Source::Input) {
            Ok(l) => l,
            Err(SysError::IndexOutOfBound) => break,
            // Fail closed: an unexpected syscall error must not silently truncate the OTX demand sum
            // (undercounting `required` would let a solver underpay). Only IndexOutOfBound ends the scan.
            Err(_) => return Err(Error::Sys),
        };
        if lock.code_hash().as_slice() == &otx_code[..] {
            if let Ok(wa) = load_witness_args(i, Source::Input) {
                if let Some(lock_w) = wa.lock().to_opt() {
                    if let Some((min, t_out, o)) = parse_otx_intent(lock_w.raw_data().as_ref()) {
                        if t_out == &token_out[..] && o == &owner_lock_hash[..] {
                            total = total.saturating_add(min);
                        }
                    }
                }
            }
        }
        i += 1;
    }
    Ok(total)
}
