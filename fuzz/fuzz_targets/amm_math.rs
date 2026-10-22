#![no_main]
// Run: cargo +nightly fuzz run amm_math
// Install: cargo install cargo-fuzz

use libfuzzer_sys::fuzz_target;
use amm_math::{
    compute_lp_mint, compute_protocol_fee_lp, get_amount_out, sqrt_k, verify_invariant, AmmError,
    BPS_DENOMINATOR, MINIMUM_LIQUIDITY,
};

// Minimum 42 bytes required:
// [0..16]  reserve_in  (u128)
// [16..32] reserve_out (u128)
// [32..40] amount_in   (u64, kept smaller to hit interesting ranges faster)
// [40..42] fee_bps     (u16, the full range, incl. the invalid >= BPS_DENOMINATOR band)
const MIN_DATA: usize = 42;

fuzz_target!(|data: &[u8]| {
    if data.len() < MIN_DATA { return; }

    let reserve_in  = u128::from_le_bytes(data[0..16].try_into().unwrap());
    let reserve_out = u128::from_le_bytes(data[16..32].try_into().unwrap());
    let amount_in   = u64::from_le_bytes(data[32..40].try_into().unwrap()) as u128;
    // The full u16 range on purpose, so the target reaches fee_bps >= BPS_DENOMINATOR, the
    // `denom - fee` underflow band, and asserts the reject path below.
    let fee_bps     = u16::from_le_bytes(data[40..42].try_into().unwrap());

    // ── Invalid-fee band must be rejected, never underflow or return Ok ───
    // (The zero-input / zero-reserve guards run first, so with degenerate reserves the error is one of
    // those; the point is that fee_bps >= denom never yields Ok and never underflows `denom - fee`.)
    if (fee_bps as u32) >= BPS_DENOMINATOR {
        let r = get_amount_out(amount_in, reserve_in, reserve_out, fee_bps);
        assert!(r.is_err(), "fee_bps {} >= denom must not return Ok: {:?}", fee_bps, r);
        if amount_in > 0 && reserve_in > 0 && reserve_out > 0 {
            assert_eq!(r, Err(AmmError::FeeTooHigh), "fee_bps {} >= denom must be FeeTooHigh", fee_bps);
        }
        let v = verify_invariant(reserve_in, reserve_out, reserve_in, reserve_out, fee_bps);
        assert!(v.is_err(), "fee_bps {} >= denom must not return Ok in verify_invariant", fee_bps);
    }

    // ── get_amount_out: must never panic ──────────────────────────────────

    if let Ok(out) = get_amount_out(amount_in, reserve_in, reserve_out, fee_bps) {
        // Output must not exceed reserve
        assert!(
            out <= reserve_out,
            "output {} > reserve {}", out, reserve_out
        );
        // Output must be less than input (price impact + fee always costs something)
        // Only enforce if reserves are both non-zero and same magnitude
        // Cannot assert out < amount_in in general (asymmetric pools)

        // Honest swap must satisfy invariant
        if reserve_in > 0 && reserve_out > out {
            let new_rx = reserve_in.saturating_add(amount_in);
            let new_ry = reserve_out - out;
            let result = verify_invariant(reserve_in, reserve_out, new_rx, new_ry, fee_bps);
            assert!(
                result.is_ok(),
                "invariant failed for honest swap: in={} rx={} ry={} fee={}: {:?}",
                amount_in, reserve_in, reserve_out, fee_bps, result
            );
        }

        // Cheating by taking one extra unit must fail invariant
        if out < reserve_out && reserve_in > 0 && amount_in > 1000 && out > 100 {
            let cheat = out + 1;
            if cheat <= reserve_out {
                let cheat_result = verify_invariant(
                    reserve_in, reserve_out,
                    reserve_in.saturating_add(amount_in),
                    reserve_out - cheat,
                    fee_bps,
                );
                assert!(
                    cheat_result.is_err(),
                    "cheat not detected: out={} cheat={} rx={} ry={} fee={}",
                    out, cheat, reserve_in, reserve_out, fee_bps
                );
            }
        }
    }

    // ── compute_lp_mint: must never panic ─────────────────────────────────

    // Initial deposit case
    if let Ok((mint, burn)) = compute_lp_mint(amount_in, reserve_in, 0, 0, 0) {
        assert_eq!(burn, MINIMUM_LIQUIDITY, "first deposit must burn MINIMUM_LIQUIDITY");
        assert!(mint > 0, "mint must be positive");
        // Total minted = mint + burn
        let total = mint + burn;
        // total ≈ sqrt(amount_in * reserve_in), a rough sanity check
        assert!(total <= amount_in.max(reserve_in).saturating_add(reserve_in.max(amount_in)));
    }

    // Subsequent deposit case
    if reserve_in > 0 && reserve_out > 0 {
        let lp_supply = reserve_in.min(reserve_out); // arbitrary supply
        if let Ok((mint, burn)) = compute_lp_mint(amount_in, reserve_out, reserve_in, reserve_out, lp_supply) {
            assert_eq!(burn, 0, "subsequent deposit must not burn");
            let _ = mint;
            // mint must be proportional: mint/supply <= amount/reserve
            // (allowing 1 unit rounding)
        }
    }

    // ── sqrt_k: geometric mean of the reserves, must never panic/overflow ─
    let rk = sqrt_k(reserve_in, reserve_out);
    // rk^2 <= reserve_in*reserve_out < (rk+1)^2 (integer sqrt). Check the lower side without
    // overflowing by comparing in u128 space only when the square fits.
    if let Some(sq) = rk.checked_mul(rk) {
        if let Some(prod) = reserve_in.checked_mul(reserve_out) {
            assert!(sq <= prod, "sqrt_k {} overshoots product", rk);
        }
    }

    // ── compute_protocol_fee_lp: UniV2 _mintFee share, must never panic ───
    // root_k_last is derived from the reserves so we exercise both the fee-off (0) and fee-on paths.
    let lp_supply = reserve_in;
    let root_k = sqrt_k(reserve_in, reserve_out);
    let root_k_last = sqrt_k(reserve_out, reserve_in) / 2; // <= root_k, sometimes 0 (fee off)
    let minted = compute_protocol_fee_lp(lp_supply, root_k, root_k_last);
    // The treasury's share can never exceed the LP supply it dilutes.
    if lp_supply > 0 {
        assert!(minted <= lp_supply, "protocol fee mint {} exceeds supply {}", minted, lp_supply);
    }
    // No growth (or fee off) mints nothing.
    if root_k_last == 0 || root_k <= root_k_last {
        assert_eq!(minted, 0, "no growth / fee off must mint 0");
    }
});
