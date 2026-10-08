//! Invariant assertion helpers (roadmap task 2.6).
//!
//! One assertion per catalog item, taking plain values so each is unit-
//! testable without accounts. All return the typed `OrbitError` so tests can
//! match variants directly; Phase 3 handlers compose them with `?` via the
//! generated `From<OrbitError> for anchor_lang::error::Error`, calling the
//! applicable set at the tail of every mutating handler.

use crate::errors::OrbitError;

/// I1: `round_vault.lamports() == round_vault_rent_minimum + vault_owed`.
///
/// The single, state-independent balance invariant (ADR-6); if this fails,
/// an instruction moved lamports without bookkeeping them.
pub fn assert_round_vault_solvent(
    vault_lamports: u64,
    rent_minimum: u64,
    vault_owed: u64,
) -> Result<(), OrbitError> {
    let expected = rent_minimum
        .checked_add(vault_owed)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    if vault_lamports != expected {
        return Err(OrbitError::RoundVaultInvariant);
    }
    Ok(())
}

/// I2 + I5: the treasury balance matches its bookkeeping, and lifetime
/// accrual minus lifetime sweeps equals what is still sweepable.
pub fn assert_treasury_consistent(
    vault_lamports: u64,
    rent_minimum: u64,
    accrued_lamports: u64,
    lifetime_accrued: u64,
    lifetime_swept: u64,
) -> Result<(), OrbitError> {
    let expected_balance = rent_minimum
        .checked_add(accrued_lamports)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    if vault_lamports != expected_balance {
        return Err(OrbitError::TreasuryInvariant);
    }
    let net = lifetime_accrued
        .checked_sub(lifetime_swept)
        .ok_or(OrbitError::TreasuryInvariant)?;
    if net != accrued_lamports {
        return Err(OrbitError::TreasuryInvariant);
    }
    Ok(())
}

/// I3 + I4: the mega-pot balance matches its bookkeeping, and lifetime
/// contributions minus lifetime awards equal what is still awardable.
pub fn assert_mega_pot_consistent(
    vault_lamports: u64,
    rent_minimum: u64,
    accrued_lamports: u64,
    lifetime_contributed: u64,
    lifetime_awarded: u64,
) -> Result<(), OrbitError> {
    let expected_balance = rent_minimum
        .checked_add(accrued_lamports)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    if vault_lamports != expected_balance {
        return Err(OrbitError::MegaPotInvariant);
    }
    let net = lifetime_contributed
        .checked_sub(lifetime_awarded)
        .ok_or(OrbitError::MegaPotInvariant)?;
    if net != accrued_lamports {
        return Err(OrbitError::MegaPotInvariant);
    }
    Ok(())
}

/// I6 — the v1 three-way zero-loss check, subsumed by I18. Kept as a thin
/// wrapper (refund slice 0) for pre-migration settle paths and tests.
pub fn assert_split_exact(
    total_lamports: u64,
    winner_payout: u64,
    admin_cut: u64,
    mega_cut: u64,
) -> Result<(), OrbitError> {
    assert_pot_split_exact(total_lamports, winner_payout, 0, admin_cut, mega_cut)
}

/// I18 — the four-way split reassembles the pot to the lamport:
/// `total_lamports == winner_payout + refund_pool + admin_cut + mega_cut`.
/// Widened so the assertion itself cannot overflow.
pub fn assert_pot_split_exact(
    total_lamports: u64,
    winner_payout: u64,
    refund_pool: u64,
    admin_cut: u64,
    mega_cut: u64,
) -> Result<(), OrbitError> {
    let reassembled = u128::from(winner_payout)
        + u128::from(refund_pool)
        + u128::from(admin_cut)
        + u128::from(mega_cut);
    if reassembled != u128::from(total_lamports) {
        return Err(OrbitError::SplitInvariant);
    }
    Ok(())
}

/// I7 — the v1 two-way mega split, subsumed by I19. Kept as a thin wrapper
/// (field share 0) for pre-migration settle paths and tests.
pub fn assert_mega_split_exact(
    accrued: u64,
    awarded: u64,
    retained: u64,
) -> Result<(), OrbitError> {
    assert_mega_split_exact_3(accrued, awarded, 0, retained)
}

/// I19 — the Mega-Pot trigger split reassembles the accrual exactly, capped
/// or not: `accrued == mega_awarded + mega_field_pool + mega_retained`.
pub fn assert_mega_split_exact_3(
    accrued: u64,
    awarded: u64,
    field_pool: u64,
    retained: u64,
) -> Result<(), OrbitError> {
    let reassembled = u128::from(awarded) + u128::from(field_pool) + u128::from(retained);
    if reassembled != u128::from(accrued) {
        return Err(OrbitError::MegaSplitInvariant);
    }
    Ok(())
}

/// I20 — neither settle-time pool can be overdrawn by `close_entry` draws:
/// `refunds_paid <= refund_pool` and `mega_field_paid <= mega_field_pool`.
pub fn assert_pools_solvent(
    refund_pool: u64,
    refunds_paid: u64,
    mega_field_pool: u64,
    mega_field_paid: u64,
) -> Result<(), OrbitError> {
    if refunds_paid > refund_pool {
        return Err(OrbitError::RefundPoolExhausted);
    }
    if mega_field_paid > mega_field_pool {
        return Err(OrbitError::MegaFieldPoolExhausted);
    }
    Ok(())
}

/// I21 — the Mega-Pot farming guard, the reason the trigger is not
/// exploitable. Derived for economics v3 (AUDIT P-2; the v2 bound
/// `cap_bps <= modulus × (admin+mega)` is positive-EV under v3):
///
/// A farmer holding fraction θ of a pot `P` loses, net of the 9% win,
/// `r·θ(1−θ)P` per round in expectation (v3 never rakes the winner; r =
/// (admin+mega)/10_000). On a trigger (odds 1/modulus) the payout is
/// `payable <= cap × base`, base = the losers' stake (the rake base), and
/// is split award:field in the ratio award_bps:field_bps:
///   - farmer wins (prob θ, base = (1−θ)P): award share + θ of the field;
///   - farmer loses (prob 1−θ, base ≈ P): θ of the field share.
/// Expected capture per round = cap·θ(1−θ)P·(award + 2θ·field) /
/// (modulus·(award+field)). Non-positive EV for every θ ∈ (0,1), every P
/// and every pot balance (worst case θ → 1) iff
///
///   cap_bps × (award + 2·field) <= modulus × (admin+mega) × (award + field)
///
/// i.e. ≤ 86 538 bps at 50/40, 1-in-625, 1%+1% — the shipped 80 000 is
/// inside (AUDIT P-2: the v2 bound `modulus × (admin+mega)` = 125 000 was
/// positive-EV under v3). Computed in u128. A `cap_bps == 0` means uncapped — the grandfathered
/// pre-Phase-11 behaviour, legal only below `economics_version` 2, which
/// the migration latch enforces separately.
pub fn assert_mega_farm_safe(
    mega_payout_cap_bps: u32,
    mega_trigger_modulus: u32,
    fee_bps_admin: u16,
    fee_bps_mega: u16,
    mega_award_bps: u16,
    mega_field_bps: u16,
) -> Result<(), OrbitError> {
    if mega_payout_cap_bps == 0 {
        return Ok(());
    }
    let take = u128::from(mega_payout_cap_bps)
        * (u128::from(mega_award_bps) + 2 * u128::from(mega_field_bps));
    let budget = u128::from(mega_trigger_modulus)
        * (u128::from(fee_bps_admin) + u128::from(fee_bps_mega))
        * (u128::from(mega_award_bps) + u128::from(mega_field_bps));
    if take > budget {
        return Err(OrbitError::MegaFarmGuardViolated);
    }
    Ok(())
}

/// I22 — at `close_round`, residual `vault_owed` is rounding dust only:
/// at most one lamport per entry from each of the two pro-rata pools.
/// A larger residual is an accounting bug, not dust, and must fail loudly
/// rather than silently donate player money to the Mega-Pot.
pub fn assert_dust_within_bounds(vault_owed: u64, entry_count: u32) -> Result<(), OrbitError> {
    let bound = u64::from(entry_count).saturating_mul(2);
    if vault_owed > bound {
        return Err(OrbitError::RoundDustOutOfBounds);
    }
    Ok(())
}

/// I16: `player_escrow.lamports() >= player_escrow_rent_minimum`.
///
/// The escrow is never closed, so the rent floor is a permanent cost per
/// player — `(128 + 122) × 3480 × 2 = 1_740_000` lamports ≈ 0.00174 SOL
/// at the 122-byte account; every debit refuses to cross it and this
/// re-asserts the fact at the tail of every escrow-touching handler. (The
/// code reads the Rent sysvar and is right; this comment previously said
/// ~0.00127 SOL, which matched neither the arithmetic nor the sysvar.)
pub fn assert_escrow_rent_exempt(
    escrow_lamports: u64,
    rent_minimum: u64,
) -> Result<(), OrbitError> {
    if escrow_lamports < rent_minimum {
        return Err(OrbitError::EscrowInvariant);
    }
    Ok(())
}

/// The spendable balance of an escrow — `lamports - rent_minimum`,
/// saturating at zero. The ONLY way escrow funds are ever measured (R4):
/// prizes, refunds and rent rebates arrive via `add_lamports` from
/// instructions that know nothing about the escrow, so no stored balance
/// could stay true.
pub fn escrow_spendable(escrow_lamports: u64, rent_minimum: u64) -> u64 {
    escrow_lamports.saturating_sub(rent_minimum)
}

/// What one auto-deposited round costs an escrow: the stake plus the
/// entry's rent (reimbursed to the crank in the same instruction, returned
/// to the escrow at `close_entry`) plus the crank tip (never returned).
pub fn auto_deposit_round_cost(
    per_round_lamports: u64,
    entry_rent: u64,
    tip_lamports: u64,
) -> Result<u64, OrbitError> {
    per_round_lamports
        .checked_add(entry_rent)
        .and_then(|sum| sum.checked_add(tip_lamports))
        .ok_or(OrbitError::ArithmeticOverflow)
}

/// `rounds_remaining` under `auto_reinvest`: how many rounds the spendable
/// balance buys, capped at `max_rounds` so the player's exposure stays
/// bounded and knowable. A zero `round_cost` returns 0 — never a division
/// by zero — and the `u64 → u32` conversion saturates.
pub fn rounds_affordable(spendable: u64, round_cost: u64, max_rounds: u32) -> u32 {
    if round_cost == 0 {
        return 0;
    }
    let affordable = (spendable / round_cost).min(u64::from(u32::MAX));
    // Fitting by construction (both mins are ≤ u32::MAX), so the cast
    // cannot truncate.
    affordable.min(u64::from(max_rounds)) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn i1_round_vault_solvent_accepts_and_rejects() {
        assert!(assert_round_vault_solvent(1_000, 500, 500).is_ok());
        assert!(matches!(
            assert_round_vault_solvent(999, 500, 500),
            Err(OrbitError::RoundVaultInvariant)
        ));
        assert!(matches!(
            assert_round_vault_solvent(u64::MAX, u64::MAX, 1),
            Err(OrbitError::ArithmeticOverflow)
        ));
    }

    #[test]
    fn i2_i5_treasury_consistent_accepts_and_rejects() {
        assert!(assert_treasury_consistent(1_500, 500, 1_000, 3_000, 2_000).is_ok());
        // balance off (I2)
        assert!(matches!(
            assert_treasury_consistent(1_499, 500, 1_000, 3_000, 2_000),
            Err(OrbitError::TreasuryInvariant)
        ));
        // lifetime bookkeeping off (I5)
        assert!(matches!(
            assert_treasury_consistent(1_500, 500, 1_000, 3_000, 1_999),
            Err(OrbitError::TreasuryInvariant)
        ));
        // lifetime_swept > lifetime_accrued is nonsense, not a wraparound
        assert!(matches!(
            assert_treasury_consistent(1_500, 500, 1_000, 1_000, 2_000),
            Err(OrbitError::TreasuryInvariant)
        ));
    }

    #[test]
    fn i3_i4_mega_pot_consistent_accepts_and_rejects() {
        assert!(assert_mega_pot_consistent(2_000, 500, 1_500, 4_000, 2_500).is_ok());
        assert!(matches!(
            assert_mega_pot_consistent(1_999, 500, 1_500, 4_000, 2_500),
            Err(OrbitError::MegaPotInvariant)
        ));
        assert!(matches!(
            assert_mega_pot_consistent(2_000, 500, 1_500, 4_000, 2_499),
            Err(OrbitError::MegaPotInvariant)
        ));
    }

    #[test]
    fn i6_split_exact_accepts_and_rejects() {
        assert!(assert_split_exact(10_000, 9_800, 100, 100).is_ok());
        // u64::MAX-scale conservation
        assert!(assert_split_exact(
            u64::MAX,
            18_077_809_192_235_360_583,
            184_467_440_737_095_516,
            184_467_440_737_095_516
        )
        .is_ok());
        assert!(matches!(
            assert_split_exact(10_000, 9_800, 100, 99),
            Err(OrbitError::SplitInvariant)
        ));
    }

    #[test]
    fn i7_mega_split_exact_accepts_and_rejects() {
        assert!(assert_mega_split_exact(123_456_789, 111_111_110, 12_345_679).is_ok());
        assert!(matches!(
            assert_mega_split_exact(123_456_789, 111_111_110, 12_345_678),
            Err(OrbitError::MegaSplitInvariant)
        ));
    }

    #[test]
    fn i18_pot_split_exact_accepts_and_rejects() {
        // The canonical 10 SOL round: 0.9 winner + 8.9 refunds + 0.1 + 0.1.
        assert!(assert_pot_split_exact(
            10_000_000_000,
            900_000_000,
            8_900_000_000,
            100_000_000,
            100_000_000
        )
        .is_ok());
        // u64::MAX-scale conservation, widened.
        assert!(assert_pot_split_exact(
            u64::MAX,
            18_077_809_192_235_360_583,
            0,
            184_467_440_737_095_516,
            184_467_440_737_095_516
        )
        .is_ok());
        assert!(matches!(
            assert_pot_split_exact(
                10_000_000_000,
                900_000_000,
                8_899_999_999,
                100_000_000,
                100_000_000
            ),
            Err(OrbitError::SplitInvariant)
        ));
        // Four non-zero slices at u64::MAX cannot overflow the u128 check.
        assert!(matches!(
            assert_pot_split_exact(0, u64::MAX, u64::MAX, u64::MAX, u64::MAX),
            Err(OrbitError::SplitInvariant)
        ));
    }

    #[test]
    fn i19_mega_split_exact_3_accepts_and_rejects() {
        // 50/40/10 of an accrual: awarded + field + retained reassemble it.
        assert!(assert_mega_split_exact_3(123_456_789, 61_728_394, 49_382_715, 12_345_680).is_ok());
        assert!(matches!(
            assert_mega_split_exact_3(123_456_789, 61_728_394, 49_382_715, 12_345_679),
            Err(OrbitError::MegaSplitInvariant)
        ));
    }

    #[test]
    fn i20_pools_solvent_accepts_and_rejects() {
        assert!(assert_pools_solvent(8_900, 8_900, 4_000, 4_000).is_ok());
        assert!(assert_pools_solvent(8_900, 0, 4_000, 0).is_ok());
        // Each pool fails with its own variant, independently.
        assert!(matches!(
            assert_pools_solvent(8_900, 8_901, 4_000, 4_000),
            Err(OrbitError::RefundPoolExhausted)
        ));
        assert!(matches!(
            assert_pools_solvent(8_900, 8_900, 4_000, 4_001),
            Err(OrbitError::MegaFieldPoolExhausted)
        ));
        // u64 extremes never overflow — these are comparisons, not sums.
        assert!(assert_pools_solvent(u64::MAX, u64::MAX, u64::MAX, u64::MAX).is_ok());
        assert!(matches!(
            assert_pools_solvent(u64::MAX, u64::MAX, 0, 1),
            Err(OrbitError::MegaFieldPoolExhausted)
        ));
    }

    #[test]
    fn i21_mega_farm_safe_accepts_and_rejects() {
        // The canonical config at 50/40: the v3 bound is
        // floor(625 × 200 × 9_000 / 13_000) = 86_538; 80_000 sits inside.
        assert!(assert_mega_farm_safe(80_000, 625, 100, 100, 5_000, 4_000).is_ok());
        assert!(assert_mega_farm_safe(86_538, 625, 100, 100, 5_000, 4_000).is_ok());
        assert!(matches!(
            assert_mega_farm_safe(86_539, 625, 100, 100, 5_000, 4_000),
            Err(OrbitError::MegaFarmGuardViolated)
        ));
        // The stale v2 boundary (125_000) is now refused.
        assert!(matches!(
            assert_mega_farm_safe(125_000, 625, 100, 100, 5_000, 4_000),
            Err(OrbitError::MegaFarmGuardViolated)
        ));
        // `0` is the grandfathered uncapped (pre-Phase-11) case — always Ok
        // here; the migration latch is what forbids it at version 2.
        assert!(assert_mega_farm_safe(0, 625, 100, 100, 5_000, 4_000).is_ok());
        // A modulus of 0 admits no positive cap at all.
        assert!(matches!(
            assert_mega_farm_safe(1, 0, 100, 100, 5_000, 4_000),
            Err(OrbitError::MegaFarmGuardViolated)
        ));
        // Extremes: computed in u128, cannot overflow.
        assert!(matches!(
            assert_mega_farm_safe(u32::MAX, 1, u16::MAX, u16::MAX, u16::MAX, u16::MAX),
            Err(OrbitError::MegaFarmGuardViolated)
        ));
    }

    #[test]
    fn i22_dust_within_bounds_accepts_and_rejects() {
        assert!(assert_dust_within_bounds(0, 0).is_ok());
        assert!(assert_dust_within_bounds(0, 100).is_ok());
        // One lamport per entry from each of the two pro-rata pools.
        assert!(assert_dust_within_bounds(200, 100).is_ok());
        assert!(matches!(
            assert_dust_within_bounds(201, 100),
            Err(OrbitError::RoundDustOutOfBounds)
        ));
        // u32::MAX entries × 2 cannot overflow the u64 bound.
        assert!(assert_dust_within_bounds(u64::MAX, u32::MAX).is_err());
        assert!(matches!(
            assert_dust_within_bounds(u64::MAX, u32::MAX),
            Err(OrbitError::RoundDustOutOfBounds)
        ));
    }

    #[test]
    fn i16_escrow_rent_exempt_accepts_and_rejects() {
        assert!(assert_escrow_rent_exempt(1_270_000, 1_270_000).is_ok());
        assert!(assert_escrow_rent_exempt(1_270_001, 1_270_000).is_ok());
        assert!(matches!(
            assert_escrow_rent_exempt(1_269_999, 1_270_000),
            Err(OrbitError::EscrowInvariant)
        ));
    }

    #[test]
    fn escrow_spendable_subtracts_the_floor_and_saturates() {
        assert_eq!(escrow_spendable(2_270_000, 1_270_000), 1_000_000);
        assert_eq!(escrow_spendable(1_270_000, 1_270_000), 0);
        // A below-floor balance (only possible pre-init) reads as zero,
        // never as a wrapped u64.
        assert_eq!(escrow_spendable(5, 1_270_000), 0);
    }

    #[test]
    fn auto_deposit_round_cost_sums_checked() {
        assert_eq!(
            auto_deposit_round_cost(100_000_000, 1_203_960, 200_000).unwrap(),
            101_403_960
        );
        assert_eq!(auto_deposit_round_cost(0, 0, 0).unwrap(), 0);
        assert!(matches!(
            auto_deposit_round_cost(u64::MAX, 1, 1),
            Err(OrbitError::ArithmeticOverflow)
        ));
    }

    #[test]
    fn rounds_affordable_divides_caps_and_never_divides_by_zero() {
        // 10 rounds at the §4.7 worked example's cost: 1_014_039_600 buys 10.
        assert_eq!(rounds_affordable(1_014_039_600, 101_403_960, 10), 10);
        // Leftover below one round buys nothing.
        assert_eq!(rounds_affordable(101_403_959, 101_403_960, 10), 0);
        // max_rounds caps the reinvest growth.
        assert_eq!(rounds_affordable(u64::MAX, 1, 5), 5);
        // The u64 → u32 conversion saturates before the cap applies.
        assert_eq!(rounds_affordable(u64::MAX, 1, u32::MAX), u32::MAX);
        // Zero cost is a divide-by-zero trap, not "infinite rounds".
        assert_eq!(rounds_affordable(1_000_000, 0, 5), 0);
    }
}
