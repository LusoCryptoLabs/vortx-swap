#![cfg_attr(not(feature = "std"), no_std)]
//! Pure AMM mathematics, no CKB dependencies.
//! All arithmetic uses U256 to prevent overflow.

use ethnum::U256;

pub const BPS_DENOMINATOR: u32 = 10_000;

/// Protocol-fee denominator (UniV2 `_mintFee`): the protocol takes 1/PROTOCOL_FEE_DENOM of the
/// fee growth as minted LP. 6 reproduces UniV2's "1/6 of fees ≈ 5bps of a 30bps pool".
pub const PROTOCOL_FEE_DENOM: u128 = 6;

/// Locked forever on first deposit. Prevents inflation attack
/// where first LP deposits dust + donates to dilute later LPs.
pub const MINIMUM_LIQUIDITY: u128 = 1_000;

#[derive(Debug, PartialEq)]
pub enum AmmError {
    ZeroInput,
    ZeroReserve,
    InvariantViolation,
    Overflow,
    InsufficientOutput,
    InsufficientInitialLiquidity,
    /// fee_bps >= BPS_DENOMINATOR: the fee cannot equal or exceed 100%. Guarded up front so the
    /// `denom - fee` term can never underflow. pool-script also caps fee_bps well below this.
    FeeTooHigh,
}

pub fn get_amount_out(
    amount_in: u128,
    reserve_in: u128,
    reserve_out: u128,
    fee_bps: u16,
) -> Result<u128, AmmError> {
    if amount_in == 0 {
        return Err(AmmError::ZeroInput);
    }
    if reserve_in == 0 || reserve_out == 0 {
        return Err(AmmError::ZeroReserve);
    }
    // A fee of 100% or more would underflow `denom - fee` below. Reject up front so the
    // math is self-contained and cannot depend on every caller pre-validating fee_bps.
    if fee_bps as u32 >= BPS_DENOMINATOR {
        return Err(AmmError::FeeTooHigh);
    }

    let amount_in = U256::from(amount_in);
    let reserve_in = U256::from(reserve_in);
    let reserve_out = U256::from(reserve_out);
    let fee = U256::from(fee_bps as u128);
    let denom = U256::from(BPS_DENOMINATOR as u128);

    let numerator = amount_in * (denom - fee) * reserve_out;
    let denominator = reserve_in * denom + amount_in * (denom - fee);

    if denominator == U256::ZERO {
        return Err(AmmError::Overflow);
    }
    let out = numerator / denominator;
    if out > U256::from(u128::MAX) {
        return Err(AmmError::Overflow);
    }
    u128::try_from(out).map_err(|_| AmmError::Overflow)
}

/// Verify constant-product invariant.
/// Requires explicit one-direction swap: x increases and y decreases, or vice versa.
pub fn verify_invariant(
    reserve_x_before: u128,
    reserve_y_before: u128,
    reserve_x_after: u128,
    reserve_y_after: u128,
    fee_bps: u16,
) -> Result<(), AmmError> {
    // Defense in depth: a zero before-reserve makes
    // k_before = rx·ry = 0, after which the `k_after < k_before` test below can never hold (unsigned),
    // so every swap would pass and drain the opposite reserve for dust. This state is unreachable in
    // practice (verify_pool_creation rejects a zero reserve, a swap can't zero one because it requires
    // k_after >= k_before > 0, and MINIMUM_LIQUIDITY floors lp_supply so removes can't drain to 0),
    // but that safety depends transitively on the separate lp-token contract keeping MINIMUM_LIQUIDITY
    // unredeemable. Guarding it here makes the swap invariant self-contained and fail-closed.
    if reserve_x_before == 0 || reserve_y_before == 0 {
        return Err(AmmError::ZeroReserve);
    }
    // A fee of 100% or more would underflow `denom - fee` below. Reject up front.
    if fee_bps as u32 >= BPS_DENOMINATOR {
        return Err(AmmError::FeeTooHigh);
    }

    let x0 = U256::from(reserve_x_before);
    let y0 = U256::from(reserve_y_before);
    let x1 = U256::from(reserve_x_after);
    let y1 = U256::from(reserve_y_after);
    let fee = U256::from(fee_bps as u128);
    let denom = U256::from(BPS_DENOMINATOR as u128);

    let (delta_in, delta_out, rx, ry) = if x1 > x0 && y1 < y0 {
        (x1 - x0, y0 - y1, x0, y0)
    } else if y1 > y0 && x1 < x0 {
        (y1 - y0, x0 - x1, y0, x0)
    } else {
        return Err(AmmError::InvariantViolation);
    };

    let delta_in_after_fee = delta_in * (denom - fee) / denom;
    let k_after = (rx + delta_in_after_fee) * (ry - delta_out);
    let k_before = rx * ry;

    if k_after < k_before {
        return Err(AmmError::InvariantViolation);
    }
    Ok(())
}

/// Returns (lp_minted_to_user, lp_locked_forever).
/// On first deposit, lp_locked_forever = MINIMUM_LIQUIDITY.
pub fn compute_lp_mint(
    amount_x: u128,
    amount_y: u128,
    reserve_x: u128,
    reserve_y: u128,
    lp_supply: u128,
) -> Result<(u128, u128), AmmError> {
    if amount_x == 0 || amount_y == 0 {
        return Err(AmmError::ZeroInput);
    }

    if lp_supply == 0 {
        let product = U256::from(amount_x) * U256::from(amount_y);
        let sqrt = integer_sqrt(product);
        if sqrt > U256::from(u128::MAX) {
            return Err(AmmError::Overflow);
        }
        let total = u128::try_from(sqrt).map_err(|_| AmmError::Overflow)?;
        if total <= MINIMUM_LIQUIDITY {
            return Err(AmmError::InsufficientInitialLiquidity);
        }
        return Ok((total - MINIMUM_LIQUIDITY, MINIMUM_LIQUIDITY));
    }

    let lp_from_x = U256::from(amount_x) * U256::from(lp_supply) / U256::from(reserve_x);
    let lp_from_y = U256::from(amount_y) * U256::from(lp_supply) / U256::from(reserve_y);
    let lp = lp_from_x.min(lp_from_y);
    if lp > U256::from(u128::MAX) {
        return Err(AmmError::Overflow);
    }
    Ok((u128::try_from(lp).map_err(|_| AmmError::Overflow)?, 0))
}

/// √(rx·ry) as a u128, the "root k" used by the protocol-fee accumulator. Computed in U256 so
/// the product never overflows; the square root of any u128·u128 product fits in u128.
pub fn sqrt_k(reserve_x: u128, reserve_y: u128) -> u128 {
    let p = U256::from(reserve_x) * U256::from(reserve_y);
    u128::try_from(integer_sqrt(p)).unwrap_or(u128::MAX)
}

/// LP to mint to the treasury (UniV2 `_mintFee`), = the protocol's 1/PROTOCOL_FEE_DENOM share of
/// the growth in √k since the last collection.
///   root_k      = √(reserve_x·reserve_y) now   (use `sqrt_k`)
///   root_k_last = stored √k at last collection  (0 ⇒ fee switch off ⇒ mints nothing)
/// numerator   = lp_supply·(root_k − root_k_last)
/// denominator = root_k·(DENOM−1) + root_k_last
/// Rounds down (favors LPs over the treasury, mirroring UniV2).
pub fn compute_protocol_fee_lp(lp_supply: u128, root_k: u128, root_k_last: u128) -> u128 {
    if root_k_last == 0 || root_k <= root_k_last {
        return 0;
    }
    let numerator = U256::from(lp_supply) * U256::from(root_k - root_k_last);
    let denominator =
        U256::from(root_k) * U256::from(PROTOCOL_FEE_DENOM - 1) + U256::from(root_k_last);
    if denominator == U256::ZERO {
        return 0;
    }
    u128::try_from(numerator / denominator).unwrap_or(0)
}

fn integer_sqrt(n: U256) -> U256 {
    if n == U256::ZERO {
        return U256::ZERO;
    }
    let mut x = n;
    let mut y = (x + U256::ONE) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_swap() {
        let out = get_amount_out(1000, 10_000, 10_000, 30).unwrap();
        assert!(out > 900 && out < 1000);
    }

    #[test]
    fn zero_input() {
        assert_eq!(get_amount_out(0, 1, 1, 30), Err(AmmError::ZeroInput));
    }
    #[test]
    fn zero_reserve() {
        assert_eq!(get_amount_out(1, 0, 1, 30), Err(AmmError::ZeroReserve));
    }

    #[test]
    fn invariant_holds() {
        let out = get_amount_out(10_000, 1_000_000, 1_000_000, 30).unwrap();
        assert!(verify_invariant(1_000_000, 1_000_000, 1_010_000, 1_000_000 - out, 30).is_ok());
    }

    #[test]
    fn invariant_rejects_both_decreasing() {
        assert!(verify_invariant(1000, 1000, 900, 900, 30).is_err());
    }

    #[test]
    fn invariant_rejects_zero_reserve() {
        // Defense-in-depth: a zero before-reserve makes k_before = 0, after which the unsigned
        // `k_after < k_before` test can never fail, so any swap would pass and drain the opposite
        // reserve. Must be rejected even though the state is unreachable in normal operation.
        assert_eq!(
            verify_invariant(0, 1_000_000, 5_000, 1, 30),
            Err(AmmError::ZeroReserve)
        );
        assert_eq!(
            verify_invariant(1_000_000, 0, 1, 5_000, 30),
            Err(AmmError::ZeroReserve)
        );
        assert_eq!(verify_invariant(0, 0, 1, 1, 30), Err(AmmError::ZeroReserve));
    }

    #[test]
    fn invariant_rejects_both_increasing() {
        assert!(verify_invariant(1000, 1000, 1100, 1100, 30).is_err());
    }

    #[test]
    fn invariant_rejects_cheat() {
        let out = get_amount_out(1000, 1_000_000, 1_000_000, 30).unwrap();
        assert!(
            verify_invariant(1_000_000, 1_000_000, 1_001_000, 1_000_000 - (out + 100), 30).is_err()
        );
    }

    #[test]
    fn first_lp_dust_attack_blocked() {
        assert_eq!(
            compute_lp_mint(1, 1, 0, 0, 0),
            Err(AmmError::InsufficientInitialLiquidity)
        );
        assert_eq!(
            compute_lp_mint(999, 999, 0, 0, 0),
            Err(AmmError::InsufficientInitialLiquidity)
        );
    }

    #[test]
    fn first_lp_correct_burn() {
        let (mint, burn) = compute_lp_mint(1_000_000, 1_000_000, 0, 0, 0).unwrap();
        assert_eq!(mint, 999_000);
        assert_eq!(burn, MINIMUM_LIQUIDITY);
    }

    #[test]
    fn subsequent_lp_no_burn() {
        let (_, burn) = compute_lp_mint(100, 100, 1_000_000, 1_000_000, 1_000_000).unwrap();
        assert_eq!(burn, 0);
    }

    #[test]
    fn large_reserves_safe() {
        assert!(get_amount_out(1_000_000, u128::MAX / 2, u128::MAX / 2, 30).is_ok());
    }

    #[test]
    fn fee_off_mints_nothing() {
        // root_k_last == 0 ⇒ fee switch off.
        assert_eq!(compute_protocol_fee_lp(1_000_000, 1_010_000, 0), 0);
    }

    #[test]
    fn fee_no_growth_mints_nothing() {
        // k did not grow since last collection.
        assert_eq!(compute_protocol_fee_lp(1_000_000, 1_000_000, 1_000_000), 0);
        assert_eq!(compute_protocol_fee_lp(1_000_000, 999_000, 1_000_000), 0);
    }

    #[test]
    fn fee_mints_one_sixth_of_growth() {
        // 1% growth in root_k → treasury gets ≈ lp_supply·dk/(6·root_k) (UniV2 1/6 share).
        let lp = 1_000_000u128;
        let root_k_last = 1_000_000u128;
        let root_k = 1_010_000u128; // +1%
        let minted = compute_protocol_fee_lp(lp, root_k, root_k_last);
        // numerator = 1e6 * 10_000 = 1e10; denom = 1_010_000*5 + 1_000_000 = 6_050_000
        // minted = 1e10 / 6_050_000 ≈ 1652
        assert_eq!(minted, 10_000_000_000u128 / 6_050_000u128);
        assert!(minted > 1600 && minted < 1700);
    }

    #[test]
    fn fee_rounds_down_favors_lps() {
        // Always rounds down: the treasury never mints more than its exact share.
        let minted = compute_protocol_fee_lp(7, 1_000_001, 1_000_000);
        assert_eq!(minted, 0); // tiny growth on tiny supply floors to 0
    }

    #[test]
    fn fee_at_or_above_100pct_rejected() {
        // fee_bps >= BPS_DENOMINATOR would underflow `denom - fee`. Both entry points must
        // reject it instead of underflowing.
        assert_eq!(
            get_amount_out(1000, 1_000_000, 1_000_000, 10_000),
            Err(AmmError::FeeTooHigh)
        );
        assert_eq!(
            get_amount_out(1000, 1_000_000, 1_000_000, u16::MAX),
            Err(AmmError::FeeTooHigh)
        );
        assert_eq!(
            verify_invariant(1_000_000, 1_000_000, 1_001_000, 999_000, 10_000),
            Err(AmmError::FeeTooHigh)
        );
        // Just below the ceiling still computes (no underflow).
        assert!(get_amount_out(1000, 1_000_000, 1_000_000, 9_999).is_ok());
    }

    #[test]
    fn sqrt_k_no_overflow() {
        // √(big·big) fits in u128 and matches the geometric mean.
        assert_eq!(sqrt_k(1_000_000, 1_000_000), 1_000_000);
        assert_eq!(sqrt_k(4, 9), 6);
        assert!(sqrt_k(u128::MAX, u128::MAX) > 0); // doesn't panic/overflow
    }
}
