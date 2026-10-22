#![no_std]
#![no_main]

//! StakePool: the singleton type script that drives CellSwap staking.
//!
//! Users stake an xUDT (the "stake token") and earn CKB rewards funded into the pool's
//! reward reserve (by the protocol treasury, or permissionlessly by anyone). Rewards stream
//! out of the reserve over time and are distributed pro-rata, time-weighted, using the classic
//! MasterChef `acc_reward_per_share` accumulator, ported to the cell model as one singleton
//! pool cell that every operation spends and recreates.
//!
//! Why a type script:
//!   A lock-only staking design is insecure: locks run only on spend, never on creation, and
//!   cell creation is permissionless, so a forged position cell (`acc_at_touch = 0`) could
//!   claim a huge reward. This script is a type script and runs on its own creation and
//!   consumption, and the stake receipt + custody cells are forced (by `stake-guard`) to be
//!   created/spent only in a tx that spends this pool. So every position's `acc_at_touch` is
//!   pinned to the live `acc` at creation, under this script's supervision. There is no
//!   unchecked creation path.
//!
//! Self-advancing accrual:
//!   Because the singleton is spent+recreated on every op, this script advances the accumulator
//!   itself using the tip epoch from a header dep; no off-chain keeper is trusted for accrual.
//!   If nobody touches the pool, accrual simply pauses (rewards are not lost; they resume on the
//!   next op). Principal is always withdrawable.
//!
//! Cell group (one pool):
//!   * pool cell (type = this script): the accumulator + the CKB reward vault (in capacity).
//!   * receipt cell (type = stake-guard): per-position; data = amount(16) || acc_at_touch(16);
//!       lock = owner's lock (only the owner spends → only the owner claims/unstakes).
//!   * custody cell (lock = stake-guard, type = stake-token xUDT): holds the staked principal.
//!   `stake-guard` (one tiny script in two roles) forces both to move only under this script.
//!
//! Args (96 bytes):
//!   [0..32]  stake_guard_code_hash  code hash of stake-guard (to find receipt/custody cells)
//!   [32..64] type_id                blake2b(first_input ‖ output_index), a true type-id singleton
//!   [64..96] governance_authority   lock hash that gates genesis, emission re-rate, pause, and
//!                                    bounded reserve-recovery. Reward-emitting pools are
//!                                    governance-gated (unlike permissionless AMM pools).
//!
//! Reward-vault drain via a twin pool: a pool's identity is its
//! type hash, and receipts/custody bind to a pool only by that hash. If `args[32..64]` were a free
//! salt, an attacker could re-use a rich pool's salt to genesis a second live cell with the identical
//! type hash, mint a cheap receipt against the twin, then apply it to the rich pool and drain its CKB
//! reward vault. So `args[32..64]` is a real CKB type-id: at genesis the script
//! requires it to equal blake2b("ckb-default-hash", first_input_CellInput ‖ output_index_LE). Because
//! an outpoint can be consumed only once, the type hash is globally unique, so no twin can exist.
//!
//! Data (91 bytes):
//!   [0..32]  stake_token_type_hash   the xUDT that is staked              (immutable)
//!   [32..48] total_staked            u128 LE
//!   [48..64] acc_reward_per_share    u128 LE  scaled by ACC_PRECISION (1e12), monotonic
//!   [64..80] reward_reserve          u128 LE  unstreamed CKB shannons
//!   [80..88] last_update_epoch       u64  LE
//!   [88..90] emission_per_epoch_bps  u16  LE  per-epoch fraction of reserve streamed (governance-mutable)
//!   [90]     paused                  u8       (governance-mutable; 0 at genesis)
//!
//! Reward vault (CKB-native): physical reward CKB = pool capacity − MIN_STAKEPOOL_CAPACITY.
//!   Invariant maintained inductively: physical >= reward_reserve + Σ unclaimed_entitlements.
//!   Genesis establishes reward_reserve == capacity − MIN (entitlements = 0); every op preserves
//!   it. So a claim of `pending` can never exceed the physically available reward. Rounding (floor
//!   in pending and acc) always favors the pool.

use cell_utils::{read_u128, read_u16, read_u64};
use ckb_std::{
    ckb_constants::Source,
    ckb_types::prelude::*,
    default_alloc, entry,
    error::SysError,
    high_level::{
        load_cell_capacity, load_cell_data, load_cell_lock, load_cell_lock_hash, load_cell_type,
        load_cell_type_hash, load_header_epoch_number, load_input, load_script, QueryIter,
    },
};
use ethnum::U256;

entry!(program_entry);
default_alloc!();

const DATA_LEN: usize = 91;
const ACC_PRECISION: u128 = 1_000_000_000_000; // 1e12
const BPS_DENOM: u128 = 10_000;
/// Floor capacity of the pool cell; reward reserve rides above this. Comfortably exceeds the
/// occupied bytes of (capacity + 91B data + stake-pool type + any owner lock).
const MIN_STAKEPOOL_CAPACITY: u64 = 30_000_000_000; // 300 CKB
const ZERO32: [u8; 32] = [0u8; 32];

#[repr(i8)]
enum Error {
    Sys = 1,
    BadArgs = 2,
    BadData = 3,
    Immutable = 4,
    Paused = 5,
    BadEpoch = 6,
    AccMismatch = 7,
    ReserveMismatch = 8,
    TotalMismatch = 9,
    CustodyMismatch = 10,
    OwnerMismatch = 11,
    AccNotPinned = 12,
    RewardOverpaid = 13,
    CapacityFloor = 14,
    UnexpectedCells = 15,
    GenesisInvalid = 16,
    Unauthorized = 17,
}

impl From<SysError> for Error {
    fn from(_: SysError) -> Self {
        Error::Sys
    }
}

struct Pool {
    stake_token: [u8; 32],
    total_staked: u128,
    acc: u128,
    reserve: u128,
    last_epoch: u64,
    emission_bps: u16,
    paused: bool,
}

impl Pool {
    fn parse(data: &[u8]) -> Result<Self, Error> {
        if data.len() < DATA_LEN {
            return Err(Error::BadData);
        }
        let mut st = [0u8; 32];
        st.copy_from_slice(&data[0..32]);
        Ok(Pool {
            stake_token: st,
            total_staked: read_u128(data, 32).map_err(|_| Error::BadData)?,
            acc: read_u128(data, 48).map_err(|_| Error::BadData)?,
            reserve: read_u128(data, 64).map_err(|_| Error::BadData)?,
            last_epoch: read_u64(data, 80).map_err(|_| Error::BadData)?,
            emission_bps: read_u16(data, 88).map_err(|_| Error::BadData)?,
            paused: data[90] != 0,
        })
    }
}

/// A stake receipt cell: type = stake-guard bound to this pool. data = amount || acc_at_touch.
struct Receipt {
    amount: u128,
    acc_at_touch: u128,
    owner: [u8; 32],
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
    if args.len() < 96 {
        return Err(Error::BadArgs);
    }
    let mut guard_code_hash = [0u8; 32];
    guard_code_hash.copy_from_slice(&args[0..32]);
    let mut type_id = [0u8; 32];
    type_id.copy_from_slice(&args[32..64]);
    let mut governance = [0u8; 32];
    governance.copy_from_slice(&args[64..96]);

    let in_count = QueryIter::new(load_cell_data, Source::GroupInput).count();
    let out_count = QueryIter::new(load_cell_data, Source::GroupOutput).count();
    if in_count > 1 || out_count > 1 {
        return Err(Error::UnexpectedCells);
    }
    if in_count == 0 && out_count == 1 {
        return verify_genesis(&type_id, &governance);
    }
    if in_count != 1 || out_count != 1 {
        return Err(Error::UnexpectedCells);
    }

    let cap_in = load_cell_capacity(0, Source::GroupInput)?;
    let cap_out = load_cell_capacity(0, Source::GroupOutput)?;
    let pin = Pool::parse(&load_cell_data(0, Source::GroupInput)?)?;
    let pout = Pool::parse(&load_cell_data(0, Source::GroupOutput)?)?;

    // stake_token is always immutable (emission_bps and paused are governance-mutable, gated below).
    if pin.stake_token != pout.stake_token {
        return Err(Error::Immutable);
    }
    let authority = authority_cosigns(&governance);
    // A paused pool is frozen to everyone except a governance admin op (to unpause / re-rate / recover).
    if pin.paused && !authority {
        return Err(Error::Paused);
    }

    // The binding receipt/custody cells carry this pool's own type hash.
    let self_type_hash = load_cell_type_hash(0, Source::GroupInput)?.ok_or(Error::Sys)?;

    // ── Advance the accumulator from the tip epoch (header dep) ────────────────
    let now = load_header_epoch_number(0, Source::HeaderDep).map_err(|_| Error::BadEpoch)?;
    if now < pin.last_epoch {
        return Err(Error::BadEpoch);
    }
    let (acc, reserve_fold) = fold(&pin, now);

    if pout.last_epoch != now {
        return Err(Error::BadEpoch);
    }
    if pout.acc != acc {
        return Err(Error::AccMismatch);
    }

    // ── Find the (≤1) receipt and custody cells on each side ──────────────────
    let r_in = find_receipt(Source::Input, &guard_code_hash, &self_type_hash)?;
    let r_out = find_receipt(Source::Output, &guard_code_hash, &self_type_hash)?;
    let c_in = find_custody(
        Source::Input,
        &guard_code_hash,
        &self_type_hash,
        &pin.stake_token,
    )?;
    let c_out = find_custody(
        Source::Output,
        &guard_code_hash,
        &self_type_hash,
        &pin.stake_token,
    )?;

    match (&r_in, &r_out) {
        // ── fund / poke / governance admin (re-rate, pause, recover): no positions touched ──
        (None, None) => {
            if c_in.is_some() || c_out.is_some() {
                return Err(Error::CustodyMismatch);
            }
            if pout.total_staked != pin.total_staked {
                return Err(Error::TotalMismatch);
            }
            // Capacity must track the reserve change exactly: no CKB is minted or lost beyond the
            // reserve delta. cap_out + reserve_fold == cap_in + pout.reserve covers both permissionless
            // funding (reserve grows) and governance recovery (reserve shrinks).
            if cap_out as u128 + reserve_fold != cap_in as u128 + pout.reserve {
                return Err(Error::ReserveMismatch);
            }
            // Governance: a reserve reduction (recovery), an emission re-rate, or a pause change
            // are admin ops requiring the governance authority. Permissionless funding (reserve grows,
            // params unchanged) needs no authority. Recovery only reduces the unstreamed reserve and
            // its capacity 1:1, so the inductive vault invariant (physical >= reserve + Σ unclaimed)
            // is preserved and staked principal / accrued rewards are never touched.
            let recovering = pout.reserve < reserve_fold;
            let admin =
                recovering || pin.emission_bps != pout.emission_bps || pin.paused != pout.paused;
            if admin && !authority {
                return Err(Error::Unauthorized);
            }
        }
        // ── stake / unstake / claim: a position is created, grown, shrunk, or harvested. ──
        _ => {
            // Position ops never change emission/pause: those are governance admin ops (above).
            if pin.emission_bps != pout.emission_bps || pin.paused != pout.paused {
                return Err(Error::Immutable);
            }
            let amt_in = r_in.as_ref().map(|r| r.amount).unwrap_or(0);
            let amt_out = r_out.as_ref().map(|r| r.amount).unwrap_or(0);

            // Owner must be consistent across the position and its custody.
            let owner = match (&r_in, &r_out) {
                (Some(a), Some(b)) => {
                    if a.owner != b.owner {
                        return Err(Error::OwnerMismatch);
                    }
                    a.owner
                }
                (Some(a), None) => a.owner,
                (None, Some(b)) => b.owner,
                // Unreachable: this arm sits inside the `_` branch of the outer match on
                // (&r_in, &r_out), which already excludes (None, None). Return a typed code rather
                // than panicking so a future refactor that made it reachable fails diagnosably.
                (None, None) => return Err(Error::Sys),
            };

            // Custody must mirror the receipt principal exactly, present-iff-nonzero, same owner.
            check_custody(&c_in, amt_in, &owner)?;
            check_custody(&c_out, amt_out, &owner)?;

            // A (re)written position must pin acc_at_touch to the live accumulator.
            if let Some(r) = &r_out {
                if r.acc_at_touch != acc {
                    return Err(Error::AccNotPinned);
                }
            }

            // total_staked tracks the principal delta exactly.
            let expect_total = pin.total_staked as i128 + amt_out as i128 - amt_in as i128;
            if expect_total < 0 || pout.total_staked as i128 != expect_total {
                return Err(Error::TotalMismatch);
            }

            // User ops never change the unstreamed reserve (only fold/fund do).
            if pout.reserve != reserve_fold {
                return Err(Error::ReserveMismatch);
            }

            // Reward released (pool capacity drop) is bounded by the accrued pending.
            let pending = match &r_in {
                Some(r) => {
                    (U256::from(r.amount) * U256::from(acc - r.acc_at_touch))
                        / U256::from(ACC_PRECISION)
                }
                None => U256::ZERO,
            };
            let cap_in_u = U256::from(cap_in);
            let cap_out_u = U256::from(cap_out);
            // cap_in − pending ≤ cap_out ≤ cap_in  (release at most `pending`, never mint CKB)
            if cap_out_u > cap_in_u {
                return Err(Error::RewardOverpaid);
            }
            if cap_in_u - cap_out_u > pending {
                return Err(Error::RewardOverpaid);
            }
        }
    }

    if cap_out < MIN_STAKEPOOL_CAPACITY {
        return Err(Error::CapacityFloor);
    }
    Ok(())
}

/// Advance the accumulator to `now`, returning (acc_after, reserve_after).
fn fold(p: &Pool, now: u64) -> (u128, u128) {
    if p.paused || p.total_staked == 0 || now <= p.last_epoch {
        return (p.acc, p.reserve);
    }
    let elapsed = (now - p.last_epoch) as u128;
    // streamed = reserve * emission_bps/10000 * elapsed, capped at the reserve.
    let mut streamed =
        (U256::from(p.reserve) * U256::from(p.emission_bps as u128) * U256::from(elapsed))
            / U256::from(BPS_DENOM);
    let reserve_u = U256::from(p.reserve);
    if streamed > reserve_u {
        streamed = reserve_u;
    }
    // Clamp acc_add into the u128 domain before truncating. `acc` is a u128, so a
    // bare `.as_u128()` on a U256 that exceeded u128::MAX (small total_staked × large streamed ×
    // ACC_PRECISION) would silently wrap, breaking the monotonic-acc invariant the whole reward model
    // relies on (the `acc - acc_at_touch` subtractions). Clamping fails safe: it only ever credits less,
    // never wraps. `distributed` is then derived from the same clamped value so the reserve debit stays
    // consistent. Practically unreachable at realistic magnitudes; this is defense in depth.
    let acc_add_u256 = (streamed * U256::from(ACC_PRECISION)) / U256::from(p.total_staked);
    let acc_add = if acc_add_u256 > U256::from(u128::MAX) {
        u128::MAX
    } else {
        acc_add_u256.as_u128()
    };
    // Only debit the reserve by what was actually credited to `acc`. The
    // sub-share dust (`streamed - distributed`) stays in the reserve for a later fold instead of
    // becoming stranded, un-claimable pool capacity.
    let distributed =
        (U256::from(acc_add) * U256::from(p.total_staked)) / U256::from(ACC_PRECISION);
    let acc = p.acc.saturating_add(acc_add);
    let reserve = p.reserve.saturating_sub(distributed.as_u128());
    (acc, reserve)
}

/// True if some input cell is locked by the governance authority (lock hash == `auth`). A zero
/// authority is treated as "not configured" so no governance op is ever satisfied.
fn authority_cosigns(auth: &[u8; 32]) -> bool {
    if auth == &ZERO32 {
        return false;
    }
    let mut i = 0usize;
    loop {
        match load_cell_lock_hash(i, Source::Input) {
            Ok(h) => {
                if &h == auth {
                    return true;
                }
            }
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => break,
        }
        i += 1;
    }
    false
}

fn verify_genesis(type_id: &[u8; 32], governance: &[u8; 32]) -> Result<(), Error> {
    // The pool is a true singleton: its `type_id` arg must be the canonical CKB type-id of this
    // genesis (first input outpoint + this cell's output index). An outpoint is spent once, so the
    // resulting type hash can never collide with another pool (no twin pool).
    check_type_id(type_id)?;
    // Governance: a reward-emitting stake-pool is created only under the governance authority, so
    // users cannot be routed into permanent, attacker-configured reward pools.
    if governance == &ZERO32 || !authority_cosigns(governance) {
        return Err(Error::Unauthorized);
    }
    let cap = load_cell_capacity(0, Source::GroupOutput)?;
    let p = Pool::parse(&load_cell_data(0, Source::GroupOutput)?)?;
    if p.paused {
        return Err(Error::Paused);
    }
    // A fresh pool starts with no stakers and no accrued rewards; all CKB above the floor is the
    // initial reward reserve. This prevents seeding a pool with phantom entitlements.
    if p.total_staked != 0 || p.acc != 0 {
        return Err(Error::GenesisInvalid);
    }
    if cap < MIN_STAKEPOOL_CAPACITY {
        return Err(Error::CapacityFloor);
    }
    if p.reserve != (cap - MIN_STAKEPOOL_CAPACITY) as u128 {
        return Err(Error::GenesisInvalid);
    }
    if p.stake_token == ZERO32 {
        return Err(Error::GenesisInvalid);
    }
    Ok(())
}

/// Verify the canonical CKB type-id: `expected` must equal
/// blake2b("ckb-default-hash", first_input_CellInput ‖ output_index_of_this_cell_LE). This makes the
/// pool's type hash globally unique (an input outpoint is consumed at most once).
fn check_type_id(expected: &[u8; 32]) -> Result<(), Error> {
    // Locate this genesis cell's absolute index in the outputs (its type hash == our own).
    let self_hash = load_cell_type_hash(0, Source::GroupOutput)?.ok_or(Error::Sys)?;
    let mut out_index: Option<usize> = None;
    let mut i = 0usize;
    loop {
        match load_cell_type_hash(i, Source::Output) {
            Ok(Some(h)) if h == self_hash => {
                out_index = Some(i);
                break;
            }
            Ok(_) => i += 1,
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(Error::Sys),
        }
    }
    let out_index = out_index.ok_or(Error::GenesisInvalid)?;
    // A genesis tx always consumes at least one input to fund the cell.
    let first_input = load_input(0, Source::Input).map_err(|_| Error::GenesisInvalid)?;
    let mut ret = [0u8; 32];
    let mut blake = blake2b_ref::Blake2bBuilder::new(32)
        .personal(b"ckb-default-hash")
        .build();
    blake.update(first_input.as_slice());
    blake.update(&(out_index as u64).to_le_bytes());
    blake.finalize(&mut ret);
    if &ret != expected {
        return Err(Error::GenesisInvalid);
    }
    Ok(())
}

/// Custody must be present exactly when principal is nonzero, equal the principal, same owner.
fn check_custody(
    c: &Option<(u128, [u8; 32])>,
    principal: u128,
    owner: &[u8; 32],
) -> Result<(), Error> {
    match c {
        Some((amount, c_owner)) => {
            if principal == 0 {
                return Err(Error::CustodyMismatch);
            }
            if *amount != principal {
                return Err(Error::CustodyMismatch);
            }
            if c_owner != owner {
                return Err(Error::OwnerMismatch);
            }
            Ok(())
        }
        None => {
            if principal != 0 {
                return Err(Error::CustodyMismatch);
            }
            Ok(())
        }
    }
}

/// Find the (at most one) receipt cell bound to this pool: type = stake-guard, type.args[0..32]
/// == self_type_hash. Returns its (amount, acc_at_touch, owner). >1 match → error.
fn find_receipt(
    source: Source,
    guard_code_hash: &[u8; 32],
    self_type_hash: &[u8; 32],
) -> Result<Option<Receipt>, Error> {
    let mut found: Option<Receipt> = None;
    let mut i = 0usize;
    loop {
        let ty = match load_cell_type(i, source) {
            Ok(t) => t,
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(Error::Sys),
        };
        if let Some(ty) = ty {
            if ty.code_hash().as_slice() == &guard_code_hash[..] {
                let ty_args = ty.args();
                let a = ty_args.raw_data();
                if a.len() >= 64 && &a[0..32] == &self_type_hash[..] {
                    let data = load_cell_data(i, source)?;
                    if data.len() < 32 {
                        return Err(Error::BadData);
                    }
                    if found.is_some() {
                        return Err(Error::UnexpectedCells);
                    }
                    let mut owner = [0u8; 32];
                    owner.copy_from_slice(&a[32..64]);
                    // The receipt's authorization must be
                    // its actual spending lock, not the self-declared `owner` bytes in the guard args.
                    // Without this, a third party can create a receipt bearing a victim's owner field
                    // under an attacker lock, then pair it with the victim's custody (matched only by
                    // (owner, amount)) to move/destroy the victim's principal, breaking "principal is
                    // always withdrawable". Requiring lock_hash == owner on both creation (output) and
                    // consumption (input) means only the owner's own lock can ever create or spend their
                    // position. This enforces the documented design ("lock = owner's lock", top of file).
                    let lock_hash = load_cell_lock_hash(i, source).map_err(|_| Error::Sys)?;
                    if lock_hash != owner {
                        return Err(Error::OwnerMismatch);
                    }
                    found = Some(Receipt {
                        amount: read_u128(&data, 0).map_err(|_| Error::BadData)?,
                        acc_at_touch: read_u128(&data, 16).map_err(|_| Error::BadData)?,
                        owner,
                    });
                }
            }
        }
        i += 1;
    }
    Ok(found)
}

/// Find the (at most one) custody cell bound to this pool: lock = stake-guard, lock.args[0..32]
/// == self_type_hash, type hash == stake_token. Returns (xUDT amount, owner). >1 match → error.
fn find_custody(
    source: Source,
    guard_code_hash: &[u8; 32],
    self_type_hash: &[u8; 32],
    stake_token: &[u8; 32],
) -> Result<Option<(u128, [u8; 32])>, Error> {
    let mut found: Option<(u128, [u8; 32])> = None;
    let mut i = 0usize;
    loop {
        let lock = match load_cell_lock(i, source) {
            Ok(l) => l,
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(Error::Sys),
        };
        if lock.code_hash().as_slice() == &guard_code_hash[..] {
            let lock_args = lock.args();
            let a = lock_args.raw_data();
            if a.len() >= 64 && &a[0..32] == &self_type_hash[..] {
                if let Ok(Some(th)) = load_cell_type_hash(i, source) {
                    if &th == stake_token {
                        let data = load_cell_data(i, source)?;
                        if data.len() < 16 {
                            return Err(Error::BadData);
                        }
                        if found.is_some() {
                            return Err(Error::UnexpectedCells);
                        }
                        let mut owner = [0u8; 32];
                        owner.copy_from_slice(&a[32..64]);
                        found = Some((read_u128(&data, 0).map_err(|_| Error::BadData)?, owner));
                    }
                }
            }
        }
        i += 1;
    }
    Ok(found)
}
