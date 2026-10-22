// tests/integration/src/contract_tests.rs
//
// On-chain execution tests for reserve custody.
//
// These tests construct real
// transactions and assert that the pool-script + pool-lock enforce token
// custody: reserves are read from real reserve cells, and a reserve cell
// cannot move unless its info cell is present.
//
// Prerequisite: `make build` (or capsule/cargo) so binaries exist at
//   ../../build/release/{pool-script,pool-lock,lp-token,cellswap-otx-lock}
// plus an always-success binary for stand-in token type scripts and user locks.
//
// Run with: `cargo test --test contract_tests`.
//
// Token type scripts here are always-success stand-ins; their hashes are
// stored into the info cell's token_x/token_y fields, which is all pool-script
// checks. Full xUDT value conservation is also enforced by the real
// xUDT type script on devnet; these tests isolate the custody/AMM logic.

#![cfg(test)]

use ckb_testtool::ckb_types::{
    bytes::Bytes,
    core::{EpochNumberWithFraction, HeaderBuilder, ScriptHashType, TransactionBuilder},
    packed::{CellDep, CellInput, CellOutput},
    prelude::*,
};
use ckb_testtool::context::Context;

const MAX_CYCLES: u64 = 200_000_000;

fn bin(name: &str) -> Bytes {
    let path = format!("../../build/release/{name}");
    std::fs::read(&path)
        .unwrap_or_else(|_| panic!("missing {path}, run `make build` first"))
        .into()
}

fn u128le(v: u128) -> Vec<u8> {
    v.to_le_bytes().to_vec()
}
fn u16le(v: u16) -> Vec<u8> {
    v.to_le_bytes().to_vec()
}

/// The canonical CKB type-id of a cell: blake2b("ckb-default-hash", first_input ‖ output_index_LE).
fn ckb_type_id(first_input: &CellInput, out_index: u64) -> [u8; 32] {
    let mut ret = [0u8; 32];
    let mut b = blake2b_ref::Blake2bBuilder::new(32)
        .personal(b"ckb-default-hash")
        .build();
    b.update(first_input.as_slice());
    b.update(&out_index.to_le_bytes());
    b.finalize(&mut ret);
    ret
}

/// 140-byte info-cell layout (no reserves: they live in reserve cells).
#[allow(clippy::too_many_arguments)]
fn info_data(
    token_x: [u8; 32],
    token_y: [u8; 32],
    lp: u128,
    fee: u16,
    pool_id: u128,
    mode: u8,
    paused: u8,
) -> Bytes {
    let mut d = vec![0u8; 156];
    d[0..32].copy_from_slice(&token_x);
    d[32..64].copy_from_slice(&token_y);
    d[64..80].copy_from_slice(&u128le(lp));
    d[80..82].copy_from_slice(&u16le(fee));
    d[82..98].copy_from_slice(&u128le(pool_id));
    // [98..114] cum_x, [114..130] cum_y, [130..138] last_epoch left zero
    d[138] = mode;
    d[139] = paused;
    // [140..156] k_last left zero = protocol fee off
    d.into()
}

/// xUDT reserve cell data: amount as u128 LE (first 16 bytes).
fn reserve_data(amount: u128) -> Bytes {
    u128le(amount).into()
}

const MIN_POOL_CAPACITY: u64 = 40_000_000_000; // 400 CKB (must match cell-utils)

/// Shared fixture: deploys scripts and returns the pieces needed to build txs.
struct Fixture {
    ctx: Context,
    pool_dep: CellDep,
    lock_dep: CellDep,
    as_dep: CellDep,
    pool_type: ckb_testtool::ckb_types::packed::Script, // info cell type (with args)
    pool_lock: ckb_testtool::ckb_types::packed::Script, // reserve cell lock (args = info type hash)
    token_x_type: ckb_testtool::ckb_types::packed::Script,
    token_y_type: ckb_testtool::ckb_types::packed::Script,
    user_lock: ckb_testtool::ckb_types::packed::Script,
    info_type_hash: [u8; 32],
    tx_hash_x: [u8; 32],
    tx_hash_y: [u8; 32],
}

fn setup(pool_id: u128) -> Fixture {
    let mut ctx = Context::default();
    let pool_out = ctx.deploy_cell(bin("pool-script"));
    let lock_out = ctx.deploy_cell(bin("pool-lock"));
    let as_out = ctx.deploy_cell(bin("always-success"));

    let pool_dep = CellDep::new_builder().out_point(pool_out.clone()).build();
    let lock_dep = CellDep::new_builder().out_point(lock_out.clone()).build();
    let as_dep = CellDep::new_builder().out_point(as_out.clone()).build();

    // pool-lock code hash (data hash of the deployed binary's cell)
    let pool_lock_code_hash: [u8; 32] = lock_out_code_hash(&ctx, &lock_out);

    // pool-script args (96 bytes) = pool_lock_code_hash || lp_token_code_hash || treasury_lock_hash.
    // Fee-off tests leave lp_token + treasury zero (they're only read when the fee switch is on).
    let mut pool_args = Vec::with_capacity(96);
    pool_args.extend_from_slice(&pool_lock_code_hash);
    pool_args.extend_from_slice(&[0u8; 32]); // lp_token_code_hash (unused when fee off)
    pool_args.extend_from_slice(&[0u8; 32]); // treasury_lock_hash (unused when fee off)
    let _ = pool_id; // pool_id lives only in info data, not in the type-script args
    let pool_type = ctx.build_script(&pool_out, Bytes::from(pool_args)).unwrap();
    let info_type_hash: [u8; 32] = pool_type.calc_script_hash().unpack();

    // pool-lock args = info cell's own type hash.
    // Use Data1 so the reserve lock's code_hash is the pool-lock *data* hash, matching
    // pool_lock_code_hash (= blake2b_256(data)) stored in pool-script's args. (build_script
    // defaults to hash_type=Type, whose code_hash is the deploy cell's type-id hash.)
    let pool_lock = ctx
        .build_script_with_hash_type(
            &lock_out,
            ScriptHashType::Data1,
            Bytes::from(info_type_hash.to_vec()),
        )
        .unwrap();

    // Stand-in token type scripts (always-success with distinct args)
    let token_x_type = ctx.build_script(&as_out, Bytes::from(vec![0xa1])).unwrap();
    let token_y_type = ctx.build_script(&as_out, Bytes::from(vec![0xb2])).unwrap();
    let user_lock = ctx.build_script(&as_out, Bytes::from(vec![0xcc])).unwrap();

    Fixture {
        ctx,
        pool_dep,
        lock_dep,
        as_dep,
        pool_type,
        pool_lock,
        token_x_type,
        token_y_type,
        user_lock,
        info_type_hash,
        tx_hash_x: [0u8; 32],
        tx_hash_y: [0u8; 32],
    }
}

fn lock_out_code_hash(ctx: &Context, out: &ckb_testtool::ckb_types::packed::OutPoint) -> [u8; 32] {
    // The code hash of a type=data script is the data hash of the deployed cell.
    let (_cell, data) = ctx.get_cell(out).expect("deployed cell");
    ckb_testtool::ckb_hash::blake2b_256(data)
}

impl Fixture {
    fn token_x_hash(&self) -> [u8; 32] {
        self.token_x_type.calc_script_hash().unpack()
    }
    fn token_y_hash(&self) -> [u8; 32] {
        self.token_y_type.calc_script_hash().unpack()
    }
}

// ─── 1. Valid swap conserves and passes ──────────────────────────────────────

#[test]
fn swap_conserves_and_passes() {
    let mut f = setup(1);
    let (tx, ry) = (1_000_000u128, 1_000_000u128);
    let fee = 30u16;
    // Swap 10_000 X in; out must keep k non-decreasing after fee.
    // Use the canonical get_amount_out rounding (floor the output, pool-safe). Flooring
    // the remaining reserve instead would round 1 unit in the user's favor and (correctly)
    // trip the invariant.
    let amount_in = 10_000u128;
    let amount_in_with_fee = amount_in * (10_000 - fee as u128);
    let amount_out = (amount_in_with_fee * ry) / (tx * 10_000 + amount_in_with_fee); // floor output
    let new_rx = tx + amount_in;
    let new_ry = ry - amount_out;

    let txn = build_swap_tx(&mut f, tx, ry, new_rx, new_ry, fee, 1, /*tamper*/ 0);
    f.ctx
        .verify_tx(&txn, MAX_CYCLES)
        .expect("valid swap should pass");
}

// ─── 2. Over-withdrawal (invariant violation) fails ──────────────────────────

#[test]
fn swap_overdraw_fails() {
    let mut f = setup(2);
    let (tx, ry) = (1_000_000u128, 1_000_000u128);
    let amount_in = 10_000u128;
    let new_rx = tx + amount_in;
    // Take way more out than the curve allows.
    let new_ry = ry - 50_000u128;
    let txn = build_swap_tx(&mut f, tx, ry, new_rx, new_ry, 30, 2, 0);
    assert!(
        f.ctx.verify_tx(&txn, MAX_CYCLES).is_err(),
        "over-withdrawal must fail invariant"
    );
}

// ─── 3. Draining a reserve without the info cell fails (pool-lock) ────────────

#[test]
fn reserve_move_without_info_fails() {
    let mut f = setup(3);
    // Build a tx that spends a reserve cell but does not include the info cell.
    let reserve_in = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(14_400_000_000u64.pack())
            .lock(f.pool_lock.clone())
            .type_(Some(f.token_y_type.clone()).pack())
            .build(),
        reserve_data(1_000_000),
    );
    let out = CellOutput::new_builder()
        .capacity(14_400_000_000u64.pack())
        .lock(f.user_lock.clone()) // attacker tries to take the tokens
        .type_(Some(f.token_y_type.clone()).pack())
        .build();
    let txn = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(reserve_in).build())
        .output(out)
        .output_data(reserve_data(1_000_000).pack())
        .cell_dep(f.lock_dep.clone())
        .cell_dep(f.as_dep.clone())
        .build();
    assert!(
        f.ctx.verify_tx(&txn, MAX_CYCLES).is_err(),
        "pool-lock must reject moving a reserve with no info cell present"
    );
}

// ─── 4. Binding a reserve to a fake info cell fails ──────────────────────────

#[test]
fn reserve_bound_to_fake_info_fails() {
    let mut f = setup(4);
    // pool-lock args point at a different type hash than any info cell in the tx.
    let fake_hash = [0x99u8; 32];
    let fake_lock = f
        .ctx
        .build_script(&f.lock_dep.out_point(), Bytes::from(fake_hash.to_vec()))
        .unwrap();
    let reserve_in = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(14_400_000_000u64.pack())
            .lock(fake_lock.clone())
            .type_(Some(f.token_y_type.clone()).pack())
            .build(),
        reserve_data(1_000_000),
    );
    // Include a real info cell (different type hash); it still shouldn't satisfy the fake lock.
    let info_in = make_info_input(&mut f, 1_000_000, 1_000_000);
    let txn = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(reserve_in).build())
        .input(CellInput::new_builder().previous_output(info_in).build())
        .output(
            CellOutput::new_builder()
                .capacity(14_400_000_000u64.pack())
                .lock(f.user_lock.clone())
                .type_(Some(f.token_y_type.clone()).pack())
                .build(),
        )
        .output_data(reserve_data(1_000_000).pack())
        .cell_dep(f.lock_dep.clone())
        .cell_dep(f.as_dep.clone())
        .cell_dep(f.pool_dep.clone())
        .build();
    assert!(
        f.ctx.verify_tx(&txn, MAX_CYCLES).is_err(),
        "reserve bound to a non-present info type hash must fail"
    );
}

// ─── 5. Reserve amount comes from the cell, not info data ─────────────────────

#[test]
fn pool_reads_reserves_from_cells_not_data() {
    // If someone crafts an info update claiming reserves changed favorably but the
    // reserve cells don't move accordingly, the invariant (computed from cells) fails.
    let mut f = setup(5);
    let (tx, ry) = (1_000_000u128, 1_000_000u128);
    // Reserve cells barely change, but we *pretend* (in a tampered build) a big swap.
    // build_swap_tx with tamper=1 keeps reserve cells equal to input while emitting
    // an info that looks like a swap happened; invariant over real cells = no-op or fail.
    let txn = build_swap_tx(&mut f, tx, ry, tx, ry - 50_000, 30, 5, /*tamper*/ 1);
    assert!(
        f.ctx.verify_tx(&txn, MAX_CYCLES).is_err(),
        "reserves must be read from real cells; faked info cannot create value"
    );
}

// ─── helpers to assemble swap transactions ───────────────────────────────────

fn make_info_input(
    f: &mut Fixture,
    _rx: u128,
    _ry: u128,
) -> ckb_testtool::ckb_types::packed::OutPoint {
    let data = info_data(f.token_x_hash(), f.token_y_hash(), 1_000_000, 30, 999, 0, 0);
    f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(MIN_POOL_CAPACITY.pack())
            .lock(f.user_lock.clone())
            .type_(Some(f.pool_type.clone()).pack())
            .build(),
        data,
    )
}

/// Build a full xUDT/xUDT swap tx: [info, rX, rY] -> [info', rX', rY'].
/// `tamper=1` leaves the reserve cells unchanged while still emitting a changed
/// info cell (used to prove reserves come from cells, not info data).
fn build_swap_tx(
    f: &mut Fixture,
    rx_in: u128,
    ry_in: u128,
    rx_out: u128,
    ry_out: u128,
    fee: u16,
    pool_id: u128,
    tamper: u8,
) -> ckb_testtool::ckb_types::core::TransactionView {
    let tx_hash_x = f.token_x_hash();
    let tx_hash_y = f.token_y_hash();
    f.tx_hash_x = tx_hash_x;
    f.tx_hash_y = tx_hash_y;

    let info_in_data = info_data(tx_hash_x, tx_hash_y, 1_000_000, fee, pool_id, 0, 0);
    let info_out_data = info_data(tx_hash_x, tx_hash_y, 1_000_000, fee, pool_id, 0, 0);

    let info_in = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(MIN_POOL_CAPACITY.pack())
            .lock(f.user_lock.clone())
            .type_(Some(f.pool_type.clone()).pack())
            .build(),
        info_in_data,
    );
    let rx_cell = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(14_400_000_000u64.pack())
            .lock(f.pool_lock.clone())
            .type_(Some(f.token_x_type.clone()).pack())
            .build(),
        reserve_data(rx_in),
    );
    let ry_cell = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(14_400_000_000u64.pack())
            .lock(f.pool_lock.clone())
            .type_(Some(f.token_y_type.clone()).pack())
            .build(),
        reserve_data(ry_in),
    );

    // Reserve outputs: if tampering, keep them at the input values.
    let (out_rx, out_ry) = if tamper == 1 {
        (rx_in, ry_in)
    } else {
        (rx_out, ry_out)
    };

    TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(info_in).build())
        .input(CellInput::new_builder().previous_output(rx_cell).build())
        .input(CellInput::new_builder().previous_output(ry_cell).build())
        .output(
            CellOutput::new_builder()
                .capacity(MIN_POOL_CAPACITY.pack())
                .lock(f.user_lock.clone())
                .type_(Some(f.pool_type.clone()).pack())
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(14_400_000_000u64.pack())
                .lock(f.pool_lock.clone())
                .type_(Some(f.token_x_type.clone()).pack())
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(14_400_000_000u64.pack())
                .lock(f.pool_lock.clone())
                .type_(Some(f.token_y_type.clone()).pack())
                .build(),
        )
        .output_data(info_out_data.pack())
        .output_data(reserve_data(out_rx).pack())
        .output_data(reserve_data(out_ry).pack())
        .cell_dep(f.pool_dep.clone())
        .cell_dep(f.lock_dep.clone())
        .cell_dep(f.as_dep.clone())
        .build()
}

/// Like build_swap_tx but with explicit info-cell in/out capacities, to exercise the rent-skim check (a mode-0 /
/// xUDT-xUDT info cell's pure-rent capacity must be conserved across a spend).
#[allow(clippy::too_many_arguments)]
fn build_swap_tx_info_caps(
    f: &mut Fixture,
    rx_in: u128,
    ry_in: u128,
    rx_out: u128,
    ry_out: u128,
    fee: u16,
    pool_id: u128,
    info_in_cap: u64,
    info_out_cap: u64,
) -> ckb_testtool::ckb_types::core::TransactionView {
    let tx_hash_x = f.token_x_hash();
    let tx_hash_y = f.token_y_hash();
    let info_in_data = info_data(tx_hash_x, tx_hash_y, 1_000_000, fee, pool_id, 0, 0);
    let info_out_data = info_data(tx_hash_x, tx_hash_y, 1_000_000, fee, pool_id, 0, 0);
    let info_in = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(info_in_cap.pack())
            .lock(f.user_lock.clone())
            .type_(Some(f.pool_type.clone()).pack())
            .build(),
        info_in_data,
    );
    let rx_cell = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(14_400_000_000u64.pack())
            .lock(f.pool_lock.clone())
            .type_(Some(f.token_x_type.clone()).pack())
            .build(),
        reserve_data(rx_in),
    );
    let ry_cell = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(14_400_000_000u64.pack())
            .lock(f.pool_lock.clone())
            .type_(Some(f.token_y_type.clone()).pack())
            .build(),
        reserve_data(ry_in),
    );
    TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(info_in).build())
        .input(CellInput::new_builder().previous_output(rx_cell).build())
        .input(CellInput::new_builder().previous_output(ry_cell).build())
        .output(
            CellOutput::new_builder()
                .capacity(info_out_cap.pack())
                .lock(f.user_lock.clone())
                .type_(Some(f.pool_type.clone()).pack())
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(14_400_000_000u64.pack())
                .lock(f.pool_lock.clone())
                .type_(Some(f.token_x_type.clone()).pack())
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(14_400_000_000u64.pack())
                .lock(f.pool_lock.clone())
                .type_(Some(f.token_y_type.clone()).pack())
                .build(),
        )
        .output_data(info_out_data.pack())
        .output_data(reserve_data(rx_out).pack())
        .output_data(reserve_data(ry_out).pack())
        .cell_dep(f.pool_dep.clone())
        .cell_dep(f.lock_dep.clone())
        .cell_dep(f.as_dep.clone())
        .build()
}

#[test]
fn pool_xudt_info_capacity_skim_rejected() {
    // Permissionless rent skim: an xUDT/xUDT pool's info cell
    // holds no reserves (they live in reserve cells), so its CKB capacity is pure rent. Without a bound,
    // a spender could recreate the info cell at a lower capacity and skim the surplus
    // (~54 CKB here). pool-script rejects out_cap < in_cap for mode-0 pools. Control: the same swap
    // that conserves the info capacity still passes (so the gate isn't just rejecting everything).
    let (rx_in, ry_in, fee) = (1_000_000u128, 1_000_000u128, 30u16);
    let amount_in = 10_000u128;
    let amount_in_with_fee = amount_in * (10_000 - fee as u128);
    let amount_out = (amount_in_with_fee * ry_in) / (rx_in * 10_000 + amount_in_with_fee); // floor output
    let (rx_out, ry_out) = (rx_in + amount_in, ry_in - amount_out);
    let surplus = 5_400_000_000u64; // 54 CKB of rent surplus over the floor
    let in_cap = MIN_POOL_CAPACITY + surplus;

    // Skim: recreate the info cell at the bare floor, pocketing the 54 CKB surplus → rejected.
    let mut f = setup(60);
    let skim = build_swap_tx_info_caps(
        &mut f,
        rx_in,
        ry_in,
        rx_out,
        ry_out,
        fee,
        60,
        in_cap,
        MIN_POOL_CAPACITY,
    );
    assert!(
        f.ctx.verify_tx(&skim, MAX_CYCLES).is_err(),
        "skimming the info cell rent surplus must fail"
    );

    // Control: same swap, info capacity conserved (out == in) → passes.
    let mut f2 = setup(61);
    let ok = build_swap_tx_info_caps(
        &mut f2, rx_in, ry_in, rx_out, ry_out, fee, 61, in_cap, in_cap,
    );
    assert!(
        f2.ctx.verify_tx(&ok, MAX_CYCLES).is_ok(),
        "conserving the info capacity should pass (control)"
    );
}

#[test]
fn swap_with_decoy_reserve_rejected() {
    // Full-pool drain: pool-lock allows spending any cell bound
    // to the info hash, so reading only the first reserve cell per token would let an
    // attacker add a decoy token_y reserve, get the invariant checked against it, and route the
    // real reserve out. read_reserves rejects any extra pool-lock cell, so two token_y reserve
    // cells on the inputs must fail.
    let mut f = setup(9);
    let (rx, ry) = (1_000_000u128, 1_000_000u128);
    let fee = 30u16;
    let hx = f.token_x_hash();
    let hy = f.token_y_hash();
    let info_b = info_data(hx, hy, 1_000_000, fee, 9, 0, 0);

    let info_in = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(MIN_POOL_CAPACITY.pack())
            .lock(f.user_lock.clone())
            .type_(Some(f.pool_type.clone()).pack())
            .build(),
        info_b.clone(),
    );
    let rx_cell = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(14_400_000_000u64.pack())
            .lock(f.pool_lock.clone())
            .type_(Some(f.token_x_type.clone()).pack())
            .build(),
        reserve_data(rx),
    );
    // The decoy token_y reserve (small), also bound to this pool via pool-lock(args = info hash).
    let ry_decoy = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(14_400_000_000u64.pack())
            .lock(f.pool_lock.clone())
            .type_(Some(f.token_y_type.clone()).pack())
            .build(),
        reserve_data(100),
    );
    // The real, large token_y reserve.
    let ry_real = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(14_400_000_000u64.pack())
            .lock(f.pool_lock.clone())
            .type_(Some(f.token_y_type.clone()).pack())
            .build(),
        reserve_data(ry),
    );

    // Attacker keeps a tiny pool-lock token_y(100) reserve (to satisfy first-cell accounting) and routes
    // the real reserve to their own cell.
    let txn = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(info_in).build())
        .input(CellInput::new_builder().previous_output(rx_cell).build())
        .input(CellInput::new_builder().previous_output(ry_decoy).build()) // decoy ordered first
        .input(CellInput::new_builder().previous_output(ry_real).build())
        .output(
            CellOutput::new_builder()
                .capacity(MIN_POOL_CAPACITY.pack())
                .lock(f.user_lock.clone())
                .type_(Some(f.pool_type.clone()).pack())
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(14_400_000_000u64.pack())
                .lock(f.pool_lock.clone())
                .type_(Some(f.token_x_type.clone()).pack())
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(14_400_000_000u64.pack())
                .lock(f.pool_lock.clone())
                .type_(Some(f.token_y_type.clone()).pack())
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(14_400_000_000u64.pack())
                .lock(f.user_lock.clone())
                .type_(Some(f.token_y_type.clone()).pack())
                .build(),
        )
        .output_data(info_b.pack())
        .output_data(reserve_data(rx).pack())
        .output_data(reserve_data(100).pack())
        .output_data(reserve_data(ry).pack())
        .cell_dep(f.pool_dep.clone())
        .cell_dep(f.lock_dep.clone())
        .cell_dep(f.as_dep.clone())
        .build();
    assert!(
        f.ctx.verify_tx(&txn, MAX_CYCLES).is_err(),
        "a decoy/duplicate reserve cell must be rejected"
    );
}

#[test]
fn remove_without_lp_token_cell_rejected() {
    // Unauthenticated full-pool drain: the "burn LP to withdraw"
    // rule lives in the lp-token type script, which only runs if an lp-token cell is present in the
    // tx. The info cell uses a permissive lock, so anyone could spend it, omit all lp-token cells, set
    // output.lp_supply = 0 on a remove, and walk off with 100% of both reserves having burned zero LP.
    // pool-script binds the recorded lp_supply delta to the real circulating-LP delta (Σ this
    // pool's lp-token cells, out − in). With no lp-token cell present that delta is 0, so a changed
    // lp_supply (1_000_000 → 0) does not validate → the drain is rejected (LpDeltaMismatch).
    let mut f = setup(11);
    let (rx, ry) = (1_000_000u128, 1_000_000u128);
    let fee = 30u16;
    let hx = f.token_x_hash();
    let hy = f.token_y_hash();
    let info_in_data = info_data(hx, hy, 1_000_000, fee, 11, 0, 0); // lp_supply = 1_000_000
    let info_out_data = info_data(hx, hy, 0, fee, 11, 0, 0); // lp_supply = 0 (the drain)

    let info_in = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(MIN_POOL_CAPACITY.pack())
            .lock(f.user_lock.clone())
            .type_(Some(f.pool_type.clone()).pack())
            .build(),
        info_in_data,
    );
    let rx_cell = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(14_400_000_000u64.pack())
            .lock(f.pool_lock.clone())
            .type_(Some(f.token_x_type.clone()).pack())
            .build(),
        reserve_data(rx),
    );
    let ry_cell = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(14_400_000_000u64.pack())
            .lock(f.pool_lock.clone())
            .type_(Some(f.token_y_type.clone()).pack())
            .build(),
        reserve_data(ry),
    );

    // No lp-token cell anywhere. Reserve cells emptied to 0; the drained tokens routed to the attacker.
    let txn = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(info_in).build())
        .input(CellInput::new_builder().previous_output(rx_cell).build())
        .input(CellInput::new_builder().previous_output(ry_cell).build())
        .output(
            CellOutput::new_builder()
                .capacity(MIN_POOL_CAPACITY.pack())
                .lock(f.user_lock.clone())
                .type_(Some(f.pool_type.clone()).pack())
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(14_400_000_000u64.pack())
                .lock(f.pool_lock.clone())
                .type_(Some(f.token_x_type.clone()).pack())
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(14_400_000_000u64.pack())
                .lock(f.pool_lock.clone())
                .type_(Some(f.token_y_type.clone()).pack())
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(14_400_000_000u64.pack())
                .lock(f.user_lock.clone())
                .type_(Some(f.token_x_type.clone()).pack())
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(14_400_000_000u64.pack())
                .lock(f.user_lock.clone())
                .type_(Some(f.token_y_type.clone()).pack())
                .build(),
        )
        .output_data(info_out_data.pack())
        .output_data(reserve_data(0).pack())
        .output_data(reserve_data(0).pack())
        .output_data(reserve_data(rx).pack())
        .output_data(reserve_data(ry).pack())
        .cell_dep(f.pool_dep.clone())
        .cell_dep(f.lock_dep.clone())
        .cell_dep(f.as_dep.clone())
        .build();
    assert!(
        f.ctx.verify_tx(&txn, MAX_CYCLES).is_err(),
        "remove-liquidity with NO lp-token cell (lp_supply change unbacked by real LP) must be rejected"
    );
}

#[test]
fn pool_creation_requires_valid_type_id() {
    // Cross-pool LP drain: pool creation must require a real CKB type-id
    // in args[96..128] == blake2b(first_input ‖ output_index). Otherwise two pools could be built with
    // the same args → same info type hash → their LP tokens become the same fungible xUDT, letting
    // cheap LP minted from a junk twin pool redeem against a valuable pool and drain it.
    let mut ctx = Context::default();
    let pool_out = ctx.deploy_cell(bin("pool-script"));
    let lock_out = ctx.deploy_cell(bin("pool-lock"));
    let as_out = ctx.deploy_cell(bin("always-success"));
    let lp_out = ctx.deploy_cell(bin("lp-token"));
    let pool_dep = CellDep::new_builder().out_point(pool_out.clone()).build();
    let lock_dep = CellDep::new_builder().out_point(lock_out.clone()).build();
    let as_dep = CellDep::new_builder().out_point(as_out.clone()).build();
    let lp_dep = CellDep::new_builder().out_point(lp_out.clone()).build();
    let pool_lock_code_hash = lock_out_code_hash(&ctx, &lock_out);
    let lp_token_code_hash = lock_out_code_hash(&ctx, &lp_out);
    let token_x = ctx.build_script(&as_out, Bytes::from(vec![0xa1])).unwrap();
    let token_y = ctx.build_script(&as_out, Bytes::from(vec![0xb2])).unwrap();
    let hx: [u8; 32] = token_x.calc_script_hash().unpack();
    let hy: [u8; 32] = token_y.calc_script_hash().unpack();
    let user_lock = ctx.build_script(&as_out, Bytes::from(vec![0xcc])).unwrap();

    let fund = ctx.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64.pack())
            .lock(user_lock.clone())
            .build(),
        Bytes::new(),
    );
    let fund_input = CellInput::new_builder().previous_output(fund).build();
    let good_tid = ckb_type_id(&fund_input, 0); // info cell is output 0

    // Build a creation tx whose pool args carry `tid` as the [96..128] type-id.
    let build =
        |ctx: &mut Context, tid: [u8; 32]| -> ckb_testtool::ckb_types::core::TransactionView {
            let mut args = Vec::with_capacity(128);
            args.extend_from_slice(&pool_lock_code_hash);
            args.extend_from_slice(&lp_token_code_hash); // lp_token code hash (read at genesis)
            args.extend_from_slice(&[0u8; 32]); // treasury
            args.extend_from_slice(&tid);
            let pool_type = ctx.build_script(&pool_out, Bytes::from(args)).unwrap();
            let info_type_hash: [u8; 32] = pool_type.calc_script_hash().unpack();
            let plock = ctx
                .build_script_with_hash_type(
                    &lock_out,
                    ScriptHashType::Data1,
                    Bytes::from(info_type_hash.to_vec()),
                )
                .unwrap();
            // The creator is minted lp_supply - MINIMUM_LIQUIDITY (1_000_000 - 1000 = 999_000); the
            // locked 1000 has no backing cell. pool-script binds circulating + 1000 == lp_supply at genesis.
            let lp_token = ctx
                .build_script_with_hash_type(
                    &lp_out,
                    ScriptHashType::Data1,
                    Bytes::from(info_type_hash.to_vec()),
                )
                .unwrap();
            // Pool creation must register in the canonical factory (entry == pool_id 777, hx, hy, fee 30).
            let fr = factory_reg(ctx, &as_out, 777, hx, hy, 30);
            TransactionBuilder::default()
                .input(fund_input.clone())
                .input(fr.input)
                .output(
                    CellOutput::new_builder()
                        .capacity(MIN_POOL_CAPACITY.pack())
                        .lock(user_lock.clone())
                        .type_(Some(pool_type).pack())
                        .build(),
                )
                .output(
                    CellOutput::new_builder()
                        .capacity(14_400_000_000u64.pack())
                        .lock(plock.clone())
                        .type_(Some(token_x.clone()).pack())
                        .build(),
                )
                .output(
                    CellOutput::new_builder()
                        .capacity(14_400_000_000u64.pack())
                        .lock(plock.clone())
                        .type_(Some(token_y.clone()).pack())
                        .build(),
                )
                .output(
                    CellOutput::new_builder()
                        .capacity(14_400_000_000u64.pack())
                        .lock(user_lock.clone())
                        .type_(Some(lp_token).pack())
                        .build(),
                )
                .output(fr.output)
                .output_data(info156(hx, hy, 1_000_000, 0).pack())
                .output_data(reserve_data(1_000_000).pack())
                .output_data(reserve_data(1_000_000).pack())
                .output_data(reserve_data(999_000).pack())
                .output_data(fr.out_data.pack())
                .cell_dep(pool_dep.clone())
                .cell_dep(lock_dep.clone())
                .cell_dep(as_dep.clone())
                .cell_dep(lp_dep.clone())
                .cell_dep(fr.dep)
                .build()
        };

    let good = build(&mut ctx, good_tid);
    assert!(
        ctx.verify_tx(&good, MAX_CYCLES).is_ok(),
        "creation with the correct type-id should pass"
    );
    let bad = build(&mut ctx, [0xABu8; 32]); // free salt, not the real type-id
    assert!(
        ctx.verify_tx(&bad, MAX_CYCLES).is_err(),
        "creation with a forged/free type-id must fail"
    );
}

#[test]
fn pool_creation_fee_and_minimum_liquidity_bounds() {
    // Creation bounds:
    //  - fee_bps must be bounded < BPS_DENOMINATOR (10000) at creation. amm-math computes
    //    `denom - fee` in ethnum U256, which wraps in --release (overflow-checks does not cover
    //    ethnum's Sub), so fee_bps >= 10000 would make verify_invariant accept a near-total drain.
    //  - The inflation guard MINIMUM_LIQUIDITY (1000) must be permanently unredeemable. The
    //    circulating LP minted at genesis must equal lp_supply - 1000, so the 1000 has no backing
    //    cell. Minting the full lp_supply (attacker keeps the lockable 1000) is rejected.
    let mut ctx = Context::default();
    let pool_out = ctx.deploy_cell(bin("pool-script"));
    let lock_out = ctx.deploy_cell(bin("pool-lock"));
    let as_out = ctx.deploy_cell(bin("always-success"));
    let lp_out = ctx.deploy_cell(bin("lp-token"));
    let pool_dep = CellDep::new_builder().out_point(pool_out.clone()).build();
    let lock_dep = CellDep::new_builder().out_point(lock_out.clone()).build();
    let as_dep = CellDep::new_builder().out_point(as_out.clone()).build();
    let lp_dep = CellDep::new_builder().out_point(lp_out.clone()).build();
    let pool_lock_code_hash = lock_out_code_hash(&ctx, &lock_out);
    let lp_token_code_hash = lock_out_code_hash(&ctx, &lp_out);
    let token_x = ctx.build_script(&as_out, Bytes::from(vec![0xa1])).unwrap();
    let token_y = ctx.build_script(&as_out, Bytes::from(vec![0xb2])).unwrap();
    let hx: [u8; 32] = token_x.calc_script_hash().unpack();
    let hy: [u8; 32] = token_y.calc_script_hash().unpack();
    let user_lock = ctx.build_script(&as_out, Bytes::from(vec![0xcc])).unwrap();
    let fund = ctx.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64.pack())
            .lock(user_lock.clone())
            .build(),
        Bytes::new(),
    );
    let fund_input = CellInput::new_builder().previous_output(fund).build();
    let tid = ckb_type_id(&fund_input, 0); // info cell is output 0

    // Creation tx with a valid type-id, parametrized by fee_bps and the LP minted to the creator.
    let build = |ctx: &mut Context,
                 fee_bps: u16,
                 lp_minted: u128|
     -> ckb_testtool::ckb_types::core::TransactionView {
        let mut args = Vec::with_capacity(128);
        args.extend_from_slice(&pool_lock_code_hash);
        args.extend_from_slice(&lp_token_code_hash);
        args.extend_from_slice(&[0u8; 32]); // treasury
        args.extend_from_slice(&tid);
        let pool_type = ctx.build_script(&pool_out, Bytes::from(args)).unwrap();
        let info_type_hash: [u8; 32] = pool_type.calc_script_hash().unpack();
        let plock = ctx
            .build_script_with_hash_type(
                &lock_out,
                ScriptHashType::Data1,
                Bytes::from(info_type_hash.to_vec()),
            )
            .unwrap();
        let lp_token = ctx
            .build_script_with_hash_type(
                &lp_out,
                ScriptHashType::Data1,
                Bytes::from(info_type_hash.to_vec()),
            )
            .unwrap();
        let mut info = info156(hx, hy, 1_000_000, 0).to_vec();
        info[80..82].copy_from_slice(&fee_bps.to_le_bytes()); // override fee_bps
                                                              // Register in the canonical factory; the entry fee tracks fee_bps (the good case = 30).
        let fr = factory_reg(ctx, &as_out, 777, hx, hy, fee_bps);
        TransactionBuilder::default()
            .input(fund_input.clone())
            .input(fr.input)
            .output(
                CellOutput::new_builder()
                    .capacity(MIN_POOL_CAPACITY.pack())
                    .lock(user_lock.clone())
                    .type_(Some(pool_type).pack())
                    .build(),
            )
            .output(
                CellOutput::new_builder()
                    .capacity(14_400_000_000u64.pack())
                    .lock(plock.clone())
                    .type_(Some(token_x.clone()).pack())
                    .build(),
            )
            .output(
                CellOutput::new_builder()
                    .capacity(14_400_000_000u64.pack())
                    .lock(plock.clone())
                    .type_(Some(token_y.clone()).pack())
                    .build(),
            )
            .output(
                CellOutput::new_builder()
                    .capacity(14_400_000_000u64.pack())
                    .lock(user_lock.clone())
                    .type_(Some(lp_token).pack())
                    .build(),
            )
            .output(fr.output)
            .output_data(Bytes::from(info).pack())
            .output_data(reserve_data(1_000_000).pack())
            .output_data(reserve_data(1_000_000).pack())
            .output_data(reserve_data(lp_minted).pack())
            .output_data(fr.out_data.pack())
            .cell_dep(pool_dep.clone())
            .cell_dep(lock_dep.clone())
            .cell_dep(as_dep.clone())
            .cell_dep(lp_dep.clone())
            .cell_dep(fr.dep)
            .build()
    };

    // Sanity: a well-formed creation (fee 30, mint lp_supply - 1000) passes.
    let good = build(&mut ctx, 30, 999_000);
    assert!(
        ctx.verify_tx(&good, MAX_CYCLES).is_ok(),
        "well-formed creation should pass"
    );
    // fee_bps == 10000 (and above) is rejected (it would wrap denom - fee).
    let fee_eq = build(&mut ctx, 10_000, 999_000);
    assert!(
        ctx.verify_tx(&fee_eq, MAX_CYCLES).is_err(),
        "fee_bps == 10000 must be rejected"
    );
    let fee_hi = build(&mut ctx, 10_001, 999_000);
    assert!(
        ctx.verify_tx(&fee_hi, MAX_CYCLES).is_err(),
        "fee_bps > 10000 must be rejected"
    );
    // Minting the full lp_supply (no locked 1000) is rejected: circulating must be lp_supply - 1000.
    let unbacked = build(&mut ctx, 30, 1_000_000);
    assert!(
        ctx.verify_tx(&unbacked, MAX_CYCLES).is_err(),
        "minting the full lp_supply (unlocked MINIMUM_LIQUIDITY) must be rejected"
    );
}

#[test]
fn pool_creation_requires_factory_registration() {
    // On-chain one-pool-per-(pair,fee): pool creation must spend+recreate the
    // canonical factory with an appended entry naming this pool. Omitting the factory, or appending an
    // entry that names a different pool, must be rejected. (factory-script then rejects a duplicate
    // (pair,fee) on that spend, which is what makes uniqueness on-chain.)
    let mut ctx = Context::default();
    let pool_out = ctx.deploy_cell(bin("pool-script"));
    let lock_out = ctx.deploy_cell(bin("pool-lock"));
    let as_out = ctx.deploy_cell(bin("always-success"));
    let lp_out = ctx.deploy_cell(bin("lp-token"));
    let pool_dep = CellDep::new_builder().out_point(pool_out.clone()).build();
    let lock_dep = CellDep::new_builder().out_point(lock_out.clone()).build();
    let as_dep = CellDep::new_builder().out_point(as_out.clone()).build();
    let lp_dep = CellDep::new_builder().out_point(lp_out.clone()).build();
    let pool_lock_code_hash = lock_out_code_hash(&ctx, &lock_out);
    let lp_token_code_hash = lock_out_code_hash(&ctx, &lp_out);
    let token_x = ctx.build_script(&as_out, Bytes::from(vec![0xa1])).unwrap();
    let token_y = ctx.build_script(&as_out, Bytes::from(vec![0xb2])).unwrap();
    let hx: [u8; 32] = token_x.calc_script_hash().unpack();
    let hy: [u8; 32] = token_y.calc_script_hash().unpack();
    let user_lock = ctx.build_script(&as_out, Bytes::from(vec![0xcc])).unwrap();
    let fund = ctx.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64.pack())
            .lock(user_lock.clone())
            .build(),
        Bytes::new(),
    );
    let fund_input = CellInput::new_builder().previous_output(fund).build();
    let tid = ckb_type_id(&fund_input, 0); // info cell is output 0

    // fac: 0 = no factory cell, 1 = factory entry names a wrong pool (fee 99), 2 = correct entry.
    let build = |ctx: &mut Context, fac: u8| -> ckb_testtool::ckb_types::core::TransactionView {
        let mut args = Vec::with_capacity(128);
        args.extend_from_slice(&pool_lock_code_hash);
        args.extend_from_slice(&lp_token_code_hash);
        args.extend_from_slice(&[0u8; 32]); // treasury
        args.extend_from_slice(&tid);
        let pool_type = ctx.build_script(&pool_out, Bytes::from(args)).unwrap();
        let info_type_hash: [u8; 32] = pool_type.calc_script_hash().unpack();
        let plock = ctx
            .build_script_with_hash_type(
                &lock_out,
                ScriptHashType::Data1,
                Bytes::from(info_type_hash.to_vec()),
            )
            .unwrap();
        let lp_token = ctx
            .build_script_with_hash_type(
                &lp_out,
                ScriptHashType::Data1,
                Bytes::from(info_type_hash.to_vec()),
            )
            .unwrap();
        let mut b = TransactionBuilder::default()
            .input(fund_input.clone())
            .output(
                CellOutput::new_builder()
                    .capacity(MIN_POOL_CAPACITY.pack())
                    .lock(user_lock.clone())
                    .type_(Some(pool_type).pack())
                    .build(),
            )
            .output(
                CellOutput::new_builder()
                    .capacity(14_400_000_000u64.pack())
                    .lock(plock.clone())
                    .type_(Some(token_x.clone()).pack())
                    .build(),
            )
            .output(
                CellOutput::new_builder()
                    .capacity(14_400_000_000u64.pack())
                    .lock(plock.clone())
                    .type_(Some(token_y.clone()).pack())
                    .build(),
            )
            .output(
                CellOutput::new_builder()
                    .capacity(14_400_000_000u64.pack())
                    .lock(user_lock.clone())
                    .type_(Some(lp_token).pack())
                    .build(),
            )
            .output_data(info156(hx, hy, 1_000_000, 0).pack())
            .output_data(reserve_data(1_000_000).pack())
            .output_data(reserve_data(1_000_000).pack())
            .output_data(reserve_data(999_000).pack())
            .cell_dep(pool_dep.clone())
            .cell_dep(lock_dep.clone())
            .cell_dep(as_dep.clone())
            .cell_dep(lp_dep.clone());
        if fac != 0 {
            // pool_id 777 / fee 30 are what info156 writes; fac==1 names fee 99 (a different pool).
            let fee = if fac == 1 { 99 } else { 30 };
            let fr = factory_reg(ctx, &as_out, 777, hx, hy, fee);
            b = b
                .input(fr.input)
                .output(fr.output)
                .output_data(fr.out_data.pack())
                .cell_dep(fr.dep);
        }
        b.build()
    };

    let no_factory = build(&mut ctx, 0);
    assert!(
        ctx.verify_tx(&no_factory, MAX_CYCLES).is_err(),
        "creation without the canonical factory must fail"
    );
    let wrong_entry = build(&mut ctx, 1);
    assert!(
        ctx.verify_tx(&wrong_entry, MAX_CYCLES).is_err(),
        "creation whose factory entry names a different pool must fail"
    );
    let good = build(&mut ctx, 2);
    assert!(
        ctx.verify_tx(&good, MAX_CYCLES).is_ok(),
        "creation with a matching factory entry should pass"
    );
}

// ─── Factory registry tests ──────────────────────────────────────────────────

use ckb_testtool::ckb_types::packed::Script as PackedScript;

/// FactoryData: next_id(16) || pool_script_hash(32) || pause_authority(32) || paused(1) || entries(90 each)
fn factory_data(
    next_id: u128,
    pause_auth: [u8; 32],
    paused: u8,
    entries: &[(u128, [u8; 32], [u8; 32], u16)],
) -> Bytes {
    let mut d = vec![0u8; 81 + entries.len() * 90];
    d[0..16].copy_from_slice(&next_id.to_le_bytes());
    d[48..80].copy_from_slice(&pause_auth);
    d[80] = paused;
    for (i, (pid, tx, ty, fee)) in entries.iter().enumerate() {
        let o = 81 + i * 90;
        d[o..o + 16].copy_from_slice(&pid.to_le_bytes());
        d[o + 16..o + 48].copy_from_slice(tx);
        d[o + 48..o + 80].copy_from_slice(ty);
        d[o + 80..o + 82].copy_from_slice(&fee.to_le_bytes());
    }
    d.into()
}

/// Build the canonical-factory register-pool transition (input + recreated output) that
/// pool-script's verify_pool_creation requires at genesis. `pool_id` must equal the new pool's info
/// pool_id; the appended entry names (tx, ty, fee). Deploys factory-script so the factory cell's type
/// code_hash (Data1) == pool-script's baked FACTORY_CODE_HASH. The factory uses a permissive
/// (always-success) lock: pool creation stays permissionless, the registry math rejects duplicates.
struct FactoryReg {
    input: CellInput,
    output: CellOutput,
    out_data: Bytes,
    dep: CellDep,
}
fn factory_reg(
    ctx: &mut Context,
    as_out: &ckb_testtool::ckb_types::packed::OutPoint,
    pool_id: u128,
    tx: [u8; 32],
    ty: [u8; 32],
    fee: u16,
) -> FactoryReg {
    let fac_out = ctx.deploy_cell(bin("factory-script"));
    let dep = CellDep::new_builder().out_point(fac_out.clone()).build();
    let aslock = ctx.build_script(as_out, Bytes::new()).unwrap();
    let auth: [u8; 32] = aslock.calc_script_hash().unpack();
    let ftype = ctx
        .build_script_with_hash_type(&fac_out, ScriptHashType::Data1, Bytes::from(vec![0u8; 32]))
        .unwrap();
    let in_data = factory_data(pool_id, auth, 0, &[]);
    let out_data = factory_data(pool_id + 1, auth, 0, &[(pool_id, tx, ty, fee)]);
    let fin = ctx.create_cell(
        CellOutput::new_builder()
            .capacity(40_000_000_000u64.pack())
            .lock(aslock.clone())
            .type_(Some(ftype.clone()).pack())
            .build(),
        in_data,
    );
    let output = CellOutput::new_builder()
        .capacity(40_000_000_000u64.pack())
        .lock(aslock)
        .type_(Some(ftype).pack())
        .build();
    FactoryReg {
        input: CellInput::new_builder().previous_output(fin).build(),
        output,
        out_data,
        dep,
    }
}

struct FacFix {
    ctx: Context,
    fac_out: ckb_testtool::ckb_types::packed::OutPoint,
    fac_dep: CellDep,
    as_dep: CellDep,
    ftype: PackedScript,
    aslock: PackedScript,
    auth: [u8; 32],
}

fn fac_setup() -> FacFix {
    let mut ctx = Context::default();
    let fac_out = ctx.deploy_cell(bin("factory-script"));
    let as_out = ctx.deploy_cell(bin("always-success"));
    let fac_dep = CellDep::new_builder().out_point(fac_out.clone()).build();
    let as_dep = CellDep::new_builder().out_point(as_out.clone()).build();
    let ftype = ctx.build_script(&fac_out, Bytes::from(vec![0x01])).unwrap();
    let aslock = ctx.build_script(&as_out, Bytes::new()).unwrap();
    let auth: [u8; 32] = aslock.calc_script_hash().unpack(); // factory cell's own lock = pause authority
    FacFix {
        ctx,
        fac_out,
        fac_dep,
        as_dep,
        ftype,
        aslock,
        auth,
    }
}

impl FacFix {
    fn factory_cell(&mut self, data: &Bytes) -> ckb_testtool::ckb_types::packed::OutPoint {
        self.ctx.create_cell(
            CellOutput::new_builder()
                .capacity(40_000_000_000u64.pack())
                .lock(self.aslock.clone())
                .type_(Some(self.ftype.clone()).pack())
                .build(),
            data.clone(),
        )
    }
    fn out(&self, _data: &Bytes) -> CellOutput {
        // Capacity must be >= the consumed factory cell (factory capacity conservation).
        CellOutput::new_builder()
            .capacity(40_000_000_000u64.pack())
            .lock(self.aslock.clone())
            .type_(Some(self.ftype.clone()).pack())
            .build()
    }
    fn deps(
        &self,
        b: ckb_testtool::ckb_types::core::TransactionBuilder,
    ) -> ckb_testtool::ckb_types::core::TransactionBuilder {
        b.cell_dep(self.fac_dep.clone())
            .cell_dep(self.as_dep.clone())
    }
}

#[test]
fn factory_genesis_requires_governance() {
    // Factory genesis (the singleton-creation path) must be co-signed by the pinned
    // GOVERNANCE_AUTHORITY, so exactly one canonical registry can ever exist (pool-script binds pool
    // creation to the factory by its baked data hash; that binding is only meaningful if an attacker
    // cannot stand up a second factory). The authority is the testnet governance secp lock, which is
    // not a spendable input under ckb-testtool (no secp dep/signature), so this test covers only the
    // reject path.
    let mut f = fac_setup();
    let data = factory_data(1, f.auth, 0, &[]);
    // A capacity input locked by always-success (not the governance authority); everything else about
    // this genesis is valid (correct type-id), so the only reason it fails is the missing gov co-sign.
    let cap_in = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64.pack())
            .lock(f.aslock.clone())
            .build(),
        Bytes::new(),
    );
    let cap_input = CellInput::new_builder().previous_output(cap_in).build();
    let tid = ckb_type_id(&cap_input, 0);
    let ftype = f
        .ctx
        .build_script(&f.fac_out, Bytes::from(tid.to_vec()))
        .unwrap();
    let out = CellOutput::new_builder()
        .capacity(30_000_000_000u64.pack())
        .lock(f.aslock.clone())
        .type_(Some(ftype).pack())
        .build();
    let tx = f
        .deps(TransactionBuilder::default())
        .input(cap_input)
        .output(out)
        .output_data(data.pack())
        .build();
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "factory genesis without the governance co-sign must fail"
    );

    // And a forged/free type-id (args 0x01) must also be rejected.
    let mut f2 = fac_setup();
    let cap2 = f2.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64.pack())
            .lock(f2.aslock.clone())
            .build(),
        Bytes::new(),
    );
    let bad_out = CellOutput::new_builder()
        .capacity(30_000_000_000u64.pack())
        .lock(f2.aslock.clone())
        .type_(Some(f2.ftype.clone()).pack())
        .build(); // ftype args = 0x01 (not a type-id)
    let tx2 = f2
        .deps(TransactionBuilder::default())
        .input(CellInput::new_builder().previous_output(cap2).build())
        .output(bad_out)
        .output_data(factory_data(1, f2.auth, 0, &[]).pack())
        .build();
    assert!(
        f2.ctx.verify_tx(&tx2, MAX_CYCLES).is_err(),
        "factory creation without a valid type-id must fail"
    );
}

#[test]
fn factory_register_pool_passes() {
    let mut f = fac_setup();
    let (a, b) = ([0xa1u8; 32], [0xb2u8; 32]);
    let in_data = factory_data(1, f.auth, 0, &[]);
    let out_data = factory_data(2, f.auth, 0, &[(1, a, b, 30)]);
    let fac_in = f.factory_cell(&in_data);
    let out = f.out(&out_data);
    let tx = f
        .deps(TransactionBuilder::default())
        .input(CellInput::new_builder().previous_output(fac_in).build())
        .output(out)
        .output_data(out_data.pack())
        .build();
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_ok(),
        "registering a new pool should pass"
    );
}

#[test]
fn factory_capacity_skim_rejected() {
    // Factory capacity conservation: recreating the factory cell at a lower capacity (pocketing
    // its parked rent) must fail, even on an otherwise-valid register.
    let mut f = fac_setup();
    let (a, b) = ([0xa1u8; 32], [0xb2u8; 32]);
    let in_data = factory_data(1, f.auth, 0, &[]);
    let out_data = factory_data(2, f.auth, 0, &[(1, a, b, 30)]);
    let fac_in = f.factory_cell(&in_data); // 400 CKB
    let out = CellOutput::new_builder()
        .capacity(35_000_000_000u64.pack()) // 350 CKB (50 skimmed)
        .lock(f.aslock.clone())
        .type_(Some(f.ftype.clone()).pack())
        .build();
    let tx = f
        .deps(TransactionBuilder::default())
        .input(CellInput::new_builder().previous_output(fac_in).build())
        .output(out)
        .output_data(out_data.pack())
        .build();
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "skimming factory capacity must be rejected"
    );
}

#[test]
fn factory_duplicate_pool_fails() {
    let mut f = fac_setup();
    let (a, b) = ([0xa1u8; 32], [0xb2u8; 32]);
    // Already has (1, A, B, 30); try to add (2, A, B, 30): same pair + fee.
    let in_data = factory_data(2, f.auth, 0, &[(1, a, b, 30)]);
    let out_data = factory_data(3, f.auth, 0, &[(1, a, b, 30), (2, a, b, 30)]);
    let fac_in = f.factory_cell(&in_data);
    let out = f.out(&out_data);
    let tx = f
        .deps(TransactionBuilder::default())
        .input(CellInput::new_builder().previous_output(fac_in).build())
        .output(out)
        .output_data(out_data.pack())
        .build();
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "duplicate pair+fee must be rejected"
    );
}

#[test]
fn factory_pause_requires_authority() {
    // Authorized: pause_authority == the factory cell's own (always-success) lock, present in inputs.
    let mut f = fac_setup();
    let in_data = factory_data(1, f.auth, 0, &[]);
    let out_data = factory_data(1, f.auth, 1, &[]); // toggle paused 0→1
    let fac_in = f.factory_cell(&in_data);
    let out = f.out(&out_data);
    let tx = f
        .deps(TransactionBuilder::default())
        .input(CellInput::new_builder().previous_output(fac_in).build())
        .output(out)
        .output_data(out_data.pack())
        .build();
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_ok(),
        "pause by the authority should pass"
    );

    // Unauthorized: pause_authority is a hash not present in any input lock.
    let mut f2 = fac_setup();
    let bad = [0x99u8; 32];
    let in2 = factory_data(1, bad, 0, &[]);
    let out2 = factory_data(1, bad, 1, &[]);
    let fac_in2 = f2.factory_cell(&in2);
    let o2 = f2.out(&out2);
    let tx2 = f2
        .deps(TransactionBuilder::default())
        .input(CellInput::new_builder().previous_output(fac_in2).build())
        .output(o2)
        .output_data(out2.pack())
        .build();
    assert!(
        f2.ctx.verify_tx(&tx2, MAX_CYCLES).is_err(),
        "pause without the authority must fail"
    );
}

#[test]
fn factory_register_tamper_authority_rejected() {
    // Appending a pool while also rewriting pause_authority must fail: the
    // script pins pool_script_hash + pause_authority and all prior entries across a transition.
    let mut f = fac_setup();
    let (a, b) = ([0xa1u8; 32], [0xb2u8; 32]);
    let attacker = [0x66u8; 32];
    let in_data = factory_data(1, f.auth, 0, &[]);
    let out_data = factory_data(2, attacker, 0, &[(1, a, b, 30)]); // pause_authority swapped
    let fac_in = f.factory_cell(&in_data);
    let out = f.out(&out_data);
    let tx = f
        .deps(TransactionBuilder::default())
        .input(CellInput::new_builder().previous_output(fac_in).build())
        .output(out)
        .output_data(out_data.pack())
        .build();
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "rewriting pause_authority during a register must fail"
    );
}

#[test]
fn factory_noop_tamper_entry_rejected() {
    // The no-op path (next_id unchanged) must pin every byte, otherwise an
    // attacker could rewrite existing entries. Changing a registered entry's fee must fail.
    let mut f = fac_setup();
    let (a, b) = ([0xa1u8; 32], [0xb2u8; 32]);
    let in_data = factory_data(2, f.auth, 0, &[(1, a, b, 30)]);
    let out_data = factory_data(2, f.auth, 0, &[(1, a, b, 0)]); // fee 30 -> 0 on an existing entry
    let fac_in = f.factory_cell(&in_data);
    let out = f.out(&out_data);
    let tx = f
        .deps(TransactionBuilder::default())
        .input(CellInput::new_builder().previous_output(fac_in).build())
        .output(out)
        .output_data(out_data.pack())
        .build();
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "rewriting an existing entry on the no-op path must fail"
    );
}

// ─── Timelock lock tests (optional LP commitment) ─────────────────────────────

const SINCE_EPOCH_FLAG: u64 = 0x2000_0000_0000_0000; // absolute, epoch-based
const SINCE_RELATIVE_EPOCH_FLAG: u64 = 0xa000_0000_0000_0000; // relative + epoch

struct TlFix {
    ctx: Context,
    tl_out: ckb_testtool::ckb_types::packed::OutPoint,
    as_out: ckb_testtool::ckb_types::packed::OutPoint,
    tl_dep: CellDep,
    as_dep: CellDep,
}

fn tl_setup() -> TlFix {
    let mut ctx = Context::default();
    let tl_out = ctx.deploy_cell(bin("timelock-lock"));
    let as_out = ctx.deploy_cell(bin("always-success"));
    let tl_dep = CellDep::new_builder().out_point(tl_out.clone()).build();
    let as_dep = CellDep::new_builder().out_point(as_out.clone()).build();
    TlFix {
        ctx,
        tl_out,
        as_out,
        tl_dep,
        as_dep,
    }
}

/// Build a tx spending one timelock-locked LP cell: lock args = owner_hash || deadline,
/// input `since` as given, plus an owner-locked input iff `include_owner`.
fn build_tl_tx(
    f: &mut TlFix,
    deadline: u64,
    since: u64,
    include_owner: bool,
) -> ckb_testtool::ckb_types::core::TransactionView {
    let owner_lock = f
        .ctx
        .build_script(&f.as_out, Bytes::from(vec![0x0e]))
        .unwrap();
    let owner_hash: [u8; 32] = owner_lock.calc_script_hash().unpack();

    let mut args = Vec::with_capacity(40);
    args.extend_from_slice(&owner_hash);
    args.extend_from_slice(&deadline.to_le_bytes());
    let tl_lock = f.ctx.build_script(&f.tl_out, Bytes::from(args)).unwrap();
    let lp_type = f
        .ctx
        .build_script(&f.as_out, Bytes::from(vec![0x11]))
        .unwrap();

    let lp_in = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(14_400_000_000u64.pack())
            .lock(tl_lock)
            .type_(Some(lp_type.clone()).pack())
            .build(),
        Bytes::from(u128le(1_000_000)),
    );

    let mut b = TransactionBuilder::default()
        .input(
            CellInput::new_builder()
                .previous_output(lp_in)
                .since(since.pack())
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(14_400_000_000u64.pack())
                .lock(owner_lock.clone())
                .type_(Some(lp_type).pack())
                .build(),
        )
        .output_data(Bytes::from(u128le(1_000_000)).pack())
        .cell_dep(f.tl_dep.clone())
        .cell_dep(f.as_dep.clone());

    if include_owner {
        let owner_cell = f.ctx.create_cell(
            CellOutput::new_builder()
                .capacity(20_000_000_000u64.pack())
                .lock(owner_lock)
                .build(),
            Bytes::new(),
        );
        b = b.input(CellInput::new_builder().previous_output(owner_cell).build());
    }
    b.build()
}

#[test]
fn timelock_unlock_after_deadline_passes() {
    let mut f = tl_setup();
    let tx = build_tl_tx(&mut f, 100, SINCE_EPOCH_FLAG | 100, true);
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_ok(),
        "owner spend at/after the deadline epoch should pass"
    );
}

#[test]
fn timelock_before_deadline_fails() {
    let mut f = tl_setup();
    let tx = build_tl_tx(&mut f, 100, SINCE_EPOCH_FLAG | 50, true);
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "spend before the deadline epoch must fail"
    );
}

#[test]
fn timelock_zero_since_cannot_bypass() {
    // since = 0 isn't an absolute epoch >= deadline → must be rejected.
    let mut f = tl_setup();
    let tx = build_tl_tx(&mut f, 100, 0, true);
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "since=0 must not bypass the deadline"
    );
}

#[test]
fn timelock_relative_since_rejected() {
    let mut f = tl_setup();
    let tx = build_tl_tx(&mut f, 100, SINCE_RELATIVE_EPOCH_FLAG | 100, true);
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "a relative since must be rejected (only absolute epoch is honored)"
    );
}

#[test]
fn timelock_without_owner_fails() {
    let mut f = tl_setup();
    let tx = build_tl_tx(&mut f, 100, SINCE_EPOCH_FLAG | 100, false);
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "no owner co-sign present → must fail (custody stays with owner)"
    );
}

#[test]
fn timelock_zero_deadline_owner_passes() {
    // deadline=0 means no time restriction, but the owner must still authorize.
    let mut f = tl_setup();
    let tx = build_tl_tx(&mut f, 0, 0, true);
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_ok(),
        "deadline=0 with owner co-sign should pass"
    );
}

// ─── Token-registry tests (paid, owner-signed registration) ───────────────────

const REG_MIN_FEE: u64 = 500_000_000_000; // 5000 CKB (== token-registry MIN_REGISTRATION_FEE)

// token-registry pins PLATFORM_TREASURY = the testnet deployer secp256k1 lock. Reconstruct that exact
// lock here so the fee output's lock hash matches the contract constant (0x7a71afd7…).
const SECP_CODE_HASH: [u8; 32] = [
    0x9b, 0xd7, 0xe0, 0x6f, 0x3e, 0xcf, 0x4b, 0xe0, 0xf2, 0xfc, 0xd2, 0x18, 0x8b, 0x23, 0xf1, 0xb9,
    0xfc, 0xc8, 0x8e, 0x5d, 0x4b, 0x65, 0xa8, 0x63, 0x7b, 0x17, 0x72, 0x3b, 0xbd, 0xa3, 0xcc, 0xe8,
];
const PLATFORM_ARGS: [u8; 20] = [
    0xc9, 0x1c, 0x40, 0xbf, 0xd1, 0x71, 0xb5, 0xcf, 0xff, 0x8b, 0x04, 0xd2, 0x1e, 0x4d, 0x31, 0x75,
    0xbe, 0x75, 0x80, 0x6e,
];
fn platform_treasury_lock() -> PackedScript {
    PackedScript::new_builder()
        .code_hash(SECP_CODE_HASH.pack())
        .hash_type((ScriptHashType::Type as u8).into())
        .args(Bytes::from(PLATFORM_ARGS.to_vec()).pack())
        .build()
}

// token-registry also pins the standard xUDT code to bind owner_lock_hash → token_type_hash on create.
// Reconstruct a token's type hash the same way the contract does (xUDT{code, args: owner_lock_hash}).
const XUDT_TESTNET_CODE: [u8; 32] = [
    0x25, 0xc2, 0x9d, 0xc3, 0x17, 0x81, 0x1a, 0x6f, 0x6f, 0x39, 0x85, 0xa7, 0xa9, 0xeb, 0xc4, 0x83,
    0x8b, 0xd3, 0x88, 0xd1, 0x9d, 0x0f, 0xee, 0xec, 0xf0, 0xbc, 0xd6, 0x0f, 0x6c, 0x09, 0x75, 0xbb,
];
fn token_hash_for_owner(owner_hash: &[u8; 32]) -> [u8; 32] {
    PackedScript::new_builder()
        .code_hash(XUDT_TESTNET_CODE.pack())
        .hash_type((ScriptHashType::Type as u8).into())
        .args(Bytes::from(owner_hash.to_vec()).pack())
        .build()
        .calc_script_hash()
        .unpack()
}

struct RegFix {
    ctx: Context,
    reg_out: ckb_testtool::ckb_types::packed::OutPoint,
    as_out: ckb_testtool::ckb_types::packed::OutPoint,
    reg_dep: CellDep,
    as_dep: CellDep,
}

fn reg_setup() -> RegFix {
    let mut ctx = Context::default();
    let reg_out = ctx.deploy_cell(bin("token-registry"));
    let as_out = ctx.deploy_cell(bin("always-success"));
    let reg_dep = CellDep::new_builder().out_point(reg_out.clone()).build();
    let as_dep = CellDep::new_builder().out_point(as_out.clone()).build();
    RegFix {
        ctx,
        reg_out,
        as_out,
        reg_dep,
        as_dep,
    }
}

/// Registration create tx: a registration cell (type=token-registry) + (optional) fee to the
/// treasury, funded by a capacity input that is (optionally) the owner's: the co-sign.
fn build_reg_create(
    f: &mut RegFix,
    treasury_lock: PackedScript,
    fee: u64,
    pay_fee: bool,
    include_owner: bool,
    good_token: bool,
) -> ckb_testtool::ckb_types::core::TransactionView {
    let owner_lock = f
        .ctx
        .build_script(&f.as_out, Bytes::from(vec![0x0e]))
        .unwrap();
    let owner_hash: [u8; 32] = owner_lock.calc_script_hash().unpack();
    let treasury_hash: [u8; 32] = treasury_lock.calc_script_hash().unpack();
    let other_lock = f
        .ctx
        .build_script(&f.as_out, Bytes::from(vec![0xff]))
        .unwrap();
    // The token_type_hash must derive from the owner (xUDT{code, args: owner_hash}); `good_token=false`
    // simulates a shadow claiming a token the owner does not control.
    let token_hash = if good_token {
        token_hash_for_owner(&owner_hash)
    } else {
        [0xaau8; 32]
    };

    let mut args = Vec::with_capacity(72); // treasury(32) || fee(8 LE) || token_type_hash(32)
    args.extend_from_slice(&treasury_hash);
    args.extend_from_slice(&fee.to_le_bytes());
    args.extend_from_slice(&token_hash);
    let reg_type = f.ctx.build_script(&f.reg_out, Bytes::from(args)).unwrap();

    let mut data = Vec::new(); // owner_lock_hash(32) || metadata
    data.extend_from_slice(&owner_hash);
    data.push(8u8); // decimals (informational)

    let cap_in = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64.pack())
            .lock(if include_owner {
                owner_lock.clone()
            } else {
                other_lock
            })
            .build(),
        Bytes::new(),
    );

    let mut b = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(cap_in).build())
        .output(
            CellOutput::new_builder()
                .capacity(20_000_000_000u64.pack())
                .lock(owner_lock)
                .type_(Some(reg_type).pack())
                .build(),
        )
        .output_data(Bytes::from(data).pack())
        .cell_dep(f.reg_dep.clone())
        .cell_dep(f.as_dep.clone());
    if pay_fee {
        b = b
            .output(
                CellOutput::new_builder()
                    .capacity(fee.pack())
                    .lock(treasury_lock)
                    .build(),
            )
            .output_data(Bytes::new().pack());
    }
    b.build()
}

#[test]
fn registry_create_with_fee_and_owner_passes() {
    let mut f = reg_setup();
    let tx = build_reg_create(
        &mut f,
        platform_treasury_lock(),
        REG_MIN_FEE,
        true,
        true,
        true,
    );
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_ok(),
        "platform fee + owner co-sign + owner-derived token should register"
    );
}

#[test]
fn registry_create_without_fee_fails() {
    let mut f = reg_setup();
    let tx = build_reg_create(
        &mut f,
        platform_treasury_lock(),
        REG_MIN_FEE,
        false,
        true,
        true,
    );
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "no fee to treasury must fail"
    );
}

#[test]
fn registry_create_without_owner_fails() {
    let mut f = reg_setup();
    let tx = build_reg_create(
        &mut f,
        platform_treasury_lock(),
        REG_MIN_FEE,
        true,
        false,
        true,
    );
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "no owner co-sign must fail"
    );
}

#[test]
fn registry_create_wrong_treasury_rejected() {
    // The fee must go to the pinned platform treasury.
    // A registration naming a non-platform treasury (even if that treasury is paid) must be rejected,
    // so a registrant cannot redirect the fee to themselves.
    let mut f = reg_setup();
    let attacker_treasury = f
        .ctx
        .build_script(&f.as_out, Bytes::from(vec![0x77]))
        .unwrap();
    let tx = build_reg_create(&mut f, attacker_treasury, REG_MIN_FEE, true, true, true);
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "a non-platform treasury must be rejected"
    );
}

#[test]
fn registry_create_fee_below_floor_rejected() {
    // The declared fee must be >= MIN_REGISTRATION_FEE.
    // A registration to the platform treasury but below the floor (here MIN-1) must be rejected, so a
    // registrant cannot set a fee of 0 / a token dust amount.
    let mut f = reg_setup();
    let tx = build_reg_create(
        &mut f,
        platform_treasury_lock(),
        REG_MIN_FEE - 1,
        true,
        true,
        true,
    );
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "a fee below the pinned floor must be rejected"
    );
}

#[test]
fn registry_create_owner_token_mismatch_rejected() {
    // The args token_type_hash must derive from the owner lock
    // (xUDT{code, args: owner_lock_hash}). A shadow registration claiming a token the owner does not
    // control (good_token=false) must be rejected at creation.
    let mut f = reg_setup();
    let tx = build_reg_create(
        &mut f,
        platform_treasury_lock(),
        REG_MIN_FEE,
        true,
        true,
        false,
    );
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "a token_type_hash not derived from the owner must be rejected"
    );
}

// ─── Staking tests (secure receipt + custody, self-advancing accumulator) ──────
//
// These cover the lock-only creation hole: positions are receipt + custody
// cells forced (by stake-guard) through the stake-pool type script, which pins acc_at_touch at
// creation and bounds every reward release to the accrued `pending`.

const MIN_STAKEPOOL_CAPACITY: u64 = 30_000_000_000; // 300 CKB (must match the contract)
const ACC_PRECISION: u128 = 1_000_000_000_000; // 1e12

/// stake-pool 91-byte data layout.
#[allow(clippy::too_many_arguments)]
fn pool_data(
    stake_token: [u8; 32],
    total: u128,
    acc: u128,
    reserve: u128,
    last_epoch: u64,
    emission_bps: u16,
    paused: u8,
) -> Bytes {
    let mut d = vec![0u8; 91];
    d[0..32].copy_from_slice(&stake_token);
    d[32..48].copy_from_slice(&u128le(total));
    d[48..64].copy_from_slice(&u128le(acc));
    d[64..80].copy_from_slice(&u128le(reserve));
    d[80..88].copy_from_slice(&last_epoch.to_le_bytes());
    d[88..90].copy_from_slice(&u16le(emission_bps));
    d[90] = paused;
    d.into()
}

/// receipt data: amount(16) || acc_at_touch(16).
fn receipt_data(amount: u128, acc_at_touch: u128) -> Bytes {
    let mut d = Vec::with_capacity(32);
    d.extend_from_slice(&u128le(amount));
    d.extend_from_slice(&u128le(acc_at_touch));
    d.into()
}

struct StakeFix {
    ctx: Context,
    pool_dep: CellDep,
    guard_dep: CellDep,
    as_dep: CellDep,
    guard_out: ckb_testtool::ckb_types::packed::OutPoint,
    as_out: ckb_testtool::ckb_types::packed::OutPoint,
    pool_type: ckb_testtool::ckb_types::packed::Script,
    pool_type_hash: [u8; 32],
    stake_token_type: ckb_testtool::ckb_types::packed::Script,
    stake_token_hash: [u8; 32],
    owner_lock: ckb_testtool::ckb_types::packed::Script,
    owner_hash: [u8; 32],
    pool_lock: ckb_testtool::ckb_types::packed::Script, // always-success lock on the pool cell
    owner_guard: ckb_testtool::ckb_types::packed::Script, // stake-guard bound to pool + owner
    authority_lock: ckb_testtool::ckb_types::packed::Script, // governance authority (gates genesis/admin)
    authority_hash: [u8; 32],
}

fn stake_setup(seed: u8) -> StakeFix {
    let mut ctx = Context::default();
    let pool_out = ctx.deploy_cell(bin("stake-pool"));
    let guard_out = ctx.deploy_cell(bin("stake-guard"));
    let as_out = ctx.deploy_cell(bin("always-success"));

    let pool_dep = CellDep::new_builder().out_point(pool_out.clone()).build();
    let guard_dep = CellDep::new_builder().out_point(guard_out.clone()).build();
    let as_dep = CellDep::new_builder().out_point(as_out.clone()).build();

    // stake-guard code hash = data hash of its binary (we build guard scripts with Data1).
    let guard_code_hash = lock_out_code_hash(&ctx, &guard_out);

    // Governance authority (gates stake-pool genesis + admin ops). Distinct from the owner
    // and pool locks so ordinary spend tests have no authority input present.
    let authority_lock = ctx.build_script(&as_out, Bytes::from(vec![0xa7])).unwrap();
    let authority_hash: [u8; 32] = authority_lock.calc_script_hash().unpack();

    // stake-pool args = guard_code_hash(32) || seed/type_id(32) || governance_authority(32)
    let mut pool_args = Vec::with_capacity(96);
    pool_args.extend_from_slice(&guard_code_hash);
    pool_args.extend_from_slice(&[seed; 32]);
    pool_args.extend_from_slice(&authority_hash);
    let pool_type = ctx.build_script(&pool_out, Bytes::from(pool_args)).unwrap();
    let pool_type_hash: [u8; 32] = pool_type.calc_script_hash().unpack();

    // Stand-in xUDT (stake token) + owner lock.
    let stake_token_type = ctx.build_script(&as_out, Bytes::from(vec![0x5a])).unwrap();
    let stake_token_hash: [u8; 32] = stake_token_type.calc_script_hash().unpack();
    let owner_lock = ctx.build_script(&as_out, Bytes::from(vec![0x0e])).unwrap();
    let owner_hash: [u8; 32] = owner_lock.calc_script_hash().unpack();

    // Always-success lock on the pool cell (permissionless: anyone can stake/poke the singleton).
    let pool_lock = ctx.build_script(&as_out, Bytes::from(vec![0x01])).unwrap();

    // stake-guard (Data1, code_hash = guard data hash) bound to this pool + owner.
    let mut ga = Vec::with_capacity(64);
    ga.extend_from_slice(&pool_type_hash);
    ga.extend_from_slice(&owner_hash);
    let owner_guard = ctx
        .build_script_with_hash_type(&guard_out, ScriptHashType::Data1, Bytes::from(ga))
        .unwrap();

    StakeFix {
        ctx,
        pool_dep,
        guard_dep,
        as_dep,
        guard_out,
        as_out,
        pool_type,
        pool_type_hash,
        stake_token_type,
        stake_token_hash,
        owner_lock,
        owner_hash,
        pool_lock,
        owner_guard,
        authority_lock,
        authority_hash,
    }
}

impl StakeFix {
    /// Add a header dep with the given epoch number; returns its hash to attach to a tx.
    fn header_dep(&mut self, epoch: u64) -> ckb_testtool::ckb_types::packed::Byte32 {
        let header = HeaderBuilder::default()
            .epoch(
                EpochNumberWithFraction::new(epoch, 0, 1)
                    .full_value()
                    .pack(),
            )
            .build();
        let hash = header.hash();
        self.ctx.insert_header(header);
        hash
    }

    /// A pool input cell with the given state.
    fn pool_input(
        &mut self,
        cap: u64,
        total: u128,
        acc: u128,
        reserve: u128,
        last_epoch: u64,
        emission_bps: u16,
    ) -> ckb_testtool::ckb_types::packed::OutPoint {
        let lock = self.pool_lock.clone();
        self.ctx.create_cell(
            CellOutput::new_builder()
                .capacity(cap.pack())
                .lock(lock)
                .type_(Some(self.pool_type.clone()).pack())
                .build(),
            pool_data(
                self.stake_token_hash,
                total,
                acc,
                reserve,
                last_epoch,
                emission_bps,
                0,
            ),
        )
    }

    fn pool_output(
        &self,
        cap: u64,
        total: u128,
        acc: u128,
        reserve: u128,
        last_epoch: u64,
        emission_bps: u16,
    ) -> (CellOutput, Bytes) {
        (
            CellOutput::new_builder()
                .capacity(cap.pack())
                .lock(self.pool_lock.clone())
                .type_(Some(self.pool_type.clone()).pack())
                .build(),
            pool_data(
                self.stake_token_hash,
                total,
                acc,
                reserve,
                last_epoch,
                emission_bps,
                0,
            ),
        )
    }
}

/// Build a stake-pool genesis tx whose `type_id` arg is correctly derived from the (single) input
/// and output index 0. `total`/`acc` let a test inject phantom entitlements.
fn build_stake_genesis(
    f: &mut StakeFix,
    cap: u64,
    total: u128,
    acc: u128,
    reserve: u128,
) -> ckb_testtool::ckb_types::core::TransactionView {
    let fund = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity((cap + 10_000_000_000).pack())
            .lock(f.authority_lock.clone()) // genesis is gated by the governance authority
            .build(),
        Bytes::new(),
    );
    let fund_input = CellInput::new_builder().previous_output(fund).build();
    let guard_code_hash = lock_out_code_hash(&f.ctx, &f.guard_out);
    let tid = ckb_type_id(&fund_input, 0);
    let mut pa = Vec::with_capacity(96);
    pa.extend_from_slice(&guard_code_hash);
    pa.extend_from_slice(&tid);
    pa.extend_from_slice(&f.authority_hash);
    let pool_out = f.pool_dep.out_point();
    let pool_type = f.ctx.build_script(&pool_out, Bytes::from(pa)).unwrap();
    let out = CellOutput::new_builder()
        .capacity(cap.pack())
        .lock(f.pool_lock.clone())
        .type_(Some(pool_type).pack())
        .build();
    let data = pool_data(f.stake_token_hash, total, acc, reserve, 5, 1000, 0);
    TransactionBuilder::default()
        .input(fund_input)
        .output(out)
        .output_data(data.pack())
        .cell_dep(f.pool_dep.clone())
        .cell_dep(f.as_dep.clone())
        .build()
}

#[test]
fn stake_genesis_passes() {
    let mut f = stake_setup(1);
    let cap = 50_000_000_000u64; // 500 CKB
    let reserve = (cap - MIN_STAKEPOOL_CAPACITY) as u128; // 200 CKB initial reward reserve
    let tx = build_stake_genesis(&mut f, cap, 0, 0, reserve);
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_ok(),
        "valid genesis should pass"
    );
}

#[test]
fn stake_emission_rerate_requires_authority() {
    // emission_bps is governance-mutable. A re-rate without the governance authority
    // is rejected; with an authority-locked input present it passes (no positions touched).
    let mut f = stake_setup(20);
    let cap = 50_000_000_000u64;
    let reserve = (cap - MIN_STAKEPOOL_CAPACITY) as u128;
    let build = |f: &mut StakeFix,
                 with_authority: bool|
     -> ckb_testtool::ckb_types::core::TransactionView {
        let pool_in = f.pool_input(cap, 0, 0, reserve, 5, 1000);
        let header = f.header_dep(5); // now == last_epoch -> no fold, no positions
        let (pout, pdata) = f.pool_output(cap, 0, 0, reserve, 5, 500); // emission 1000 -> 500
        let mut b = TransactionBuilder::default()
            .input(CellInput::new_builder().previous_output(pool_in).build())
            .output(pout)
            .output_data(pdata.pack());
        if with_authority {
            let auth = f.ctx.create_cell(
                CellOutput::new_builder()
                    .capacity(10_000_000_000u64.pack())
                    .lock(f.authority_lock.clone())
                    .build(),
                Bytes::new(),
            );
            b = b.input(CellInput::new_builder().previous_output(auth).build());
        }
        b.cell_dep(f.pool_dep.clone())
            .cell_dep(f.guard_dep.clone())
            .cell_dep(f.as_dep.clone())
            .header_dep(header)
            .build()
    };
    let without = build(&mut f, false);
    assert!(
        f.ctx.verify_tx(&without, MAX_CYCLES).is_err(),
        "re-rate without governance authority must be rejected"
    );
    let with = build(&mut f, true);
    assert!(
        f.ctx.verify_tx(&with, MAX_CYCLES).is_ok(),
        "re-rate with the governance authority should pass"
    );
}

#[test]
fn stake_genesis_phantom_rewards_rejected() {
    // A genesis pool that claims acc>0 or total_staked>0 (phantom entitlements) must fail.
    let mut f = stake_setup(2);
    let cap = 50_000_000_000u64;
    let reserve = (cap - MIN_STAKEPOOL_CAPACITY) as u128;
    let tx = build_stake_genesis(&mut f, cap, 1_000_000, 5, reserve); // total/acc nonzero
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "genesis with phantom rewards must fail"
    );
}

#[test]
fn stake_genesis_non_type_id_seed_rejected() {
    // A pool whose args[32..64] is a free salt (not the canonical type-id)
    // must be rejected at genesis. Otherwise an attacker could re-use a rich pool's salt to mint a
    // twin pool with a colliding type hash and drain the rich pool's reward vault with a cheap
    // receipt. f.pool_type carries args = guard ‖ [seed;32], which is not a valid type-id.
    let mut f = stake_setup(7);
    let cap = 50_000_000_000u64;
    let reserve = (cap - MIN_STAKEPOOL_CAPACITY) as u128;
    let fund = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(60_000_000_000u64.pack())
            .lock(f.owner_lock.clone())
            .build(),
        Bytes::new(),
    );
    let (out, data) = f.pool_output(cap, 0, 0, reserve, 5, 1000);
    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(fund).build())
        .output(out)
        .output_data(data.pack())
        .cell_dep(f.pool_dep.clone())
        .cell_dep(f.as_dep.clone())
        .build();
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "genesis with a non-type-id seed must fail"
    );
}

/// Build a fresh-stake tx: pool(total t0 → t0+amt), new receipt + custody for `amt`.
/// `receipt_acc` lets tests forge a wrong acc_at_touch.
fn build_stake(
    f: &mut StakeFix,
    amt: u128,
    receipt_acc: u128,
) -> ckb_testtool::ckb_types::core::TransactionView {
    let cap = 50_000_000_000u64;
    let reserve = (cap - MIN_STAKEPOOL_CAPACITY) as u128;
    // total_staked = 0 in → no accrual on this op; acc stays 0.
    let pool_in = f.pool_input(cap, 0, 0, reserve, 5, 1000);
    let header = f.header_dep(5);
    let (pout, pdata) = f.pool_output(cap, amt, 0, reserve, 5, 1000);

    let guard = f.owner_guard.clone();
    // user supplies the staked xUDT
    let xudt_in = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(20_000_000_000u64.pack())
            .lock(f.owner_lock.clone())
            .type_(Some(f.stake_token_type.clone()).pack())
            .build(),
        Bytes::from(u128le(amt)),
    );
    let receipt_out = CellOutput::new_builder()
        .capacity(15_000_000_000u64.pack())
        .lock(f.owner_lock.clone())
        .type_(Some(guard.clone()).pack())
        .build();
    let custody_out = CellOutput::new_builder()
        .capacity(15_000_000_000u64.pack())
        .lock(guard)
        .type_(Some(f.stake_token_type.clone()).pack())
        .build();

    TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(pool_in).build())
        .input(CellInput::new_builder().previous_output(xudt_in).build())
        .output(pout)
        .output_data(pdata.pack())
        .output(receipt_out)
        .output_data(receipt_data(amt, receipt_acc).pack())
        .output(custody_out)
        .output_data(Bytes::from(u128le(amt)).pack())
        .cell_dep(f.pool_dep.clone())
        .cell_dep(f.guard_dep.clone())
        .cell_dep(f.as_dep.clone())
        .header_dep(header)
        .build()
}

#[test]
fn stake_fresh_position_passes() {
    let mut f = stake_setup(3);
    let tx = build_stake(&mut f, 1_000_000, 0); // acc_at_touch correctly pinned to 0
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_ok(),
        "a correctly-pinned fresh stake should pass"
    );
}

#[test]
fn stake_receipt_lock_owner_mismatch_rejected() {
    // A receipt whose actual lock differs from its
    // declared owner (guard args[32..64]) must be rejected. Otherwise a third party manufactures a
    // receipt bearing a victim's owner field under an attacker lock and pairs it (matched only by
    // (owner, amount)) with the victim's custody to move/destroy the victim's principal, breaking
    // "principal is always withdrawable". Here: an otherwise-valid fresh stake, but the receipt is
    // locked by a lock different from its owner field.
    let mut f = stake_setup(9);
    let cap = 50_000_000_000u64;
    let reserve = (cap - MIN_STAKEPOOL_CAPACITY) as u128;
    let amt = 1_000_000u128;
    let pool_in = f.pool_input(cap, 0, 0, reserve, 5, 1000);
    let header = f.header_dep(5);
    let (pout, pdata) = f.pool_output(cap, amt, 0, reserve, 5, 1000);
    let guard = f.owner_guard.clone(); // owner field = f.owner_hash
    let attacker_lock = f
        .ctx
        .build_script(&f.as_out, Bytes::from(vec![0xaa]))
        .unwrap();
    let xudt_in = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(20_000_000_000u64.pack())
            .lock(f.owner_lock.clone())
            .type_(Some(f.stake_token_type.clone()).pack())
            .build(),
        Bytes::from(u128le(amt)),
    );
    let receipt_out = CellOutput::new_builder()
        .capacity(15_000_000_000u64.pack())
        .lock(attacker_lock) // <-- lock != owner field
        .type_(Some(guard.clone()).pack())
        .build();
    let custody_out = CellOutput::new_builder()
        .capacity(15_000_000_000u64.pack())
        .lock(guard)
        .type_(Some(f.stake_token_type.clone()).pack())
        .build();
    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(pool_in).build())
        .input(CellInput::new_builder().previous_output(xudt_in).build())
        .output(pout)
        .output_data(pdata.pack())
        .output(receipt_out)
        .output_data(receipt_data(amt, 0).pack())
        .output(custody_out)
        .output_data(Bytes::from(u128le(amt)).pack())
        .cell_dep(f.pool_dep.clone())
        .cell_dep(f.guard_dep.clone())
        .cell_dep(f.as_dep.clone())
        .header_dep(header)
        .build();
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "a receipt whose lock != its owner field must be rejected"
    );
}

#[test]
fn stake_forged_acc_at_touch_rejected() {
    // The lock-only attack: a position created with acc_at_touch != live acc. The pool type
    // script runs on creation and rejects it. (Here acc=0 but the receipt claims a huge acc would
    // be the inverse; we forge a nonzero acc_at_touch while live acc is 0 → still must be rejected
    // because it doesn't equal the live acc.)
    let mut f = stake_setup(4);
    let tx = build_stake(&mut f, 1_000_000, 999); // acc_at_touch=999 != live acc 0
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "mis-pinned acc_at_touch must be rejected"
    );
}

#[test]
fn stake_custody_mismatch_rejected() {
    // Receipt principal must equal the custodied xUDT. Build a stake where custody < receipt.
    let mut f = stake_setup(5);
    let cap = 50_000_000_000u64;
    let reserve = (cap - MIN_STAKEPOOL_CAPACITY) as u128;
    let pool_in = f.pool_input(cap, 0, 0, reserve, 5, 1000);
    let header = f.header_dep(5);
    let (pout, pdata) = f.pool_output(cap, 1_000_000, 0, reserve, 5, 1000);
    let guard = f.owner_guard.clone();
    let receipt_out = CellOutput::new_builder()
        .capacity(15_000_000_000u64.pack())
        .lock(f.owner_lock.clone())
        .type_(Some(guard.clone()).pack())
        .build();
    let custody_out = CellOutput::new_builder()
        .capacity(15_000_000_000u64.pack())
        .lock(guard)
        .type_(Some(f.stake_token_type.clone()).pack())
        .build();
    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(pool_in).build())
        .output(pout)
        .output_data(pdata.pack())
        .output(receipt_out)
        .output_data(receipt_data(1_000_000, 0).pack()) // receipt says 1_000_000
        .output(custody_out)
        .output_data(Bytes::from(u128le(500_000)).pack()) // custody only holds 500_000
        .cell_dep(f.pool_dep.clone())
        .cell_dep(f.guard_dep.clone())
        .cell_dep(f.as_dep.clone())
        .header_dep(header)
        .build();
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "custody must equal receipt principal"
    );
}

#[test]
fn stake_receipt_without_pool_rejected() {
    // Core check: a receipt cell created without spending the pool. stake-guard (the
    // receipt's type script) runs on creation and rejects it (pool not in inputs). This is the
    // unchecked-creation path that the lock-only design left open.
    let mut f = stake_setup(6);
    let guard = f.owner_guard.clone();
    let fund = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(60_000_000_000u64.pack())
            .lock(f.owner_lock.clone())
            .build(),
        Bytes::new(),
    );
    let receipt_out = CellOutput::new_builder()
        .capacity(15_000_000_000u64.pack())
        .lock(f.owner_lock.clone())
        .type_(Some(guard).pack())
        .build();
    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(fund).build())
        .output(receipt_out)
        .output_data(receipt_data(1_000_000, 0).pack())
        .cell_dep(f.guard_dep.clone())
        .cell_dep(f.as_dep.clone())
        .build();
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "a receipt cannot be created without spending the pool"
    );
}

/// Build a claim tx against a position of `amount` staked since `acc_at_touch`, with the pool
/// folding from `last_epoch` to `now`. `release` = CKB the pool pays out (cap drop).
fn build_claim(
    f: &mut StakeFix,
    amount: u128,
    acc_at_touch: u128,
    last_epoch: u64,
    now: u64,
    emission_bps: u16,
    release: u64,
) -> (ckb_testtool::ckb_types::core::TransactionView, u128) {
    let cap = 50_000_000_000u64;
    let reserve = (cap - MIN_STAKEPOOL_CAPACITY) as u128;
    // Replicate the contract fold to compute acc/reserve after.
    let (acc_after, reserve_after) = {
        if amount == 0 || now <= last_epoch {
            (0u128, reserve)
        } else {
            let elapsed = (now - last_epoch) as u128;
            let mut streamed = reserve * (emission_bps as u128) * elapsed / 10_000;
            if streamed > reserve {
                streamed = reserve;
            }
            let acc_add = streamed * ACC_PRECISION / amount; // amount == total_staked here
                                                             // Fold remainder: debit only what was credited to acc, mirroring the contract.
            let distributed = acc_add * amount / ACC_PRECISION;
            (acc_add, reserve - distributed)
        }
    };
    let pool_in = f.pool_input(cap, amount, 0, reserve, last_epoch, emission_bps);
    let header = f.header_dep(now);
    let cap_out = cap - release;
    let (pout, pdata) = f.pool_output(cap_out, amount, acc_after, reserve_after, now, emission_bps);

    let guard = f.owner_guard.clone();
    // existing position: receipt + custody in, recreated (claim keeps principal).
    let receipt_in = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(15_000_000_000u64.pack())
            .lock(f.owner_lock.clone())
            .type_(Some(guard.clone()).pack())
            .build(),
        receipt_data(amount, acc_at_touch),
    );
    let custody_in = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(15_000_000_000u64.pack())
            .lock(guard.clone())
            .type_(Some(f.stake_token_type.clone()).pack())
            .build(),
        Bytes::from(u128le(amount)),
    );
    let receipt_out = CellOutput::new_builder()
        .capacity(15_000_000_000u64.pack())
        .lock(f.owner_lock.clone())
        .type_(Some(guard.clone()).pack())
        .build();
    let custody_out = CellOutput::new_builder()
        .capacity(15_000_000_000u64.pack())
        .lock(guard)
        .type_(Some(f.stake_token_type.clone()).pack())
        .build();

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(pool_in).build())
        .input(CellInput::new_builder().previous_output(receipt_in).build())
        .input(CellInput::new_builder().previous_output(custody_in).build())
        .output(pout)
        .output_data(pdata.pack())
        .output(receipt_out)
        .output_data(receipt_data(amount, acc_after).pack()) // acc_at_touch advanced
        .output(custody_out)
        .output_data(Bytes::from(u128le(amount)).pack())
        .cell_dep(f.pool_dep.clone())
        .cell_dep(f.guard_dep.clone())
        .cell_dep(f.as_dep.clone())
        .header_dep(header)
        .build();
    // pending = amount * acc_after / PREC (acc_at_touch entered as 0 in pool_input)
    let pending = amount * acc_after / ACC_PRECISION;
    (tx, pending)
}

#[test]
fn claim_pays_accrued_reward() {
    let mut f = stake_setup(7);
    // 1 epoch elapses at 10%/epoch over a 200 CKB reserve, 1e6 staked.
    let (_tx, pending) = build_claim(&mut f, 1_000_000, 0, 5, 6, 1000, 0);
    let tx = build_claim(&mut f, 1_000_000, 0, 5, 6, 1000, pending as u64).0;
    assert!(pending > 0, "test should accrue a nonzero reward");
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_ok(),
        "claiming exactly the accrued reward should pass"
    );
}

#[test]
fn claim_overpay_rejected() {
    let mut f = stake_setup(8);
    let (_tx, pending) = build_claim(&mut f, 1_000_000, 0, 5, 6, 1000, 0);
    // Release more than the accrued pending → must fail.
    let tx = build_claim(
        &mut f,
        1_000_000,
        0,
        5,
        6,
        1000,
        pending as u64 + 1_000_000_000,
    )
    .0;
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "releasing more than the accrued reward must fail"
    );
}

#[test]
fn fund_increases_reserve() {
    // Permissionless fund: add 50 CKB to capacity and reserve, no positions touched.
    let mut f = stake_setup(9);
    let cap = 50_000_000_000u64;
    let reserve = (cap - MIN_STAKEPOOL_CAPACITY) as u128;
    let pool_in = f.pool_input(cap, 0, 0, reserve, 5, 1000); // total=0 → no accrual
    let header = f.header_dep(7);
    let add = 5_000_000_000u64; // 50 CKB
    let funder = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(10_000_000_000u64.pack())
            .lock(f.owner_lock.clone())
            .build(),
        Bytes::new(),
    );
    let (pout, pdata) = f.pool_output(cap + add, 0, 0, reserve + add as u128, 7, 1000);
    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(pool_in).build())
        .input(CellInput::new_builder().previous_output(funder).build())
        .output(pout)
        .output_data(pdata.pack())
        .cell_dep(f.pool_dep.clone())
        .cell_dep(f.as_dep.clone())
        .header_dep(header)
        .build();
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_ok(),
        "funding the reserve should pass"
    );
}

#[test]
fn fund_skim_capacity_rejected() {
    // Claiming reserve growth without actually adding the CKB (cap unchanged) must fail.
    let mut f = stake_setup(10);
    let cap = 50_000_000_000u64;
    let reserve = (cap - MIN_STAKEPOOL_CAPACITY) as u128;
    let pool_in = f.pool_input(cap, 0, 0, reserve, 5, 1000);
    let header = f.header_dep(7);
    let funder = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(10_000_000_000u64.pack())
            .lock(f.owner_lock.clone())
            .build(),
        Bytes::new(),
    );
    // reserve grows by 50 CKB but capacity does not → unbacked reserve.
    let (pout, pdata) = f.pool_output(cap, 0, 0, reserve + 5_000_000_000u128, 7, 1000);
    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(pool_in).build())
        .input(CellInput::new_builder().previous_output(funder).build())
        .output(pout)
        .output_data(pdata.pack())
        .cell_dep(f.pool_dep.clone())
        .cell_dep(f.as_dep.clone())
        .header_dep(header)
        .build();
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "reserve growth must be backed by added CKB"
    );
}

// ─── Protocol-fee (_mintFee) tests ────────────────────────────────────────────
//
// k_last == 0 is fee off. When on, every liquidity event / collect
// mints the protocol's 1/6 cut of the growth in sqrt(k) as LP to the treasury and advances k_last.
// Enabling the switch requires the treasury authority co-sign.

const PROTOCOL_FEE_DENOM: u128 = 6;

fn fee_lp(lp_supply: u128, root_k: u128, root_k_last: u128) -> u128 {
    if root_k_last == 0 || root_k <= root_k_last {
        return 0;
    }
    let num = (root_k - root_k_last) * lp_supply;
    let den = root_k * (PROTOCOL_FEE_DENOM - 1) + root_k_last;
    num / den
}

/// 156-byte info data with an explicit k_last (xUDT/xUDT mode, fee tier 30).
fn info156(token_x: [u8; 32], token_y: [u8; 32], lp: u128, k_last: u128) -> Bytes {
    let mut d = vec![0u8; 156];
    d[0..32].copy_from_slice(&token_x);
    d[32..64].copy_from_slice(&token_y);
    d[64..80].copy_from_slice(&u128le(lp));
    d[80..82].copy_from_slice(&u16le(30));
    d[82..98].copy_from_slice(&u128le(777));
    d[140..156].copy_from_slice(&u128le(k_last));
    d.into()
}

struct FeeFix {
    ctx: Context,
    pool_dep: CellDep,
    lock_dep: CellDep,
    lp_dep: CellDep,
    as_dep: CellDep,
    pool_type: ckb_testtool::ckb_types::packed::Script,
    pool_lock: ckb_testtool::ckb_types::packed::Script,
    lp_token: ckb_testtool::ckb_types::packed::Script,
    token_x_type: ckb_testtool::ckb_types::packed::Script,
    token_y_type: ckb_testtool::ckb_types::packed::Script,
    treasury_lock: ckb_testtool::ckb_types::packed::Script,
    user_lock: ckb_testtool::ckb_types::packed::Script,
}

fn fee_setup() -> FeeFix {
    let mut ctx = Context::default();
    let pool_out = ctx.deploy_cell(bin("pool-script"));
    let lock_out = ctx.deploy_cell(bin("pool-lock"));
    let lp_out = ctx.deploy_cell(bin("lp-token"));
    let as_out = ctx.deploy_cell(bin("always-success"));
    let pool_dep = CellDep::new_builder().out_point(pool_out.clone()).build();
    let lock_dep = CellDep::new_builder().out_point(lock_out.clone()).build();
    let lp_dep = CellDep::new_builder().out_point(lp_out.clone()).build();
    let as_dep = CellDep::new_builder().out_point(as_out.clone()).build();

    let pool_lock_code_hash = lock_out_code_hash(&ctx, &lock_out);
    let lp_token_code_hash = lock_out_code_hash(&ctx, &lp_out);
    let treasury_lock = ctx.build_script(&as_out, Bytes::from(vec![0x77])).unwrap();
    let treasury_hash: [u8; 32] = treasury_lock.calc_script_hash().unpack();

    let mut args = Vec::with_capacity(96);
    args.extend_from_slice(&pool_lock_code_hash);
    args.extend_from_slice(&lp_token_code_hash);
    args.extend_from_slice(&treasury_hash);
    let pool_type = ctx.build_script(&pool_out, Bytes::from(args)).unwrap();
    let info_type_hash: [u8; 32] = pool_type.calc_script_hash().unpack();

    let pool_lock = ctx
        .build_script_with_hash_type(
            &lock_out,
            ScriptHashType::Data1,
            Bytes::from(info_type_hash.to_vec()),
        )
        .unwrap();
    let lp_token = ctx
        .build_script_with_hash_type(
            &lp_out,
            ScriptHashType::Data1,
            Bytes::from(info_type_hash.to_vec()),
        )
        .unwrap();
    let token_x_type = ctx.build_script(&as_out, Bytes::from(vec![0xa1])).unwrap();
    let token_y_type = ctx.build_script(&as_out, Bytes::from(vec![0xb2])).unwrap();
    let user_lock = ctx.build_script(&as_out, Bytes::from(vec![0xcc])).unwrap();

    FeeFix {
        ctx,
        pool_dep,
        lock_dep,
        lp_dep,
        as_dep,
        pool_type,
        pool_lock,
        lp_token,
        token_x_type,
        token_y_type,
        treasury_lock,
        user_lock,
    }
}

impl FeeFix {
    fn token_x_hash(&self) -> [u8; 32] {
        self.token_x_type.calc_script_hash().unpack()
    }
    fn token_y_hash(&self) -> [u8; 32] {
        self.token_y_type.calc_script_hash().unpack()
    }
}

/// Build a reserves-unchanged tx (collect or fee-enable): info in/out + reserve cells (r,r) on both
/// sides + optionally a treasury LP mint + optionally a treasury-authority input.
#[allow(clippy::too_many_arguments)]
fn build_unchanged(
    f: &mut FeeFix,
    r: u128,
    lp_in: u128,
    k_in: u128,
    lp_out: u128,
    k_out: u128,
    treasury_lp: u128,
    lp_to_treasury_lock: bool,
    include_authority: bool,
) -> ckb_testtool::ckb_types::core::TransactionView {
    let tx = f.token_x_hash();
    let ty = f.token_y_hash();
    let info_in = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(MIN_POOL_CAPACITY.pack())
            .lock(f.user_lock.clone())
            .type_(Some(f.pool_type.clone()).pack())
            .build(),
        info156(tx, ty, lp_in, k_in),
    );
    let rx_in = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(14_400_000_000u64.pack())
            .lock(f.pool_lock.clone())
            .type_(Some(f.token_x_type.clone()).pack())
            .build(),
        reserve_data(r),
    );
    let ry_in = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(14_400_000_000u64.pack())
            .lock(f.pool_lock.clone())
            .type_(Some(f.token_y_type.clone()).pack())
            .build(),
        reserve_data(r),
    );

    let mut b = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(info_in).build())
        .input(CellInput::new_builder().previous_output(rx_in).build())
        .input(CellInput::new_builder().previous_output(ry_in).build())
        .output(
            CellOutput::new_builder()
                .capacity(MIN_POOL_CAPACITY.pack())
                .lock(f.user_lock.clone())
                .type_(Some(f.pool_type.clone()).pack())
                .build(),
        )
        .output_data(info156(tx, ty, lp_out, k_out).pack())
        .output(
            CellOutput::new_builder()
                .capacity(14_400_000_000u64.pack())
                .lock(f.pool_lock.clone())
                .type_(Some(f.token_x_type.clone()).pack())
                .build(),
        )
        .output_data(reserve_data(r).pack())
        .output(
            CellOutput::new_builder()
                .capacity(14_400_000_000u64.pack())
                .lock(f.pool_lock.clone())
                .type_(Some(f.token_y_type.clone()).pack())
                .build(),
        )
        .output_data(reserve_data(r).pack())
        .cell_dep(f.pool_dep.clone())
        .cell_dep(f.lock_dep.clone())
        .cell_dep(f.lp_dep.clone())
        .cell_dep(f.as_dep.clone());

    if treasury_lp > 0 {
        let lock = if lp_to_treasury_lock {
            f.treasury_lock.clone()
        } else {
            f.user_lock.clone()
        };
        b = b
            .output(
                CellOutput::new_builder()
                    .capacity(14_400_000_000u64.pack())
                    .lock(lock)
                    .type_(Some(f.lp_token.clone()).pack())
                    .build(),
            )
            .output_data(Bytes::from(u128le(treasury_lp)).pack());
    }
    if include_authority {
        let auth = f.ctx.create_cell(
            CellOutput::new_builder()
                .capacity(20_000_000_000u64.pack())
                .lock(f.treasury_lock.clone())
                .build(),
            Bytes::new(),
        );
        b = b.input(CellInput::new_builder().previous_output(auth).build());
    }
    b.build()
}

#[test]
fn fee_enable_with_authority_passes() {
    let mut f = fee_setup();
    let tx = build_unchanged(
        &mut f, 1_000_000, 1_000_000, 0, 1_000_000, 1_000_000, 0, false, true,
    );
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_ok(),
        "treasury-authorized fee enable should pass"
    );
}

#[test]
fn fee_enable_without_authority_fails() {
    let mut f = fee_setup();
    let tx = build_unchanged(
        &mut f, 1_000_000, 1_000_000, 0, 1_000_000, 1_000_000, 0, false, false,
    );
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "enabling the fee without treasury co-sign must fail"
    );
}

#[test]
fn fee_collect_mints_to_treasury_passes() {
    let mut f = fee_setup();
    let fee = fee_lp(1_000_000, 1_000_000, 990_000);
    assert!(fee > 0, "test should accrue a fee");
    let tx = build_unchanged(
        &mut f,
        1_000_000,
        1_000_000,
        990_000,
        1_000_000 + fee,
        1_000_000,
        fee,
        true,
        false,
    );
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_ok(),
        "collecting the protocol fee to the treasury should pass"
    );
}

#[test]
fn fee_collect_to_non_treasury_rejected() {
    let mut f = fee_setup();
    let fee = fee_lp(1_000_000, 1_000_000, 990_000);
    let tx = build_unchanged(
        &mut f,
        1_000_000,
        1_000_000,
        990_000,
        1_000_000 + fee,
        1_000_000,
        fee,
        false,
        false,
    );
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "fee LP not sent to the treasury must be rejected"
    );
}

#[test]
fn fee_collect_skim_supply_rejected() {
    let mut f = fee_setup();
    let fee = fee_lp(1_000_000, 1_000_000, 990_000);
    let tx = build_unchanged(
        &mut f,
        1_000_000,
        1_000_000,
        990_000,
        1_000_000 + fee,
        1_000_000,
        0,
        true,
        false,
    );
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "claiming fee growth without minting the LP must fail"
    );
}

// k_last must be monotonic non-decreasing on collect. With reserves r the current
// root_k == r; if the stored k_last is already above r (reserves were higher before a prior remove),
// a collect that ratchets k_last back down to r would let the treasury later over-mint "phantom fee"
// as price recovers. pool-script pins output.k_last = max(input.k_last, root_k). These two tests
// fail in opposite directions if that becomes `new_k_last = root_k`: the
// down-ratchet wrongly passes (first test) and the pinned-up no-op wrongly fails (second).
#[test]
fn fee_collect_klast_ratchet_down_rejected() {
    let mut f = fee_setup();
    // root_k = r = 1_000_000; stored k_last = 1_100_000 (> root_k). No fee accrues (root_k <= k_last),
    // so lp_supply is unchanged. Output tries to lower k_last back to root_k; must be rejected.
    let down = build_unchanged(
        &mut f, 1_000_000, 1_000_000, 1_100_000, 1_000_000, 1_000_000, 0, false, false,
    );
    assert!(
        f.ctx.verify_tx(&down, MAX_CYCLES).is_err(),
        "lowering k_last below the stored value on collect must be rejected"
    );
}

#[test]
fn fee_collect_klast_pinned_up_passes() {
    let mut f = fee_setup();
    // Same state, but k_last is pinned at the higher stored value (max(k_last, root_k)).
    // No fee, no supply change: the honest no-op collect must pass.
    let pinned = build_unchanged(
        &mut f, 1_000_000, 1_000_000, 1_100_000, 1_000_000, 1_100_000, 0, false, false,
    );
    assert!(
        f.ctx.verify_tx(&pinned, MAX_CYCLES).is_ok(),
        "keeping k_last pinned at max(k_last, root_k) on a zero-fee collect must pass"
    );
}

// ─── Mining-pool tests (stake LP -> earn minted VTX) ────────────────────────
//
// Genesis is governance-authorized and verifies on-chain that the stake token is a CKB/xUDT pool's
// LP. Claims require the total VTX minted to equal the accrued pending. Receipt+custody reuse
// stake-guard (same security model as stake-pool).

const MINING_ACC_PRECISION: u128 = 1_000_000_000_000;

fn mining_pool_data(
    stake_token: [u8; 32],
    total: u128,
    acc: u128,
    last_epoch: u64,
    emission: u64,
) -> Bytes {
    let mut d = vec![0u8; 81];
    d[0..32].copy_from_slice(&stake_token);
    d[32..48].copy_from_slice(&u128le(total));
    d[48..64].copy_from_slice(&u128le(acc));
    d[64..72].copy_from_slice(&last_epoch.to_le_bytes());
    d[72..80].copy_from_slice(&emission.to_le_bytes());
    d.into()
}

struct MineFix {
    ctx: Context,
    mine_dep: CellDep,
    guard_dep: CellDep,
    pool_dep: CellDep,
    as_dep: CellDep,
    pool_out: ckb_testtool::ckb_types::packed::OutPoint,
    lp_out: ckb_testtool::ckb_types::packed::OutPoint,
    as_out: ckb_testtool::ckb_types::packed::OutPoint,
    mine_out: ckb_testtool::ckb_types::packed::OutPoint,
    mine_type: ckb_testtool::ckb_types::packed::Script,
    mine_args_prefix: Vec<u8>, // args[0..161] (everything before the 32-byte type-id seed)
    vtx_type: ckb_testtool::ckb_types::packed::Script,
    authority_lock: ckb_testtool::ckb_types::packed::Script,
    owner_lock: ckb_testtool::ckb_types::packed::Script,
    pool_lock: ckb_testtool::ckb_types::packed::Script,
    owner_guard: ckb_testtool::ckb_types::packed::Script,
}

fn mine_setup(seed: u8) -> MineFix {
    let mut ctx = Context::default();
    let mine_out = ctx.deploy_cell(bin("mining-pool"));
    let guard_out = ctx.deploy_cell(bin("stake-guard"));
    let pool_out = ctx.deploy_cell(bin("pool-script"));
    let lp_out = ctx.deploy_cell(bin("lp-token"));
    let as_out = ctx.deploy_cell(bin("always-success"));

    let mine_dep = CellDep::new_builder().out_point(mine_out.clone()).build();
    let guard_dep = CellDep::new_builder().out_point(guard_out.clone()).build();
    let pool_dep = CellDep::new_builder().out_point(pool_out.clone()).build();
    let as_dep = CellDep::new_builder().out_point(as_out.clone()).build();

    let guard_code_hash = lock_out_code_hash(&ctx, &guard_out);
    let lp_code_hash = lock_out_code_hash(&ctx, &lp_out);
    let vtx_type = ctx.build_script(&as_out, Bytes::from(vec![0xc5])).unwrap();
    let vtx_hash: [u8; 32] = vtx_type.calc_script_hash().unpack();
    let authority_lock = ctx.build_script(&as_out, Bytes::from(vec![0x99])).unwrap();
    let authority_hash: [u8; 32] = authority_lock.calc_script_hash().unpack();
    let owner_lock = ctx.build_script(&as_out, Bytes::from(vec![0x0e])).unwrap();
    let owner_hash: [u8; 32] = owner_lock.calc_script_hash().unpack();
    let pool_lock = ctx.build_script(&as_out, Bytes::from(vec![0x01])).unwrap();

    // pool-script code hash = the type-id code hash a pool-built info cell's type carries.
    let probe = ctx
        .build_script(&pool_out, Bytes::from(vec![0u8; 96]))
        .unwrap();
    let pool_code_hash: [u8; 32] = probe.code_hash().unpack();

    let mut prefix = Vec::with_capacity(161);
    prefix.extend_from_slice(&guard_code_hash);
    prefix.extend_from_slice(&vtx_hash);
    prefix.extend_from_slice(&authority_hash);
    prefix.extend_from_slice(&lp_code_hash);
    prefix.push(2u8); // ScriptHashType::Data1
    prefix.extend_from_slice(&pool_code_hash);
    let mut args = prefix.clone();
    args.extend_from_slice(&[seed; 32]); // free-salt seed; genesis tests override with a real type-id
    let mine_type = ctx.build_script(&mine_out, Bytes::from(args)).unwrap();
    let mine_type_hash: [u8; 32] = mine_type.calc_script_hash().unpack();

    let mut ga = Vec::with_capacity(64);
    ga.extend_from_slice(&mine_type_hash);
    ga.extend_from_slice(&owner_hash);
    let owner_guard = ctx
        .build_script_with_hash_type(&guard_out, ScriptHashType::Data1, Bytes::from(ga))
        .unwrap();

    MineFix {
        ctx,
        mine_dep,
        guard_dep,
        pool_dep,
        as_dep,
        pool_out,
        lp_out,
        as_out,
        mine_out,
        mine_type,
        mine_args_prefix: prefix,
        vtx_type,
        authority_lock,
        owner_lock,
        pool_lock,
        owner_guard,
    }
}

/// Genesis tx: authority input (optional) + the mining-pool output, with an AMM info cell dep of
/// `mode` (1 = CKB/xUDT). `good_stake_token` makes stake_token match the pool's LP hash.
fn build_mine_genesis(
    f: &mut MineFix,
    with_authority: bool,
    mode: u8,
    good_stake_token: bool,
) -> ckb_testtool::ckb_types::core::TransactionView {
    let info_type = f
        .ctx
        .build_script(&f.pool_out, Bytes::from(vec![0u8; 96]))
        .unwrap();
    let info_type_hash: [u8; 32] = info_type.calc_script_hash().unpack();
    let info_cell = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(MIN_POOL_CAPACITY.pack())
            .lock(f.pool_lock.clone())
            .type_(Some(info_type).pack())
            .build(),
        info_data([0u8; 32], [0xb2u8; 32], 1_000_000, 30, 1, mode, 0),
    );
    let info_dep = CellDep::new_builder().out_point(info_cell).build();

    let lp_token = f
        .ctx
        .build_script_with_hash_type(
            &f.lp_out,
            ScriptHashType::Data1,
            Bytes::from(info_type_hash.to_vec()),
        )
        .unwrap();
    let lp_hash: [u8; 32] = lp_token.calc_script_hash().unpack();
    let stake_token = if good_stake_token {
        lp_hash
    } else {
        [0x42u8; 32]
    };

    let fund = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(60_000_000_000u64.pack())
            .lock(if with_authority {
                f.authority_lock.clone()
            } else {
                f.owner_lock.clone()
            })
            .build(),
        Bytes::new(),
    );
    let fund_input = CellInput::new_builder().previous_output(fund).build();
    // Genesis requires the pool_seed (args[161..193]) to be the canonical type-id of this genesis
    // (first input ‖ output index 0). Rebuild the mining-pool type with that seed.
    let tid = ckb_type_id(&fund_input, 0);
    let mut args = f.mine_args_prefix.clone();
    args.extend_from_slice(&tid);
    let mine_type = f.ctx.build_script(&f.mine_out, Bytes::from(args)).unwrap();
    let out = CellOutput::new_builder()
        .capacity(30_000_000_000u64.pack())
        .lock(f.pool_lock.clone())
        .type_(Some(mine_type).pack())
        .build();
    TransactionBuilder::default()
        .input(fund_input)
        .output(out)
        .output_data(mining_pool_data(stake_token, 0, 0, 5, 1000).pack())
        .cell_dep(f.mine_dep.clone())
        .cell_dep(f.pool_dep.clone())
        .cell_dep(f.as_dep.clone())
        .cell_dep(info_dep)
        .build()
}

#[test]
fn mining_genesis_ckb_xudt_lp_passes() {
    let mut f = mine_setup(1);
    let tx = build_mine_genesis(&mut f, true, 1, true);
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_ok(),
        "authorized genesis with a CKB/xUDT LP should pass"
    );
}

#[test]
fn mining_genesis_without_authority_fails() {
    let mut f = mine_setup(2);
    let tx = build_mine_genesis(&mut f, false, 1, true);
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "genesis without the governance authority must fail"
    );
}

#[test]
fn mining_genesis_xudt_xudt_lp_rejected() {
    let mut f = mine_setup(3);
    let tx = build_mine_genesis(&mut f, true, 0, true);
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "staking an xUDT/xUDT pool's LP must be rejected"
    );
}

#[test]
fn mining_genesis_wrong_stake_token_rejected() {
    let mut f = mine_setup(4);
    let tx = build_mine_genesis(&mut f, true, 1, false);
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "stake_token not equal to the pool's LP hash must be rejected"
    );
}

#[test]
fn mining_genesis_non_type_id_seed_rejected() {
    // Type-id parity: a mining genesis whose pool_seed
    // (args[161..193]) is a free salt, not the canonical blake2b(first_input ‖ out_index) type-id,
    // must be rejected. f.mine_type carries seed = [seed;32] (a salt), so this exercises the reject
    // branch of check_type_id (the four passing fixtures all feed the correct type-id).
    let mut f = mine_setup(9);
    let info_type = f
        .ctx
        .build_script(&f.pool_out, Bytes::from(vec![0u8; 96]))
        .unwrap();
    let info_type_hash: [u8; 32] = info_type.calc_script_hash().unpack();
    let info_cell = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(MIN_POOL_CAPACITY.pack())
            .lock(f.pool_lock.clone())
            .type_(Some(info_type).pack())
            .build(),
        info_data([0u8; 32], [0xb2u8; 32], 1_000_000, 30, 1, 1, 0),
    );
    let info_dep = CellDep::new_builder().out_point(info_cell).build();
    let lp_token = f
        .ctx
        .build_script_with_hash_type(
            &f.lp_out,
            ScriptHashType::Data1,
            Bytes::from(info_type_hash.to_vec()),
        )
        .unwrap();
    let lp_hash: [u8; 32] = lp_token.calc_script_hash().unpack();
    let fund = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(60_000_000_000u64.pack())
            .lock(f.authority_lock.clone())
            .build(),
        Bytes::new(),
    );
    // Output uses f.mine_type (seed = [9;32] free salt, not the genesis type-id).
    let out = CellOutput::new_builder()
        .capacity(30_000_000_000u64.pack())
        .lock(f.pool_lock.clone())
        .type_(Some(f.mine_type.clone()).pack())
        .build();
    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(fund).build())
        .output(out)
        .output_data(mining_pool_data(lp_hash, 0, 0, 5, 1000).pack())
        .cell_dep(f.mine_dep.clone())
        .cell_dep(f.pool_dep.clone())
        .cell_dep(f.as_dep.clone())
        .cell_dep(info_dep)
        .build();
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "mining genesis with a non-type-id seed must fail"
    );
}

/// Claim tx (single staker, amount = total) folding `last`->`now`, minting `mint` VTX to the
/// owner. The claim path skips the CKB/xUDT check, so stake_token = the custody type's hash.
fn build_mine_claim(
    f: &mut MineFix,
    amount: u128,
    last: u64,
    now: u64,
    emission: u64,
    mint: u128,
) -> (ckb_testtool::ckb_types::core::TransactionView, u128) {
    let stake_tok_type = f
        .ctx
        .build_script(&f.as_out, Bytes::from(vec![0x5a]))
        .unwrap();
    let stake_token: [u8; 32] = stake_tok_type.calc_script_hash().unpack();
    let acc_after = if amount == 0 || now <= last {
        0u128
    } else {
        (emission as u128) * ((now - last) as u128) * MINING_ACC_PRECISION / amount
    };
    let pending = amount * acc_after / MINING_ACC_PRECISION;
    let guard = f.owner_guard.clone();

    let pool_in = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(30_000_000_000u64.pack())
            .lock(f.pool_lock.clone())
            .type_(Some(f.mine_type.clone()).pack())
            .build(),
        mining_pool_data(stake_token, amount, 0, last, emission),
    );
    let receipt_in = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(20_000_000_000u64.pack())
            .lock(f.owner_lock.clone())
            .type_(Some(guard.clone()).pack())
            .build(),
        receipt_data(amount, 0),
    );
    let custody_in = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(20_000_000_000u64.pack())
            .lock(guard.clone())
            .type_(Some(stake_tok_type.clone()).pack())
            .build(),
        Bytes::from(u128le(amount)),
    );

    let header = HeaderBuilder::default()
        .epoch(EpochNumberWithFraction::new(now, 0, 1).full_value().pack())
        .build();
    let hh = header.hash();
    f.ctx.insert_header(header);

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(pool_in).build())
        .input(CellInput::new_builder().previous_output(receipt_in).build())
        .input(CellInput::new_builder().previous_output(custody_in).build())
        .output(
            CellOutput::new_builder()
                .capacity(30_000_000_000u64.pack())
                .lock(f.pool_lock.clone())
                .type_(Some(f.mine_type.clone()).pack())
                .build(),
        )
        .output_data(mining_pool_data(stake_token, amount, acc_after, now, emission).pack())
        .output(
            CellOutput::new_builder()
                .capacity(20_000_000_000u64.pack())
                .lock(f.owner_lock.clone())
                .type_(Some(guard.clone()).pack())
                .build(),
        )
        .output_data(receipt_data(amount, acc_after).pack())
        .output(
            CellOutput::new_builder()
                .capacity(20_000_000_000u64.pack())
                .lock(guard)
                .type_(Some(stake_tok_type).pack())
                .build(),
        )
        .output_data(Bytes::from(u128le(amount)).pack())
        .output(
            CellOutput::new_builder()
                .capacity(14_400_000_000u64.pack())
                .lock(f.owner_lock.clone())
                .type_(Some(f.vtx_type.clone()).pack())
                .build(),
        )
        .output_data(Bytes::from(u128le(mint)).pack())
        .cell_dep(f.mine_dep.clone())
        .cell_dep(f.guard_dep.clone())
        .cell_dep(f.as_dep.clone())
        .header_dep(hh)
        .build();
    (tx, pending)
}

#[test]
fn mining_claim_mint_equals_pending_passes() {
    let mut f = mine_setup(5);
    let (_t, pending) = build_mine_claim(&mut f, 1_000_000, 5, 6, 1000, 0);
    assert!(pending > 0, "test should accrue a reward");
    let tx = build_mine_claim(&mut f, 1_000_000, 5, 6, 1000, pending).0;
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_ok(),
        "minting exactly the accrued pending should pass"
    );
}

#[test]
fn mining_claim_overmint_rejected() {
    let mut f = mine_setup(6);
    let (_t, pending) = build_mine_claim(&mut f, 1_000_000, 5, 6, 1000, 0);
    let tx = build_mine_claim(&mut f, 1_000_000, 5, 6, 1000, pending + 1).0;
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "minting more VTX than the accrued pending must fail"
    );
}

#[test]
fn mining_receipt_lock_owner_mismatch_rejected() {
    // Owner-lock binding, as in stake-pool: the owner field in the stake-guard args is
    // attacker-writable, so mining-pool must check the receipt's actual spending lock.
    // Otherwise a third party could mint a receipt bearing a victim's
    // owner field under an attacker lock, then pair it with the victim's custody (matched only by
    // (owner, amount)) to drain the victim's staked LP and accrued VTX. mining-pool requires
    // load_cell_lock_hash == owner on both creation and consumption. Here: an
    // otherwise-valid claim, but the output receipt is locked by a lock != its owner field.
    let mut f = mine_setup(11);
    let attacker_lock = f
        .ctx
        .build_script(&f.as_out, Bytes::from(vec![0xaa]))
        .unwrap();
    let amount = 1_000_000u128;
    let (last, now, emission) = (5u64, 6u64, 1000u64);

    let stake_tok_type = f
        .ctx
        .build_script(&f.as_out, Bytes::from(vec![0x5a]))
        .unwrap();
    let stake_token: [u8; 32] = stake_tok_type.calc_script_hash().unpack();
    let acc_after = (emission as u128) * ((now - last) as u128) * MINING_ACC_PRECISION / amount;
    let pending = amount * acc_after / MINING_ACC_PRECISION;
    let guard = f.owner_guard.clone();

    let pool_in = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(30_000_000_000u64.pack())
            .lock(f.pool_lock.clone())
            .type_(Some(f.mine_type.clone()).pack())
            .build(),
        mining_pool_data(stake_token, amount, 0, last, emission),
    );
    let receipt_in = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(20_000_000_000u64.pack())
            .lock(f.owner_lock.clone())
            .type_(Some(guard.clone()).pack())
            .build(),
        receipt_data(amount, 0),
    );
    let custody_in = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(20_000_000_000u64.pack())
            .lock(guard.clone())
            .type_(Some(stake_tok_type.clone()).pack())
            .build(),
        Bytes::from(u128le(amount)),
    );
    let header = HeaderBuilder::default()
        .epoch(EpochNumberWithFraction::new(now, 0, 1).full_value().pack())
        .build();
    let hh = header.hash();
    f.ctx.insert_header(header);

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(pool_in).build())
        .input(CellInput::new_builder().previous_output(receipt_in).build())
        .input(CellInput::new_builder().previous_output(custody_in).build())
        .output(
            CellOutput::new_builder()
                .capacity(30_000_000_000u64.pack())
                .lock(f.pool_lock.clone())
                .type_(Some(f.mine_type.clone()).pack())
                .build(),
        )
        .output_data(mining_pool_data(stake_token, amount, acc_after, now, emission).pack())
        // Output receipt locked by the attacker, owner field still = the victim's owner (guard args).
        .output(
            CellOutput::new_builder()
                .capacity(20_000_000_000u64.pack())
                .lock(attacker_lock)
                .type_(Some(guard.clone()).pack())
                .build(),
        )
        .output_data(receipt_data(amount, acc_after).pack())
        .output(
            CellOutput::new_builder()
                .capacity(20_000_000_000u64.pack())
                .lock(guard)
                .type_(Some(stake_tok_type).pack())
                .build(),
        )
        .output_data(Bytes::from(u128le(amount)).pack())
        .output(
            CellOutput::new_builder()
                .capacity(14_400_000_000u64.pack())
                .lock(f.owner_lock.clone())
                .type_(Some(f.vtx_type.clone()).pack())
                .build(),
        )
        .output_data(Bytes::from(u128le(pending)).pack())
        .cell_dep(f.mine_dep.clone())
        .cell_dep(f.guard_dep.clone())
        .cell_dep(f.as_dep.clone())
        .header_dep(hh)
        .build();
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "a mining receipt whose lock != its owner field must be rejected"
    );
}

// ─── emission-lock: VTX mint authority ─────────────────────────────────────────────────────

struct EmiFix {
    ctx: Context,
    emi_dep: CellDep,
    as_dep: CellDep,
    emi_lock: PackedScript, // locks the emission-authority cell
    pool_type_builder_out: ckb_testtool::ckb_types::packed::OutPoint, // always-success deploy out
    mining_code: [u8; 32],
    governance: [u8; 32],
    aslock: PackedScript,
}

fn emi_setup() -> EmiFix {
    let mut ctx = Context::default();
    let emi_out = ctx.deploy_cell(bin("emission-lock"));
    let as_out = ctx.deploy_cell(bin("always-success"));
    let emi_dep = CellDep::new_builder().out_point(emi_out.clone()).build();
    let as_dep = CellDep::new_builder().out_point(as_out.clone()).build();

    // The "mining pool" cell is typed by always-success; its code hash is the binary identity.
    let probe = ctx
        .build_script(&as_out, Bytes::from(vec![0u8; 96]))
        .unwrap();
    let mining_code: [u8; 32] = probe.code_hash().unpack();
    let governance = [0x6cu8; 32];

    // emission-lock args = mining_pool_code_hash(32) || governance_authority(32).
    let mut ea = Vec::with_capacity(64);
    ea.extend_from_slice(&mining_code);
    ea.extend_from_slice(&governance);
    let emi_lock = ctx.build_script(&emi_out, Bytes::from(ea)).unwrap();
    let aslock = ctx.build_script(&as_out, Bytes::from(vec![0x01])).unwrap();

    EmiFix {
        ctx,
        emi_dep,
        as_dep,
        emi_lock,
        pool_type_builder_out: as_out,
        mining_code: mining_code,
        governance,
        aslock,
    }
}

/// Spend the emission-authority cell alongside a mining-pool cell whose embedded authority
/// (type args [64..96]) is `pool_authority`. emission-lock authorizes the mint only if that
/// authority equals the governance authority baked into its own args.
fn build_emission_tx(
    f: &mut EmiFix,
    pool_authority: [u8; 32],
) -> ckb_testtool::ckb_types::core::TransactionView {
    // Authority cell: locked by emission-lock → spending it runs emission-lock.
    let auth_cell = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(20_000_000_000u64.pack())
            .lock(f.emi_lock.clone())
            .build(),
        Bytes::new(),
    );
    // Mining-pool cell: type = always-success with 96-byte args carrying `pool_authority` at [64..96]
    // (so its code hash matches emission-lock's mining_pool_code_hash arg).
    let mut pa = vec![0u8; 96];
    pa[64..96].copy_from_slice(&pool_authority);
    let pool_type = f
        .ctx
        .build_script(&f.pool_type_builder_out, Bytes::from(pa))
        .unwrap();
    let pool_code: [u8; 32] = pool_type.code_hash().unpack();
    assert_eq!(
        pool_code, f.mining_code,
        "test pool type must match emission-lock's mining_code"
    );
    let pool_cell = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(20_000_000_000u64.pack())
            .lock(f.aslock.clone())
            .type_(Some(pool_type).pack())
            .build(),
        Bytes::new(),
    );
    TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(auth_cell).build())
        .input(CellInput::new_builder().previous_output(pool_cell).build())
        .output(
            CellOutput::new_builder()
                .capacity(20_000_000_000u64.pack())
                .lock(f.aslock.clone())
                .build(),
        )
        .output_data(Bytes::new().pack())
        .cell_dep(f.emi_dep.clone())
        .cell_dep(f.as_dep.clone())
        .build()
}

#[test]
fn mining_pool_capacity_skim_rejected() {
    // Permissionless rent skim: the mining-pool cell's reward is minted VTX, never paid from the
    // cell, so its CKB capacity is pure rent. Without a bound, a spender could recreate the
    // singleton at a lower capacity and skim the surplus. mining-pool rejects cap_out < cap_in. A
    // no-position "poke" (fold the accumulator, total_staked = 0) is the minimal carrier: identical data,
    // only the cell's CKB capacity is reduced.
    let mut f = mine_setup(20);
    let (last, now) = (5u64, 6u64);
    let in_cap = 37_000_000_000u64; // ~70 CKB of rent surplus over the cell's occupied size
    let stake_token = [0x5au8; 32];

    let header = HeaderBuilder::default()
        .epoch(EpochNumberWithFraction::new(now, 0, 1).full_value().pack())
        .build();
    let hh = header.hash();
    f.ctx.insert_header(header);

    let mk = |f: &mut MineFix, out_cap: u64| {
        let pool_in = f.ctx.create_cell(
            CellOutput::new_builder()
                .capacity(in_cap.pack())
                .lock(f.pool_lock.clone())
                .type_(Some(f.mine_type.clone()).pack())
                .build(),
            mining_pool_data(stake_token, 0, 0, last, 1000),
        );
        TransactionBuilder::default()
            .input(CellInput::new_builder().previous_output(pool_in).build())
            .output(
                CellOutput::new_builder()
                    .capacity(out_cap.pack())
                    .lock(f.pool_lock.clone())
                    .type_(Some(f.mine_type.clone()).pack())
                    .build(),
            )
            .output_data(mining_pool_data(stake_token, 0, 0, now, 1000).pack())
            .cell_dep(f.mine_dep.clone())
            .cell_dep(f.as_dep.clone())
            .header_dep(hh.clone())
            .build()
    };

    // Skim: recreate the singleton 70 CKB lighter → rejected.
    let skim = mk(&mut f, in_cap - 7_000_000_000);
    assert!(
        f.ctx.verify_tx(&skim, MAX_CYCLES).is_err(),
        "skimming the mining-pool rent surplus must fail"
    );

    // Control: same poke, capacity conserved (out == in) → passes.
    let ok = mk(&mut f, in_cap);
    assert!(
        f.ctx.verify_tx(&ok, MAX_CYCLES).is_ok(),
        "a poke that conserves capacity should pass (control)"
    );
}

#[test]
fn emission_authorized_pool_passes() {
    // A mining pool whose embedded authority == the governance authority may gate a mint.
    let mut f = emi_setup();
    let g = f.governance;
    let tx = build_emission_tx(&mut f, g);
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_ok(),
        "governance-authority pool should authorize the mint"
    );
}

#[test]
fn emission_forged_pool_rejected() {
    // Unbounded mint: a forged pool carrying the genuine mining-pool code
    // hash but an attacker-chosen authority must not be able to unlock the emission-authority cell.
    let mut f = emi_setup();
    let tx = build_emission_tx(&mut f, [0x99u8; 32]); // attacker authority != governance
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "a forged-authority mining pool must not authorize a mint"
    );
}

// ─── intent-lock: cross-cell double-satisfaction ─────────────────────────────────────────────

struct IntentFix {
    ctx: Context,
    intent_dep: CellDep,
    as_dep: CellDep,
    intent_lock: PackedScript,
    token_in_type: PackedScript,
    token_out_type: PackedScript,
    token_out_hash: [u8; 32],
    owner_lock: PackedScript,
    min: u128,
}

fn intent_setup(min: u128) -> IntentFix {
    let mut ctx = Context::default();
    let intent_out = ctx.deploy_cell(bin("intent-lock"));
    let as_out = ctx.deploy_cell(bin("always-success"));
    let intent_dep = CellDep::new_builder().out_point(intent_out.clone()).build();
    let as_dep = CellDep::new_builder().out_point(as_out.clone()).build();

    let token_in_type = ctx.build_script(&as_out, Bytes::from(vec![0x71])).unwrap();
    let token_out_type = ctx.build_script(&as_out, Bytes::from(vec![0x70])).unwrap();
    let token_out_hash: [u8; 32] = token_out_type.calc_script_hash().unpack();
    let owner_lock = ctx.build_script(&as_out, Bytes::from(vec![0x0e])).unwrap();
    let owner_hash: [u8; 32] = owner_lock.calc_script_hash().unpack();

    // intent-lock args (138 bytes): owner(32) || min(16) || token_out(32) || deadline(8)=0
    //                               || pool_prefix(16) || solver_fee(2) || otx_lock_code_hash(32)
    // otx_lock_code_hash names the OTX settlement lock; we use the always-success code hash so
    // an always-success-locked stand-in stands in for an OTX cell in the cross-satisfaction test.
    let as_code_hash: [u8; 32] = token_in_type.code_hash().unpack();
    let mut a = vec![0u8; 138];
    a[0..32].copy_from_slice(&owner_hash);
    a[32..48].copy_from_slice(&u128le(min));
    a[48..80].copy_from_slice(&token_out_hash);
    // deadline [80..88] = 0 (no deadline); pool prefix + fee left zero.
    a[106..138].copy_from_slice(&as_code_hash);
    let intent_lock = ctx.build_script(&intent_out, Bytes::from(a)).unwrap();

    IntentFix {
        ctx,
        intent_dep,
        as_dep,
        intent_lock,
        token_in_type,
        token_out_type,
        token_out_hash,
        owner_lock,
        min,
    }
}

/// Settle `n` sibling intents (same owner+token+min) with a single owner payout of `payout`.
fn build_intent_settlement(
    f: &mut IntentFix,
    n: usize,
    payout: u128,
) -> ckb_testtool::ckb_types::core::TransactionView {
    let mut tb = TransactionBuilder::default();
    for _ in 0..n {
        let cell = f.ctx.create_cell(
            CellOutput::new_builder()
                .capacity(20_000_000_000u64.pack())
                .lock(f.intent_lock.clone())
                .type_(Some(f.token_in_type.clone()).pack())
                .build(),
            Bytes::from(u128le(500)),
        );
        tb = tb.input(CellInput::new_builder().previous_output(cell).build());
    }
    // The owner must be refunded the consumed intent cells' CKB capacity (n * 200 CKB here).
    tb.output(
        CellOutput::new_builder()
            .capacity(((n as u64) * 20_000_000_000).pack())
            .lock(f.owner_lock.clone())
            .type_(Some(f.token_out_type.clone()).pack())
            .build(),
    )
    .output_data(Bytes::from(u128le(payout)).pack())
    .cell_dep(f.intent_dep.clone())
    .cell_dep(f.as_dep.clone())
    .build()
}

#[test]
fn intent_single_settlement_passes() {
    // One intent settled by a payout >= its minimum still passes.
    let mut f = intent_setup(1000);
    let min = f.min;
    let tx = build_intent_settlement(&mut f, 1, min);
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_ok(),
        "a single intent paid its minimum should pass"
    );
}

#[test]
fn intent_batched_underpay_rejected() {
    // Drain N, pay once: two sibling intents (each min 1000) settled by one
    // payout of 1000 must fail; the required payout is the sum (2000).
    let mut f = intent_setup(1000);
    let min = f.min;
    let tx = build_intent_settlement(&mut f, 2, min); // pays 1000 for 2x1000 owed
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "two siblings settled by one min-payout must fail"
    );
}

#[test]
fn intent_batched_full_pay_passes() {
    // Paying the sum of the two siblings' minimums settles both.
    let mut f = intent_setup(1000);
    let min = f.min;
    let tx = build_intent_settlement(&mut f, 2, min * 2);
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_ok(),
        "paying the summed minimum should settle both"
    );
}

#[test]
fn intent_rent_skim_rejected() {
    // Owner rent refund: settling an intent while refunding the owner less than the consumed
    // cell's capacity (the solver pockets the ~200 CKB rent) must fail, even when the token minimum is
    // paid. solver_fee_bps is 0 here, so the full capacity must be returned.
    let mut f = intent_setup(1000);
    let min = f.min;
    let cell = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(20_000_000_000u64.pack())
            .lock(f.intent_lock.clone())
            .type_(Some(f.token_in_type.clone()).pack())
            .build(),
        Bytes::from(u128le(500)),
    );
    // Token min is paid, but the owner output is only 61 CKB (< the consumed 200 CKB).
    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(cell).build())
        .output(
            CellOutput::new_builder()
                .capacity(6_100_000_000u64.pack())
                .lock(f.owner_lock.clone())
                .type_(Some(f.token_out_type.clone()).pack())
                .build(),
        )
        .output_data(Bytes::from(u128le(min)).pack())
        .cell_dep(f.intent_dep.clone())
        .cell_dep(f.as_dep.clone())
        .build();
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "skimming the owner's intent rent must be rejected"
    );
}

/// Build a settlement spending one intent-lock cell (min) + one cellswap-otx-lock stand-in cell
/// (always-success lock, OTX-shaped witness committing the same owner+token_out+`otx_min`), paid by
/// a single owner output of `payout`. intent-lock only parses the OTX witness, so an always-success
/// stand-in (no real P-256 sig) faithfully exercises the cross-contract demand sum.
fn build_intent_plus_otx(
    f: &mut IntentFix,
    otx_min: u128,
    payout: u128,
) -> ckb_testtool::ckb_types::core::TransactionView {
    use ckb_testtool::ckb_types::packed::WitnessArgs;
    let owner_hash: [u8; 32] = f.owner_lock.calc_script_hash().unpack();
    let as_op = f.as_dep.out_point();
    let otx_lock = f.ctx.build_script(&as_op, Bytes::from(vec![0xff])).unwrap();

    let intent_cell = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(20_000_000_000u64.pack())
            .lock(f.intent_lock.clone())
            .type_(Some(f.token_in_type.clone()).pack())
            .build(),
        Bytes::from(u128le(500)),
    );
    let otx_cell = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(20_000_000_000u64.pack())
            .lock(otx_lock)
            .type_(Some(f.token_in_type.clone()).pack())
            .build(),
        Bytes::from(u128le(500)),
    );

    // OTX witness.lock: sig(64)||pubkey(64)||auth_len=0(4)||client_len=0(4)||intent(120)
    //   intent = min(16)||token_out(32)||owner(32)||token_in(32)||deadline(8); intent-lock reads
    //   only min/token_out/owner, so token_in+deadline are left zero here.
    let mut w = vec![0u8; 256];
    w[136..152].copy_from_slice(&u128le(otx_min)); // min_amount_out
    w[152..184].copy_from_slice(&f.token_out_hash); // token_out
    w[184..216].copy_from_slice(&owner_hash); // owner_lock_hash
    let otx_wa = WitnessArgs::new_builder()
        .lock(Some(Bytes::from(w)).pack())
        .build();

    TransactionBuilder::default()
        .input(
            CellInput::new_builder()
                .previous_output(intent_cell)
                .build(),
        )
        .input(CellInput::new_builder().previous_output(otx_cell).build())
        .output(
            CellOutput::new_builder()
                .capacity(20_000_000_000u64.pack())
                .lock(f.owner_lock.clone())
                .type_(Some(f.token_out_type.clone()).pack())
                .build(),
        )
        .output_data(Bytes::from(u128le(payout)).pack())
        .witness(WitnessArgs::default().as_bytes().pack()) // index 0 (intent-lock input, unused)
        .witness(otx_wa.as_bytes().pack()) // index 1 (OTX stand-in intent)
        .cell_dep(f.intent_dep.clone())
        .cell_dep(f.as_dep.clone())
        .build()
}

#[test]
fn intent_otx_cross_satisfaction_rejected() {
    // Cross-contract double-satisfaction: an intent-lock order (min 1000) and an OTX cell
    // (min 1000) for the same owner+token_out must not both be settled by one payout of 1000.
    // intent-lock sums OTX sibling demand → required 2000 → the underpay is rejected.
    let mut f = intent_setup(1000);
    let tx = build_intent_plus_otx(&mut f, 1000, 1000); // pays 1000 for 1000 (intent) + 1000 (otx)
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "one payout must not satisfy both an intent-lock and an OTX cell (drain 2, pay once)"
    );
}

#[test]
fn intent_otx_full_pay_passes() {
    // Paying the sum (intent min + OTX min) settles both, so the demand sum doesn't break the
    // legitimate co-settlement path.
    let mut f = intent_setup(1000);
    let tx = build_intent_plus_otx(&mut f, 1000, 2000);
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_ok(),
        "paying intent min + OTX min should settle both legs"
    );
}

/// Build an intent-lock script with a zero otx_code_hash (the unprotected form, equivalent
/// to a legacy 106-byte cell).
fn intent_lock_zero_otx(f: &mut IntentFix) -> ckb_testtool::ckb_types::packed::Script {
    let owner_hash: [u8; 32] = f.owner_lock.calc_script_hash().unpack();
    let mut a = vec![0u8; 138];
    a[0..32].copy_from_slice(&owner_hash);
    a[32..48].copy_from_slice(&u128le(1000));
    a[48..80].copy_from_slice(&f.token_out_hash);
    // a[106..138] left zero → otx_code_hash = zero → cross-contract demand sum unavailable.
    let op = f.intent_dep.out_point();
    f.ctx.build_script(&op, Bytes::from(a)).unwrap()
}

#[test]
fn intent_zero_otx_hash_settlement_rejected() {
    // An intent cell whose args carry a zero/absent cellswap-
    // otx code hash would skip the cross-contract demand sum, letting a solver co-settle it
    // with an OTX cell under one underpaying payout (drain 2, pay once), since the OTX lock never counts
    // intent demand. intent-lock makes such a cell unsettleable (Error::Unprotected):
    // even paying its full min must fail. (It stays owner-cancellable, see the next test, so no
    // funds are stranded.)
    let mut f = intent_setup(1000);
    let zero_lock = intent_lock_zero_otx(&mut f);
    let cell = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(20_000_000_000u64.pack())
            .lock(zero_lock)
            .type_(Some(f.token_in_type.clone()).pack())
            .build(),
        Bytes::from(u128le(500)),
    );
    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(cell).build())
        .output(
            CellOutput::new_builder()
                .capacity(20_000_000_000u64.pack())
                .lock(f.owner_lock.clone())
                .type_(Some(f.token_out_type.clone()).pack())
                .build(),
        )
        .output_data(Bytes::from(u128le(1000)).pack()) // pays the full min, must still fail
        .cell_dep(f.intent_dep.clone())
        .cell_dep(f.as_dep.clone())
        .build();
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "a zero-OTX-hash intent cell must not be settleable"
    );
}

#[test]
fn intent_zero_otx_hash_still_cancellable() {
    // The settlement guard must not strand legacy/zero-hash cells: the owner can always reclaim by co-signing
    // (is_owner_authorizing is checked before settlement). Same zero-hash cell + an owner-locked input.
    let mut f = intent_setup(1000);
    let zero_lock = intent_lock_zero_otx(&mut f);
    let cell = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(20_000_000_000u64.pack())
            .lock(zero_lock)
            .type_(Some(f.token_in_type.clone()).pack())
            .build(),
        Bytes::from(u128le(500)),
    );
    let owner_cell = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(20_000_000_000u64.pack())
            .lock(f.owner_lock.clone())
            .build(),
        Bytes::new(),
    );
    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(cell).build())
        .input(CellInput::new_builder().previous_output(owner_cell).build())
        .output(
            CellOutput::new_builder()
                .capacity(20_000_000_000u64.pack())
                .lock(f.owner_lock.clone())
                .build(),
        )
        .output_data(Bytes::new().pack())
        .cell_dep(f.intent_dep.clone())
        .cell_dep(f.as_dep.clone())
        .build();
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_ok(),
        "owner can still cancel a zero-OTX-hash cell, so no funds are stranded"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// cellswap-otx-lock: WebAuthn/secp256r1 hardening tests (gated by `otx-tests`).
// Each builds a real P-256 WebAuthn assertion (authData + clientDataJSON + signature)
// over the committed intent and runs the lock on-chain via ckb-testtool, covering the
// happy path and the two hardening guards (user-present flag, non-zero minimum).
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(feature = "otx-tests")]
mod otx_lock {
    use super::{bin, u128le, MAX_CYCLES};
    use base64ct::{Base64UrlUnpadded, Encoding};
    use ckb_testtool::ckb_types::{
        bytes::Bytes,
        core::{EpochNumberWithFraction, HeaderBuilder, TransactionBuilder},
        packed::{CellDep, CellInput, CellOutput, WitnessArgs},
        prelude::*,
    };
    use ckb_testtool::context::Context;
    use p256::ecdsa::{signature::hazmat::PrehashSigner, Signature, SigningKey};
    use p256::elliptic_curve::sec1::ToEncodedPoint;
    use rand_core::OsRng;
    use sha2::{Digest, Sha256};

    fn sha256(d: &[u8]) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(d);
        h.finalize().into()
    }
    fn blake_personal(personal: &[u8; 16], parts: &[&[u8]]) -> [u8; 32] {
        let mut h = blake2b_ref::Blake2bBuilder::new(32)
            .personal(personal)
            .build();
        for p in parts {
            h.update(p);
        }
        let mut r = [0u8; 32];
        h.finalize(&mut r);
        r
    }

    /// Build + on-chain-verify an OTX settlement tx. `flags` = WebAuthn authData flags byte,
    /// `min` = committed minimum out, `out_amt` = what the output actually pays the owner,
    /// `deadline` = committed deadline epoch (0 = none), `header_epoch` = epoch of the HeaderDep to
    /// attach (None = no header dep). Returns true iff the lock accepts the tx.
    fn run_ex(
        flags: u8,
        min: u128,
        out_amt: u128,
        deadline: u64,
        header_epoch: Option<u64>,
    ) -> bool {
        let mut ctx = Context::default();
        let otx_out = ctx.deploy_cell(bin("cellswap-otx-lock"));
        let as_out = ctx.deploy_cell(bin("always-success"));
        let otx_dep = CellDep::new_builder().out_point(otx_out.clone()).build();
        let as_dep = CellDep::new_builder().out_point(as_out.clone()).build();

        // P-256 key; args pin blake2b256_ckb(pubkey): scheme(0x01) || hash(32)
        let sk = SigningKey::random(&mut OsRng);
        let ep = sk.verifying_key().to_encoded_point(false);
        let pubkey_xy = &ep.as_bytes()[1..65]; // uncompressed 0x04 || x || y → x||y
        let pubkey_hash = blake_personal(b"ckb-default-hash", &[pubkey_xy]);
        let mut args = vec![0x01u8];
        args.extend_from_slice(&pubkey_hash);
        let otx_lock = ctx.build_script(&otx_out, Bytes::from(args)).unwrap();

        // token_out type + owner lock (always-success stand-ins). token_in == token_out here.
        let token_type = ctx.build_script(&as_out, Bytes::from(vec![0x22])).unwrap();
        let token_out: [u8; 32] = token_type.calc_script_hash().unpack();
        let token_in = token_out; // single-token shape: the input token == the committed token_in
        let owner_lock = ctx.build_script(&as_out, Bytes::from(vec![0x33])).unwrap();
        let owner_hash: [u8; 32] = owner_lock.calc_script_hash().unpack();

        let total_in: u128 = 1_000;
        let otx_in = ctx.create_cell(
            CellOutput::new_builder()
                .capacity(20_000_000_000u64.pack())
                .lock(otx_lock)
                .type_(Some(token_type.clone()).pack())
                .build(),
            Bytes::from(u128le(total_in)),
        );

        // commitment = blake2b("ckb-cswp-otxcom\0",
        //   outpoint(36)||total(16)||min(16)||token_out(32)||owner(32)||token_in(32)||deadline(8))
        let commitment = blake_personal(
            b"ckb-cswp-otxcom\x00",
            &[
                otx_in.as_slice(),
                &total_in.to_le_bytes(),
                &min.to_le_bytes(),
                &token_out,
                &owner_hash,
                &token_in,
                &deadline.to_le_bytes(),
            ],
        );

        let lock_witness = build_lock_witness(
            &sk,
            pubkey_xy,
            flags,
            &commitment,
            min,
            &token_out,
            &owner_hash,
            &token_in,
            deadline,
        );
        let wa = WitnessArgs::new_builder()
            .lock(Some(Bytes::from(lock_witness)).pack())
            .build();

        let mut builder = TransactionBuilder::default()
            .input(CellInput::new_builder().previous_output(otx_in).build())
            .output(
                CellOutput::new_builder()
                    .capacity(20_000_000_000u64.pack())
                    .lock(owner_lock)
                    .type_(Some(token_type).pack())
                    .build(),
            )
            .output_data(Bytes::from(u128le(out_amt)).pack())
            .witness(wa.as_bytes().pack())
            .cell_dep(otx_dep)
            .cell_dep(as_dep);

        if let Some(epoch) = header_epoch {
            let header = HeaderBuilder::default()
                .epoch(
                    EpochNumberWithFraction::new(epoch, 0, 1)
                        .full_value()
                        .pack(),
                )
                .build();
            ctx.insert_header(header.clone());
            builder = builder.header_dep(header.hash());
        }

        ctx.verify_tx(&builder.build(), MAX_CYCLES).is_ok()
    }

    /// Back-compat wrapper for the no-deadline tests.
    fn run(flags: u8, min: u128, out_amt: u128) -> bool {
        run_ex(flags, min, out_amt, 0, None)
    }

    /// Assemble witness.lock = sig(64)||pubkey(64)||auth_len(4)||auth||client_len(4)||client||intent(120)
    /// where intent = min(16)||token_out(32)||owner(32)||token_in(32)||deadline(8).
    #[allow(clippy::too_many_arguments)]
    fn build_lock_witness(
        sk: &SigningKey,
        pubkey_xy: &[u8],
        flags: u8,
        commitment: &[u8; 32],
        min: u128,
        token_out: &[u8; 32],
        owner_hash: &[u8; 32],
        token_in: &[u8; 32],
        deadline: u64,
    ) -> Vec<u8> {
        // clientDataJSON whose challenge = base64url_nopad(commitment)
        let challenge = Base64UrlUnpadded::encode_string(commitment);
        let client = format!(
            "{{\"type\":\"webauthn.get\",\"challenge\":\"{}\",\"origin\":\"https://app.joy.id\"}}",
            challenge
        );
        let client_bytes = client.as_bytes();

        // authData: rpIdHash(32) || flags(1) || signCount(4 BE)
        let mut auth = [0u8; 37];
        auth[32] = flags;
        auth[33..37].copy_from_slice(&1u32.to_be_bytes());

        // WebAuthn signature base = sha256(authData || sha256(clientDataJSON))
        let client_hash = sha256(client_bytes);
        let mut base = Vec::with_capacity(37 + 32);
        base.extend_from_slice(&auth);
        base.extend_from_slice(&client_hash);
        let prehash = sha256(&base);
        let sig: Signature = sk.sign_prehash(&prehash).unwrap();
        let sig_bytes = sig.to_bytes();

        let mut lock = Vec::new();
        lock.extend_from_slice(sig_bytes.as_slice());
        lock.extend_from_slice(pubkey_xy);
        lock.extend_from_slice(&(auth.len() as u32).to_le_bytes());
        lock.extend_from_slice(&auth);
        lock.extend_from_slice(&(client_bytes.len() as u32).to_le_bytes());
        lock.extend_from_slice(client_bytes);
        lock.extend_from_slice(&min.to_le_bytes());
        lock.extend_from_slice(token_out);
        lock.extend_from_slice(owner_hash);
        lock.extend_from_slice(token_in);
        lock.extend_from_slice(&deadline.to_le_bytes());
        lock
    }

    #[test]
    fn otx_happy_path_passes() {
        // user-present + user-verified, positive min, output pays the minimum.
        assert!(
            run(0x05, 1_000, 1_000),
            "a valid WebAuthn OTX settlement should pass"
        );
    }

    #[test]
    fn otx_no_user_present_fails() {
        // UV set (0x04) but user-present (bit 0) cleared → rejected.
        assert!(
            !run(0x04, 1_000, 1_000),
            "an assertion without the user-present flag must be rejected"
        );
    }

    #[test]
    fn otx_zero_min_fails() {
        // a zero committed minimum would allow a free drain → rejected.
        assert!(!run(0x05, 0, 0), "min_amount_out == 0 must be rejected");
    }

    #[test]
    fn otx_deadline_in_future_passes() {
        // deadline committed, HeaderDep epoch (5) <= deadline (100) → settlement allowed.
        assert!(
            run_ex(0x05, 1_000, 1_000, 100, Some(5)),
            "a settlement before the committed deadline epoch should pass"
        );
    }

    #[test]
    fn otx_deadline_passed_fails() {
        // HeaderDep epoch (100) > deadline (50) → the lock must reject (Expired).
        assert!(
            !run_ex(0x05, 1_000, 1_000, 50, Some(100)),
            "a settlement after the committed deadline epoch must be rejected"
        );
    }

    #[test]
    fn otx_deadline_without_header_fails() {
        // A committed deadline (>0) with no HeaderDep cannot be proven within bounds → fail closed.
        assert!(
            !run_ex(0x05, 1_000, 1_000, 50, None),
            "a deadline-bearing intent with no HeaderDep must be rejected"
        );
    }

    #[test]
    fn otx_wrong_input_token_is_rejected() {
        // Token substitution: the lock guards every OTX cell of one passkey. A solver adds
        // a second group input of a different token type (amount 0, so the committed total still
        // matches and the signature stays valid) to sweep an asset the user never meant to spend. The
        // commitment binds token_in and the lock asserts every group input is that type, so this must
        // be rejected. Everything else (capacity refund, min paid) is satisfied, isolating the bind.
        let mut ctx = Context::default();
        let otx_out = ctx.deploy_cell(bin("cellswap-otx-lock"));
        let as_out = ctx.deploy_cell(bin("always-success"));
        let otx_dep = CellDep::new_builder().out_point(otx_out.clone()).build();
        let as_dep = CellDep::new_builder().out_point(as_out.clone()).build();

        let sk = SigningKey::random(&mut OsRng);
        let ep = sk.verifying_key().to_encoded_point(false);
        let pubkey_xy = &ep.as_bytes()[1..65];
        let pubkey_hash = blake_personal(b"ckb-default-hash", &[pubkey_xy]);
        let mut args = vec![0x01u8];
        args.extend_from_slice(&pubkey_hash);
        let otx_lock = ctx.build_script(&otx_out, Bytes::from(args)).unwrap();

        // The intended input token (token_in == token_out for this single-token shape)…
        let token_type = ctx.build_script(&as_out, Bytes::from(vec![0x22])).unwrap();
        let token_out: [u8; 32] = token_type.calc_script_hash().unpack();
        let token_in = token_out;
        // …and a different, more-valuable asset the user also holds under the same lock.
        let other_type = ctx.build_script(&as_out, Bytes::from(vec![0x44])).unwrap();
        let owner_lock = ctx.build_script(&as_out, Bytes::from(vec![0x33])).unwrap();
        let owner_hash: [u8; 32] = owner_lock.calc_script_hash().unpack();

        let total_in: u128 = 1_000;
        let a = ctx.create_cell(
            CellOutput::new_builder()
                .capacity(20_000_000_000u64.pack())
                .lock(otx_lock.clone())
                .type_(Some(token_type.clone()).pack())
                .build(),
            Bytes::from(u128le(total_in)),
        );
        // Decoy: amount 0 in its first 16 bytes so the on-chain total stays == committed total.
        let b = ctx.create_cell(
            CellOutput::new_builder()
                .capacity(20_000_000_000u64.pack())
                .lock(otx_lock)
                .type_(Some(other_type).pack())
                .build(),
            Bytes::from(u128le(0)),
        );

        // Sign over the intended single input only (firstInput = a, total = 1000, token_in = token).
        let commitment = blake_personal(
            b"ckb-cswp-otxcom\x00",
            &[
                a.as_slice(),
                &total_in.to_le_bytes(),
                &total_in.to_le_bytes(),
                &token_out,
                &owner_hash,
                &token_in,
                &0u64.to_le_bytes(),
            ],
        );
        let lock_witness = build_lock_witness(
            &sk,
            pubkey_xy,
            0x05,
            &commitment,
            total_in,
            &token_out,
            &owner_hash,
            &token_in,
            0,
        );
        let wa = WitnessArgs::new_builder()
            .lock(Some(Bytes::from(lock_witness)).pack())
            .build();

        // Output refunds both cells' capacity to the owner and pays the min, so the only reason to
        // reject is the foreign-type cell `b` in the lock group.
        let tx = TransactionBuilder::default()
            .input(CellInput::new_builder().previous_output(a).build())
            .input(CellInput::new_builder().previous_output(b).build())
            .output(
                CellOutput::new_builder()
                    .capacity(40_000_000_000u64.pack())
                    .lock(owner_lock)
                    .type_(Some(token_type).pack())
                    .build(),
            )
            .output_data(Bytes::from(u128le(total_in)).pack())
            .witness(wa.as_bytes().pack())
            .cell_dep(otx_dep)
            .cell_dep(as_dep)
            .build();

        assert!(
            ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
            "a group input of a token other than the committed token_in must be rejected, otherwise \
             a solver can sweep a different asset held under the same OTX lock."
        );
    }
}

// ─── Adversarial repros against pool-script ───────────────────────────────────
// Adversarial transactions that the SDK would never build, probing fields the swap path leaves
// unconstrained. Each asserts the secure expectation, so a failure here means the hole is open.

/// Like `build_swap_tx` but the caller supplies the output info-cell data verbatim.
fn build_swap_tx_out_info(
    f: &mut Fixture,
    rx_in: u128,
    ry_in: u128,
    rx_out: u128,
    ry_out: u128,
    fee: u16,
    pool_id: u128,
    out_info: Bytes,
) -> ckb_testtool::ckb_types::core::TransactionView {
    let tx_hash_x = f.token_x_hash();
    let tx_hash_y = f.token_y_hash();
    f.tx_hash_x = tx_hash_x;
    f.tx_hash_y = tx_hash_y;

    let info_in_data = info_data(tx_hash_x, tx_hash_y, 1_000_000, fee, pool_id, 0, 0);
    let info_in = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(MIN_POOL_CAPACITY.pack())
            .lock(f.user_lock.clone())
            .type_(Some(f.pool_type.clone()).pack())
            .build(),
        info_in_data,
    );
    let rx_cell = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(14_400_000_000u64.pack())
            .lock(f.pool_lock.clone())
            .type_(Some(f.token_x_type.clone()).pack())
            .build(),
        reserve_data(rx_in),
    );
    let ry_cell = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(14_400_000_000u64.pack())
            .lock(f.pool_lock.clone())
            .type_(Some(f.token_y_type.clone()).pack())
            .build(),
        reserve_data(ry_in),
    );

    TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(info_in).build())
        .input(CellInput::new_builder().previous_output(rx_cell).build())
        .input(CellInput::new_builder().previous_output(ry_cell).build())
        .output(
            CellOutput::new_builder()
                .capacity(MIN_POOL_CAPACITY.pack())
                .lock(f.user_lock.clone())
                .type_(Some(f.pool_type.clone()).pack())
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(14_400_000_000u64.pack())
                .lock(f.pool_lock.clone())
                .type_(Some(f.token_x_type.clone()).pack())
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(14_400_000_000u64.pack())
                .lock(f.pool_lock.clone())
                .type_(Some(f.token_y_type.clone()).pack())
                .build(),
        )
        .output_data(out_info.pack())
        .output_data(reserve_data(rx_out).pack())
        .output_data(reserve_data(ry_out).pack())
        .cell_dep(f.pool_dep.clone())
        .cell_dep(f.lock_dep.clone())
        .cell_dep(f.as_dep.clone())
        .build()
}

/// Canonical pool-safe amount_out for `amount_in` of X into (rx, ry).
fn amount_out_x_for_y(amount_in: u128, rx: u128, ry: u128, fee: u16) -> u128 {
    let aif = amount_in * (10_000 - fee as u128);
    (aif * ry) / (rx * 10_000 + aif)
}

#[test]
fn paused_flag_unauthenticated_brick() {
    // Permanent pool brick + reserve lock: `paused` is not among
    // pool-script's immutable fields and is gated by no authority. If a swap could set
    // `output.paused`, any swapper could flip it 0→1.
    // Thereafter every op hits `if input.paused` and fails → the pool and all reserves locked under
    // pool-lock are frozen forever.
    //
    // Expectation: a swap that sets paused=1 must be rejected.
    let mut f = setup(1);
    let (rx, ry, fee) = (1_000_000u128, 1_000_000u128, 30u16);
    let amount_in = 10_000u128;
    let out = amount_out_x_for_y(amount_in, rx, ry, fee);
    let out_info = info_data(
        f.token_x_hash(),
        f.token_y_hash(),
        1_000_000,
        fee,
        1,
        0,
        /*paused*/ 1,
    );
    let txn = build_swap_tx_out_info(&mut f, rx, ry, rx + amount_in, ry - out, fee, 1, out_info);
    let res = f.ctx.verify_tx(&txn, MAX_CYCLES);
    assert!(
        res.is_err(),
        "a swap that sets paused=1 must be rejected, otherwise any user can brick \
         any pool and permanently lock its reserves. {res:?}"
    );
}

#[test]
fn twap_accumulator_forgeable() {
    // Forgeable TWAP: if the accumulators were checked only non-decreasing, a
    // swapper could set them to any larger value (poisonable oracle). They are pinned (immutable
    // on every spend), so a swap that changes cum_x/cum_y must be rejected. This guards the pin.
    let mut f = setup(1);
    let (rx, ry, fee) = (1_000_000u128, 1_000_000u128, 30u16);
    let amount_in = 10_000u128;
    let out = amount_out_x_for_y(amount_in, rx, ry, fee);
    let mut d = info_data(f.token_x_hash(), f.token_y_hash(), 1_000_000, fee, 1, 0, 0).to_vec();
    d[98..114].copy_from_slice(&u128le(u128::MAX / 2)); // cum_x → absurd
    d[114..130].copy_from_slice(&u128le(u128::MAX / 2)); // cum_y → absurd
    let txn = build_swap_tx_out_info(
        &mut f,
        rx,
        ry,
        rx + amount_in,
        ry - out,
        fee,
        1,
        Bytes::from(d),
    );
    let res = f.ctx.verify_tx(&txn, MAX_CYCLES);
    assert!(
        res.is_err(),
        "a swap with arbitrary TWAP accumulators must be rejected, otherwise the \
         pool's TWAP is forgeable. {res:?}"
    );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Lock-boost: fixed-term lock-weighted emission for committed LPs,
// plus the composed `stake-timelock-guard` custody lock. Exploit repros + happy path.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

fn receipt_data56(amount: u128, acc: u128, weight: u128, unlock: u64) -> Bytes {
    let mut d = Vec::with_capacity(56);
    d.extend_from_slice(&u128le(amount));
    d.extend_from_slice(&u128le(acc));
    d.extend_from_slice(&u128le(weight));
    d.extend_from_slice(&unlock.to_le_bytes());
    d.into()
}

fn since_abs_epoch(epoch: u64) -> u64 {
    0x2000_0000_0000_0000u64 | epoch
}

/// Build a fresh locked-position stake tx (r_in=None -> r_out present): pool total_weight 0 -> `weight`,
/// a 56B receipt (amount, weight, unlock_epoch), and a custody output under the composed guard with
/// `custody_deadline`. Tamper `weight`/`unlock_epoch`/`custody_deadline` to exercise the guards.
fn build_boost_stake(
    seed: u8,
    amount: u128,
    unlock_epoch: u64,
    weight: u128,
    custody_deadline: u64,
    now: u64,
) -> (Context, ckb_testtool::ckb_types::core::TransactionView) {
    let mut ctx = Context::default();
    let mine_out = ctx.deploy_cell(bin("mining-pool"));
    let guard_out = ctx.deploy_cell(bin("stake-guard"));
    let stl_out = ctx.deploy_cell(bin("stake-timelock-guard"));
    let pool_out = ctx.deploy_cell(bin("pool-script"));
    let lp_out = ctx.deploy_cell(bin("lp-token"));
    let as_out = ctx.deploy_cell(bin("always-success"));

    let mine_dep = CellDep::new_builder().out_point(mine_out.clone()).build();
    let guard_dep = CellDep::new_builder().out_point(guard_out.clone()).build();
    let stl_dep = CellDep::new_builder().out_point(stl_out.clone()).build();
    let as_dep = CellDep::new_builder().out_point(as_out.clone()).build();

    let guard_code_hash = lock_out_code_hash(&ctx, &guard_out);
    let stl_code_hash = lock_out_code_hash(&ctx, &stl_out);
    let lp_code_hash = lock_out_code_hash(&ctx, &lp_out);
    let vtx_type = ctx.build_script(&as_out, Bytes::from(vec![0xc5])).unwrap();
    let vtx_hash: [u8; 32] = vtx_type.calc_script_hash().unpack();
    let authority_lock = ctx.build_script(&as_out, Bytes::from(vec![0x99])).unwrap();
    let authority_hash: [u8; 32] = authority_lock.calc_script_hash().unpack();
    let owner_lock = ctx.build_script(&as_out, Bytes::from(vec![0x0e])).unwrap();
    let owner_hash: [u8; 32] = owner_lock.calc_script_hash().unpack();
    let pool_lock = ctx.build_script(&as_out, Bytes::from(vec![0x01])).unwrap();
    let probe = ctx
        .build_script(&pool_out, Bytes::from(vec![0u8; 96]))
        .unwrap();
    let pool_code_hash: [u8; 32] = probe.code_hash().unpack();

    // 225-byte mining-pool args, including the optional [193..225] composed-guard code hash.
    let mut args = Vec::with_capacity(225);
    args.extend_from_slice(&guard_code_hash);
    args.extend_from_slice(&vtx_hash);
    args.extend_from_slice(&authority_hash);
    args.extend_from_slice(&lp_code_hash);
    args.push(2u8);
    args.extend_from_slice(&pool_code_hash);
    args.extend_from_slice(&[seed; 32]);
    args.extend_from_slice(&stl_code_hash);
    let mine_type = ctx.build_script(&mine_out, Bytes::from(args)).unwrap();
    let mine_type_hash: [u8; 32] = mine_type.calc_script_hash().unpack();

    let mut ga = Vec::with_capacity(64);
    ga.extend_from_slice(&mine_type_hash);
    ga.extend_from_slice(&owner_hash);
    let owner_guard = ctx
        .build_script_with_hash_type(&guard_out, ScriptHashType::Data1, Bytes::from(ga))
        .unwrap();

    let stake_tok_type = ctx.build_script(&as_out, Bytes::from(vec![0x5a])).unwrap();
    let stake_token: [u8; 32] = stake_tok_type.calc_script_hash().unpack();

    // Custody output lock = composed guard, args: mine_type_hash || owner_hash || custody_deadline.
    let mut cga = Vec::with_capacity(72);
    cga.extend_from_slice(&mine_type_hash);
    cga.extend_from_slice(&owner_hash);
    cga.extend_from_slice(&custody_deadline.to_le_bytes());
    let custody_lock = ctx
        .build_script_with_hash_type(&stl_out, ScriptHashType::Data1, Bytes::from(cga))
        .unwrap();

    let header = HeaderBuilder::default()
        .epoch(EpochNumberWithFraction::new(now, 0, 1).full_value().pack())
        .build();
    let hh = header.hash();
    ctx.insert_header(header);

    let emission = 1000u64;
    let pool_in = ctx.create_cell(
        CellOutput::new_builder()
            .capacity(30_000_000_000u64.pack())
            .lock(pool_lock.clone())
            .type_(Some(mine_type.clone()).pack())
            .build(),
        mining_pool_data(stake_token, 0, 0, now, emission),
    );
    let fund = ctx.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64.pack())
            .lock(owner_lock.clone())
            .build(),
        Bytes::new(),
    );

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(pool_in).build())
        .input(CellInput::new_builder().previous_output(fund).build())
        .output(
            CellOutput::new_builder()
                .capacity(30_000_000_000u64.pack())
                .lock(pool_lock.clone())
                .type_(Some(mine_type.clone()).pack())
                .build(),
        )
        .output_data(mining_pool_data(stake_token, weight, 0, now, emission).pack())
        .output(
            CellOutput::new_builder()
                .capacity(20_000_000_000u64.pack())
                .lock(owner_lock.clone())
                .type_(Some(owner_guard.clone()).pack())
                .build(),
        )
        .output_data(receipt_data56(amount, 0, weight, unlock_epoch).pack())
        .output(
            CellOutput::new_builder()
                .capacity(20_000_000_000u64.pack())
                .lock(custody_lock.clone())
                .type_(Some(stake_tok_type.clone()).pack())
                .build(),
        )
        .output_data(Bytes::from(u128le(amount)).pack())
        .cell_dep(mine_dep)
        .cell_dep(guard_dep)
        .cell_dep(stl_dep)
        .cell_dep(as_dep)
        .header_dep(hh)
        .build();
    (ctx, tx)
}

#[test]
fn mining_lock_boost_stake_passes() {
    // 360-day lock (2160 epochs) -> 2.5x (boost_bps 25000). weight = amount*25000/10000.
    let (now, amount) = (100u64, 1_000_000u128);
    let unlock = now + 2160;
    let weight = amount * 25_000 / 10_000; // 2_500_000
    let (ctx, tx) = build_boost_stake(31, amount, unlock, weight, unlock, now);
    assert!(
        ctx.verify_tx(&tx, MAX_CYCLES).is_ok(),
        "a correctly-weighted 360d lock stake should pass"
    );
}

#[test]
fn mining_lock_boost_forged_weight_rejected() {
    // Same 360d lock but the receipt claims more than the 2.5x tier -> WeightInvalid.
    let (now, amount) = (100u64, 1_000_000u128);
    let unlock = now + 2160;
    let forged = amount * 30_000 / 10_000; // 3.0x, above the 2.5x cap/tier
    let (ctx, tx) = build_boost_stake(32, amount, unlock, forged, unlock, now);
    assert!(
        ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "a weight exceeding the committed tier must be rejected"
    );
}

#[test]
fn mining_unlocked_claiming_boost_rejected() {
    // unlock_epoch == 0 (unlocked) but weight > amount: an unlocked position claiming a boost.
    let (now, amount) = (100u64, 1_000_000u128);
    let forged = amount * 2; // 2x with no lock
    let (ctx, tx) = build_boost_stake(33, amount, 0, forged, 0, now);
    assert!(
        ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "an unlocked position must have weight == amount (1.0x)"
    );
}

#[test]
fn mining_lock_boost_deadline_mismatch_rejected() {
    // Correct tier weight, but the custody's composed-guard deadline != the receipt's unlock_epoch:
    // a forged high weight whose principal lock does not actually freeze until the claimed deadline.
    let (now, amount) = (100u64, 1_000_000u128);
    let unlock = now + 2160;
    let weight = amount * 25_000 / 10_000;
    let (ctx, tx) = build_boost_stake(
        34,
        amount,
        unlock,
        weight,
        now + 100, /* wrong deadline */
        now,
    );
    assert!(
        ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "receipt.unlock_epoch must equal the custody lock deadline"
    );
}

/// Build a tx that spends a `stake-timelock-guard`-locked cell, toggling the three spend conditions.
fn build_stl_spend(
    seed: u8,
    deadline: u64,
    since_val: u64,
    pool_present: bool,
    owner_present: bool,
) -> (Context, ckb_testtool::ckb_types::core::TransactionView) {
    let mut ctx = Context::default();
    let stl_out = ctx.deploy_cell(bin("stake-timelock-guard"));
    let as_out = ctx.deploy_cell(bin("always-success"));
    let stl_dep = CellDep::new_builder().out_point(stl_out.clone()).build();
    let as_dep = CellDep::new_builder().out_point(as_out.clone()).build();

    let pool_type = ctx
        .build_script(&as_out, Bytes::from(vec![0x77, seed]))
        .unwrap();
    let pool_type_hash: [u8; 32] = pool_type.calc_script_hash().unpack();
    let owner_lock = ctx
        .build_script(&as_out, Bytes::from(vec![0x0e, seed]))
        .unwrap();
    let owner_hash: [u8; 32] = owner_lock.calc_script_hash().unpack();
    let other_lock = ctx
        .build_script(&as_out, Bytes::from(vec![0xcc, seed]))
        .unwrap();

    let mut ga = Vec::with_capacity(72);
    ga.extend_from_slice(&pool_type_hash);
    ga.extend_from_slice(&owner_hash);
    ga.extend_from_slice(&deadline.to_le_bytes());
    let stl_lock = ctx
        .build_script_with_hash_type(&stl_out, ScriptHashType::Data1, Bytes::from(ga))
        .unwrap();

    let guarded = ctx.create_cell(
        CellOutput::new_builder()
            .capacity(40_000_000_000u64.pack())
            .lock(stl_lock.clone())
            .build(),
        Bytes::new(),
    );
    let mut tb = TransactionBuilder::default()
        .input(
            CellInput::new_builder()
                .previous_output(guarded)
                .since(since_val.pack())
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(10_000_000_000u64.pack())
                .lock(other_lock.clone())
                .build(),
        )
        .output_data(Bytes::new().pack())
        .cell_dep(stl_dep)
        .cell_dep(as_dep);

    if pool_present {
        let pool_cell = ctx.create_cell(
            CellOutput::new_builder()
                .capacity(20_000_000_000u64.pack())
                .lock(other_lock.clone())
                .type_(Some(pool_type).pack())
                .build(),
            Bytes::new(),
        );
        tb = tb.input(CellInput::new_builder().previous_output(pool_cell).build());
    }
    if owner_present {
        let owner_cell = ctx.create_cell(
            CellOutput::new_builder()
                .capacity(20_000_000_000u64.pack())
                .lock(owner_lock.clone())
                .build(),
            Bytes::new(),
        );
        tb = tb.input(CellInput::new_builder().previous_output(owner_cell).build());
    }
    (ctx, tb.build())
}

#[test]
fn stl_guard_after_deadline_passes() {
    // Pool spent + owner co-signs + since == absolute epoch >= deadline -> spend allowed.
    let (ctx, tx) = build_stl_spend(41, 500, since_abs_epoch(500), true, true);
    assert!(
        ctx.verify_tx(&tx, MAX_CYCLES).is_ok(),
        "all three conditions satisfied at/after the deadline should pass"
    );
}

#[test]
fn stl_guard_before_deadline_fails() {
    // since epoch 499 < deadline 500 -> StillLocked (consensus-frozen principal).
    let (ctx, tx) = build_stl_spend(42, 500, since_abs_epoch(499), true, true);
    assert!(
        ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "spending before the deadline epoch must be rejected"
    );
}

#[test]
fn stl_guard_without_pool_fails() {
    // The bound mining-pool is not in inputs -> PoolNotSpent (supervision lost; lock-only hole).
    let (ctx, tx) = build_stl_spend(43, 500, since_abs_epoch(500), false, true);
    assert!(
        ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "spending without the mining-pool present must be rejected"
    );
}

#[test]
fn stl_guard_without_owner_fails() {
    // No input bears the owner lock -> Unauthorized (nobody but the owner can move the principal).
    let (ctx, tx) = build_stl_spend(44, 500, since_abs_epoch(500), true, false);
    assert!(
        ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "spending without the owner co-signing must be rejected"
    );
}

#[test]
fn stl_guard_relative_since_rejected() {
    // A relative since (bit 63 set), even with epoch value >= deadline, must be rejected: the
    // commitment requires an absolute epoch, else an attacker fakes the lock with a short relative term.
    let rel = 0xA000_0000_0000_0000u64 | 500; // relative (0x8…) + epoch metric (0x2…) + value 500
    let (ctx, tx) = build_stl_spend(45, 500, rel, true, true);
    assert!(
        ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "a relative since must be rejected (absolute epoch required)"
    );
}

#[test]
fn stl_guard_block_metric_since_rejected() {
    // Absolute but block-number metric (not epoch) -> BadSince: a block count can't express the
    // epoch deadline, so the wrong metric must be rejected rather than silently treated as epochs.
    let blk = 9_999u64; // absolute (bit 63 = 0), metric 0b00 = block number, value 9999
    let (ctx, tx) = build_stl_spend(46, 500, blk, true, true);
    assert!(
        ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "a non-epoch (block-number) since must be rejected"
    );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Enforced sink, `vtx-sink-lock`: bought-back VTX can only be disposed as <=25% to the team
// with the rest burned (single-asset, oracle-free).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const SINK_SECP: [u8; 32] = [
    0x9b, 0xd7, 0xe0, 0x6f, 0x3e, 0xcf, 0x4b, 0xe0, 0xf2, 0xfc, 0xd2, 0x18, 0x8b, 0x23, 0xf1, 0xb9,
    0xfc, 0xc8, 0x8e, 0x5d, 0x4b, 0x65, 0xa8, 0x63, 0x7b, 0x17, 0x72, 0x3b, 0xbd, 0xa3, 0xcc, 0xe8,
];

struct SinkFix {
    ctx: Context,
    sink_dep: CellDep,
    as_dep: CellDep,
    vtx_type: ckb_testtool::ckb_types::packed::Script,
    sink_lock: ckb_testtool::ckb_types::packed::Script,
    team_lock: ckb_testtool::ckb_types::packed::Script,
    burn_lock: ckb_testtool::ckb_types::packed::Script,
    other_lock: ckb_testtool::ckb_types::packed::Script,
}

fn sink_setup(seed: u8) -> SinkFix {
    let mut ctx = Context::default();
    let sink_out = ctx.deploy_cell(bin("vtx-sink-lock"));
    let as_out = ctx.deploy_cell(bin("always-success"));
    let sink_dep = CellDep::new_builder().out_point(sink_out.clone()).build();
    let as_dep = CellDep::new_builder().out_point(as_out.clone()).build();

    let vtx_type = ctx
        .build_script(&as_out, Bytes::from(vec![0xc5, seed]))
        .unwrap();
    let vtx_hash: [u8; 32] = vtx_type.calc_script_hash().unpack();
    let team_lock = ctx
        .build_script(&as_out, Bytes::from(vec![0x7e, seed]))
        .unwrap();
    let team_hash: [u8; 32] = team_lock.calc_script_hash().unpack();
    let other_lock = ctx
        .build_script(&as_out, Bytes::from(vec![0xcc, seed]))
        .unwrap();

    let mut args = Vec::with_capacity(64);
    args.extend_from_slice(&vtx_hash);
    args.extend_from_slice(&team_hash);
    let sink_lock = ctx
        .build_script_with_hash_type(&sink_out, ScriptHashType::Data1, Bytes::from(args))
        .unwrap();

    // burn lock = secp256k1 code hash + zero(20) args, matching the contract's computed burn_lock_hash.
    let burn_lock = ckb_testtool::ckb_types::packed::Script::new_builder()
        .code_hash(ckb_testtool::ckb_types::packed::Byte32::from_slice(&SINK_SECP).unwrap())
        .hash_type(1u8.into())
        .args(Bytes::from(vec![0u8; 20]).pack())
        .build();

    SinkFix {
        ctx,
        sink_dep,
        as_dep,
        vtx_type,
        sink_lock,
        team_lock,
        burn_lock,
        other_lock,
    }
}

fn sink_vtx_input(
    f: &mut SinkFix,
    lock: &ckb_testtool::ckb_types::packed::Script,
    amt: u128,
) -> CellInput {
    let op = f.ctx.create_cell(
        CellOutput::new_builder()
            .capacity(40_000_000_000u64.pack())
            .lock(lock.clone())
            .type_(Some(f.vtx_type.clone()).pack())
            .build(),
        Bytes::from(u128le(amt)),
    );
    CellInput::new_builder().previous_output(op).build()
}

fn sink_vtx_out(
    f: &SinkFix,
    lock: &ckb_testtool::ckb_types::packed::Script,
    amt: u128,
) -> (CellOutput, Bytes) {
    (
        CellOutput::new_builder()
            .capacity(14_400_000_000u64.pack())
            .lock(lock.clone())
            .type_(Some(f.vtx_type.clone()).pack())
            .build(),
        Bytes::from(u128le(amt)),
    )
}

#[test]
fn sink_burn_all_passes() {
    let mut f = sink_setup(1);
    let (sink, burn) = (f.sink_lock.clone(), f.burn_lock.clone());
    let inp = sink_vtx_input(&mut f, &sink, 100);
    let (o, od) = sink_vtx_out(&f, &burn, 100);
    let tx = TransactionBuilder::default()
        .input(inp)
        .output(o)
        .output_data(od.pack())
        .cell_dep(f.sink_dep.clone())
        .cell_dep(f.as_dep.clone())
        .build();
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_ok(),
        "burning 100% of sunk VTX must pass"
    );
}

#[test]
fn sink_team_at_cap_passes() {
    // 25 to team + 75 burned, of 100 sunk == exactly the 25% cap.
    let mut f = sink_setup(2);
    let (sink, team, burn) = (
        f.sink_lock.clone(),
        f.team_lock.clone(),
        f.burn_lock.clone(),
    );
    let inp = sink_vtx_input(&mut f, &sink, 100);
    let (ot, odt) = sink_vtx_out(&f, &team, 25);
    let (ob, odb) = sink_vtx_out(&f, &burn, 75);
    let tx = TransactionBuilder::default()
        .input(inp)
        .output(ot)
        .output_data(odt.pack())
        .output(ob)
        .output_data(odb.pack())
        .cell_dep(f.sink_dep.clone())
        .cell_dep(f.as_dep.clone())
        .build();
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_ok(),
        "team at exactly 25% must pass"
    );
}

#[test]
fn sink_team_over_cap_rejected() {
    // 30 to team + 70 burned, of 100 sunk -> over the 25% cap -> TeamOverCap.
    let mut f = sink_setup(3);
    let (sink, team, burn) = (
        f.sink_lock.clone(),
        f.team_lock.clone(),
        f.burn_lock.clone(),
    );
    let inp = sink_vtx_input(&mut f, &sink, 100);
    let (ot, odt) = sink_vtx_out(&f, &team, 30);
    let (ob, odb) = sink_vtx_out(&f, &burn, 70);
    let tx = TransactionBuilder::default()
        .input(inp)
        .output(ot)
        .output_data(odt.pack())
        .output(ob)
        .output_data(odb.pack())
        .cell_dep(f.sink_dep.clone())
        .cell_dep(f.as_dep.clone())
        .build();
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "routing >25% of sunk VTX to the team must be rejected"
    );
}

#[test]
fn sink_unauthorized_vtx_output_rejected() {
    // Sunk VTX routed to a lock that is neither team nor burn nor sink -> UnauthorizedVtxOutput.
    let mut f = sink_setup(4);
    let (sink, other) = (f.sink_lock.clone(), f.other_lock.clone());
    let inp = sink_vtx_input(&mut f, &sink, 100);
    let (o, od) = sink_vtx_out(&f, &other, 100);
    let tx = TransactionBuilder::default()
        .input(inp)
        .output(o)
        .output_data(od.pack())
        .cell_dep(f.sink_dep.clone())
        .cell_dep(f.as_dep.clone())
        .build();
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "VTX leaving the sink to an unauthorized lock must be rejected"
    );
}

#[test]
fn sink_foreign_vtx_input_rejected() {
    // A VTX input not under the sink-lock (so the output accounting can't see all the VTX) -> ForeignVtxInput.
    let mut f = sink_setup(5);
    let (sink, other, burn) = (
        f.sink_lock.clone(),
        f.other_lock.clone(),
        f.burn_lock.clone(),
    );
    let in1 = sink_vtx_input(&mut f, &sink, 100);
    let in2 = sink_vtx_input(&mut f, &other, 50);
    let (o, od) = sink_vtx_out(&f, &burn, 150);
    let tx = TransactionBuilder::default()
        .input(in1)
        .input(in2)
        .output(o)
        .output_data(od.pack())
        .cell_dep(f.sink_dep.clone())
        .cell_dep(f.as_dep.clone())
        .build();
    assert!(
        f.ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "a foreign (non-sink-locked) VTX input must be rejected"
    );
}

#[test]
fn lp_token_nonstandard_args_len_rejected() {
    // lp-token must accept only exactly-32-byte args, matching pool-script's exact-equality
    // LP-supply accounting (it counts an LP cell only when args == pool_type_hash with 32-byte `==`). A
    // 33-byte-args LP cell (pool_hash ‖ 0xNN) would otherwise be a valid, mintable/burnable token here yet
    // uncounted there; both scripts must define a valid LP cell identically.
    use ckb_testtool::ckb_types::packed::WitnessArgs;
    let mut ctx = Context::default();
    let lp_out = ctx.deploy_cell(bin("lp-token"));
    let as_out = ctx.deploy_cell(bin("always-success"));
    let lp_dep = CellDep::new_builder().out_point(lp_out.clone()).build();
    let as_dep = CellDep::new_builder().out_point(as_out.clone()).build();
    let lock = ctx.build_script(&as_out, Bytes::from(vec![0x01])).unwrap();

    // 33-byte args: a pool type hash with one extra trailing byte.
    let mut args = vec![0xabu8; 32];
    args.push(0x00);
    let lp_type = ctx.build_script(&lp_out, Bytes::from(args)).unwrap();

    // A plain transfer (in_sum == out_sum) would normally pass, isolating the args-length check.
    let cell = ctx.create_cell(
        CellOutput::new_builder()
            .capacity(10_000_000_000u64.pack())
            .lock(lock.clone())
            .type_(Some(lp_type.clone()).pack())
            .build(),
        Bytes::from(u128le(100)),
    );
    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(cell).build())
        .output(
            CellOutput::new_builder()
                .capacity(10_000_000_000u64.pack())
                .lock(lock)
                .type_(Some(lp_type).pack())
                .build(),
        )
        .output_data(Bytes::from(u128le(100)).pack())
        .witness(WitnessArgs::default().as_bytes().pack())
        .cell_dep(lp_dep)
        .cell_dep(as_dep)
        .build();
    assert!(
        ctx.verify_tx(&tx, MAX_CYCLES).is_err(),
        "an lp-token cell with 33-byte args must be rejected (only exactly 32 is valid)."
    );
}
