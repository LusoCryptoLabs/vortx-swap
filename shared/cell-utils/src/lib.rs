#![no_std]
//! Shared cell validation utilities for all CellSwap contracts.

use ckb_std::{
    ckb_constants::Source,
    error::SysError,
    high_level::{load_cell_capacity, load_cell_data},
};

// Pool info cell floor. The info cell occupies ~378 CKB (128-byte type-id args
// + 156B data + permissive lock), so the floor must sit above the true occupied size.
// For a CKB-native pool reserveX = capacity - MIN_POOL_CAPACITY, so a floor below
// occupied mis-prices un-withdrawable rent as reserve and lets the contract permit
// a final removal the node then rejects. 400 CKB sits safely above occupied, so
// reserveX never includes occupied rent.
pub const MIN_POOL_CAPACITY: u64 = 40_000_000_000; // 400 CKB in shannons
pub const MIN_CELL_CAPACITY: u64 = 6_100_000_000; // 61 CKB

/// Read u128 little-endian from cell data at offset
pub fn read_u128(data: &[u8], offset: usize) -> Result<u128, SysError> {
    if data.len() < offset + 16 {
        return Err(SysError::Encoding);
    }
    let mut buf = [0u8; 16];
    buf.copy_from_slice(&data[offset..offset + 16]);
    Ok(u128::from_le_bytes(buf))
}

/// Read u64 little-endian from cell data at offset
pub fn read_u64(data: &[u8], offset: usize) -> Result<u64, SysError> {
    if data.len() < offset + 8 {
        return Err(SysError::Encoding);
    }
    let mut buf = [0u8; 8];
    buf.copy_from_slice(&data[offset..offset + 8]);
    Ok(u64::from_le_bytes(buf))
}

/// Read u16 little-endian from cell data at offset
pub fn read_u16(data: &[u8], offset: usize) -> Result<u16, SysError> {
    if data.len() < offset + 2 {
        return Err(SysError::Encoding);
    }
    let mut buf = [0u8; 2];
    buf.copy_from_slice(&data[offset..offset + 2]);
    Ok(u16::from_le_bytes(buf))
}

/// Check that a cell's capacity meets the minimum
pub fn check_min_capacity(index: usize, source: Source, min: u64) -> Result<(), SysError> {
    let cap = load_cell_capacity(index, source)?;
    if cap < min {
        return Err(SysError::Encoding); // reuse as "invalid capacity"
    }
    Ok(())
}

/// Get xUDT amount from cell data (first 16 bytes, little-endian u128)
pub fn get_xudt_amount(index: usize, source: Source) -> Result<u128, SysError> {
    let data = load_cell_data(index, source)?;
    read_u128(&data, 0)
}

/// Parse (min_amount_out, token_out, owner_lock_hash) from a cellswap-otx-lock `witness.lock`.
///
/// Layout: sig(64) || pubkey(64) || auth_len(4 LE) || auth || client_len(4 LE) || client || intent(120)
///   intent = min_amount_out(16) || token_out(32) || owner_lock_hash(32) || token_in(32) || deadline(8)
///
/// Returns None if the witness is not that shape. This is the single source of truth for the OTX
/// witness intent shape: cellswap-otx-lock (the lock itself) and intent-lock (its cross-contract
/// demand sum) both call it, so the two can never drift out of sync. The returned
/// slices borrow from `w`.
pub fn parse_otx_intent(w: &[u8]) -> Option<(u128, &[u8], &[u8])> {
    if w.len() < 132 {
        return None;
    }
    let auth_len = u32::from_le_bytes(w[128..132].try_into().ok()?) as usize;
    let auth_end = 132usize.checked_add(auth_len)?;
    if w.len() < auth_end.checked_add(4)? {
        return None;
    }
    let client_len = u32::from_le_bytes(w[auth_end..auth_end + 4].try_into().ok()?) as usize;
    let client_end = auth_end.checked_add(4)?.checked_add(client_len)?;
    if w.len() < client_end.checked_add(120)? {
        return None;
    }
    let intent = &w[client_end..client_end + 120];
    let min = u128::from_le_bytes(intent[0..16].try_into().ok()?);
    Some((min, &intent[16..48], &intent[48..80]))
}
