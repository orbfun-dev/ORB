//! Ticket arithmetic: the half-open ranges that partition a round's pot.
//!
//! Each deposit mints a `TicketRange` starting at the round's running total;
//! by induction the ranges of a round are contiguous, non-overlapping and
//! non-empty, and their union is exactly `[0, round.total_lamports)`. That
//! partition (invariant I9) is what lets a winning ticket identify exactly
//! one entry with no search.

use crate::errors::MathError;

/// A half-open ticket range `[start, end)`, one per deposit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TicketRange {
    /// Inclusive lower bound — the round's total immediately before this
    /// deposit.
    pub start: u64,
    /// Exclusive upper bound — `start + amount`.
    pub end: u64,
}

/// Mints the next range for a deposit of `amount` lamports, exactly as
/// `deposit` will: the range starts at `running_total` and ends at
/// `running_total + amount`.
///
/// # Errors
///
/// - [`MathError::ZeroAmount`] if `amount == 0` — an empty range would break
///   the partition (I9).
/// - [`MathError::Overflow`] if `running_total + amount` does not fit `u64`.
pub fn next_range(running_total: u64, amount: u64) -> Result<TicketRange, MathError> {
    if amount == 0 {
        return Err(MathError::ZeroAmount);
    }
    let end = running_total
        .checked_add(amount)
        .ok_or(MathError::Overflow)?;
    Ok(TicketRange {
        start: running_total,
        end,
    })
}

/// Membership proof: `true` iff `ticket` lies in `[range.start, range.end)`.
///
/// The `<=` / `<` asymmetry is load-bearing (I9): `end` is exclusive, so a
/// ticket equal to `end` belongs to the *next* range, if any.
pub fn range_contains(range: &TicketRange, ticket: u64) -> bool {
    range.start <= ticket && ticket < range.end
}

/// Reduces 128-bit ticket entropy to a winning ticket in `[0, total)`.
///
/// # Errors
///
/// [`MathError::ZeroTotal`] if `total_lamports == 0` — a zero-deposit round
/// must never reach the entropy path at all.
pub fn ticket_from_entropy(entropy: u128, total_lamports: u64) -> Result<u64, MathError> {
    if total_lamports == 0 {
        return Err(MathError::ZeroTotal);
    }
    Ok((entropy % u128::from(total_lamports)) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    /// The strict half-open boundary behavior: `start` is inside, `end - 1`
    /// is inside, `end` itself is not.
    #[test]
    fn range_membership_is_strictly_half_open() {
        let range = TicketRange { start: 5, end: 9 };
        assert!(range_contains(&range, 5), "start is inclusive");
        assert!(range_contains(&range, 8), "end - 1 is inside");
        assert!(!range_contains(&range, 9), "end is exclusive");
        assert!(!range_contains(&range, 4), "below start is outside");
        assert!(!range_contains(&range, u64::MAX));

        let top = TicketRange {
            start: u64::MAX - 1,
            end: u64::MAX,
        };
        assert!(range_contains(&top, u64::MAX - 1));
        assert!(!range_contains(&top, u64::MAX));
    }

    #[test]
    fn next_range_builds_contiguous_ranges() {
        assert_eq!(next_range(0, 10), Ok(TicketRange { start: 0, end: 10 }));
        assert_eq!(next_range(10, 1), Ok(TicketRange { start: 10, end: 11 }));
        assert_eq!(
            next_range(u64::MAX - 1, 1),
            Ok(TicketRange {
                start: u64::MAX - 1,
                end: u64::MAX
            })
        );
    }

    #[test]
    fn next_range_rejects_zero_amount() {
        assert_eq!(next_range(0, 0), Err(MathError::ZeroAmount));
        assert_eq!(next_range(1_000, 0), Err(MathError::ZeroAmount));
    }

    #[test]
    fn next_range_rejects_overflow() {
        assert_eq!(next_range(u64::MAX, 1), Err(MathError::Overflow));
        assert_eq!(next_range(u64::MAX - 1, 2), Err(MathError::Overflow));
    }

    /// Task 1.4 — the table.
    #[test]
    fn ticket_table() {
        // total == 1 ⇒ always 0, whatever the entropy.
        assert_eq!(ticket_from_entropy(0, 1), Ok(0));
        assert_eq!(ticket_from_entropy(1, 1), Ok(0));
        assert_eq!(ticket_from_entropy(u128::MAX, 1), Ok(0));
        // total == 0 ⇒ ZeroTotal.
        assert_eq!(ticket_from_entropy(0, 0), Err(MathError::ZeroTotal));
        assert_eq!(ticket_from_entropy(u128::MAX, 0), Err(MathError::ZeroTotal));
        // entropy == 0 ⇒ 0.
        assert_eq!(ticket_from_entropy(0, 1_000), Ok(0));
        // entropy == u128::MAX, total == 1000 ⇒ 455 (recomputed:
        // 2^128 ≡ 456 (mod 1000), so 2^128 - 1 ≡ 455).
        assert_eq!(ticket_from_entropy(u128::MAX, 1_000), Ok(455));
        // plain reduction spot-check.
        assert_eq!(ticket_from_entropy(1_001, 1_000), Ok(1));
    }

    // Task 1.4 — the property: for every entropy and every legal total,
    // the ticket lands strictly inside `[0, total)`.
    proptest! {
        #[test]
        fn ticket_is_always_below_total(
            entropy in 0u128..=u128::MAX,
            total in 1u64..=u64::MAX,
        ) {
            let ticket = ticket_from_entropy(entropy, total)
                .expect("total >= 1 is the only legality condition");
            prop_assert!(ticket < total);
        }
    }

    // Task 1.3 — invariant I9, the correctness core. Folds 1–200 amounts
    // (each 1..=10^12) with `next_range` exactly as `deposit` will, then
    // checks: zero origin, contiguity, non-emptiness, terminal end equal to
    // the total, exactly-one-container for 100 pseudo-uniform samples plus
    // every boundary the off-by-one could hide at (`0`, `total - 1`, every
    // `start`, every `end - 1`), and that `total` itself is contained by no
    // range — the pin on the half-open `<` vs `<=` asymmetry.
    proptest! {
        #[test]
        fn i9_ranges_partition_the_ticket_space(
            amounts in proptest::collection::vec(1u64..=10_u64.pow(12), 1..=200),
        ) {
            // 200 × 10^12 cannot reach u64::MAX, so the fold cannot fail.
            let mut ranges: Vec<TicketRange> = Vec::with_capacity(amounts.len());
            let mut running_total: u64 = 0;
            for &amount in &amounts {
                let range = next_range(running_total, amount)
                    .expect("each amount <= 10^12, at most 200 of them");
                ranges.push(range);
                running_total = range.end;
            }
            let total = running_total;

            prop_assert_eq!(ranges[0].start, 0);
            for pair in ranges.windows(2) {
                prop_assert_eq!(pair[0].end, pair[1].start);
            }
            prop_assert_eq!(
                ranges.last().map(|r| r.end),
                Some(total),
                "the union must end exactly at the total"
            );
            for range in &ranges {
                prop_assert!(range.end > range.start, "ranges are non-empty");
            }

            // 100 pseudo-uniform samples: a Weyl sequence stepped by the
            // 64-bit golden-ratio conjugate, folded mod `total`. Derived
            // deterministically from the generated amounts so proptest
            // shrinking stays reproducible.
            const GOLDEN_RATIO_CONJUGATE: u128 = 0x9E37_79B9_7F4A_7C15;
            let mut probes: Vec<u64> = (1u128..=100)
                .map(|k| ((k * GOLDEN_RATIO_CONJUGATE) % u128::from(total)) as u64)
                .collect();
            probes.push(0);
            probes.push(total - 1);
            for range in &ranges {
                probes.push(range.start);
                probes.push(range.end - 1);
            }
            for &ticket in &probes {
                let owners = ranges.iter().filter(|r| range_contains(r, ticket)).count();
                prop_assert_eq!(owners, 1, "ticket {} must have exactly one owner", ticket);
            }
            for range in &ranges {
                prop_assert!(!range_contains(range, total), "total belongs to no range");
            }
        }
    }

    /// Task 1.7 (a) — uniformity of the ticket reduction. 10⁶ seeded ChaCha
    /// entropies reduced mod 1,000; every bucket must sit within 4σ of its
    /// expected 1,000 count. This is what catches a biased reduction the
    /// table tests would wave through.
    #[test]
    #[ignore = "statistical — roadmap task 1.7: cargo test -p orbit_jackpot --lib -- --ignored"]
    fn ticket_reduction_is_uniform() {
        use rand_chacha::rand_core::{Rng, SeedableRng};
        use rand_chacha::ChaCha8Rng;

        const TOTAL: u64 = 1_000;
        const SAMPLES: u64 = 1_000_000;
        let mut rng = ChaCha8Rng::seed_from_u64(0x5EED_0000_1000);
        let mut buckets = vec![0u64; TOTAL as usize];
        let mut buf = [0u8; 16];
        for _ in 0..SAMPLES {
            rng.fill_bytes(&mut buf);
            let entropy = u128::from_le_bytes(buf);
            let ticket = ticket_from_entropy(entropy, TOTAL).expect("TOTAL >= 1");
            buckets[ticket as usize] += 1;
        }
        let expected = SAMPLES as f64 / TOTAL as f64;
        let sigma = (expected * (1.0 - 1.0 / TOTAL as f64)).sqrt();
        for (bucket, &count) in buckets.iter().enumerate() {
            let deviation = (count as f64 - expected).abs();
            assert!(
                deviation <= 4.0 * sigma,
                "bucket {bucket} deviated {deviation:.2} beyond 4σ={:.2}",
                4.0 * sigma
            );
        }
    }
}
