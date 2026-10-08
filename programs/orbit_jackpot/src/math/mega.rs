//! Mega-Pot arithmetic: the 1-in-N trigger carved out of the second entropy
//! half, and the capped 50/40/10 division of the pot when it fires.
//!
//! The trigger odds are config (`mega_trigger_modulus`, canonical 625 under
//! Phase 11 economics). The payout split is three-way: the round winner's
//! `awarded`, the every-entry pro-rata `field_pool`, and the `retained`
//! residual that stays in the pot as the next cycle's seed. The total
//! payout is capped at `mega_payout_cap_bps` of the round's own pot — the
//! I21 farm guard; `0` means uncapped (the pre-Phase-11 behaviour, R6).
//! Under a cap the winner:field ratio is preserved and the unpaid remainder
//! simply stays in the pot, so pops always happen on schedule.

use crate::constants::BPS_DENOMINATOR;
use crate::errors::MathError;

/// The three-way division of the Mega-Pot when it fires.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MegaSplit {
    /// To the round winner, via `claim_winnings` (ADR-8 snapshot).
    pub awarded: u64,
    /// Pro-rata to every entry, via `close_entry` — the winner's included.
    pub field_pool: u64,
    /// Residual of `accrued` — always `accrued - payable`, so the triple
    /// reassembles `accrued` to the lamport (invariant I19) and the next
    /// cycle inherits its seed.
    pub retained: u64,
}

/// Decides whether the Mega-Pot fires for this round: `entropy % modulus == 0`.
///
/// With the canonical `mega_trigger_modulus` of 625 the bias of reducing a
/// uniform 128-bit value mod 625 is `625 / 2^128 ≈ 2×10^-36` — negligible,
/// same argument as ever, no rejection sampling needed.
///
/// # Errors
///
/// [`MathError::ZeroModulus`] if `modulus == 0` — the modulo would otherwise
/// panic, and the pure-math layer never panics.
pub fn mega_triggered(entropy: u128, modulus: u32) -> Result<bool, MathError> {
    if modulus == 0 {
        return Err(MathError::ZeroModulus);
    }
    // `== 0` semantics, in the form clippy 1.91 mandates; the zero guard
    // above is what keeps `is_multiple_of` from panicking.
    Ok(entropy.is_multiple_of(u128::from(modulus)))
}

/// Splits the Mega-Pot's spendable balance into the winner's award, the
/// field's pro-rata pool and a retained residual, under the payout cap.
///
/// `accrued` must be the authoritative spendable balance (`accrued_lamports`),
/// never a raw account balance: an award computed from lamports that
/// include the rent-exempt minimum could push the vault below exemption.
/// `total_lamports` is the settling round's own pot — the cap is measured
/// against it, so a Mega-Pot pop can never pay more than `cap_bps` of what
/// the round itself raked in (I21).
///
/// The algorithm, in order: sum the payout bps, compute the nominal
/// `accrued × g / 10_000`, clamp it to the cap (`cap_bps == 0` = uncapped,
/// the v1 behaviour — R6), then divide the payable between winner and
/// field *preserving their bps ratio*, with the field taking the residual
/// of the payable and the pot retaining the unpaid remainder.
///
/// # Errors
///
/// - [`MathError::BpsOverflow`] if `award_bps + field_bps` exceeds
///   [`BPS_DENOMINATOR`].
/// - [`MathError::Overflow`] is structurally unreachable — `payable <=
///   accrued` and `awarded <= payable` by construction — but both residuals
///   are taken with checked subtraction so invariant I19 holds by
///   construction, not by hope.
pub fn split_mega_pot(
    accrued: u64,
    total_lamports: u64,
    award_bps: u16,
    field_bps: u16,
    payout_cap_bps: u32,
) -> Result<MegaSplit, MathError> {
    let g = u32::from(award_bps) + u32::from(field_bps);
    if g > u32::from(BPS_DENOMINATOR) {
        return Err(MathError::BpsOverflow);
    }
    // u64::MAX × 10_000 ≈ 2^77.2, far inside u128; the same product
    // overflows u64.
    let nominal = (u128::from(accrued) * u128::from(g) / u128::from(BPS_DENOMINATOR)) as u64;
    let payable = if payout_cap_bps == 0 {
        nominal // R6: uncapped — the pre-Phase-11 behaviour
    } else {
        // total × cap_bps reaches ~2^96, still u128; a config cap large
        // enough to push the quotient past u64::MAX can never bind (the
        // nominal is <= accrued <= u64::MAX), so clamping the cast is
        // behaviour-preserving where a bare `as` would wrap.
        let cap = (u128::from(total_lamports) * u128::from(payout_cap_bps)
            / u128::from(BPS_DENOMINATOR))
        .min(u128::from(u64::MAX)) as u64;
        nominal.min(cap)
    };
    // Preserve the winner:field ratio under the cap. g == 0 => awarded 0
    // and the whole payable (also 0) stays with the field side.
    let awarded = if g == 0 {
        0
    } else {
        (u128::from(payable) * u128::from(award_bps) / u128::from(g)) as u64
    };
    let field_pool = payable.checked_sub(awarded).ok_or(MathError::Overflow)?;
    let retained = accrued.checked_sub(payable).ok_or(MathError::Overflow)?;
    Ok(MegaSplit {
        awarded,
        field_pool,
        retained,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{MEGA_AWARD_BPS, MEGA_FIELD_BPS, MEGA_PAYOUT_CAP_BPS};
    use proptest::prelude::*;
    // rand 0.9+ split `fill_bytes` out of `RngCore` (now deprecated) into `Rng`.
    use rand_chacha::rand_core::{Rng, SeedableRng};
    use rand_chacha::ChaCha8Rng;

    /// The trigger table, against the canonical Phase 11 modulus.
    #[test]
    fn trigger_table() {
        assert_eq!(mega_triggered(0, 625), Ok(true));
        assert_eq!(mega_triggered(625, 625), Ok(true));
        assert_eq!(mega_triggered(624, 625), Ok(false));
        assert_eq!(mega_triggered(u128::MAX, 625), Ok(u128::MAX % 625 == 0));
        assert_eq!(mega_triggered(0, 0), Err(MathError::ZeroModulus));
        assert_eq!(mega_triggered(1, 0), Err(MathError::ZeroModulus));
        // modulus == 1 ⇒ always true, whatever the entropy.
        assert_eq!(mega_triggered(0, 1), Ok(true));
        assert_eq!(mega_triggered(1, 1), Ok(true));
        assert_eq!(mega_triggered(u128::MAX, 1), Ok(true));
        // a large multiple still triggers exactly on divisibility
        assert_eq!(mega_triggered(625_u128 * 1_000_000_000, 625), Ok(true));
    }

    /// The split table: 50/40/10 of the accrual, floored winner, residual
    /// field, retained seed.
    #[test]
    fn mega_split_table() {
        // Uncapped, canonical bps: 123_456_789 → nominal 111_111_110,
        // awarded floor(111_111_110 × 5/9) = 61_728_394.
        assert_eq!(
            split_mega_pot(123_456_789, u64::MAX, MEGA_AWARD_BPS, MEGA_FIELD_BPS, 0),
            Ok(MegaSplit {
                awarded: 61_728_394,
                field_pool: 49_382_716,
                retained: 12_345_679,
            })
        );
        assert_eq!(
            split_mega_pot(
                0,
                10_000,
                MEGA_AWARD_BPS,
                MEGA_FIELD_BPS,
                MEGA_PAYOUT_CAP_BPS
            ),
            Ok(MegaSplit {
                awarded: 0,
                field_pool: 0,
                retained: 0,
            })
        );
        // Sub-lamport accrual: everything floors to the retained seed.
        assert_eq!(
            split_mega_pot(
                1,
                10_000,
                MEGA_AWARD_BPS,
                MEGA_FIELD_BPS,
                MEGA_PAYOUT_CAP_BPS
            ),
            Ok(MegaSplit {
                awarded: 0,
                field_pool: 0,
                retained: 1,
            })
        );
        // bps extremes: g == 10_000 pays the whole accrual out.
        assert_eq!(
            split_mega_pot(u64::MAX, u64::MAX, 5_000, 5_000, 0),
            Ok(MegaSplit {
                awarded: 9_223_372_036_854_775_807,
                field_pool: 9_223_372_036_854_775_808,
                retained: 0,
            })
        );
        // g == 0 awards and fields nothing.
        assert_eq!(
            split_mega_pot(u64::MAX, 10_000, 0, 0, MEGA_PAYOUT_CAP_BPS),
            Ok(MegaSplit {
                awarded: 0,
                field_pool: 0,
                retained: u64::MAX,
            })
        );
        // g above the denominator is rejected.
        assert_eq!(
            split_mega_pot(10_000, 10_000, 10_000, 1, 0),
            Err(MathError::BpsOverflow)
        );
    }

    /// The cap binds on a big pot over a small round, and preserves the
    /// 5:4 winner:field ratio exactly: 8×10^10 payable splits 5/9 : 4/9.
    #[test]
    fn the_cap_binds_and_preserves_the_ratio() {
        // 100 SOL accrued, 10 SOL round pot, cap 80_000 (8× the pot).
        let m = split_mega_pot(100_000_000_000, 10_000_000_000, 5_000, 4_000, 80_000).unwrap();
        assert_eq!(m.awarded, 44_444_444_444);
        assert_eq!(m.field_pool, 35_555_555_556);
        assert_eq!(m.retained, 20_000_000_000);
        assert_eq!(
            m.awarded + m.field_pool + m.retained,
            100_000_000_000,
            "I19 under the cap"
        );
        // The same accrual against a 20 SOL round is uncapped: nominal
        // 0.9 × 10^11 = 9×10^10 > the 1.6×10^10 cap of the 10 SOL round
        // above — a bigger round unlocks a bigger jackpot.
        let big = split_mega_pot(100_000_000_000, 20_000_000_000, 5_000, 4_000, 80_000).unwrap();
        assert_eq!(big.awarded, 50_000_000_000);
        assert_eq!(big.field_pool, 40_000_000_000);
        assert_eq!(big.retained, 10_000_000_000);
    }

    /// R6, table form: field_bps 0 and cap 0 reproduce the v1 two-way
    /// 90/10 split bit-for-bit for every probed accrual.
    #[test]
    fn v1_bps_reproduce_v1_split_bit_for_bit() {
        for accrued in [0u64, 1, 10, 123_456_789, u64::MAX] {
            let split = split_mega_pot(accrued, u64::MAX, 9_000, 0, 0).unwrap();
            let v1_awarded = (u128::from(accrued) * 9_000u128 / u128::from(BPS_DENOMINATOR)) as u64;
            assert_eq!(split.awarded, v1_awarded, "v1 award at accrued={accrued}");
            assert_eq!(split.field_pool, 0, "v1 has no field share");
            assert_eq!(split.retained, accrued - v1_awarded, "v1 retained");
        }
        // The v1 u64::MAX row from the old table, pinned.
        assert_eq!(
            split_mega_pot(u64::MAX, u64::MAX, 9_000, 0, 0),
            Ok(MegaSplit {
                awarded: 16_602_069_666_338_596_453,
                field_pool: 0,
                retained: 1_844_674_407_370_955_162,
            })
        );
    }

    // Property — I19 discharged across the full domains: the split
    // reassembles `accrued` exactly, capped or not, never panics, errors on
    // exactly the illegal bps pairs, and keeps the winner's share within
    // one lamport of `payable × award_bps / g` (the ratio the cap must
    // preserve).
    proptest! {
        #[test]
        fn i19_mega_split_preserves_every_lamport(
            accrued in 0u64..=u64::MAX,
            total in 0u64..=u64::MAX,
            award_bps in 0u16..=u16::MAX,
            field_bps in 0u16..=u16::MAX,
            cap_bps in any::<u32>(),
        ) {
            let g = u32::from(award_bps) + u32::from(field_bps);
            match split_mega_pot(accrued, total, award_bps, field_bps, cap_bps) {
                Err(MathError::BpsOverflow) => {
                    prop_assert!(g > u32::from(BPS_DENOMINATOR));
                }
                Err(other) => panic!("unexpected error {other:?} at accrued={accrued}"),
                Ok(split) => {
                    prop_assert!(g <= u32::from(BPS_DENOMINATOR));

                    // I19 — exact conservation, widened.
                    let reassembled = u128::from(split.awarded)
                        + u128::from(split.field_pool)
                        + u128::from(split.retained);
                    prop_assert_eq!(reassembled, u128::from(accrued));

                    // The oracle, entirely in u128: payable = nominal.min(cap).
                    let nominal = u128::from(accrued) * u128::from(g)
                        / u128::from(BPS_DENOMINATOR);
                    let payable = if cap_bps == 0 {
                        nominal
                    } else {
                        let cap = u128::from(total) * u128::from(cap_bps)
                            / u128::from(BPS_DENOMINATOR);
                        nominal.min(cap)
                    };
                    prop_assert_eq!(u128::from(split.awarded) + u128::from(split.field_pool), payable);

                    // Winner:field ratio within one lamport of the bps.
                    if g > 0 {
                        let exact_award = payable * u128::from(award_bps) / u128::from(g);
                        prop_assert!(u128::from(split.awarded) >= exact_award);
                        prop_assert!(u128::from(split.awarded) <= exact_award + 1);
                    } else {
                        prop_assert_eq!(split.awarded, 0);
                        prop_assert_eq!(split.field_pool, 0);
                    }
                }
            }
        }
    }

    /// Task 1.7 (b) — empirical Mega-Pot frequency. 10⁷ seeded ChaCha draws
    /// against the canonical 625 modulus; the hit count must sit within 4σ
    /// of 10⁷ / 625 = 16 000. This is what catches a slicing or modulus
    /// mistake the table tests would wave through.
    #[test]
    #[ignore = "statistical — roadmap task 1.7: cargo test -p orbit_jackpot --lib -- --ignored"]
    fn mega_hits_at_one_in_625() {
        const MODULUS: u32 = 625;
        const SAMPLES: u64 = 10_000_000;
        let mut rng = ChaCha8Rng::seed_from_u64(0x5EED_0000_0625);
        let mut buf = [0u8; 16];
        let mut hits = 0u64;
        for _ in 0..SAMPLES {
            rng.fill_bytes(&mut buf);
            let entropy = u128::from_le_bytes(buf);
            if mega_triggered(entropy, MODULUS).expect("canonical modulus is nonzero") {
                hits += 1;
            }
        }
        let expected = SAMPLES as f64 / f64::from(MODULUS);
        let sigma =
            (SAMPLES as f64 * (1.0 / f64::from(MODULUS)) * (1.0 - 1.0 / f64::from(MODULUS))).sqrt();
        let deviation = (hits as f64 - expected).abs();
        assert!(
            deviation <= 4.0 * sigma,
            "mega frequency {hits}/{} drifted {deviation:.2} beyond 4σ={}",
            SAMPLES,
            4.0 * sigma
        );
    }
}
