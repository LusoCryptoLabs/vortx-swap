#![no_std]
#![no_main]

//! MiningPool: liquidity-mining stake pool. Stake a CKB/xUDT pool's LP token, earn minted VTX.
//!
//! This is the counterpart of `stake-pool` (which stakes any xUDT for CKB).
//! It reuses `stake-guard` verbatim for the receipt + custody cells (the security model, where positions
//! can only be created/moved under this pool's supervision, carries over unchanged). The deltas:
//!
//!   * The reward is minted VTX, not a CKB reserve. The accumulator advances at an absolute rate
//!     (`emission_per_epoch`), and a claim requires the total VTX minted in the tx to equal the
//!     accrued `pending` (no over-mint). `emission-lock` (VTX's owner) authorizes the mint by
//!     requiring this pool to be spent; this script bounds the amount.
//!   * `emission_per_epoch` is mutable under the governance authority (re-weight / de-list).
//!   * Genesis is governance-authorized and verifies on-chain that the staked token is the LP token
//!     of a CKB/xUDT pool (anti-gaming).
//!
//! Lock-boost (fixed-term lock-weighted emission). A position may
//! commit its LP until a future epoch for a higher mining rate. Redistributive: the accumulator
//! divides the same emission by `total_weight` (boosted effective stake), so lockers take a bigger
//! slice of a fixed pie: total VTX supply is unchanged and `emission-lock` is untouched.
//!   * `weight = amount · boost_bps(committed_term)/10000`, validated at creation; an unlocked
//!     position has `weight == amount` (1.0×), the backward-compatible base case.
//!   * The principal custody of a locked position is locked by `stake-timelock-guard` (args[193..225])
//!     whose `since >= deadline` freezes the principal until the deadline. Because every position op
//!     spends the custody, a locked position cannot be touched until expiry: you commit, then
//!     unstake-with-reward at/after the deadline (no mid-lock harvest, no decay, no roll needed). The
//!     pool binds `receipt.unlock_epoch == custody.deadline` and the tier-derived weight.
//!
//! Data (81 bytes):
//!   [0..32]  stake_token_type_hash   the LP token's type hash (a CKB/xUDT pool's LP)
//!   [32..48] total_weight            u128 LE  (Σ boosted effective stake; == Σ principal when all unlocked)
//!   [48..64] acc_reward_per_share    u128 LE  (×ACC_PRECISION)
//!   [64..72] last_update_epoch       u64  LE
//!   [72..80] emission_per_epoch      u64  LE   VTX base units / epoch (mutable by governance)
//!   [80]     paused                  u8
//!
//! Receipt data (56 bytes; legacy 32 bytes ⇒ weight == amount, unlock_epoch == 0):
//!   [0..16]  amount        u128 LE   the staked LP principal (custody-bound)
//!   [16..32] acc_at_touch  u128 LE
//!   [32..48] weight        u128 LE   boosted effective stake = amount · boost_bps/10000
//!   [48..56] unlock_epoch  u64  LE   commitment deadline; 0 = unlocked
//!
//! Args (193 bytes; 225 with the optional lock-boost field):
//!   [0..32]    stake_guard_code_hash         binds receipt/unlocked-custody cells (as in stake-pool)
//!   [32..64]   vtx_type_hash                 the reward token (to sum minted VTX)
//!   [64..96]   authority_lock_hash           governance co-sign (genesis + emission change)
//!   [96..128]  lp_token_code_hash            to recompute the LP script hash for the CKB/xUDT check
//!   [128]      lp_token_hash_type            hash-type byte of the LP token script
//!   [129..161] pool_script_code_hash         to locate the AMM info cell dep
//!   [161..193] pool_seed                     uniqueness → unique type hash (singleton identity)
//!   [193..225] stake_timelock_guard_code_hash  (optional) the composed lock for locked custody cells;
//!              absent/zero ⇒ lock-boost disabled (only unlocked, weight==amount positions)

use cell_utils::{read_u128, read_u64};
use ckb_std::{
    ckb_constants::Source,
    ckb_types::{
        packed::{Byte32, Script},
        prelude::*,
    },
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

const DATA_LEN: usize = 81;
const ACC_PRECISION: u128 = 1_000_000_000_000; // 1e12
/// Defense-in-depth sanity bound on the absolute emission rate (VTX base units / epoch). The
/// primary guard against an unbounded mint is the governance-authority binding in `emission-lock`
/// (see its module docs); this cap additionally limits a governance fat-finger and keeps the
/// accumulator math far from u64/u128 limits. Governance can re-tune it by redeploying the pool.
const MAX_EMISSION_PER_EPOCH: u64 = 1_000_000_000_000_000_000; // 1e18
const POOL_MODE_CKB_NATIVE: u8 = 0x01;
const POOL_MODE_OFF: usize = 138; // byte offset of pool_mode in the AMM info cell data
const ZERO32: [u8; 32] = [0u8; 32];

// ── Lock-boost tier schedule, pinned in bytecode ───────────────────────────────────────────────
// Boost weight as basis points of the principal, by committed term in epochs (epoch ≈ 4h, 6/day).
// 30/60/90/180/360 days = 180/360/540/1080/2160 epochs. Rounds down to a tier. The top tier is the cap.
const BOOST_DENOM: u128 = 10_000;
// A lock deadline must be satisfiable by a 24-bit `since` epoch (RFC-0017), else stake-timelock-guard
// can never release the principal. Reject creation of a position with a deadline beyond this.
const MAX_UNLOCK_EPOCH: u64 = 0x00ff_ffff;
const TIER_30D: u64 = 180;
const TIER_60D: u64 = 360;
const TIER_90D: u64 = 540;
const TIER_180D: u64 = 1080;
const TIER_360D: u64 = 2160;

/// boost_bps(committed_term_epochs): the pinned tier table. Unlocked / sub-30d == 1.0× (10000).
fn boost_bps(term: u64) -> u128 {
    if term >= TIER_360D {
        25_000 // 2.5× ceiling
    } else if term >= TIER_180D {
        20_000 // 2.0×
    } else if term >= TIER_90D {
        17_500 // 1.75×
    } else if term >= TIER_60D {
        15_000 // 1.5×
    } else if term >= TIER_30D {
        12_500 // 1.25×
    } else {
        10_000 // 1.0×
    }
}

#[repr(i8)]
enum Error {
    Sys = 1,
    BadArgs = 2,
    BadData = 3,
    Immutable = 4,
    Paused = 5,
    BadEpoch = 6,
    AccMismatch = 7,
    TotalMismatch = 8,
    CustodyMismatch = 9,
    OwnerMismatch = 10,
    AccNotPinned = 11,
    RewardMintMismatch = 12,
    EmissionUnauthorized = 13,
    UnexpectedCells = 14,
    GenesisInvalid = 15,
    GenesisUnauthorized = 16,
    NotCkbXudtLp = 17,
    CapacitySkim = 18,
    WeightInvalid = 19,
    DeadlineMismatch = 20,
}

impl From<SysError> for Error {
    fn from(_: SysError) -> Self {
        Error::Sys
    }
}

struct Args {
    stake_guard_code_hash: [u8; 32],
    vtx_type_hash: [u8; 32],
    authority_lock_hash: [u8; 32],
    lp_token_code_hash: [u8; 32],
    lp_token_hash_type: u8,
    pool_script_code_hash: [u8; 32],
    /// Optional composed custody lock for locked positions; ZERO32 ⇒ lock-boost disabled.
    stake_timelock_guard_code_hash: [u8; 32],
}

struct Pool {
    stake_token: [u8; 32],
    total_weight: u128,
    acc: u128,
    last_epoch: u64,
    emission_per_epoch: u64,
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
            total_weight: read_u128(data, 32).map_err(|_| Error::BadData)?,
            acc: read_u128(data, 48).map_err(|_| Error::BadData)?,
            last_epoch: read_u64(data, 64).map_err(|_| Error::BadData)?,
            emission_per_epoch: read_u64(data, 72).map_err(|_| Error::BadData)?,
            paused: data[80] != 0,
        })
    }
}

struct Receipt {
    amount: u128,
    acc_at_touch: u128,
    weight: u128,
    unlock_epoch: u64,
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
    let a = raw.raw_data();
    if a.len() < 193 {
        return Err(Error::BadArgs);
    }
    let mut args = Args {
        stake_guard_code_hash: [0u8; 32],
        vtx_type_hash: [0u8; 32],
        authority_lock_hash: [0u8; 32],
        lp_token_code_hash: [0u8; 32],
        lp_token_hash_type: a[128],
        pool_script_code_hash: [0u8; 32],
        stake_timelock_guard_code_hash: [0u8; 32],
    };
    args.stake_guard_code_hash.copy_from_slice(&a[0..32]);
    args.vtx_type_hash.copy_from_slice(&a[32..64]);
    args.authority_lock_hash.copy_from_slice(&a[64..96]);
    args.lp_token_code_hash.copy_from_slice(&a[96..128]);
    args.pool_script_code_hash.copy_from_slice(&a[129..161]);
    // Optional lock-boost field, present only on boost-enabled pools.
    if a.len() >= 225 {
        args.stake_timelock_guard_code_hash
            .copy_from_slice(&a[193..225]);
    }

    let in_count = QueryIter::new(load_cell_data, Source::GroupInput).count();
    let out_count = QueryIter::new(load_cell_data, Source::GroupOutput).count();
    if in_count > 1 || out_count > 1 {
        return Err(Error::UnexpectedCells);
    }
    if in_count == 0 && out_count == 1 {
        return verify_genesis(&args);
    }
    if in_count != 1 || out_count != 1 {
        return Err(Error::UnexpectedCells);
    }

    let pin = Pool::parse(&load_cell_data(0, Source::GroupInput)?)?;
    let pout = Pool::parse(&load_cell_data(0, Source::GroupOutput)?)?;

    // Permissionless rent skim: the mining-pool cell holds only
    // accumulator state (its reward is minted VTX, never paid out of this cell), so its CKB capacity is
    // pure rent and must never decrease across a spend.
    let cap_in = load_cell_capacity(0, Source::GroupInput)?;
    let cap_out = load_cell_capacity(0, Source::GroupOutput)?;
    if cap_out < cap_in {
        return Err(Error::CapacitySkim);
    }

    if pin.stake_token != pout.stake_token || pin.paused != pout.paused {
        return Err(Error::Immutable);
    }
    if pin.paused {
        return Err(Error::Paused);
    }

    let self_type_hash = load_cell_type_hash(0, Source::GroupInput)?.ok_or(Error::Sys)?;

    // ── Advance the accumulator at the absolute emission rate, from the tip epoch ──────────────
    let now = load_header_epoch_number(0, Source::HeaderDep).map_err(|_| Error::BadEpoch)?;
    if now < pin.last_epoch {
        return Err(Error::BadEpoch);
    }
    let acc = fold(&pin, now);
    if pout.last_epoch != now {
        return Err(Error::BadEpoch);
    }
    if pout.acc != acc {
        return Err(Error::AccMismatch);
    }

    let r_in = find_receipt(Source::Input, &args.stake_guard_code_hash, &self_type_hash)?;
    let r_out = find_receipt(Source::Output, &args.stake_guard_code_hash, &self_type_hash)?;
    let c_in = find_custody(Source::Input, &args, &self_type_hash, &pin.stake_token)?;
    let c_out = find_custody(Source::Output, &args, &self_type_hash, &pin.stake_token)?;

    let minted = vtx_minted(&args.vtx_type_hash)?;

    match (&r_in, &r_out) {
        // ── poke / governance emission change: no positions touched ──
        (None, None) => {
            if c_in.is_some() || c_out.is_some() {
                return Err(Error::CustodyMismatch);
            }
            if pout.total_weight != pin.total_weight {
                return Err(Error::TotalMismatch);
            }
            // Changing the emission rate (re-weight / de-list) needs the governance authority.
            if pout.emission_per_epoch != pin.emission_per_epoch
                && !authority_cosigns(&args.authority_lock_hash)
            {
                return Err(Error::EmissionUnauthorized);
            }
            if pout.emission_per_epoch > MAX_EMISSION_PER_EPOCH {
                return Err(Error::GenesisInvalid);
            }
            // No reward accrues to anyone here → nothing may be minted.
            if minted != U256::ZERO {
                return Err(Error::RewardMintMismatch);
            }
        }
        // ── stake / unstake / claim ──
        _ => {
            // Emission cannot change during a user op (only via the no-position governance path).
            if pout.emission_per_epoch != pin.emission_per_epoch {
                return Err(Error::Immutable);
            }
            let amt_in = r_in.as_ref().map(|r| r.amount).unwrap_or(0);
            let amt_out = r_out.as_ref().map(|r| r.amount).unwrap_or(0);
            let weight_in = r_in.as_ref().map(|r| r.weight).unwrap_or(0);
            let weight_out = r_out.as_ref().map(|r| r.weight).unwrap_or(0);
            let unlock_in = r_in.as_ref().map(|r| r.unlock_epoch).unwrap_or(0);
            let unlock_out = r_out.as_ref().map(|r| r.unlock_epoch).unwrap_or(0);

            let owner = match (&r_in, &r_out) {
                (Some(x), Some(y)) => {
                    if x.owner != y.owner {
                        return Err(Error::OwnerMismatch);
                    }
                    x.owner
                }
                (Some(x), None) => x.owner,
                (None, Some(y)) => y.owner,
                // Unreachable: this arm sits inside the `_` branch of the outer match on
                // (&r_in, &r_out), which already excludes (None, None). Return a typed code rather
                // than panicking so a future refactor that made it reachable would fail with a
                // diagnosable error instead of a bare VM abort.
                (None, None) => return Err(Error::Sys),
            };

            // ── Lock-boost: validate the output receipt's weight + lock (boost is set at creation) ──
            // An unlocked output must be 1.0× (weight == amount), which is exactly the legacy invariant,
            // so legacy 32B receipts (weight==amount, unlock==0) pass unchanged. A locked output must
            // carry the tier-derived weight for a future deadline; its custody is bound to that deadline
            // below (so a forged high weight has no matching consensus lock → rejected).
            if let Some(r) = &r_out {
                if r.unlock_epoch == 0 {
                    if r.weight != r.amount {
                        return Err(Error::WeightInvalid);
                    }
                } else {
                    if r.unlock_epoch <= now {
                        return Err(Error::WeightInvalid); // cannot create an already-expired lock
                    }
                    // The custody is frozen by stake-timelock-guard, which compares the input's
                    // 24-bit `since` epoch (RFC-0017 EPOCH_NUMBER_MASK = 0x00ff_ffff) against this
                    // deadline. A deadline beyond 24 bits could never be satisfied by any `since`, so
                    // the principal would be permanently frozen; reject it at creation. (0xff_ffff
                    // epochs ≈ 7,600 years, so this never bites an honest lock.)
                    if r.unlock_epoch > MAX_UNLOCK_EPOCH {
                        return Err(Error::WeightInvalid);
                    }
                    // Known residual: `term` is the committed lock duration
                    // used to pick the boost tier, but `now` is read from a HeaderDep, which proves only
                    // that some block with this epoch exists in-chain, not that it is the tip. An attacker
                    // can therefore reference a stale header (small `now`) to inflate `term` past the real
                    // committed duration (unlock_epoch - true_tip) and claim a higher tier, taking a
                    // larger slice of the fixed emission from honest stakers. This is bounded as tightly as
                    // CKB allows on-chain: `now` is floored at `pin.last_epoch` (see the check above,
                    // `now < pin.last_epoch` is rejected) and `pin.last_epoch` is advanced to `now` on every
                    // pool touch, so the exploitable understatement is bounded by (true_tip - pin.last_epoch),
                    // i.e. how long the pool has sat untouched. It cannot be closed fully on-chain: CKB
                    // gives no upper bound on the current epoch (a HeaderDep is a lower bound, `since` is a
                    // lower bound, neither proves recency). A complete fix (mandatory absolute-epoch
                    // `since` == now on locked-position creation) also needs the integration tests
                    // updated in lockstep.
                    let term = r.unlock_epoch - now;
                    let expected = (U256::from(r.amount) * U256::from(boost_bps(term))
                        / U256::from(BOOST_DENOM))
                    .as_u128();
                    if r.weight != expected {
                        return Err(Error::WeightInvalid);
                    }
                }
            }

            // Custody binding: principal == receipt amount, owner-lock match, and the custody's deadline
            // == the receipt's unlock_epoch on each side (so a locked position's weight is always backed
            // by a real `stake-timelock-guard` lock freezing the principal until that exact deadline).
            check_custody(&c_in, amt_in, &owner, unlock_in)?;
            check_custody(&c_out, amt_out, &owner, unlock_out)?;

            if let Some(r) = &r_out {
                if r.acc_at_touch != acc {
                    return Err(Error::AccNotPinned);
                }
            }

            // Conservation on boosted weight (total_weight is the accumulator denominator).
            let expect_total = pin.total_weight as i128 + weight_out as i128 - weight_in as i128;
            if expect_total < 0 || pout.total_weight as i128 != expect_total {
                return Err(Error::TotalMismatch);
            }

            // Reward: the total VTX minted in this tx must equal exactly the accrued pending, computed
            // on the position's weight (boosted effective stake).
            let pending = match &r_in {
                Some(r) => {
                    (U256::from(r.weight) * U256::from(acc - r.acc_at_touch))
                        / U256::from(ACC_PRECISION)
                }
                None => U256::ZERO,
            };
            if minted != pending {
                return Err(Error::RewardMintMismatch);
            }
        }
    }
    Ok(())
}

/// acc += emission_per_epoch · elapsed · PREC / total_weight  (absolute-rate emission, boosted denom).
fn fold(p: &Pool, now: u64) -> u128 {
    if p.paused || p.total_weight == 0 || now <= p.last_epoch {
        return p.acc;
    }
    let elapsed = (now - p.last_epoch) as u128;
    let add = (U256::from(p.emission_per_epoch as u128)
        * U256::from(elapsed)
        * U256::from(ACC_PRECISION))
        / U256::from(p.total_weight);
    // Clamp into u128 before truncating, so a U256 above u128::MAX can't silently
    // wrap `acc` (a u128) and break the monotonic-accumulator invariant. Fails safe (credits less).
    let add_u128 = if add > U256::from(u128::MAX) {
        u128::MAX
    } else {
        add.as_u128()
    };
    p.acc.saturating_add(add_u128)
}

/// Net VTX minted in this tx = Σ outputs − Σ inputs of cells typed by `vtx_type_hash`.
fn vtx_minted(vtx_type_hash: &[u8; 32]) -> Result<U256, Error> {
    let out = sum_vtx(Source::Output, vtx_type_hash)?;
    let inp = sum_vtx(Source::Input, vtx_type_hash)?;
    if out < inp {
        return Ok(U256::ZERO); // a net burn mints nothing; treated as 0 (claims require > 0)
    }
    Ok(out - inp)
}

fn sum_vtx(source: Source, vtx_type_hash: &[u8; 32]) -> Result<U256, Error> {
    let mut total = U256::ZERO;
    let mut i = 0usize;
    loop {
        match load_cell_type_hash(i, source) {
            Ok(Some(h)) if &h == vtx_type_hash => {
                let data = load_cell_data(i, source)?;
                total += U256::from(read_u128(&data, 0).map_err(|_| Error::BadData)?);
                i += 1;
            }
            Ok(_) => i += 1,
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(Error::Sys),
        }
    }
    Ok(total)
}

/// Bind a custody cell to a position: principal == receipt amount, owner-lock match, and the custody's
/// committed `deadline` == the receipt's `unlock_epoch` (0 for an unlocked stake-guard custody).
fn check_custody(
    c: &Option<(u128, [u8; 32], u64)>,
    principal: u128,
    owner: &[u8; 32],
    deadline: u64,
) -> Result<(), Error> {
    match c {
        Some((amount, c_owner, c_deadline)) => {
            if principal == 0 || *amount != principal {
                return Err(Error::CustodyMismatch);
            }
            if c_owner != owner {
                return Err(Error::OwnerMismatch);
            }
            if *c_deadline != deadline {
                return Err(Error::DeadlineMismatch);
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
                let aa = ty_args.raw_data();
                if aa.len() >= 64 && &aa[0..32] == &self_type_hash[..] {
                    let data = load_cell_data(i, source)?;
                    if data.len() < 32 {
                        return Err(Error::BadData);
                    }
                    if found.is_some() {
                        return Err(Error::UnexpectedCells);
                    }
                    let mut owner = [0u8; 32];
                    owner.copy_from_slice(&aa[32..64]);
                    // As in stake-pool, the receipt's authorization must be its
                    // actual spending lock, not the self-declared `owner` bytes in the guard args.
                    let lock_hash = load_cell_lock_hash(i, source).map_err(|_| Error::Sys)?;
                    if lock_hash != owner {
                        return Err(Error::OwnerMismatch);
                    }
                    // Lock-boost: 56B receipt carries weight + unlock_epoch; a legacy 32B receipt is
                    // the unlocked base case (weight == amount, unlock_epoch == 0).
                    let amount = read_u128(&data, 0).map_err(|_| Error::BadData)?;
                    let (weight, unlock_epoch) = if data.len() >= 56 {
                        (
                            read_u128(&data, 32).map_err(|_| Error::BadData)?,
                            read_u64(&data, 48).map_err(|_| Error::BadData)?,
                        )
                    } else {
                        (amount, 0)
                    };
                    found = Some(Receipt {
                        amount,
                        acc_at_touch: read_u128(&data, 16).map_err(|_| Error::BadData)?,
                        weight,
                        unlock_epoch,
                        owner,
                    });
                }
            }
        }
        i += 1;
    }
    Ok(found)
}

/// Find this position's custody cell. Recognizes both the plain `stake-guard` lock (unlocked custody,
/// deadline 0) and, when lock-boost is enabled, the composed `stake-timelock-guard` lock (locked
/// custody; its args carry the deadline at [64..72]). Returns (principal, owner, deadline).
fn find_custody(
    source: Source,
    args: &Args,
    self_type_hash: &[u8; 32],
    stake_token: &[u8; 32],
) -> Result<Option<(u128, [u8; 32], u64)>, Error> {
    let boost_on = args.stake_timelock_guard_code_hash != ZERO32;
    let mut found: Option<(u128, [u8; 32], u64)> = None;
    let mut i = 0usize;
    loop {
        let lock = match load_cell_lock(i, source) {
            Ok(l) => l,
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(Error::Sys),
        };
        let code = lock.code_hash();
        let is_plain = code.as_slice() == &args.stake_guard_code_hash[..];
        let is_locked = boost_on && code.as_slice() == &args.stake_timelock_guard_code_hash[..];
        if is_plain || is_locked {
            let la = lock.args();
            let aa = la.raw_data();
            if aa.len() >= 64 && &aa[0..32] == &self_type_hash[..] {
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
                        owner.copy_from_slice(&aa[32..64]);
                        // The composed guard's args carry the deadline at [64..72]; the plain guard
                        // has no deadline (unlocked → 0).
                        let deadline = if is_locked && aa.len() >= 72 {
                            read_u64(&aa, 64).map_err(|_| Error::BadData)?
                        } else {
                            0
                        };
                        found = Some((
                            read_u128(&data, 0).map_err(|_| Error::BadData)?,
                            owner,
                            deadline,
                        ));
                    }
                }
            }
        }
        i += 1;
    }
    Ok(found)
}

fn authority_cosigns(lock_hash: &[u8; 32]) -> bool {
    if lock_hash == &ZERO32 {
        return false;
    }
    let mut i = 0usize;
    loop {
        match load_cell_lock_hash(i, Source::Input) {
            Ok(h) if &h == lock_hash => return true,
            Ok(_) => i += 1,
            Err(_) => return false,
        }
    }
}

/// Genesis: governance-authorized, fresh state, and an on-chain proof that `stake_token` is the LP
/// token of a CKB/xUDT pool.
fn verify_genesis(args: &Args) -> Result<(), Error> {
    let p = Pool::parse(&load_cell_data(0, Source::GroupOutput)?)?;
    if p.paused {
        return Err(Error::Paused);
    }
    if p.total_weight != 0 || p.acc != 0 {
        return Err(Error::GenesisInvalid);
    }
    if p.stake_token == ZERO32 {
        return Err(Error::GenesisInvalid);
    }
    if p.emission_per_epoch > MAX_EMISSION_PER_EPOCH {
        return Err(Error::GenesisInvalid);
    }
    let seed = pool_seed()?;
    check_type_id(&seed)?;
    if !authority_cosigns(&args.authority_lock_hash) {
        return Err(Error::GenesisUnauthorized);
    }
    verify_ckb_xudt_lp(args, &p.stake_token)
}

/// The pool_seed at args[161..193] (must be a CKB type-id, see verify_genesis).
fn pool_seed() -> Result<[u8; 32], Error> {
    let script = load_script().map_err(|_| Error::Sys)?;
    let raw = script.args();
    let a = raw.raw_data();
    if a.len() < 193 {
        return Err(Error::BadArgs);
    }
    let mut s = [0u8; 32];
    s.copy_from_slice(&a[161..193]);
    Ok(s)
}

/// Verify the canonical CKB type-id: `expected` == blake2b("ckb-default-hash", first_input ‖
/// output_index_of_this_cell_LE). Makes the mining pool's type hash globally unique.
fn check_type_id(expected: &[u8; 32]) -> Result<(), Error> {
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

/// Read the AMM info cell (a dep, identified by `pool_script_code_hash`), require it's a CKB/xUDT
/// pool, recompute its LP-token script hash, and require `stake_token` to equal it.
fn verify_ckb_xudt_lp(args: &Args, stake_token: &[u8; 32]) -> Result<(), Error> {
    let mut i = 0usize;
    loop {
        let ty = match load_cell_type(i, Source::CellDep) {
            Ok(t) => t,
            Err(SysError::IndexOutOfBound) => return Err(Error::NotCkbXudtLp),
            Err(_) => return Err(Error::Sys),
        };
        if let Some(ty) = ty {
            if ty.code_hash().as_slice() == &args.pool_script_code_hash[..] {
                let data = load_cell_data(i, Source::CellDep)?;
                if data.len() <= POOL_MODE_OFF || data[POOL_MODE_OFF] != POOL_MODE_CKB_NATIVE {
                    i += 1;
                    continue; // not a CKB/xUDT pool, keep looking
                }
                let info_type_hash = load_cell_type_hash(i, Source::CellDep)?.ok_or(Error::Sys)?;
                let lp_hash = lp_script_hash(args, &info_type_hash);
                if &lp_hash == stake_token {
                    return Ok(());
                }
            }
        }
        i += 1;
    }
}

/// Reconstruct the LP-token script for an AMM pool (args = the pool's info type hash) and hash it
/// with the ckb-default-hash personalization, yielding the LP token's type hash.
fn lp_script_hash(args: &Args, info_type_hash: &[u8; 32]) -> [u8; 32] {
    let code = Byte32::from_slice(&args.lp_token_code_hash).unwrap();
    let lp_args = info_type_hash[..].pack();
    let script = Script::new_builder()
        .code_hash(code)
        .hash_type(args.lp_token_hash_type.into())
        .args(lp_args)
        .build();
    let mut out = [0u8; 32];
    let mut b = blake2b_ref::Blake2bBuilder::new(32)
        .personal(b"ckb-default-hash")
        .build();
    b.update(script.as_slice());
    b.finalize(&mut out);
    out
}
