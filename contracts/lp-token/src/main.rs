#![no_std]
#![no_main]

//! LP token: xUDT-compatible liquidity provider token.
//!
//! Minting and burning are controlled by the pool: LP tokens can only be
//! created or destroyed in a transaction that also consumes/creates the
//! matching pool cell. This prevents forging LP tokens to drain the pool.
//!
//! Args (32 bytes): pool_type_hash, the pool this LP token belongs to
//!
//! Behavior:
//!   - Transfer (inputs == outputs): standard conservation, no pool needed
//!   - Mint (outputs > inputs): pool lp_supply must increase by exactly that amount
//!   - Burn (inputs > outputs): pool lp_supply must decrease by exactly that amount

use cell_utils::read_u128;
use ckb_std::{
    ckb_constants::Source,
    default_alloc, entry,
    error::SysError,
    high_level::{load_cell_data, load_cell_type_hash, load_script, QueryIter},
};

entry!(program_entry);
default_alloc!();

const POOL_LP_SUPPLY_OFF: usize = 64; // lp_supply lives at info data [64..80] (pool-script layout)
                                      // Prefix-min guard for locating the pool info cell. lp-token reads only lp_supply at [64..80],
                                      // which sits inside the reserves-removed [0..140] prefix, so it does not need the k_last fee tail
                                      // that pool-script appends at [140..156]. Keeping this at 140 (matching the SDK's POOL_DATA_MIN and
                                      // the shared codec prefix) lets lp-token still read legacy pre-fee 140-byte pool cells.
const POOL_DATA_SIZE: usize = 140;
// Locked forever on first deposit. Must match amm_math::MINIMUM_LIQUIDITY and the
// pool-script genesis check: at pool creation the circulating LP minted = lp_supply - this.
const MINIMUM_LIQUIDITY: u128 = 1_000;

#[repr(i8)]
enum Error {
    Sys = 1,
    InvalidArgs = 2,
    InvalidAmount = 3,
    SupplyMismatch = 4,
    PoolNotFound = 5,
    UnauthorizedMint = 6,
    UnauthorizedBurn = 7,
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
    // Require exactly 32-byte args. pool-script's LP-supply accounting counts an LP cell
    // only when its args equal the pool type hash with exact 32-byte equality (`==`). If this script
    // accepted any args.len() >= 32, a 33-byte-args LP cell (pool_hash ‖ 0xNN) would be a
    // valid, mintable/burnable token here yet uncounted there. Both scripts
    // must define "a valid LP cell" identically; pin it to 32 bytes on both sides.
    if args_raw.len() != 32 {
        return Err(Error::InvalidArgs);
    }
    let mut pool_type_hash = [0u8; 32];
    pool_type_hash.copy_from_slice(&args_raw[0..32]);

    let input_sum = sum_group_amounts(Source::GroupInput)?;
    let output_sum = sum_group_amounts(Source::GroupOutput)?;

    if input_sum == output_sum {
        return Ok(());
    } // plain transfer

    let pool_in_opt = find_pool_supply(Source::Input, &pool_type_hash)?;
    let pool_out_opt = find_pool_supply(Source::Output, &pool_type_hash)?;
    if pool_in_opt.is_none() && pool_out_opt.is_none() {
        return Err(Error::PoolNotFound);
    }
    let pool_in = pool_in_opt.unwrap_or(0);
    let pool_out = pool_out_opt.unwrap_or(0);

    if output_sum > input_sum {
        let minted = output_sum - input_sum;
        // Genesis: the pool is being created (no input pool cell). MINIMUM_LIQUIDITY is
        // locked-unminted, so the circulating LP minted must be exactly lp_supply - MINIMUM_LIQUIDITY.
        // This leaves the locked 1000 with no backing cell, so it can never be redeemed.
        if pool_in_opt.is_none() {
            let expected = pool_out
                .checked_sub(MINIMUM_LIQUIDITY)
                .ok_or(Error::SupplyMismatch)?;
            if minted != expected {
                return Err(Error::SupplyMismatch);
            }
            return Ok(());
        }
        if pool_out < pool_in {
            return Err(Error::UnauthorizedMint);
        }
        if pool_out - pool_in != minted {
            return Err(Error::SupplyMismatch);
        }
    } else {
        let burned = input_sum - output_sum;
        if pool_in < pool_out {
            return Err(Error::UnauthorizedBurn);
        }
        if pool_in - pool_out != burned {
            return Err(Error::SupplyMismatch);
        }
    }
    Ok(())
}

fn sum_group_amounts(source: Source) -> Result<u128, Error> {
    let mut total: u128 = 0;
    for data in QueryIter::new(load_cell_data, source) {
        if data.len() < 16 {
            return Err(Error::InvalidAmount);
        }
        let amount = read_u128(&data, 0).map_err(|_| Error::InvalidAmount)?;
        total = total.checked_add(amount).ok_or(Error::InvalidAmount)?;
    }
    Ok(total)
}

fn find_pool_supply(source: Source, pool_type_hash: &[u8; 32]) -> Result<Option<u128>, Error> {
    let mut i = 0usize;
    loop {
        match load_cell_type_hash(i, source) {
            Ok(Some(th)) if &th == pool_type_hash => {
                let data = load_cell_data(i, source)?;
                if data.len() < POOL_DATA_SIZE {
                    return Err(Error::PoolNotFound);
                }
                let supply =
                    read_u128(&data, POOL_LP_SUPPLY_OFF).map_err(|_| Error::PoolNotFound)?;
                return Ok(Some(supply));
            }
            Ok(_) => {}
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => break,
        }
        i += 1;
    }
    Ok(None)
}
