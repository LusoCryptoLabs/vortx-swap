#![no_std]
#![no_main]

//! Pool type script (info cell): AMM invariant over real custodied reserves, plus an optional
//! protocol fee (UniV2 `_mintFee`) that funds the staking/treasury system.
//!
//! Custody model (see ARCHITECTURE.md):
//!   A pool is a cell group:
//!     - this info cell (type = pool-script): tracks lp_supply/fee/pool_id/TWAP/mode/k_last
//!     - reserve cell X / Y: real xUDT cells (type = xUDT) locked by `pool-lock`,
//!       whose lock args = this info cell's own type-script hash.
//!   Reserves are read from the reserve cells, never self-reported in info data.
//!
//! Pool modes:
//!   0x00 = xUDT/xUDT: both reserves are reserve cells.
//!   0x01 = CKB/xUDT:  token_x is CKB → reserve_x = info capacity − MIN_POOL_CAPACITY.
//!
//! Protocol fee (`_mintFee`, optional):
//!   `k_last` (√k at the last collection) lives in info data. `k_last == 0` ⇒ fee switch off, and
//!   the pool behaves as a plain AMM (no treasury mint). When on, every
//!   liquidity event (add/remove) and the permissionless collect op first mint
//!   `lp_to_treasury = lpSupply·(√k − √k_last)/(√k·5 + √k_last)` LP to a treasury-locked LP cell
//!   (the protocol's 1/6 cut of fee growth), then advance `k_last = √k`. Swaps do not mint (fee
//!   accrues into k via the reserves and is captured at the next liquidity event). The fee switch
//!   is turned on by a treasury-authorized op that sets `k_last: 0 → √k` with reserves/supply
//!   unchanged.
//!
//! Info data layout (156 bytes):
//!   [0..32]    token_x_type_hash  (zero for CKB-native)
//!   [32..64]   token_y_type_hash
//!   [64..80]   lp_supply          (u128 LE)
//!   [80..82]   fee_bps            (u16 LE)
//!   [82..98]   pool_id            (u128 LE)
//!   [98..114]  cumulative_price_x (u128 LE)  TWAP
//!   [114..130] cumulative_price_y (u128 LE)
//!   [130..138] last_update_epoch  (u64 LE)
//!   [138]      pool_mode          (u8)
//!   [139]      paused             (u8)
//!   [140..156] k_last             (u128 LE)  √k at last fee collection; 0 = fee off
//!
//! Args (96 bytes):
//!   [0..32]   pool_lock_code_hash   identifies reserve cells (pool-lock)
//!   [32..64]  lp_token_code_hash    identifies the LP token (to locate the treasury's fee LP)
//!   [64..96]  treasury_lock_hash    where protocol-fee LP is minted (zero ⇒ fee can't be enabled)

use amm_math::{
    compute_lp_mint, compute_protocol_fee_lp, sqrt_k, verify_invariant, AmmError, BPS_DENOMINATOR,
    MINIMUM_LIQUIDITY,
};
use cell_utils::{check_min_capacity, read_u128, read_u16, read_u64, MIN_POOL_CAPACITY};
use ckb_std::{
    ckb_constants::Source,
    ckb_types::prelude::Entity,
    default_alloc, entry,
    error::SysError,
    high_level::{
        load_cell_capacity, load_cell_data, load_cell_lock, load_cell_lock_hash, load_cell_type,
        load_cell_type_hash, load_input, load_script, QueryIter,
    },
};
use ethnum::U256;

entry!(program_entry);
default_alloc!();

pub const POOL_DATA_SIZE: usize = 156;
pub const K_LAST_OFF: usize = 140;
pub const POOL_MODE_CKB_NATIVE: u8 = 0x01;
const ZERO32: [u8; 32] = [0u8; 32];

/// Canonical factory registry (on-chain one-pool-per-(pair,fee)). Pool creation must append
/// a matching entry to the factory singleton, identified here by the factory-script binary's ckb data
/// hash (the factory is deployed by data-hash, so this value == the on-chain factory cell's type
/// code_hash, and == the test's deployed factory data hash, keeping test == deploy). factory-script
/// runs on that same spend and enforces append-only + duplicate-(pair,fee) rejection, and its genesis is
/// governance-gated so exactly one canonical registry exists. Net: uniqueness is enforced on-chain while
/// pool creation stays permissionless (the factory uses a permissive lock; anyone may register).
/// Derived at build time from build/release/factory-script by build.rs (its CKB data hash), so the
/// constant cannot silently go stale: test == build == deploy by construction, on any toolchain.
/// A hand-written literal would drift whenever factory-script is recompiled.
/// factory-script must be built + staged before pool-script (the contract
/// build order / `make build` enforces this).
const FACTORY_CODE_HASH: [u8; 32] =
    include!(concat!(env!("OUT_DIR"), "/factory_code_hash_array.rs"));
const FACTORY_HEADER: usize = 81; // must match factory-script FactoryData header
const FACTORY_ENTRY_SIZE: usize = 90; // must match factory-script POOL_ENTRY_SIZE

#[repr(i8)]
enum Error {
    Sys = 1,
    InvalidPoolData = 2,
    InvariantViolation = 3,
    PoolPaused = 4,
    TypeHashMismatch = 5,
    FeeChanged = 6,
    PoolIdChanged = 7,
    InsufficientCapacity = 8,
    LpSupplyMismatch = 9,
    TwapInvalid = 10,
    UnexpectedCellCount = 11,
    InitialLiquidityLow = 12,
    ReserveCellMissing = 13,
    BadArgs = 14,
    KLastInvalid = 15,
    TreasuryShortfall = 16,
    FeeEnableUnauthorized = 17,
    SingleSidedLiquidity = 18,
    LpDeltaMismatch = 19,
    FeeBpsTooHigh = 20,
    FactoryMissing = 21,
    FactoryEntryMismatch = 22,
    CapacitySkim = 23,
}

impl From<SysError> for Error {
    fn from(_: SysError) -> Self {
        Error::Sys
    }
}
impl From<AmmError> for Error {
    fn from(e: AmmError) -> Self {
        match e {
            AmmError::InsufficientInitialLiquidity => Error::InitialLiquidityLow,
            _ => Error::InvariantViolation,
        }
    }
}

struct Args {
    pool_lock_code_hash: [u8; 32],
    lp_token_code_hash: [u8; 32],
    treasury_lock_hash: [u8; 32],
}

struct Info {
    token_x: [u8; 32],
    token_y: [u8; 32],
    lp_supply: u128,
    fee_bps: u16,
    pool_id: u128,
    cum_x: u128,
    cum_y: u128,
    last_epoch: u64,
    pool_mode: u8,
    paused: bool,
    k_last: u128,
    capacity: u64,
}

impl Info {
    fn parse(data: &[u8], cap: u64) -> Result<Self, Error> {
        if data.len() < POOL_DATA_SIZE {
            return Err(Error::InvalidPoolData);
        }
        let mut tx = [0u8; 32];
        let mut ty = [0u8; 32];
        tx.copy_from_slice(&data[0..32]);
        ty.copy_from_slice(&data[32..64]);
        Ok(Info {
            token_x: tx,
            token_y: ty,
            lp_supply: read_u128(data, 64).map_err(|_| Error::InvalidPoolData)?,
            fee_bps: read_u16(data, 80).map_err(|_| Error::InvalidPoolData)?,
            pool_id: read_u128(data, 82).map_err(|_| Error::InvalidPoolData)?,
            cum_x: read_u128(data, 98).map_err(|_| Error::InvalidPoolData)?,
            cum_y: read_u128(data, 114).map_err(|_| Error::InvalidPoolData)?,
            last_epoch: read_u64(data, 130).map_err(|_| Error::InvalidPoolData)?,
            pool_mode: data[138],
            paused: data[139] != 0,
            k_last: read_u128(data, K_LAST_OFF).map_err(|_| Error::InvalidPoolData)?,
            capacity: cap,
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
    let script = load_script()?;
    let args_raw = script.args();
    let a = args_raw.raw_data();
    if a.len() < 96 {
        return Err(Error::BadArgs);
    }
    let mut args = Args {
        pool_lock_code_hash: [0u8; 32],
        lp_token_code_hash: [0u8; 32],
        treasury_lock_hash: [0u8; 32],
    };
    args.pool_lock_code_hash.copy_from_slice(&a[0..32]);
    args.lp_token_code_hash.copy_from_slice(&a[32..64]);
    args.treasury_lock_hash.copy_from_slice(&a[64..96]);

    let in_count = QueryIter::new(load_cell_data, Source::GroupInput).count();
    let out_count = QueryIter::new(load_cell_data, Source::GroupOutput).count();
    if in_count > 1 || out_count > 1 {
        return Err(Error::UnexpectedCellCount);
    }
    if in_count == 0 && out_count == 1 {
        return verify_pool_creation(&args);
    }
    if in_count != 1 || out_count != 1 {
        return Err(Error::UnexpectedCellCount);
    }

    let in_cap = load_cell_capacity(0, Source::GroupInput)?;
    let out_cap = load_cell_capacity(0, Source::GroupOutput)?;
    let input = Info::parse(&load_cell_data(0, Source::GroupInput)?, in_cap)?;
    let output = Info::parse(&load_cell_data(0, Source::GroupOutput)?, out_cap)?;

    // Immutable fields.
    if input.token_x != output.token_x || input.token_y != output.token_y {
        return Err(Error::TypeHashMismatch);
    }
    if input.fee_bps != output.fee_bps {
        return Err(Error::FeeChanged);
    }
    if input.pool_id != output.pool_id {
        return Err(Error::PoolIdChanged);
    }
    if input.pool_mode != output.pool_mode {
        return Err(Error::TypeHashMismatch);
    }
    if input.paused {
        return Err(Error::PoolPaused);
    }
    // Unauthenticated permanent brick: `paused` is gated by no authority and the
    // swap/liquidity paths never constrain `output.paused`. If a spend could flip it 0→1, every
    // later op would fail the `input.paused` check above → the pool and all reserves custodied by
    // pool-lock are frozen forever. A spendable pool must therefore stay unpaused. (A governance
    // emergency pause would have to be authority-gated like the fee switch, never a free
    // field flip on a swap.)
    if output.paused {
        return Err(Error::PoolPaused);
    }
    // Forgeable TWAP: nothing here proves the cumulative-price accumulators equal
    // `cum += price·elapsed`, so if they were mutable any spend (swap, liquidity,
    // collect) could set them to arbitrary values,
    // poisoning anything that reads this pool's TWAP. Without a header-dep-enforced
    // accumulation, pin them: cum_x/cum_y are immutable on every spend, so they can't be forged;
    // an accumulator that never changes yields a constant (derivative-0), non-manipulable series.
    // last_epoch stays monotonic (the SDK bumps it to the tip epoch; harmless with cum pinned).
    if output.cum_x != input.cum_x || output.cum_y != input.cum_y {
        return Err(Error::TwapInvalid);
    }
    if output.last_epoch < input.last_epoch {
        return Err(Error::TwapInvalid);
    }

    check_min_capacity(0, Source::GroupOutput, MIN_POOL_CAPACITY)
        .map_err(|_| Error::InsufficientCapacity)?;

    // Permissionless rent skim: for an xUDT/xUDT pool both
    // reserves live in separate reserve cells, so the info cell's CKB capacity is pure rent and nothing
    // above binds it across a spend. Anyone spending the permissively-locked info cell could recreate it
    // at a lower capacity and pocket the surplus once (no token/LP/principal at risk, but real CKB).
    // Conserve the rent: a mode-0 info cell's capacity must never decrease.
    // CKB-native pools carry reserveX in this capacity (bound by the AMM invariant / liquidity math
    // below), so the gate is mode-0 only. Every SDK flow recreates a mode-0 info cell at its exact input
    // capacity, so this never rejects an honest tx. pool_mode is pinned immutable above.
    if input.pool_mode != POOL_MODE_CKB_NATIVE && out_cap < in_cap {
        return Err(Error::CapacitySkim);
    }

    let self_type_hash =
        load_cell_type_hash(0, Source::GroupInput)?.ok_or(Error::TypeHashMismatch)?;

    let (rx_in, ry_in) = read_reserves(
        &input,
        &args.pool_lock_code_hash,
        &self_type_hash,
        Source::Input,
    )?;
    let (rx_out, ry_out) = read_reserves(
        &output,
        &args.pool_lock_code_hash,
        &self_type_hash,
        Source::Output,
    )?;

    // Dispatch by reserve direction (robust to the protocol-fee mint, which changes lp_supply on
    // liquidity events): both up = add, both down = remove, one-each = swap, unchanged = collect.
    let x_up = rx_out > rx_in;
    let x_dn = rx_out < rx_in;
    let y_up = ry_out > ry_in;
    let y_dn = ry_out < ry_in;

    if (x_up && y_dn) || (x_dn && y_up) {
        // Swap: no fee mint; lp_supply and k_last carried forward unchanged.
        if output.lp_supply != input.lp_supply {
            return Err(Error::LpSupplyMismatch);
        }
        if output.k_last != input.k_last {
            return Err(Error::KLastInvalid);
        }
        verify_invariant(rx_in, ry_in, rx_out, ry_out, input.fee_bps)?;
        // TWAP accumulators are pinned in the common path above, so no extra check here.
        return Ok(());
    }

    if x_up && y_up {
        return verify_liquidity_event(
            &args,
            &input,
            &output,
            rx_in,
            ry_in,
            rx_out,
            ry_out,
            &self_type_hash,
            true,
        );
    }
    if x_dn && y_dn {
        return verify_liquidity_event(
            &args,
            &input,
            &output,
            rx_in,
            ry_in,
            rx_out,
            ry_out,
            &self_type_hash,
            false,
        );
    }
    if !x_up && !x_dn && !y_up && !y_dn {
        // Reserves unchanged: a fee collect (sweep) or the fee-enable op.
        return verify_reserves_unchanged(&args, &input, &output, rx_in, ry_in, &self_type_hash);
    }
    // One side changed, the other didn't: single-sided liquidity is not allowed.
    Err(Error::SingleSidedLiquidity)
}

/// Add (`is_add`) or remove liquidity, applying the protocol fee first.
#[allow(clippy::too_many_arguments)]
fn verify_liquidity_event(
    args: &Args,
    input: &Info,
    output: &Info,
    rx_in: u128,
    ry_in: u128,
    rx_out: u128,
    ry_out: u128,
    self_type_hash: &[u8; 32],
    is_add: bool,
) -> Result<(), Error> {
    let fee_on = input.k_last != 0;
    let root_k_in = sqrt_k(rx_in, ry_in);
    let lp_to_treasury = if fee_on {
        compute_protocol_fee_lp(input.lp_supply, root_k_in, input.k_last)
    } else {
        0
    };
    // Supply after the protocol mint, before the user's own add/remove (UniV2 ordering).
    let intermediate = input
        .lp_supply
        .checked_add(lp_to_treasury)
        .ok_or(Error::LpSupplyMismatch)?;

    // k_last advances to the new √k when fee is on; stays 0 when off.
    let expected_k_last = if fee_on { sqrt_k(rx_out, ry_out) } else { 0 };
    if output.k_last != expected_k_last {
        return Err(Error::KLastInvalid);
    }

    // Unauthenticated pool drain: the info cell's self-reported
    // `lp_supply` is not trustworthy on its own. The real "burn LP to withdraw / mint LP to deposit"
    // rule lives in the lp-token type script, which only runs if an lp-token cell is present in the
    // tx. An attacker could omit all lp-token cells, set output.lp_supply = 0 on a remove, and drain
    // 100% of both reserves having burned zero LP (the info cell uses a permissive lock, so anyone
    // can spend it). Bind the recorded supply to real circulating LP here, inside pool-script, which
    // is guaranteed to run: the net change in this pool's lp-token cells (Σ outputs − Σ inputs) must
    // equal the net change in lp_supply. With no lp-token cell present both totals are 0, so lp_supply
    // cannot change → the drain (and the mirror add-side inflation) is rejected. This is the same
    // equation lp-token enforces (out_sum − in_sum == Δlp_supply), so it never rejects a legitimate
    // add/remove; it only additionally requires that lp-token participates. Holds for fee-on too:
    // the treasury's fee LP is also an lp-token cell of this pool, so it is counted on both sides.
    let lp_in = lp_circulating_total(Source::Input, args, self_type_hash)?;
    let lp_out = lp_circulating_total(Source::Output, args, self_type_hash)?;
    // lp_out − lp_in == output.lp_supply − input.lp_supply, rearranged to stay in unsigned u128:
    let lhs = lp_out
        .checked_add(input.lp_supply)
        .ok_or(Error::LpDeltaMismatch)?;
    let rhs = lp_in
        .checked_add(output.lp_supply)
        .ok_or(Error::LpDeltaMismatch)?;
    if lhs != rhs {
        return Err(Error::LpDeltaMismatch);
    }

    if is_add {
        let dx = rx_out - rx_in;
        let dy = ry_out - ry_in;
        if dx == 0 || dy == 0 {
            return Err(Error::InvariantViolation);
        }
        let (expected_user_lp, _) = compute_lp_mint(dx, dy, rx_in, ry_in, intermediate)?;
        if output.lp_supply < intermediate {
            return Err(Error::LpSupplyMismatch);
        }
        let user_lp = output.lp_supply - intermediate;
        // Rounding favors the pool: minted may not exceed what the deposit earns.
        if user_lp > expected_user_lp {
            return Err(Error::LpSupplyMismatch);
        }
    } else {
        let dx = rx_in - rx_out;
        let dy = ry_in - ry_out;
        if intermediate == 0 {
            return Err(Error::LpSupplyMismatch);
        }
        if output.lp_supply > intermediate {
            return Err(Error::LpSupplyMismatch);
        }
        let lp_burned = intermediate - output.lp_supply;
        // Withdrawal may not exceed the proportional share of the post-fee supply.
        let max_x = U256::from(rx_in) * U256::from(lp_burned) / U256::from(intermediate);
        let max_y = U256::from(ry_in) * U256::from(lp_burned) / U256::from(intermediate);
        if U256::from(dx) > max_x || U256::from(dy) > max_y {
            return Err(Error::LpSupplyMismatch);
        }
    }

    verify_treasury_mint(args, self_type_hash, lp_to_treasury)
}

/// Reserves unchanged: either a permissionless fee collect (fee on) or the fee-enable op (fee off).
fn verify_reserves_unchanged(
    args: &Args,
    input: &Info,
    output: &Info,
    rx: u128,
    ry: u128,
    self_type_hash: &[u8; 32],
) -> Result<(), Error> {
    let root_k = sqrt_k(rx, ry);
    if input.k_last == 0 {
        // Fee enable: 0 → √k, supply unchanged, no mint; requires treasury authority co-sign.
        if output.k_last != root_k {
            return Err(Error::KLastInvalid);
        }
        if output.lp_supply != input.lp_supply {
            return Err(Error::LpSupplyMismatch);
        }
        if !authority_cosigns(&args.treasury_lock_hash) {
            return Err(Error::FeeEnableUnauthorized);
        }
        return Ok(());
    }
    // Collect: mint the accrued protocol fee, advance k_last; reserves + (other) state unchanged.
    let lp_to_treasury = compute_protocol_fee_lp(input.lp_supply, root_k, input.k_last);
    let intermediate = input
        .lp_supply
        .checked_add(lp_to_treasury)
        .ok_or(Error::LpSupplyMismatch)?;
    if output.lp_supply != intermediate {
        return Err(Error::LpSupplyMismatch);
    }
    // k_last must be monotonic non-decreasing. compute_protocol_fee_lp mints 0
    // when root_k <= k_last, so a collect at a transient lower root_k would mint nothing yet ratchet
    // k_last down, letting the treasury later over-mint "phantom fee" as price recovers (root_k −
    // k_last would then capture the recovery, not just real trading fees). Pin k_last to the maximum of
    // its prior value and the current root_k so it can only ever advance, matching UniV2's kLast.
    let new_k_last = if root_k > input.k_last {
        root_k
    } else {
        input.k_last
    };
    if output.k_last != new_k_last {
        return Err(Error::KLastInvalid);
    }
    verify_treasury_mint(args, self_type_hash, lp_to_treasury)
}

/// Require the treasury's LP balance to grow by at least `lp_to_treasury` (its fee cut). A treasury
/// LP cell = locked by `treasury_lock_hash`, typed by the LP token (code hash + args = this pool).
fn verify_treasury_mint(
    args: &Args,
    self_type_hash: &[u8; 32],
    lp_to_treasury: u128,
) -> Result<(), Error> {
    if lp_to_treasury == 0 {
        return Ok(());
    }
    let t_in = treasury_lp_total(Source::Input, args, self_type_hash)?;
    let t_out = treasury_lp_total(Source::Output, args, self_type_hash)?;
    // Load-bearing cross-contract invariant: this is a
    // `>=` (not `==`) lower bound; it only guarantees the treasury receives at least its fee cut. The
    // reason an attacker can't over-mint LP to the treasury is that the lp-token type script separately
    // pins the total LP minted in the tx to the pool's lp_supply delta (lp-token verifies
    // out_sum - in_sum == Δlp_supply), and the collect branch pins that delta to exactly lp_to_treasury.
    // So the bound here is correct only in conjunction with lp-token's exact-delta check. If that check
    // were ever weakened, this `>=` would permit an over-mint. Keep the two in lockstep.
    if t_out < t_in.saturating_add(lp_to_treasury) {
        return Err(Error::TreasuryShortfall);
    }
    Ok(())
}

/// Sum the LP amounts in treasury-locked LP cells (this pool's LP) on `source`.
fn treasury_lp_total(
    source: Source,
    args: &Args,
    self_type_hash: &[u8; 32],
) -> Result<u128, Error> {
    let mut total: u128 = 0;
    let mut i = 0usize;
    loop {
        let lh = match load_cell_lock_hash(i, source) {
            Ok(h) => h,
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(Error::Sys),
        };
        if lh == args.treasury_lock_hash {
            if let Ok(Some(ty)) = load_cell_type(i, source) {
                let same_code = ty.code_hash().as_slice() == &args.lp_token_code_hash[..];
                let same_args = ty.args().raw_data().as_ref() == &self_type_hash[..];
                if same_code && same_args {
                    let data = load_cell_data(i, source)?;
                    total = total
                        .saturating_add(read_u128(&data, 0).map_err(|_| Error::InvalidPoolData)?);
                }
            }
        }
        i += 1;
    }
    Ok(total)
}

/// Sum the LP amounts across all lp-token cells bound to this pool on `source` (lock-agnostic: it
/// counts every holder's LP, unlike `treasury_lp_total` which filters to the treasury lock). An
/// lp-token cell of this pool = type.code_hash == args.lp_token_code_hash and type.args == this
/// pool's own type hash (the lp-token owner binding). Used to bind the info cell's self-reported
/// `lp_supply` to the real circulating LP supply on every liquidity event.
fn lp_circulating_total(
    source: Source,
    args: &Args,
    self_type_hash: &[u8; 32],
) -> Result<u128, Error> {
    let mut total: u128 = 0;
    let mut i = 0usize;
    loop {
        match load_cell_type(i, source) {
            Ok(Some(ty)) => {
                let same_code = ty.code_hash().as_slice() == &args.lp_token_code_hash[..];
                let same_args = ty.args().raw_data().as_ref() == &self_type_hash[..];
                if same_code && same_args {
                    let data = load_cell_data(i, source)?;
                    total = total
                        .saturating_add(read_u128(&data, 0).map_err(|_| Error::InvalidPoolData)?);
                }
            }
            Ok(None) => {}
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(Error::Sys),
        }
        i += 1;
    }
    Ok(total)
}

/// True if any input is unlocked by `lock_hash` (governance co-sign for enabling the fee switch).
fn authority_cosigns(lock_hash: &[u8; 32]) -> bool {
    if lock_hash == &ZERO32 {
        return false; // no treasury configured ⇒ fee can never be enabled
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

/// Read (reserve_x, reserve_y) for the pool from the real reserve cells.
/// CKB-native mode: reserve_x = info capacity − MIN_POOL_CAPACITY.
///
/// Full-pool drain: `pool-lock` allows spending any
/// cell whose lock args == this info cell's type hash, as long as the info cell is present in/out.
/// Reading only the first matching reserve cell per token would let an attacker
/// add a decoy reserve cell, get the AMM invariant checked against the decoy, and route the
/// real reserve out for free. So this does a single pass and requires exactly the expected reserve set:
/// one cell for token_y, plus one for token_x in xUDT/xUDT mode, and rejects any other pool-lock
/// cell bound to this pool (a second same-token cell, or a wrong-token donation). There is no
/// summing: the canonical form is exactly one reserve cell per token, so duplicates are an error.
fn read_reserves(
    info: &Info,
    pool_lock_code_hash: &[u8; 32],
    self_type_hash: &[u8; 32],
    source: Source,
) -> Result<(u128, u128), Error> {
    let ckb_native = info.pool_mode == POOL_MODE_CKB_NATIVE;
    if ckb_native && info.token_x != ZERO32 {
        return Err(Error::TypeHashMismatch);
    }
    let mut rx: Option<u128> = None;
    let mut ry: Option<u128> = None;
    let mut i = 0usize;
    loop {
        let lock = match load_cell_lock(i, source) {
            Ok(l) => l,
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(Error::Sys),
        };
        let is_pool_lock = lock.code_hash().as_slice() == &pool_lock_code_hash[..]
            && lock.args().raw_data().as_ref() == &self_type_hash[..];
        if is_pool_lock {
            // Every pool-lock cell bound to this pool must be a recognized reserve cell. A cell with
            // no type (CKB), or a type matching neither token, is a decoy/wrong-token donation.
            let th = load_cell_type_hash(i, source)?.ok_or(Error::UnexpectedCellCount)?;
            let data = load_cell_data(i, source)?;
            if data.len() < 16 {
                return Err(Error::InvalidPoolData);
            }
            let amount = read_u128(&data, 0).map_err(|_| Error::InvalidPoolData)?;
            if !ckb_native && th == info.token_x {
                if rx.is_some() {
                    return Err(Error::UnexpectedCellCount); // duplicate token_x reserve
                }
                rx = Some(amount);
            } else if th == info.token_y {
                if ry.is_some() {
                    return Err(Error::UnexpectedCellCount); // duplicate token_y reserve
                }
                ry = Some(amount);
            } else {
                return Err(Error::UnexpectedCellCount); // pool-lock cell that is not a reserve
            }
        }
        i += 1;
    }
    let ry = ry.ok_or(Error::ReserveCellMissing)?;
    let rx = if ckb_native {
        (info.capacity.saturating_sub(MIN_POOL_CAPACITY)) as u128
    } else {
        rx.ok_or(Error::ReserveCellMissing)?
    };
    Ok((rx, ry))
}

fn verify_pool_creation(args: &Args) -> Result<(), Error> {
    // Cross-pool LP drain: the info cell's type hash is treated as
    // the pool's unforgeable identity by pool-lock (reserve custody), read_reserves, and lp-token (LP
    // args = info type hash). If two pools could share a type hash, their LP tokens would be the same
    // fungible xUDT, letting cheap LP minted from a junk twin pool redeem against a valuable pool and
    // drain it. So the info cell is a true CKB type-id: the pool args carry a 32-byte type-id at
    // [96..128] that must equal blake2b("ckb-default-hash", first_input ‖ output_index), globally
    // unique per genesis (an outpoint is consumed once). Enforced only at creation; the spend path
    // does not re-check it, and no twin of an existing pool can be created (creation needs 128B args).
    let script = load_script()?;
    let raw = script.args();
    let a = raw.raw_data();
    if a.len() < 128 {
        return Err(Error::BadArgs);
    }
    let mut type_id = [0u8; 32];
    type_id.copy_from_slice(&a[96..128]);
    check_type_id(&type_id)?;

    let cap = load_cell_capacity(0, Source::GroupOutput)?;
    let output = Info::parse(&load_cell_data(0, Source::GroupOutput)?, cap)?;
    // A pool must be born unpaused: a paused pool can never be spent, so allowing creation in
    // a paused state would mint a dead-on-arrival pool with locked reserves.
    if output.paused {
        return Err(Error::PoolPaused);
    }
    if output.lp_supply < MINIMUM_LIQUIDITY {
        return Err(Error::InitialLiquidityLow);
    }
    // fee_bps wrap drain: fee_bps is pinned immutable across spends, so bound it
    // once at creation. amm-math computes `denom - fee` in ethnum U256; with
    // fee_bps >= BPS_DENOMINATOR that underflows (the release build's overflow-checks does not cover
    // ethnum's custom Sub, which only panics under debug_assertions), so verify_invariant would
    // accept a near-total drain. Bound it here so the invariant arithmetic is provably non-negative.
    if output.fee_bps as u32 >= BPS_DENOMINATOR {
        return Err(Error::FeeBpsTooHigh);
    }
    check_min_capacity(0, Source::GroupOutput, MIN_POOL_CAPACITY)
        .map_err(|_| Error::InsufficientCapacity)?;

    let self_type_hash =
        load_cell_type_hash(0, Source::GroupOutput)?.ok_or(Error::TypeHashMismatch)?;
    let (rx, ry) = read_reserves(
        &output,
        &args.pool_lock_code_hash,
        &self_type_hash,
        Source::Output,
    )?;
    if rx == 0 || ry == 0 {
        return Err(Error::ReserveCellMissing);
    }

    let (expected_lp, _) = compute_lp_mint(rx, ry, 0, 0, 0)?;
    if output.lp_supply > expected_lp + MINIMUM_LIQUIDITY + 1 {
        return Err(Error::LpSupplyMismatch);
    }
    // Enforce the MINIMUM_LIQUIDITY lock on-chain: the inflation guard is only
    // real if the locked 1000 is permanently unredeemable. Require the circulating LP actually minted
    // (the sum of this pool's lp-token cells) to be exactly lp_supply - MINIMUM_LIQUIDITY, so the 1000
    // has no backing cell and can never be burned. The LP delta check on every later liquidity event
    // then preserves circulating == lp_supply - MINIMUM_LIQUIDITY by induction, pinning
    // lp_supply >= MINIMUM_LIQUIDITY forever (circulating is a sum of u128 cell amounts, always >= 0).
    let lp_circ = lp_circulating_total(Source::Output, args, &self_type_hash)?;
    if lp_circ
        .checked_add(MINIMUM_LIQUIDITY)
        .ok_or(Error::LpSupplyMismatch)?
        != output.lp_supply
    {
        return Err(Error::LpSupplyMismatch);
    }
    // A fresh pool may start with the fee off (k_last = 0) or already on (k_last = √k of its
    // initial reserves); any other value is a phantom fee snapshot.
    if output.k_last != 0 && output.k_last != sqrt_k(rx, ry) {
        return Err(Error::KLastInvalid);
    }
    // On-chain one-pool-per-(pair,fee): bind this creation to the canonical
    // factory registry. Done last so cheaper structural checks fail first.
    verify_factory_registration(&output)?;
    Ok(())
}

/// Require this pool is registered in the canonical factory singleton. The factory cell (type
/// code_hash == FACTORY_CODE_HASH) must be spent (input) and recreated (output) with exactly one
/// appended registry entry that names this pool (pool_id, token_x, token_y, fee_bps). factory-script
/// runs on that same spend and guarantees the append is duplicate-free + append-only over a
/// governance-gated singleton; binding here makes uniqueness enforced on-chain while keeping creation
/// permissionless (the factory uses a permissive lock: anyone may register, the math rejects dups).
fn verify_factory_registration(info: &Info) -> Result<(), Error> {
    let fi = find_single_factory(Source::Input)?.ok_or(Error::FactoryMissing)?;
    let fo = find_single_factory(Source::Output)?.ok_or(Error::FactoryMissing)?;
    let in_data = load_cell_data(fi, Source::Input)?;
    let out_data = load_cell_data(fo, Source::Output)?;
    if in_data.len() < FACTORY_HEADER || out_data.len() < FACTORY_HEADER {
        return Err(Error::FactoryMissing);
    }
    let prev = (in_data.len() - FACTORY_HEADER) / FACTORY_ENTRY_SIZE;
    let new = (out_data.len() - FACTORY_HEADER) / FACTORY_ENTRY_SIZE;
    if new != prev + 1 {
        return Err(Error::FactoryEntryMismatch);
    }
    let off = FACTORY_HEADER + prev * FACTORY_ENTRY_SIZE;
    if out_data.len() < off + 82 {
        return Err(Error::FactoryEntryMismatch);
    }
    let pid = read_u128(&out_data, off).map_err(|_| Error::FactoryEntryMismatch)?;
    let fee = u16::from_le_bytes([out_data[off + 80], out_data[off + 81]]);
    // CKB-native pools carry token_x == ZERO32, which is exactly what the SDK writes into the entry.
    if pid != info.pool_id
        || out_data[off + 16..off + 48] != info.token_x
        || out_data[off + 48..off + 80] != info.token_y
        || fee != info.fee_bps
    {
        return Err(Error::FactoryEntryMismatch);
    }
    Ok(())
}

/// Find the single cell on `source` whose type code_hash == FACTORY_CODE_HASH. Returns its index, or
/// None if absent; rejects (FactoryEntryMismatch) if more than one factory-typed cell is present (a
/// decoy second registry).
fn find_single_factory(source: Source) -> Result<Option<usize>, Error> {
    let mut found: Option<usize> = None;
    let mut i = 0usize;
    loop {
        match load_cell_type(i, source) {
            Ok(Some(ty)) => {
                if ty.code_hash().as_slice() == &FACTORY_CODE_HASH[..] {
                    if found.is_some() {
                        return Err(Error::FactoryEntryMismatch);
                    }
                    found = Some(i);
                }
            }
            Ok(None) => {}
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(Error::Sys),
        }
        i += 1;
    }
    Ok(found)
}

/// Verify the canonical CKB type-id: `expected` must equal
/// blake2b("ckb-default-hash", first_input_CellInput ‖ output_index_of_this_cell_LE). This makes the
/// pool info cell's type hash globally unique (an input outpoint is consumed at most once).
fn check_type_id(expected: &[u8; 32]) -> Result<(), Error> {
    let self_hash = load_cell_type_hash(0, Source::GroupOutput)?.ok_or(Error::TypeHashMismatch)?;
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
    let out_index = out_index.ok_or(Error::TypeHashMismatch)?;
    let first_input = load_input(0, Source::Input).map_err(|_| Error::BadArgs)?;
    let mut ret = [0u8; 32];
    let mut blake = blake2b_ref::Blake2bBuilder::new(32)
        .personal(b"ckb-default-hash")
        .build();
    blake.update(first_input.as_slice());
    blake.update(&(out_index as u64).to_le_bytes());
    blake.finalize(&mut ret);
    if &ret != expected {
        return Err(Error::BadArgs);
    }
    Ok(())
}
