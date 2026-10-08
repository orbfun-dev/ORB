//! Round-pot split: the four-way 9/89/1/1 division and its zero-loss
//! guarantee.
//!
//! Both fee cuts and the winner slice are floor-divided through `u128`
//! intermediates — rounding always favors the many, never the treasury —
//! and the **refund slice is the exact residual of `total`**, so the four
//! shares reassemble `total` to the lamport (invariant I18). Dust is
//! mathematically impossible rather than merely unlikely.
//!
//! Taking the *refund* slice as the residual (rather than the winner's, as
//! v1 did) means `refund_pool >= floor(total × refund_bps/10_000)`,
//! overshooting by at most 3 lamports — one per floored slice. Rounding
//! goes to the field (the many), not to the winner (the one), and never to
//! the treasury. `refund_bps` is therefore not an input: it is the
//! complement, validated at config level by I14.
//!
//! R6, bit-for-bit v1 reproduction: a pre-Phase-11 config reads
//! `winner_bps = 9_800` from its stored field, and the zeroed reserved
//! bytes contribute nothing — the v1 98% residual then lands in
//! `refund_pool` as 0..2 lamports of dust, the winner's floor having taken
//! its exact 98% share. In-flight rounds drain exactly as they did before
//! the upgrade.

use crate::constants::BPS_DENOMINATOR;
use crate::errors::MathError;

/// The four-way division of a settled round pot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PotSplit {
    /// Floored winner share, `total * winner_bps / 10_000`.
    pub winner_payout: u64,
    /// Residual of `total` after all three floored slices — always
    /// `total - winner_payout - admin_cut - mega_cut`.
    pub refund_pool: u64,
    /// Floored admin share, `total * admin_bps / 10_000`.
    pub admin_cut: u64,
    /// Floored Mega-Pot share, `total * mega_bps / 10_000`.
    pub mega_cut: u64,
}

/// Splits `total` lamports into floored winner, admin and Mega-Pot cuts
/// plus the refund residual that `close_entry` pays to the field pro-rata.
///
/// # Errors
///
/// - [`MathError::BpsOverflow`] if `winner_bps + admin_bps + mega_bps`
///   exceeds [`BPS_DENOMINATOR`] (the refund slice would go negative).
/// - [`MathError::Overflow`] is structurally unreachable — a bps sum of at
///   most 10_000 implies the three cuts absorb at most `total` — but the
///   residual is taken with checked subtraction so invariant I18 holds by
///   construction, not by hope.
pub fn split_round_pot(
    total: u64,
    winner_bps: u16,
    admin_bps: u16,
    mega_bps: u16,
) -> Result<PotSplit, MathError> {
    let bps_sum = u32::from(winner_bps) + u32::from(admin_bps) + u32::from(mega_bps);
    if bps_sum > u32::from(BPS_DENOMINATOR) {
        return Err(MathError::BpsOverflow);
    }

    // Widened intermediates are mandatory, not stylistic: at
    // `total = u64::MAX` the product `total * bps` is ~2^77.2, which overflows
    // u64 but sits far inside u128.
    let wide_total = u128::from(total);
    let winner_payout = (wide_total * u128::from(winner_bps) / u128::from(BPS_DENOMINATOR)) as u64;
    let admin_cut = (wide_total * u128::from(admin_bps) / u128::from(BPS_DENOMINATOR)) as u64;
    let mega_cut = (wide_total * u128::from(mega_bps) / u128::from(BPS_DENOMINATOR)) as u64;

    let refund_pool = total
        .checked_sub(winner_payout)
        .and_then(|remainder| remainder.checked_sub(admin_cut))
        .and_then(|remainder| remainder.checked_sub(mega_cut))
        .ok_or(MathError::Overflow)?;

    Ok(PotSplit {
        winner_payout,
        refund_pool,
        admin_cut,
        mega_cut,
    })
}

/// One entry's pro-rata share of a settle-time pool — the ONLY sanctioned
/// per-entry formula (R2):
///
/// ```text
/// floor(amount * pool / total)
/// ```
///
/// Because `Σ amount_i == total` exactly (I9), the sum-of-floors lemma
/// gives `Σ entry_share(amount_i, pool, total) <= pool` always, with a
/// deficit of at most `n - 1` lamports — the vault can never be overdrawn.
/// Computing `amount - floor(amount × dock_bps/10_000)` instead looks
/// equivalent and is not: with `total = 100` and 100 entries of one lamport
/// it pays `100` out of a pool of `89`, locking the round forever.
///
/// # Errors
///
/// [`MathError::ZeroTotal`] if `total == 0` — there is nobody to take a
/// share of a pool against an empty pot (`close_entry` guards this before
/// ever reaching here on a funded round).
pub fn entry_share(amount: u64, pool: u64, total: u64) -> Result<u64, MathError> {
    if total == 0 {
        return Err(MathError::ZeroTotal);
    }
    // amount × pool peaks at ~2^64 × 2^64 = 2^128 — u128's home turf. In
    // contract (amount <= total, I9) the quotient is <= pool; the clamp
    // only stops an out-of-contract caller from wrapping silently.
    Ok(
        (u128::from(amount) * u128::from(pool) / u128::from(total)).min(u128::from(u64::MAX))
            as u64,
    )
}

/// Economics v3 ("the winner's own stake is never raked", 2026-10-08).
///
/// v2 docked every stake 11% — winner included — and paid the winner 9% of
/// the WHOLE pot, so a player holding more than 9/11 ≈ 82% of a pot lost
/// money even when they won. v3 rakes only the losers' money:
///
/// * `admin_cut`, `mega_cut` = their bps of `losers = total − winner_stake`;
/// * `refund_pool` = v2's refund pool over the WHOLE pot, unchanged, so the
///   pro-rata refund every entry draws at `close_entry` (denominator
///   `total_lamports`) is unchanged — losers still get 89% of their stake;
/// * `winner_payout` = the exact residual. The winning entry draws its
///   pro-rata refund too, so the winner's total is
///   `floor(w·refund/total) + winner_payout ≥ winner_stake + 0.09·losers`
///   (less ≤ 2 lamports of flooring) — never below their own stake.
///
/// Same four fields, same I18 reassembly, no account-layout change:
/// `close_entry` and `claim_winnings` are untouched.
pub fn split_round_pot_v3(
    total: u64,
    winner_stake: u64,
    winner_bps: u16,
    admin_bps: u16,
    mega_bps: u16,
) -> Result<PotSplit, MathError> {
    let losers = total.checked_sub(winner_stake).ok_or(MathError::Overflow)?;
    // The refund pool is v2's, bit for bit (the exact residual of the
    // whole-pot split), so every loser's refund is identical to v2.
    let refund_pool = split_round_pot(total, winner_bps, admin_bps, mega_bps)?.refund_pool;
    let bps = |base: u64, b: u16| -> u64 {
        (u128::from(base) * u128::from(b) / u128::from(BPS_DENOMINATOR)) as u64
    };
    let admin_cut = bps(losers, admin_bps);
    let mega_cut = bps(losers, mega_bps);
    let winner_payout = total
        .checked_sub(refund_pool)
        .and_then(|r| r.checked_sub(admin_cut))
        .and_then(|r| r.checked_sub(mega_cut))
        .ok_or(MathError::Overflow)?;
    Ok(PotSplit {
        winner_payout,
        refund_pool,
        admin_cut,
        mega_cut,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{BPS_DENOMINATOR, FEE_BPS_ADMIN, FEE_BPS_MEGA, WINNER_BPS};
    use crate::math::tickets::next_range;
    use proptest::prelude::*;

    /// The exact-sum table. Every row also restates invariant I18: the four
    /// fields reassemble `total` exactly, with the field holding the
    /// residual.
    #[test]
    fn exact_sum_table() {
        #[rustfmt::skip]
        let cases = [
            // (total,                        winner,                 admin,                  mega,                   refund)                   — point being made
            (10_000u64,                      900u64,                 100u64,                 100u64,                 8_900u64),                // clean 9/89/1/1
            (10_000_000_000u64,              900_000_000u64,          100_000_000u64,          100_000_000u64,          8_900_000_000u64),        // the canonical 10 × 1 SOL round
            (150u64,                         13u64,                  1u64,                   1u64,                   135u64),                  // floor(13.5): rounding favours the field
            (99u64,                          8u64,                   0u64,                   0u64,                   91u64),                   // sub-threshold dust -> the field takes it
            (1u64,                           0u64,                   0u64,                   0u64,                   1u64),                    // minimum pot: the whole lamport refunds
            (0u64,                           0u64,                   0u64,                   0u64,                   0u64),                    // empty pot: no panic, no division error
            (u64::MAX,                       1_660_206_966_633_859_645u64, 184_467_440_737_095_516u64, 184_467_440_737_095_516u64, 16_417_602_225_601_500_938u64), // u128 intermediate is mandatory
        ];
        for (total, winner, admin, mega, refund) in cases {
            let split = split_round_pot(total, WINNER_BPS, FEE_BPS_ADMIN, FEE_BPS_MEGA)
                .expect("every table row uses the legal canonical bps");
            assert_eq!(split.winner_payout, winner, "winner at total={total}");
            assert_eq!(split.admin_cut, admin, "admin cut at total={total}");
            assert_eq!(split.mega_cut, mega, "mega cut at total={total}");
            assert_eq!(
                split.refund_pool, refund,
                "refund residual at total={total}"
            );
            let reassembled = u128::from(split.winner_payout)
                + u128::from(split.refund_pool)
                + u128::from(split.admin_cut)
                + u128::from(split.mega_cut);
            assert_eq!(reassembled, u128::from(total), "I18 at total={total}");
        }
    }

    /// The error boundary: any bps triple summing above the denominator is
    /// rejected, including individually oversized values.
    #[test]
    fn bps_above_the_denominator_is_rejected() {
        assert_eq!(
            split_round_pot(10_000, 9_801, 100, 100),
            Err(MathError::BpsOverflow)
        );
        assert_eq!(
            split_round_pot(10_000, 5_001, 5_000, 0),
            Err(MathError::BpsOverflow)
        );
        assert_eq!(
            split_round_pot(0, 10_001, 0, 0),
            Err(MathError::BpsOverflow)
        );
        assert_eq!(
            split_round_pot(u64::MAX, u16::MAX, u16::MAX, u16::MAX),
            Err(MathError::BpsOverflow)
        );
    }

    /// The boundary itself is legal: a bps sum of exactly 10_000 leaves the
    /// refund pool only the rounding dust (here zero, since the slices
    /// divide evenly).
    #[test]
    fn bps_sum_of_exactly_the_denominator_is_legal() {
        assert_eq!(
            split_round_pot(10_000, 5_000, 2_500, 2_500),
            Ok(PotSplit {
                winner_payout: 5_000,
                refund_pool: 0,
                admin_cut: 2_500,
                mega_cut: 2_500,
            })
        );
    }

    /// Zero cuts refund the entire pot, and `u64::MAX` proves the residual
    /// path survives the largest representable total.
    #[test]
    fn zero_bps_refund_the_entire_pot() {
        assert_eq!(
            split_round_pot(u64::MAX, 0, 0, 0),
            Ok(PotSplit {
                winner_payout: 0,
                refund_pool: u64::MAX,
                admin_cut: 0,
                mega_cut: 0,
            })
        );
    }

    /// R6, table form: the v1 bps triple reproduces the v1 cuts exactly and
    /// collapses the refund slice to the 0..2 lamports of dust that v1's
    /// winner-residual definition would have handed the winner.
    #[test]
    fn v1_bps_reproduce_v1_cuts_bit_for_bit() {
        for total in [
            0u64,
            1,
            99,
            100,
            150,
            10_000,
            7_770_000_000,
            10_000_000_000,
            u64::MAX,
        ] {
            let split =
                split_round_pot(total, 9_800, FEE_BPS_ADMIN, FEE_BPS_MEGA).expect("legal bps");
            let v1_admin = (u128::from(total) * u128::from(FEE_BPS_ADMIN)
                / u128::from(BPS_DENOMINATOR)) as u64;
            let v1_mega =
                (u128::from(total) * u128::from(FEE_BPS_MEGA) / u128::from(BPS_DENOMINATOR)) as u64;
            let v1_winner_residual = total - v1_admin - v1_mega;
            assert_eq!(split.admin_cut, v1_admin, "v1 admin at total={total}");
            assert_eq!(split.mega_cut, v1_mega, "v1 mega at total={total}");
            assert!(
                split.refund_pool <= 2,
                "v1 dust bound at total={total}: {}",
                split.refund_pool
            );
            assert_eq!(
                split.winner_payout + split.refund_pool,
                v1_winner_residual,
                "winner + dust == v1 residual at total={total}"
            );
        }
    }

    /// `entry_share` table: floors through u128, refuses a zero total.
    #[test]
    fn entry_share_table() {
        // The canonical 10 × 1 SOL round: each 1 SOL entry draws 0.89 SOL.
        assert_eq!(
            entry_share(1_000_000_000, 8_900_000_000, 10_000_000_000),
            Ok(890_000_000)
        );
        // 7/10 of the pot draws 7/10 of the pool, exactly.
        assert_eq!(entry_share(7, 100, 10), Ok(70));
        // Floor: 1/3 of 100 against 10.
        assert_eq!(entry_share(1, 100, 3), Ok(33));
        // Zero pool pays nothing; zero amount takes nothing.
        assert_eq!(entry_share(5, 0, 10), Ok(0));
        assert_eq!(entry_share(0, 100, 10), Ok(0));
        // Zero total is the typed error, never a division by zero.
        assert_eq!(entry_share(5, 100, 0), Err(MathError::ZeroTotal));
        // u64 extremes with the contract (amount <= total) intact.
        assert_eq!(entry_share(u64::MAX, u64::MAX, u64::MAX), Ok(u64::MAX));
        assert_eq!(
            entry_share(u64::MAX - 1, u64::MAX, u64::MAX),
            Ok(u64::MAX - 1)
        );
    }

    /// R2's mandatory counterexample, table form: the 100 × 1-lamport round.
    /// The pro-rata formula pays 89 lamports total (dust 89 to the Mega-Pot
    /// at close); the forbidden `amount - floor(amount × 11%)` formula
    /// claims 100 and would lock the round forever.
    #[test]
    fn the_one_lamport_hundred_entry_round_cannot_overdraw() {
        let total = 100u64;
        let split = split_round_pot(total, WINNER_BPS, FEE_BPS_ADMIN, FEE_BPS_MEGA).unwrap();
        assert_eq!(split.refund_pool, 89);
        let amounts = vec![1u64; 100];
        let paid: u64 = amounts
            .iter()
            .map(|&a| entry_share(a, split.refund_pool, total).unwrap())
            .sum();
        assert_eq!(paid, 0, "every floor(1 × 89/100) is 0");
        assert!(paid <= split.refund_pool);
        let forbidden: u64 = amounts.iter().map(|&a| a - a * 1_100 / 10_000).sum();
        assert_eq!(forbidden, 100);
        assert!(forbidden > split.refund_pool, "the naive formula overdraws");
    }

    // Property 1 — I18 discharged across the full `u64` total domain and
    // the full `u16` bps domain, legal and illegal combinations alike. The
    // function must never panic, must error on exactly the illegal bps
    // combinations, must reassemble every lamport otherwise, and must keep
    // the refund residual within 3 lamports above its exact proportional
    // share (one per floored slice — rounding favours the field).
    proptest! {
        #[test]
        fn i18_split_preserves_every_lamport(
            total in 0u64..=u64::MAX,
            winner_bps in 0u16..=u16::MAX,
            admin_bps in 0u16..=u16::MAX,
            mega_bps in 0u16..=u16::MAX,
        ) {
            let bps_sum =
                u32::from(winner_bps) + u32::from(admin_bps) + u32::from(mega_bps);
            match split_round_pot(total, winner_bps, admin_bps, mega_bps) {
                Err(MathError::BpsOverflow) => {
                    prop_assert!(bps_sum > u32::from(BPS_DENOMINATOR));
                }
                Err(other) => panic!("unexpected error {other:?} at total={total}"),
                Ok(split) => {
                    prop_assert!(bps_sum <= u32::from(BPS_DENOMINATOR));

                    // I18 — exact conservation, widened so the assertion
                    // itself cannot overflow.
                    let reassembled = u128::from(split.winner_payout)
                        + u128::from(split.refund_pool)
                        + u128::from(split.admin_cut)
                        + u128::from(split.mega_cut);
                    prop_assert_eq!(reassembled, u128::from(total));

                    // exact share <= refund_pool <= exact share + 3
                    let refund_bps = u32::from(BPS_DENOMINATOR) - bps_sum;
                    let exact_share = u128::from(total) * u128::from(refund_bps);
                    let refund_scaled =
                        u128::from(split.refund_pool) * u128::from(BPS_DENOMINATOR);
                    prop_assert!(refund_scaled >= exact_share);
                    let three_lamports = 3 * u128::from(BPS_DENOMINATOR);
                    prop_assert!(refund_scaled <= exact_share + three_lamports);
                }
            }
        }
    }

    // Property 2 — the no-overdraw lemma: for any partition of `total`
    // into 1..200 amounts folded exactly as `deposit` folds them, and any
    // pool up to `total`, the sum of pro-rata shares never exceeds the
    // pool and the deficit is at most one lamport per boundary.
    proptest! {
        #[test]
        fn sum_of_entry_shares_never_overdraws_the_pool(
            amounts in proptest::collection::vec(1u64..=10_u64.pow(12), 1..=200),
            pool_bits in 0u64..=u64::MAX,
        ) {
            let mut total: u64 = 0;
            for &amount in &amounts {
                let range = next_range(total, amount)
                    .expect("each amount <= 10^12, at most 200 of them");
                total = range.end;
            }
            let pool = pool_bits % total.saturating_add(1);
            let paid: u64 = amounts
                .iter()
                .map(|&a| entry_share(a, pool, total).unwrap())
                .sum();
            prop_assert!(paid <= pool);
            prop_assert!(pool - paid < amounts.len() as u64);
        }
    }

    // Property 3 — the flat rake, the property that kills the whale hole:
    // a fixed aggregate stake `a` split across k wallets inside a pot `P`
    // loses exactly `a × (admin+mega)/10_000` in expectation, whatever the
    // wallet count. If any formula made the edge depend on pot composition,
    // this would fail (design §3, R1). The win term is kept as an exact
    // rational (numerator over P) so only the refund flooring — at most
    // k - 1 lamports, plus the <= 2 of settle flooring — counts against
    // the tolerance.
    proptest! {
        #[test]
        fn expected_loss_is_flat_regardless_of_wallet_split(
            attacker in proptest::collection::vec(1u64..=10_u64.pow(12), 1..=50),
            others in 0u64..=10_u64.pow(12),
            admin_bps in 0u16..=2_500u16,
            mega_bps in 0u16..=2_500u16,
            winner_bps in 0u16..=u16::MAX,
        ) {
            // Keep the bps triple legal: the winner's share gives way.
            let winner_bps = winner_bps.min(10_000u16 - admin_bps - mega_bps);
            let aggregate: u64 = attacker.iter().sum();
            let pot = aggregate + others;
            let split = split_round_pot(pot, winner_bps, admin_bps, mega_bps).unwrap();

            // Simulated EV, all terms over the common denominator P:
            // wallet i wins with probability s_i/P (pari-mutuel, I9) and
            // always draws its refund pro-rata.
            let win_over_p: u128 = attacker
                .iter()
                .map(|&s| u128::from(s) * u128::from(split.winner_payout))
                .sum();
            let refunds_over_p: u128 = attacker
                .iter()
                .map(|&s| {
                    u128::from(entry_share(s, split.refund_pool, pot).unwrap())
                        * u128::from(pot)
                })
                .sum();
            let loss_over_p =
                u128::from(aggregate) * u128::from(pot) - win_over_p - refunds_over_p;

            // loss == aggregate × (admin+mega)/10_000, within k + 2 lamports.
            let k = attacker.len() as u64;
            let tolerance = u128::from(k + 2) * u128::from(pot) * 10_000;
            let target = u128::from(aggregate)
                * u128::from(u32::from(admin_bps) + u32::from(mega_bps))
                * u128::from(pot);
            prop_assert!(loss_over_p * 10_000 + tolerance >= target);
            prop_assert!(loss_over_p * 10_000 <= target + tolerance);
        }
    }

    // ── economics v3 ──

    /// The winner's total draw under v3: their pro-rata refund + the prize.
    fn v3_winner_total(total: u64, w: u64) -> u64 {
        let s = split_round_pot_v3(total, w, 900, 100, 100).expect("legal");
        entry_share(w, s.refund_pool, total).expect("total > 0") + s.winner_payout
    }

    #[test]
    fn v3_the_owner_case_wins_money_instead_of_losing_it() {
        // 0.1 SOL against 0.01 SOL: v2 paid the winner 0.0989 (a loss).
        let (w, total) = (100_000_000u64, 110_000_000u64);
        let s = split_round_pot_v3(total, w, 900, 100, 100).unwrap();
        assert_eq!(s.admin_cut, 100_000, "1% of the 0.01 SOL the loser put in");
        assert_eq!(s.mega_cut, 100_000);
        assert_eq!(s.refund_pool, 97_900_000, "89% of the whole pot, exactly as v2");
        assert_eq!(v3_winner_total(total, w), 100_900_000, "stake + 9% of the loser's 0.01");
        // The loser is unchanged from v2: 89% back.
        assert_eq!(entry_share(10_000_000, s.refund_pool, total).unwrap(), 8_900_000);
    }

    #[test]
    fn v3_balanced_two_player_round() {
        let s = split_round_pot_v3(2_000_000_000, 1_000_000_000, 900, 100, 100).unwrap();
        assert_eq!(s.admin_cut, 10_000_000);
        assert_eq!(v3_winner_total(2_000_000_000, 1_000_000_000), 1_090_000_000);
    }

    #[test]
    fn v3_rejects_a_stake_larger_than_the_pot_and_bad_bps() {
        assert!(split_round_pot_v3(10, 11, 900, 100, 100).is_err());
        assert!(split_round_pot_v3(10, 1, 9_900, 100, 100).is_err());
    }

    proptest! {
        /// I18 under v3, and the point of v3: the winner never gets back
        /// less than they staked, the losers' refunds are exactly v2's,
        /// and the rake never touches the winner's own money.
        #[test]
        fn v3_reassembles_and_never_rakes_the_winner(
            w in 1u64..=1_000_000_000_000u64,
            losers in 1u64..=1_000_000_000_000u64,
        ) {
            let total = w + losers;
            let s = split_round_pot_v3(total, w, 900, 100, 100).unwrap();
            prop_assert_eq!(
                u128::from(s.winner_payout) + u128::from(s.refund_pool)
                    + u128::from(s.admin_cut) + u128::from(s.mega_cut),
                u128::from(total)
            );
            prop_assert!(v3_winner_total(total, w) >= w, "winner below stake");
            prop_assert!(s.admin_cut + s.mega_cut <= losers / 50 + 1, "rake beyond 2% of losers");
            let v2 = split_round_pot(total, 900, 100, 100).unwrap();
            prop_assert_eq!(s.refund_pool, v2.refund_pool, "losers' refunds unchanged");
        }
    }

    // ── audit 2026-10-08: I21 under economics v3 ──

    /// Exact expected net of a single-entry attacker holding stake `a` in a
    /// pot of `a + others` (the others are many 1-lamport-scale entries, so
    /// the field share is taken over the whole pot when one of them wins),
    /// per round, with the Mega-Pot full enough for the cap to bind.
    /// Returned as a rational (numerator over `denominator`) so the sign is
    /// exact. Positive means the attacker farms the Mega-Pot at a profit.
    fn v3_attacker_net_per_round(
        a: u64,
        others: u64,
        admin_bps: u16,
        mega_bps: u16,
        award_bps: u16,
        field_bps: u16,
        cap_bps: u32,
        modulus: u32,
    ) -> (i128, u128) {
        use crate::math::mega::split_mega_pot;
        let total = a + others;
        let p = u128::from(total);
        let m = u128::from(modulus);
        // Denominator for every term: P (win probability) × modulus
        // (trigger probability) × 10_000 (field share flooring removed by
        // working in exact rationals below).
        let denom = p * m * p;
        let mut net: i128 = 0;
        // Outcome 1 — the attacker's entry wins (probability a/P).
        {
            let s = split_round_pot_v3(total, a, 900, admin_bps, mega_bps).unwrap();
            let take_home = entry_share(a, s.refund_pool, total).unwrap() + s.winner_payout;
            let gain = i128::from(take_home) - i128::from(a);
            net += gain * i128::from(a) * m as i128 * p as i128;
            // Trigger (probability 1/modulus): winner slice + pro-rata field.
            let losers = total - a;
            let mega = split_mega_pot(u64::MAX / 4, losers, award_bps, field_bps, cap_bps).unwrap();
            let capture = u128::from(mega.awarded) * p + u128::from(mega.field_pool) * u128::from(a);
            net += capture as i128 * i128::from(a);
        }
        // Outcome 2 — some tiny other entry wins (probability others/P): the
        // attacker is a loser, refunded 89%, and on a trigger draws the
        // field share pro-rata; the cap base is then ≈ the whole pot.
        {
            let s = split_round_pot_v3(total, 1, 900, admin_bps, mega_bps).unwrap();
            let refund = entry_share(a, s.refund_pool, total).unwrap();
            let gain = i128::from(refund) - i128::from(a);
            net += gain * i128::from(others) * m as i128 * p as i128;
            let mega = split_mega_pot(u64::MAX / 4, total - 1, award_bps, field_bps, cap_bps).unwrap();
            let capture = u128::from(mega.field_pool) * u128::from(a);
            net += capture as i128 * i128::from(others);
        }
        (net, denom)
    }

    /// The I21 guard (`assert_mega_farm_safe`) was derived for v2, where the
    /// attacker pays a flat 2% of their stake per round. Under v3 the rake
    /// is charged on the losers' money only, so a dominant player pays
    /// almost nothing when they win, while the field share still pays them
    /// on every trigger. Every configuration the guard accepts must still
    /// be non-positive EV for the farmer; the guard's own boundary
    /// (`cap_bps == modulus × (admin + mega)`) is not.
    #[test]
    fn i21_guard_boundary_is_still_unfarmable_under_v3() {
        use crate::invariants::assert_mega_farm_safe;
        let (admin, mega, award, field, modulus) = (100u16, 100u16, 5_000u16, 4_000u16, 625u32);
        // The live config (8× cap) is inside the guard and non-positive.
        assert!(assert_mega_farm_safe(80_000, modulus, admin, mega, award, field).is_ok());
        let (net, _) = v3_attacker_net_per_round(99 * SOL_T, SOL_T, admin, mega, award, field, 80_000, modulus);
        assert!(net <= 0, "live config must not be farmable: net {net}");
        // The guard's (v3) boundary is accepted, one bps beyond is not …
        let boundary = (u64::from(modulus)
            * (u64::from(admin) + u64::from(mega))
            * (u64::from(award) + u64::from(field))
            / (u64::from(award) + 2 * u64::from(field))) as u32;
        assert!(assert_mega_farm_safe(boundary, modulus, admin, mega, award, field).is_ok());
        assert!(assert_mega_farm_safe(boundary + 1, modulus, admin, mega, award, field).is_err());
        // … and therefore must also be non-positive EV for a dominant farmer.
        let (net, denom) = v3_attacker_net_per_round(99 * SOL_T, SOL_T, admin, mega, award, field, boundary, modulus);
        assert!(
            net <= 0,
            "I21 is stale under v3: a 99%-dominant farmer nets +{} lamports per round \
             (×1/{denom}) at the guard's own boundary cap_bps={boundary}",
            net
        );
    }

    proptest! {
        /// AUDIT P-2: at the guard's own boundary, no farmer share θ of
        /// the pot is positive-EV under v3 (exact rationals via the
        /// auditor's simulation).
        #[test]
        fn i21_boundary_is_non_positive_for_every_farmer_share(theta_pct in 1u64..=99) {
            let (admin, mega, award, field, modulus) = (100u16, 100u16, 5_000u16, 4_000u16, 625u32);
            let boundary = (u64::from(modulus) * 200 * 9_000 / 13_000) as u32;
            let a = theta_pct * SOL_T;
            let others = (100 - theta_pct) * SOL_T;
            let (net, _) = v3_attacker_net_per_round(a, others, admin, mega, award, field, boundary, modulus);
            prop_assert!(net <= 0, "θ={}%: net {} > 0", theta_pct, net);
        }
    }

    const SOL_T: u64 = 1_000_000_000;
}
