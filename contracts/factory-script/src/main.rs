#![no_std]
#![no_main]

use cell_utils::read_u128;
use ckb_std::{
    ckb_constants::Source,
    ckb_types::prelude::Entity,
    default_alloc, entry,
    error::SysError,
    high_level::{
        load_cell_capacity, load_cell_data, load_cell_lock_hash, load_cell_type_hash, load_input,
        load_script, QueryIter,
    },
};

entry!(program_entry);
default_alloc!();

#[repr(i8)]
enum Error {
    Sys = 1,
    InvalidData = 2,
    DuplicatePool = 3,
    InvalidPoolId = 4,
    Unauthorized = 5,
    Tampered = 6,
}

/// FactoryData layout:
/// [0..16]   next_pool_id      (u128 LE)
/// [16..48]  pool_script_hash  (bytes32)
/// [48..80]  pause_authority   (lock_hash bytes32)
/// [80]      global_paused     (u8)
/// [81..]    pool entries, each POOL_ENTRY_SIZE bytes:
///
/// Scope of `global_paused`: this flag gates only operations that spend the
/// factory cell, i.e. new pool creation. It is not a trading kill-switch: `pool-script` authorizes
/// swaps without referencing the factory, so existing pools keep trading even when global_paused==1.
/// The per-pool `paused` byte (AMM info cell, offset 139) is the swap-level pause. Making this a true
/// global trading halt would require pool-script to consult the factory as a cell-dep, which changes
/// pool-script's args/code hash and would orphan deployed pools.
///           [0..16]  pool_id         (u128 LE)
///           [16..48] token_x_type_hash
///           [48..80] token_y_type_hash
///           [80..82] fee_bps         (u16 LE)
///           [82..90] reserved
const FACTORY_HEADER: usize = 81;
const POOL_ENTRY_SIZE: usize = 90;

/// Governance authority lock hash, pinned on-chain. The one-time factory genesis (the
/// singleton-creation path) must be co-signed by this lock, so exactly one canonical registry can ever
/// exist (pool-script binds pool creation to the canonical factory by its baked data hash, and that
/// binding is only meaningful if an attacker cannot stand up a second factory with attacker-set
/// entries). This gates genesis only: appending a pool and pausing stay permissionless by design
/// (anyone may spend the permissive-locked factory to register, factory math rejects duplicates), so
/// pool creation remains permissionless. The testnet value is the governance/deployer lock (0x7a71afd7…),
/// the same authority token-registry/emission-lock/stake-pool pin.
/// For mainnet, rebuild with the mainnet governance multisig lock hash before deploying. This is a
/// testnet-specific value: unlike a system-script code hash it must change for mainnet, so a mainnet
/// deploy of this exact binary would bind governance to the testnet deployer key.
const GOVERNANCE_AUTHORITY: [u8; 32] = [
    0x7a, 0x71, 0xaf, 0xd7, 0x50, 0x8e, 0xe6, 0x03, 0xc6, 0xc2, 0x19, 0xc6, 0x6f, 0x32, 0x40, 0x8c,
    0x96, 0xb5, 0xa2, 0xe6, 0x6a, 0xf6, 0x74, 0x77, 0x2c, 0xa2, 0xda, 0x27, 0x48, 0x6a, 0x68, 0x0d,
];
// A zero authority would make genesis co-sign trivially unauthorizable-or-forgeable; catch an
// accidental blanking at compile time. (This does not catch a testnet-vs-mainnet mismatch: the
// network-specific value must still be set at the mainnet rebuild, see the mainnet note above.)
const _: () = {
    let mut nonzero = false;
    let mut i = 0;
    while i < 32 {
        if GOVERNANCE_AUTHORITY[i] != 0 {
            nonzero = true;
        }
        i += 1;
    }
    assert!(nonzero, "GOVERNANCE_AUTHORITY must not be all-zero");
};

fn program_entry() -> i8 {
    match verify() {
        Ok(_) => 0,
        Err(e) => e as i8,
    }
}

fn verify() -> Result<(), Error> {
    // Only GroupOutput[0] is validated below,
    // so require exactly one factory-typed output (and at most one input). Otherwise a spend could
    // emit output[1] as a second, unvalidated factory cell with attacker-set authority/entries.
    let in_count = QueryIter::new(load_cell_data, Source::GroupInput).count();
    let out_count = QueryIter::new(load_cell_data, Source::GroupOutput).count();
    if in_count > 1 || out_count != 1 {
        return Err(Error::Tampered);
    }

    // Initial creation: no factory cell in the inputs. Self-enforce a real CKB type-id (do not rely
    // solely on external TYPE_ID wiring) so the registry is a globally-unique singleton.
    let input_data = match load_cell_data(0, Source::GroupInput) {
        Ok(d) => d,
        Err(SysError::IndexOutOfBound) => return check_type_id(),
        Err(_) => return Err(Error::Sys),
    };
    let output_data = load_cell_data(0, Source::GroupOutput).map_err(|_| Error::Sys)?;

    // The factory is a permissive-locked singleton: bind the factory
    // cell's capacity so a spend cannot pocket its parked rent surplus. The recreated cell must keep
    // at least the consumed capacity.
    let cap_in = load_cell_capacity(0, Source::GroupInput).map_err(|_| Error::Sys)?;
    let cap_out = load_cell_capacity(0, Source::GroupOutput).map_err(|_| Error::Sys)?;
    if cap_out < cap_in {
        return Err(Error::Tampered);
    }

    if input_data.len() < FACTORY_HEADER || output_data.len() < FACTORY_HEADER {
        return Err(Error::InvalidData);
    }

    let in_next_id = read_u128(&input_data, 0).map_err(|_| Error::InvalidData)?;
    let out_next_id = read_u128(&output_data, 0).map_err(|_| Error::InvalidData)?;
    let global_paused_in = input_data[80];
    let global_paused_out = output_data[80];

    // Registry/authority seizure: every field this script does not
    // explicitly intend to change must be pinned input→output. Without this, spending the factory
    // cell would let an attacker rewrite `pool_script_hash`,
    // `pause_authority`, and existing pool entries while only the appended entry was validated (and
    // the `out_next_id == in_next_id` path would validate nothing). `pool_script_hash` (bytes [16..48])
    // and `pause_authority` (bytes [48..80]) are immutable on every path here.
    if input_data[16..48] != output_data[16..48] {
        return Err(Error::Tampered); // pool_script_hash is immutable
    }
    if input_data[48..80] != output_data[48..80] {
        return Err(Error::Tampered); // pause_authority is immutable
    }

    // Pause/unpause operation: require pause_authority. Only the global_paused byte may change;
    // next_pool_id and all entries must be byte-for-byte identical.
    if global_paused_in != global_paused_out {
        if in_next_id != out_next_id {
            return Err(Error::Tampered);
        }
        if input_data.len() != output_data.len()
            || input_data[FACTORY_HEADER..] != output_data[FACTORY_HEADER..]
        {
            return Err(Error::Tampered); // entries must not change while (un)pausing
        }
        return verify_pause_authority(&input_data);
    }

    // No change to next_pool_id: nothing may change at all (the only mutable fields are reached via
    // the pause path above or pool creation below). Require the cell to be byte-for-byte identical.
    if out_next_id == in_next_id {
        if input_data.len() != output_data.len() || input_data[..] != output_data[..] {
            return Err(Error::Tampered);
        }
        return Ok(());
    }

    // Pool creation: next_pool_id must increment by exactly 1
    if out_next_id != in_next_id + 1 {
        return Err(Error::InvalidPoolId);
    }
    // `global_paused` is documented to gate pool
    // creation, so honor it here: no new pool may be registered while the registry is paused.
    if global_paused_out != 0 {
        return Err(Error::Unauthorized);
    }

    let new_pool_count = (output_data.len() - FACTORY_HEADER) / POOL_ENTRY_SIZE;
    let prev_pool_count = (input_data.len() - FACTORY_HEADER) / POOL_ENTRY_SIZE;

    if new_pool_count != prev_pool_count + 1 {
        return Err(Error::InvalidData);
    }

    // All previously-registered entries must be preserved byte-for-byte; only the appended tail and
    // next_pool_id may differ.
    let preserved = FACTORY_HEADER + prev_pool_count * POOL_ENTRY_SIZE;
    if input_data[FACTORY_HEADER..] != output_data[FACTORY_HEADER..preserved] {
        return Err(Error::Tampered);
    }

    // New entry must have pool_id == in_next_id
    let new_off = FACTORY_HEADER + prev_pool_count * POOL_ENTRY_SIZE;
    let new_pool_id = read_u128(&output_data, new_off).map_err(|_| Error::InvalidData)?;
    if new_pool_id != in_next_id {
        return Err(Error::InvalidPoolId);
    }

    // Check for duplicate token pair + fee tier
    let tx = &output_data[new_off + 16..new_off + 48];
    let ty = &output_data[new_off + 48..new_off + 80];
    let fee = u16::from_le_bytes([output_data[new_off + 80], output_data[new_off + 81]]);

    for i in 0..prev_pool_count {
        let off = FACTORY_HEADER + i * POOL_ENTRY_SIZE;
        let existing_fee = u16::from_le_bytes([output_data[off + 80], output_data[off + 81]]);
        let same_pair = (output_data[off + 16..off + 48] == *tx
            && output_data[off + 48..off + 80] == *ty)
            || (output_data[off + 16..off + 48] == *ty && output_data[off + 48..off + 80] == *tx);
        if same_pair && existing_fee == fee {
            return Err(Error::DuplicatePool);
        }
    }

    Ok(())
}

/// Self-enforce the canonical CKB type-id at creation: the factory cell's type args must equal
/// blake2b("ckb-default-hash", first_input ‖ output_index_LE), so the registry singleton's type hash
/// is globally unique and cannot be re-created/forked.
fn check_type_id() -> Result<(), Error> {
    let script = load_script().map_err(|_| Error::Sys)?;
    let raw = script.args();
    let a = raw.raw_data();
    if a.len() < 32 {
        return Err(Error::Tampered);
    }
    let mut expected = [0u8; 32];
    expected.copy_from_slice(&a[0..32]);
    let self_hash = load_cell_type_hash(0, Source::GroupOutput)
        .map_err(|_| Error::Sys)?
        .ok_or(Error::Sys)?;
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
    let out_index = out_index.ok_or(Error::Tampered)?;
    let first_input = load_input(0, Source::Input).map_err(|_| Error::Tampered)?;
    let mut ret = [0u8; 32];
    let mut blake = blake2b_ref::Blake2bBuilder::new(32)
        .personal(b"ckb-default-hash")
        .build();
    blake.update(first_input.as_slice());
    blake.update(&(out_index as u64).to_le_bytes());
    blake.finalize(&mut ret);
    if ret != expected {
        return Err(Error::Tampered);
    }
    // Genesis must be governance-co-signed, so only one canonical registry is ever created. (This
    // is the singleton-creation path; once created, registering pools and pausing do not re-check this,
    // so pool creation stays permissionless.)
    if !governance_cosigns() {
        return Err(Error::Unauthorized);
    }
    Ok(())
}

/// True if any input is unlocked by the pinned GOVERNANCE_AUTHORITY (co-sign for factory genesis).
fn governance_cosigns() -> bool {
    let mut i = 0usize;
    loop {
        match load_cell_lock_hash(i, Source::Input) {
            Ok(h) if h == GOVERNANCE_AUTHORITY => return true,
            Ok(_) => i += 1,
            Err(_) => return false,
        }
    }
}

fn verify_pause_authority(factory_data: &[u8]) -> Result<(), Error> {
    let mut auth = [0u8; 32];
    auth.copy_from_slice(&factory_data[48..80]);

    let mut i = 0usize;
    loop {
        match load_cell_lock_hash(i, Source::Input) {
            Ok(lock) if lock == auth => return Ok(()),
            Ok(_) => i += 1,
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => break,
        }
    }
    Err(Error::Unauthorized)
}
