#![no_std]
#![no_main]

//! CellSwap OTX lock: secp256r1 WebAuthn, self-contained intent.
//!
//! Verified against JoyID SDK source (@joyid/ckb verifyNativeKeySignature).
//!
//! What the user signs:
//!   A user cannot sign the full settlement transaction: at signing time they
//!   don't know the pool state, other users' cells, or their exact output
//!   (it depends on pool price at settlement). So the user signs only what they
//!   know and control:
//!
//!     commitment = blake2b_personal(
//!       first_input_outpoint (36 bytes)   // uniquely identifies this spend
//!       || total_input_amount (16 bytes)  // how much they put in
//!       || min_amount_out     (16 bytes)  // minimum they accept
//!       || token_out          (32 bytes)  // what they want
//!       || owner_lock_hash    (32 bytes)  // where it must go
//!       || token_in           (32 bytes)  // which token they spend
//!       || deadline_epoch     (8 bytes)   // settle-by epoch, 0 = none
//!     )
//!
//!   This is passed to JoyID signChallenge() as a Uint8Array. JoyID base64url-
//!   encodes it as the WebAuthn challenge.
//!
//! Lock verification:
//!   1. Recompute the commitment from this input group + the intent in the witness
//!   2. Verify clientDataJSON.challenge == base64url(commitment)
//!   3. Verify the WebAuthn secp256r1 signature
//!   4. Verify some output sends >= min_amount_out of token_out to owner_lock_hash
//!
//! This is self-contained: no entity-script, no Cobuild OtxStart needed.
//! The aggregator can batch many such cells; each self-validates. The user's
//! funds can only move if they receive their minimum. Replay is impossible
//! because the input outpoint (a UTXO) is consumed.
//!
//! Lock args (33 bytes): scheme_version(1) || blake2b256(pubkey)(32)
//!   The raw secp256r1 pubkey is not on-chain at rest (quantum harvest-now
//!   resistance). scheme_version = 0x01 (secp256r1/WebAuthn ES256); reserved
//!   for adding a post-quantum scheme later without redesign (crypto-agility).
//!
//! Witness (WitnessArgs.lock):
//!   [0..64]            raw r‖s signature
//!   [64..128]          secp256r1 pubkey x(32) || y(32), revealed only at spend
//!   [128..132]         auth_data length (u32 LE)
//!   [..]               auth_data (37 bytes for JoyID)
//!   [..+4]             client_data length (u32 LE)
//!   [..]               client_data (clientDataJSON)
//!   [..16]             min_amount_out (u128 LE)   ┐
//!   [..32]             token_out type hash         │
//!   [..32]             owner_lock_hash             │ intent (120 bytes), committed in
//!   [..32]             token_in type hash          │ the signature (see compute_commitment)
//!   [..8]              deadline_epoch (u64 LE)     ┘
//!
//! token_in binding: the input token type is part of the commitment, and every
//! group-input cell's type hash is asserted to equal it, so a solver cannot sweep a different asset the
//! user holds under the same lock (the lock guards all of a passkey's OTX cells). Deadline:
//! deadline_epoch is committed and enforced best-effort via a HeaderDep, so a censored intent
//! is not a perpetual option for the counterparty. deadline_epoch == 0 means "no deadline".

use alloc::vec::Vec;

use cell_utils::parse_otx_intent;
use ckb_std::{
    ckb_constants::Source,
    ckb_types::prelude::Entity,
    default_alloc, entry,
    error::SysError,
    high_level::{
        load_cell_capacity, load_cell_data, load_cell_lock, load_cell_lock_hash,
        load_cell_type_hash, load_header_epoch_number, load_input, load_script, load_witness_args,
    },
};
use p256::ecdsa::{signature::hazmat::PrehashVerifier, Signature, VerifyingKey};
use sha2::{Digest, Sha256};

entry!(program_entry);
default_alloc!();

const COMMIT_PERSONALIZATION: &[u8; 16] = b"ckb-cswp-otxcom\x00";
const CKB_HASH_PERSONALIZATION: &[u8; 16] = b"ckb-default-hash";

// Signature scheme versions (crypto-agility).
// New schemes (e.g. a post-quantum co-signature) can be added without redesign.
const SCHEME_SECP256R1_WEBAUTHN: u8 = 0x01;

#[repr(i8)]
enum Error {
    Sys = 1,
    InvalidArgs = 2,
    InvalidWitness = 3,
    InvalidSig = 4,
    ChallengeMismatch = 5,
    InvalidPubkey = 6,
    IntentNotSatisfied = 7,
    BadAmount = 8,
    UnsupportedScheme = 9,
    PubkeyHashMismatch = 10,
    UserNotPresent = 11,
    ZeroMinOut = 12,
    RentNotRefunded = 13,
    WrongInputToken = 14,
    Expired = 15,
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
    // ── Lock args: scheme_version(1) || blake2b256(pubkey)(32) ──
    // The raw secp256r1 pubkey is not stored on-chain at rest (quantum
    // harvest-now resistance). Args hold only a hash + a scheme byte for
    // crypto-agility. The pubkey itself is revealed in the witness at spend.
    let script = load_script()?;
    let args = script.args();
    let args_raw = args.raw_data();
    if args_raw.len() < 33 {
        return Err(Error::InvalidArgs);
    }
    let scheme = args_raw[0];
    if scheme != SCHEME_SECP256R1_WEBAUTHN {
        return Err(Error::UnsupportedScheme);
    }
    let pubkey_hash = &args_raw[1..33];

    // ── Witness ──
    // sig(64) || pubkey(64) || auth_len(4) || auth || client_len(4) || client || intent(120)
    let witness_args =
        load_witness_args(0, Source::GroupInput).map_err(|_| Error::InvalidWitness)?;
    let lock_opt = witness_args.lock().to_opt().ok_or(Error::InvalidWitness)?;
    let w = lock_opt.raw_data();
    if w.len() < 132 {
        return Err(Error::InvalidWitness);
    }

    let sig_raw = &w[0..64];
    let pubkey = &w[64..128]; // x(32) || y(32), revealed only now
    let pubkey_x = &pubkey[0..32];
    let pubkey_y = &pubkey[32..64];

    // Bind the revealed pubkey to the committed hash in args.
    let computed = ckb_hash(pubkey);
    if &computed[..] != pubkey_hash {
        return Err(Error::PubkeyHashMismatch);
    }

    let auth_len = u32::from_le_bytes(w[128..132].try_into().unwrap()) as usize;
    let auth_end = 132 + auth_len;
    if w.len() < auth_end + 4 {
        return Err(Error::InvalidWitness);
    }
    let auth_data = &w[132..auth_end];
    // WebAuthn authenticatorData = rpIdHash(32) || flags(1) || signCount(4). Assert the
    // user-present flag (UP, bit 0) so we only accept an assertion the authenticator made
    // with a present user, never a silent one. JoyID/FaceID also sets user-verified (UV, bit 2).
    // The rpIdHash is enforced by the browser's per-RP credential scoping, so we don't re-check
    // it on-chain (hard-coding an RP would also break crypto-agility). authData is covered by the
    // signature, so this is defense-in-depth against any flow that produces a UP=0 assertion.
    if auth_data.len() < 37 || auth_data[32] & 0x01 == 0 {
        return Err(Error::UserNotPresent);
    }
    let client_len = u32::from_le_bytes(w[auth_end..auth_end + 4].try_into().unwrap()) as usize;
    let client_end = auth_end + 4 + client_len;
    // intent follows client_data:
    //   min_amount_out(16) + token_out(32) + owner_lock_hash(32) + token_in(32) + deadline(8) = 120
    if w.len() < client_end + 120 {
        return Err(Error::InvalidWitness);
    }
    let client_data = &w[auth_end + 4..client_end];

    let intent = &w[client_end..client_end + 120];
    let min_amount_out = u128::from_le_bytes(intent[0..16].try_into().unwrap());
    let token_out = &intent[16..48];
    let owner_lock_hash = &intent[48..80];
    let token_in = &intent[80..112];
    let deadline_epoch = u64::from_le_bytes(intent[112..120].try_into().unwrap());

    // A zero minimum would let any settlement (even one paying the owner nothing) satisfy the
    // intent, so the inputs could be consumed for free. Require a positive floor.
    if min_amount_out == 0 {
        return Err(Error::ZeroMinOut);
    }

    // ── Recompute the commitment the user signed ──
    // sum_group_input_amount (called inside) also asserts every group-input cell's type hash equals
    // `token_in`, so the solver cannot sweep a different asset held under this same lock.
    let commitment = compute_commitment(
        min_amount_out,
        token_out,
        owner_lock_hash,
        token_in,
        deadline_epoch,
    )?;

    // ── Challenge in clientDataJSON must equal base64url(commitment) ──
    verify_challenge(client_data, &commitment)?;

    // ── WebAuthn signature ──
    let client_hash = sha256(client_data);
    let mut sig_base = Vec::with_capacity(auth_data.len() + 32);
    sig_base.extend_from_slice(auth_data);
    sig_base.extend_from_slice(&client_hash);
    let prehash = sha256(&sig_base);

    // Build VerifyingKey from x‖y via uncompressed SEC1 encoding (0x04 || x || y).
    // from_sec1_bytes is the documented, stable path in p256 0.13.
    let mut sec1 = [0u8; 65];
    sec1[0] = 0x04;
    sec1[1..33].copy_from_slice(pubkey_x);
    sec1[33..65].copy_from_slice(pubkey_y);
    let vk = VerifyingKey::from_sec1_bytes(&sec1).map_err(|_| Error::InvalidPubkey)?;

    // Verify using the prehash: this must be verify_prehash, not verify.
    // Low-S is intentionally not enforced. WebAuthn authenticators (incl. JoyID)
    // legitimately emit high-S signatures, and ECDSA verification accepts both S and n−S, so a
    // low-S requirement would reject ~half of real assertions. Signature malleability is inert
    // here: the intent is committed (changing it breaks the challenge) and the input outpoint is
    // consumed on settlement, so a re-signed witness cannot replay or redirect funds.
    let sig = Signature::from_slice(sig_raw).map_err(|_| Error::InvalidSig)?;
    vk.verify_prehash(&prehash, &sig)
        .map_err(|_| Error::InvalidSig)?;

    // ── Deadline (best-effort only) ──
    // The deadline is bound in the commitment (so a solver cannot fabricate or extend it), and enforced
    // here against a HeaderDep epoch. As with intent-lock, a HeaderDep proves only that some block with
    // this epoch exists, not that it is the tip, so a solver can attach a stale header (epoch ≤ deadline)
    // to settle slightly late. CKB `since` cannot help (it is a lower bound, "not before", whereas a
    // deadline is an upper bound, "not after", which is not cheaply provable on-chain). The real
    // protections against an unwanted late fill are min_amount_out (the owner never receives less) and
    // self-spending the input to cancel. deadline_epoch == 0 means "no deadline".
    if deadline_epoch > 0 {
        let epoch = load_header_epoch_number(0, Source::HeaderDep).map_err(|_| Error::Expired)?;
        if epoch > deadline_epoch {
            return Err(Error::Expired);
        }
    }

    // ── Verify outputs satisfy the intent ──
    // Not just "this cell's min", but the sum of min_amount_out across
    // every cellswap-otx-lock input in this tx that targets the same
    // (owner_lock_hash, token_out). One output to that owner cannot
    // cross-satisfy two intents: the outputs must cover the whole demand.
    let code_hash = script.code_hash();
    verify_intent_satisfied(
        code_hash.as_slice(),
        min_amount_out,
        token_out,
        owner_lock_hash,
    )
}

/// commitment = blake2b(
///   first_input_outpoint(36) || total_input_amount(16) || min_amount_out(16)
///   || token_out(32) || owner_lock_hash(32) || token_in(32) || deadline_epoch(8)
/// )
fn compute_commitment(
    min_amount_out: u128,
    token_out: &[u8],
    owner_lock_hash: &[u8],
    token_in: &[u8],
    deadline_epoch: u64,
) -> Result<[u8; 32], Error> {
    // First input of this group: uniquely identifies the spend (replay-proof)
    let first_input = load_input(0, Source::GroupInput)?;
    let outpoint = first_input.previous_output();

    // Total input amount across this lock's group. This also asserts every group-input cell is of the
    // committed `token_in` type, binding which asset the user spends, not just how much.
    let total_in = sum_group_input_amount(token_in)?;

    let mut h = blake2b_ref::Blake2bBuilder::new(32)
        .personal(COMMIT_PERSONALIZATION)
        .build();
    h.update(outpoint.as_slice()); // 36 bytes
    h.update(&total_in.to_le_bytes()); // 16 bytes
    h.update(&min_amount_out.to_le_bytes()); // 16 bytes
    h.update(token_out); // 32 bytes
    h.update(owner_lock_hash); // 32 bytes
    h.update(token_in); // 32 bytes
    h.update(&deadline_epoch.to_le_bytes()); // 8 bytes
    let mut r = [0u8; 32];
    h.finalize(&mut r);
    Ok(r)
}

/// Sum the CKB capacity of all input cells in this lock group (for the rent-refund floor).
fn sum_group_input_capacity() -> Result<u128, Error> {
    let mut total: u128 = 0;
    let mut i = 0usize;
    loop {
        match load_cell_capacity(i, Source::GroupInput) {
            Ok(c) => {
                total = total.saturating_add(c as u128);
                i += 1;
            }
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(Error::Sys),
        }
    }
    Ok(total)
}

/// Sum the CKB capacity of every cellswap-otx-lock input in the tx whose committed intent pays
/// `owner_lock_hash` (the cross-sibling rent-refund floor, see verify_intent_satisfied). An OTX lock
/// group reveals its intent only in the witness at its first input index, but all cells of one passkey
/// share one lock (one lock hash == one group), so we attribute every consumed cell to its group by
/// resolving the group-first witness. This counts the full capacity of every owner-paying cell, so a
/// multi-cell group combined with siblings cannot be under-counted.
fn sum_owner_otx_capacity(self_code_hash: &[u8], owner_lock_hash: &[u8]) -> Result<u128, Error> {
    let mut total: u128 = 0;
    let mut i = 0usize;
    loop {
        match load_cell_lock(i, Source::Input) {
            Ok(lock) => {
                if lock.code_hash().as_slice() == self_code_hash {
                    let lh = load_cell_lock_hash(i, Source::Input).map_err(|_| Error::Sys)?;
                    if group_first_pays_owner(&lh, owner_lock_hash)? {
                        let c = load_cell_capacity(i, Source::Input).map_err(|_| Error::Sys)?;
                        total = total.saturating_add(c as u128);
                    }
                }
                i += 1;
            }
            Err(SysError::IndexOutOfBound) => break,
            // Fail closed: an unexpected error must not truncate the rent floor.
            Err(_) => return Err(Error::Sys),
        }
    }
    Ok(total)
}

/// True iff the OTX group identified by lock hash `lh` commits (in its group-first witness intent) to
/// paying `owner_lock_hash`. The group-first index is the lowest input index sharing this lock hash;
/// reading the intent there (not at an arbitrary member index) stops an attacker planting a fake intent
/// at a non-first index to attribute a cell to the wrong owner. Over-counting is impossible (we only
/// match the committed owner); under-counting is what this prevents.
fn group_first_pays_owner(lh: &[u8], owner_lock_hash: &[u8]) -> Result<bool, Error> {
    let mut j = 0usize;
    loop {
        match load_cell_lock_hash(j, Source::Input) {
            Ok(h) if &h[..] == lh => {
                if let Ok(wa) = load_witness_args(j, Source::Input) {
                    if let Some(lock_w) = wa.lock().to_opt() {
                        if let Some((_, _, owner)) = parse_otx_intent(&lock_w.raw_data()) {
                            return Ok(owner == owner_lock_hash);
                        }
                    }
                }
                // Group-first carries no parseable intent: cannot attribute to any owner.
                return Ok(false);
            }
            Ok(_) => {}
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(Error::Sys),
        }
        j += 1;
    }
    Ok(false)
}

/// Sum xUDT amounts of all input cells in this lock group, asserting each is of the committed
/// `token_in` type. Without the type assertion, a solver could add a different asset the
/// user holds under this same lock (the lock guards every OTX cell of one passkey) into the group and
/// route it out: the commitment binds only the total amount, not which token it is. A cell with no
/// type, or a type hash other than `token_in`, is rejected.
fn sum_group_input_amount(token_in: &[u8]) -> Result<u128, Error> {
    let mut total: u128 = 0;
    let mut i = 0usize;
    loop {
        match load_cell_data(i, Source::GroupInput) {
            Ok(data) => {
                // Every group input must be the committed input token: bind the asset, not just the sum.
                match load_cell_type_hash(i, Source::GroupInput) {
                    Ok(Some(th)) if &th[..] == token_in => {}
                    Ok(_) => return Err(Error::WrongInputToken),
                    Err(_) => return Err(Error::Sys),
                }
                if data.len() < 16 {
                    return Err(Error::BadAmount);
                }
                let amt = u128::from_le_bytes(data[0..16].try_into().unwrap());
                total = total.checked_add(amt).ok_or(Error::BadAmount)?;
                i += 1;
            }
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(Error::Sys),
        }
    }
    Ok(total)
}

/// Verify outputs send >= (total demanded) of token_out to owner_lock_hash, where
/// "total demanded" is the sum of min_amount_out across every cellswap-otx-lock input
/// in this tx that targets the same (owner_lock_hash, token_out).
fn verify_intent_satisfied(
    self_code_hash: &[u8],
    min_amount_out: u128,
    token_out: &[u8],
    owner_lock_hash: &[u8],
) -> Result<(), Error> {
    // Sum what the outputs actually send to (owner_lock_hash, token_out), plus the total CKB capacity
    // of every owner-locked output (for the rent-refund floor below).
    let mut received: u128 = 0;
    let mut owner_cap_out: u128 = 0;
    let mut i = 0usize;
    loop {
        match load_cell_lock_hash(i, Source::Output) {
            Ok(lh) if &lh == owner_lock_hash => {
                if let Ok(c) = load_cell_capacity(i, Source::Output) {
                    owner_cap_out = owner_cap_out.saturating_add(c as u128);
                }
                if let Ok(Some(th)) = load_cell_type_hash(i, Source::Output) {
                    if &th == token_out {
                        let data = load_cell_data(i, Source::Output)?;
                        if data.len() >= 16 {
                            let amt = u128::from_le_bytes(data[0..16].try_into().unwrap());
                            received = received.saturating_add(amt);
                        }
                    }
                }
            }
            Ok(_) => {}
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => break,
        }
        i += 1;
    }

    // Payout floor: the owner must be refunded the consumed cells' CKB rent, so a
    // solver cannot skim an over-funded OTX cell's rent. Require the total owner-locked output capacity
    // to be at least the total input capacity of every cellswap-otx-lock cell in this tx that pays this
    // owner, not just this lock group's inputs. Batching N same-owner cells from different passkeys is N
    // separate lock groups; if each compared the shared owner_cap_out against only its own
    // group capacity, the floor would collapse to max(group) and a solver would keep (N-1) groups' rent.
    // sum_owner_otx_capacity attributes every consumed cell to its group via the group-first witness
    // (resolved by lock hash), so multi-cell groups combined with siblings are fully counted. The
    // .max(sum_group_input_capacity()) is a redundant floor on the current group.
    // Normal SDK use migrates at the occupied floor, so this only bites a solver trying to keep surplus.
    let rent_floor =
        sum_owner_otx_capacity(self_code_hash, owner_lock_hash)?.max(sum_group_input_capacity()?);
    if owner_cap_out < rent_floor {
        return Err(Error::RentNotRefunded);
    }

    // Sum the demand: every cellswap-otx-lock input whose intent targets this same
    // (owner_lock_hash, token_out). This includes this cell's own min. Because every
    // such input independently computes the identical demand and the identical
    // `received`, no single output can be counted toward two intents. A forged extra
    // input can only raise the demand (griefing/censorship), never reduce protection,
    // and forging it requires owning + signing that cell, which pays this owner anyway.
    let demanded = sum_demand_for(self_code_hash, token_out, owner_lock_hash)?;
    let required = demanded.max(min_amount_out);

    if received < required {
        return Err(Error::IntentNotSatisfied);
    }
    Ok(())
}

/// Sum min_amount_out over all cellswap-otx-lock inputs in the tx whose intent
/// targets (owner_lock_hash, token_out). A lock group reveals its intent only in the
/// witness at its first input index; non-first group members carry no lock witness and
/// are naturally skipped, so each group is counted exactly once.
fn sum_demand_for(
    self_code_hash: &[u8],
    token_out: &[u8],
    owner_lock_hash: &[u8],
) -> Result<u128, Error> {
    let mut total: u128 = 0;
    let mut i = 0usize;
    loop {
        match load_cell_lock(i, Source::Input) {
            Ok(lock) => {
                if lock.code_hash().as_slice() == self_code_hash {
                    if let Ok(wa) = load_witness_args(i, Source::Input) {
                        if let Some(lock_w) = wa.lock().to_opt() {
                            let wv = lock_w.raw_data();
                            if let Some((min, t_out, owner)) = parse_otx_intent(&wv) {
                                if t_out == token_out && owner == owner_lock_hash {
                                    total = total.checked_add(min).ok_or(Error::BadAmount)?;
                                }
                            }
                        }
                    }
                }
                i += 1;
            }
            Err(SysError::IndexOutOfBound) => break,
            // Fail closed: an unexpected syscall error must not silently truncate the demand sum
            // (undercounting `required` would let a solver underpay). Only IndexOutOfBound ends the scan.
            Err(_) => return Err(Error::Sys),
        }
    }
    Ok(total)
}

/// clientDataJSON.challenge == base64url_nopad(commitment)
fn verify_challenge(client_data: &[u8], commitment: &[u8; 32]) -> Result<(), Error> {
    // WebAuthn challenges are URL-safe base64 without padding (base64ct::Base64Url pads with '=').
    use base64ct::{Base64UrlUnpadded, Encoding};
    let expected = Base64UrlUnpadded::encode_string(commitment);
    let json = core::str::from_utf8(client_data).map_err(|_| Error::InvalidWitness)?;
    let key = "\"challenge\":\"";
    let pos = json.find(key).ok_or(Error::ChallengeMismatch)?;
    let rest = &json[pos + key.len()..];
    let end = rest.find('"').ok_or(Error::ChallengeMismatch)?;
    if &rest[..end] != expected.as_str() {
        return Err(Error::ChallengeMismatch);
    }
    Ok(())
}

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

/// blake2b-256 with CKB's default-hash personalization (matches ccc.hashCkb).
fn ckb_hash(data: &[u8]) -> [u8; 32] {
    let mut h = blake2b_ref::Blake2bBuilder::new(32)
        .personal(CKB_HASH_PERSONALIZATION)
        .build();
    h.update(data);
    let mut r = [0u8; 32];
    h.finalize(&mut r);
    r
}
