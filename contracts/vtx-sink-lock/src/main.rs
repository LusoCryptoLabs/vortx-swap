#![no_std]
#![no_main]

//! VtxSinkLock: the enforced VTX buy-back sink.
//!
//! A lock script holding bought-back VTX destined for the value sink. Spending sink-locked VTX is
//! permitted only if its disposition obeys the credibly-neutral rule, on-chain and oracle-free
//! (single asset, VTX):
//!
//!   * at most `MAX_TEAM_BPS` (25%, a bytecode-pinned ungovernable ceiling) of the net sunk VTX may go
//!     to the configured team treasury (`team_lock_hash`), and
//!   * every other unit of net sunk VTX must go to the unspendable burn lock. Any VTX output to a lock
//!     that is neither this sink-lock (carry-forward), the team, nor burn is rejected.
//!
//! Because VTX is a standard xUDT (Σ VTX in == Σ VTX out off the mint path) and the only permitted VTX
//! output destinations are {sink, team, burn}, the burn amount is forced to `net − team >= 75% of net`.
//! No price oracle is needed: the cap and the floor are both ratios of the same asset.
//!
//! Scope: this enforces the holder-protecting guarantee that bought-back VTX cannot be diverted
//! from the burn beyond the 25% team cap. The team's separate liquid-CKB ops slice is a different
//! asset and remains keeper policy (enforcing CKB-vs-VTX would need an oracle). Routing bought VTX into
//! this lock is the keeper's flow; once it is here, its disposition is enforced + publicly verifiable.
//!
//! Capacity (out of scope): this lock conserves only the VTX (xUDT) amount, not the sink
//! cell's CKB rent, so a spender obeying the disposition rules could pocket freed rent.
//! No VTX or principal is at risk, and a strict `cap_out >= cap_in` would
//! wrongly forbid a full drain (no carry-forward sink output), so it is intentionally left unbound for
//! this keeper flow. Revisit if the sink ever becomes permissionless-critical.
//!
//! Args (64 bytes):
//!   [0..32]   vtx_type_hash    identifies VTX cells (their type hash)
//!   [32..64]  team_lock_hash   the only non-burn destination allowed for the team's VTX cut

use ckb_std::{
    ckb_constants::Source,
    ckb_types::{
        packed::{Byte32, Script},
        prelude::*,
    },
    default_alloc, entry,
    error::SysError,
    high_level::{
        load_cell_data, load_cell_lock, load_cell_lock_hash, load_cell_type_hash, load_script,
    },
};

entry!(program_entry);
default_alloc!();

/// Ungovernable ceiling on the team's share of any sunk VTX (25%). Pinned in bytecode.
const MAX_TEAM_BPS: u128 = 2_500;
const BPS_DENOM: u128 = 10_000;

/// Burn-lock code hash. The burn lock is this code with all-zero (20-byte) args; no private key
/// produces blake160(pubkey) == 0, so VTX sent there is provably unspendable. It is pinned here and kept
/// in lockstep with `packages/config`, `sdk.burnLockScript()`, and the test, so the contract-computed
/// burn target equals where the SDK actually sends; burns always succeed and are unspendable.
/// This is the canonical CKB secp256k1_blake160_sighash_all type code hash
/// (0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8), which is the same on testnet
/// and mainnet (a system script deployed by type-id), so the burn renders as the standard dead address
/// on block explorers and needs no per-network rebuild.
const SECP_CODE_HASH: [u8; 32] = [
    0x9b, 0xd7, 0xe0, 0x6f, 0x3e, 0xcf, 0x4b, 0xe0, 0xf2, 0xfc, 0xd2, 0x18, 0x8b, 0x23, 0xf1, 0xb9,
    0xfc, 0xc8, 0x8e, 0x5d, 0x4b, 0x65, 0xa8, 0x63, 0x7b, 0x17, 0x72, 0x3b, 0xbd, 0xa3, 0xcc, 0xe8,
];
// Guard against an accidental all-zero blanking of the burn code hash in a future edit (an all-zero
// code hash would make the burn target a non-secp lock and could be spendable).
const _: () = assert!(!is_zero32(&SECP_CODE_HASH));

/// const-fn all-zero check for the compile-time guards above.
const fn is_zero32(h: &[u8; 32]) -> bool {
    let mut i = 0;
    while i < 32 {
        if h[i] != 0 {
            return false;
        }
        i += 1;
    }
    true
}

#[repr(i8)]
enum Error {
    Sys = 1,
    BadArgs = 2,
    BadData = 3,
    ForeignVtxInput = 4,
    UnauthorizedVtxOutput = 5,
    TeamOverCap = 6,
    Overflow = 7,
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

fn read_amount(data: &[u8]) -> Result<u128, Error> {
    if data.len() < 16 {
        return Err(Error::BadData);
    }
    let mut b = [0u8; 16];
    b.copy_from_slice(&data[0..16]);
    Ok(u128::from_le_bytes(b))
}

fn verify() -> Result<(), Error> {
    let script = load_script().map_err(|_| Error::Sys)?;
    let raw = script.args();
    let a = raw.raw_data();
    if a.len() < 64 {
        return Err(Error::BadArgs);
    }
    let mut vtx = [0u8; 32];
    vtx.copy_from_slice(&a[0..32]);
    let mut team = [0u8; 32];
    team.copy_from_slice(&a[32..64]);

    let my_code = script.code_hash();
    let my_code = my_code.as_slice();
    let burn = burn_lock_hash();

    // ── Inputs: sum sink-locked VTX; reject any foreign (non-sink-locked) VTX input. Requiring every
    //    VTX input to be sink-locked means all VTX in this tx originates from the sink, so the output
    //    classification below accounts for all of it (xUDT conservation then forces the burn floor). ──
    let mut s_in: u128 = 0;
    let mut i = 0usize;
    loop {
        match load_cell_type_hash(i, Source::Input) {
            Ok(Some(h)) if h == vtx => {
                let lock = load_cell_lock(i, Source::Input).map_err(|_| Error::Sys)?;
                let la = lock.args();
                let laa = la.raw_data();
                let same = lock.code_hash().as_slice() == my_code && laa.as_ref() == a.as_ref();
                if !same {
                    return Err(Error::ForeignVtxInput);
                }
                let d = load_cell_data(i, Source::Input)?;
                s_in = s_in.checked_add(read_amount(&d)?).ok_or(Error::Overflow)?;
                i += 1;
            }
            Ok(_) => i += 1,
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(Error::Sys),
        }
    }

    // ── Outputs: classify every VTX output as sink-carry / team / burn; reject anything else. ──
    let mut s_out: u128 = 0;
    let mut t: u128 = 0;
    let mut j = 0usize;
    loop {
        match load_cell_type_hash(j, Source::Output) {
            Ok(Some(h)) if h == vtx => {
                let lock = load_cell_lock(j, Source::Output).map_err(|_| Error::Sys)?;
                let la = lock.args();
                let laa = la.raw_data();
                let is_sink = lock.code_hash().as_slice() == my_code && laa.as_ref() == a.as_ref();
                let d = load_cell_data(j, Source::Output)?;
                let amt = read_amount(&d)?;
                if is_sink {
                    s_out = s_out.checked_add(amt).ok_or(Error::Overflow)?;
                } else {
                    let lh = load_cell_lock_hash(j, Source::Output).map_err(|_| Error::Sys)?;
                    if lh == team {
                        t = t.checked_add(amt).ok_or(Error::Overflow)?;
                    } else if lh == burn {
                        // burned: counts toward the floor implicitly (see below)
                    } else {
                        return Err(Error::UnauthorizedVtxOutput);
                    }
                }
                j += 1;
            }
            Ok(_) => j += 1,
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(Error::Sys),
        }
    }

    // net sunk = s_in − s_out (carry-forward stays in the sink). Team ≤ 25% of net; the remainder is
    // forced to burn: only {sink, team, burn} VTX outputs are allowed and xUDT conserves Σin == Σout,
    // so burn = net − team ≥ 75% of net.
    let net = s_in.checked_sub(s_out).ok_or(Error::Overflow)?;
    // t/net ≤ MAX_TEAM_BPS/BPS_DENOM  ⇔  t·BPS_DENOM ≤ MAX_TEAM_BPS·net  (no division, no rounding gap)
    let lhs = t.checked_mul(BPS_DENOM).ok_or(Error::Overflow)?;
    let rhs = MAX_TEAM_BPS.checked_mul(net).ok_or(Error::Overflow)?;
    if lhs > rhs {
        return Err(Error::TeamOverCap);
    }
    Ok(())
}

/// The unspendable burn lock hash: secp256k1-blake160 with all-zero (20-byte) args.
fn burn_lock_hash() -> [u8; 32] {
    let code = Byte32::from_slice(&SECP_CODE_HASH).unwrap();
    let script = Script::new_builder()
        .code_hash(code)
        .hash_type(1u8.into()) // ScriptHashType::Type
        .args([0u8; 20][..].pack())
        .build();
    let mut out = [0u8; 32];
    let mut b = blake2b_ref::Blake2bBuilder::new(32)
        .personal(b"ckb-default-hash")
        .build();
    b.update(script.as_slice());
    b.finalize(&mut out);
    out
}
