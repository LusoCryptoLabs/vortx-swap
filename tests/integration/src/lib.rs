// Integration tests, run with `cargo test`
// Uses std-feature build of amm-math

#[cfg(test)]
mod amm_tests {
    use amm_math::{
        compute_lp_mint, get_amount_out, verify_invariant, AmmError, MINIMUM_LIQUIDITY,
    };

    // ── Happy paths ───────────────────────────────────────────────────────

    #[test]
    fn swap_x_for_y() {
        let out = get_amount_out(10_000, 1_000_000, 1_000_000, 30).unwrap();
        // 1% of pool in, 0.3% fee + ~1% price impact → 9871 (constant-product exact).
        assert_eq!(out, 9_871);
        assert!(verify_invariant(1_000_000, 1_000_000, 1_010_000, 1_000_000 - out, 30).is_ok());
    }

    #[test]
    fn swap_y_for_x() {
        let out = get_amount_out(5_000, 2_000_000, 500_000, 30).unwrap();
        assert!(verify_invariant(500_000, 2_000_000, 500_000 - out, 2_005_000, 30).is_ok());
    }

    #[test]
    fn initial_liquidity_with_burn() {
        let (mint, burn) = compute_lp_mint(1_000_000, 1_000_000, 0, 0, 0).unwrap();
        // sqrt(1e6 * 1e6) = 1e6, minus MINIMUM_LIQUIDITY locked
        assert_eq!(mint, 1_000_000 - MINIMUM_LIQUIDITY);
        assert_eq!(burn, MINIMUM_LIQUIDITY);
    }

    #[test]
    fn proportional_liquidity_no_burn() {
        let (mint, burn) =
            compute_lp_mint(100_000, 100_000, 1_000_000, 1_000_000, 1_000_000).unwrap();
        assert!(mint > 0);
        assert_eq!(burn, 0);
    }

    // ── Attack vectors ────────────────────────────────────────────────────

    #[test]
    fn attack_first_lp_inflation_blocked() {
        // The Uniswap v2 inflation attack
        assert_eq!(
            compute_lp_mint(1, 1, 0, 0, 0),
            Err(AmmError::InsufficientInitialLiquidity)
        );
        assert_eq!(
            compute_lp_mint(999, 999, 0, 0, 0),
            Err(AmmError::InsufficientInitialLiquidity)
        );
        // Just barely OK at sqrt > MINIMUM_LIQUIDITY
        assert!(compute_lp_mint(1_001, 1_001, 0, 0, 0).is_ok());
    }

    #[test]
    fn attack_zero_input_rejected() {
        assert_eq!(
            get_amount_out(0, 1_000, 1_000, 30),
            Err(AmmError::ZeroInput)
        );
        assert_eq!(
            compute_lp_mint(0, 1, 100, 100, 1000),
            Err(AmmError::ZeroInput)
        );
        assert_eq!(
            compute_lp_mint(1, 0, 100, 100, 1000),
            Err(AmmError::ZeroInput)
        );
    }

    #[test]
    fn attack_zero_reserve_rejected() {
        assert_eq!(
            get_amount_out(100, 0, 1_000, 30),
            Err(AmmError::ZeroReserve)
        );
        assert_eq!(
            get_amount_out(100, 1_000, 0, 30),
            Err(AmmError::ZeroReserve)
        );
    }

    #[test]
    fn attack_invariant_both_decrease_rejected() {
        // Can't decrease both reserves: that's a free withdrawal
        assert!(verify_invariant(1000, 1000, 900, 900, 30).is_err());
    }

    #[test]
    fn attack_invariant_both_increase_rejected() {
        // Can't increase both reserves with one swap (donation is separate path)
        assert!(verify_invariant(1000, 1000, 1100, 1100, 30).is_err());
    }

    #[test]
    fn attack_extra_output_rejected() {
        // Honest swap
        let honest = get_amount_out(1_000, 1_000_000, 1_000_000, 30).unwrap();
        // Try to take 100 more: must fail invariant
        assert!(verify_invariant(
            1_000_000,
            1_000_000,
            1_001_000,
            1_000_000 - (honest + 100),
            30
        )
        .is_err());
    }

    #[test]
    fn attack_fee_bypass_rejected() {
        // Try to swap as if no fee
        let no_fee_out = get_amount_out(1_000, 1_000_000, 1_000_000, 0).unwrap();
        // Apply this output with actual 30bps fee setting: must fail
        assert!(
            verify_invariant(1_000_000, 1_000_000, 1_001_000, 1_000_000 - no_fee_out, 30).is_err()
        );
    }

    #[test]
    fn attack_overflow_safe_at_max_reserves() {
        let max = u128::MAX / 2;
        assert!(get_amount_out(1_000, max, max, 30).is_ok());
        assert!(get_amount_out(max / 1000, max, max, 30).is_ok());
    }

    #[test]
    fn attack_rounding_to_zero() {
        // Tiny input on huge pool: output rounds to 0
        let out = get_amount_out(1, u128::MAX / 2, u128::MAX / 2, 30).unwrap();
        assert_eq!(out, 0);
    }

    // ── Edge cases ────────────────────────────────────────────────────────

    #[test]
    fn fee_tier_correctness() {
        // Stable (5bps) should give more output than Standard (30bps) than Exotic (100bps)
        let stable = get_amount_out(10_000, 1_000_000, 1_000_000, 5).unwrap();
        let standard = get_amount_out(10_000, 1_000_000, 1_000_000, 30).unwrap();
        let exotic = get_amount_out(10_000, 1_000_000, 1_000_000, 100).unwrap();
        assert!(stable > standard);
        assert!(standard > exotic);
    }

    #[test]
    fn price_impact_grows_with_size() {
        let small = get_amount_out(1_000, 1_000_000, 1_000_000, 30).unwrap();
        let large = get_amount_out(100_000, 1_000_000, 1_000_000, 30).unwrap();
        let small_price = small as f64 / 1_000.0;
        let large_price = large as f64 / 100_000.0;
        assert!(large_price < small_price);
    }

    #[test]
    fn lp_proportionality_preserved() {
        // Two LPs, same proportional deposit → same LP tokens
        let (lp1, _) = compute_lp_mint(100_000, 100_000, 1_000_000, 1_000_000, 1_000_000).unwrap();
        let (lp2, _) = compute_lp_mint(200_000, 200_000, 1_000_000, 1_000_000, 1_000_000).unwrap();
        assert_eq!(lp2, lp1 * 2);
    }
}
