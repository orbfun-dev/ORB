//! Entropy slicing: the disjoint reduction of a raw 32-byte randomness value.
//!
//! The value is split into two independent 128-bit halves — the low 16 bytes
//! drive the winning ticket, the high 16 bytes drive the Mega-Pot trigger.
//! Disjoint slices of a uniform 32-byte output are independent, which is the
//! domain separation the spec asks for, with no hashing dependency at all;
//! and reducing a 128-bit value mod `M < 2^64` bounds the modulo bias at
//! `M / 2^128 <= 2^-64` — negligible, and constant-time.
//!
//! This file must stay free of every runtime and framework import so the
//! outcome arithmetic is reproducible bit-for-bit across languages (the
//! cross-language fixture depends on it).
#![forbid(unsafe_code)]

/// Splits a raw 32-byte randomness value into its two independent halves.
///
/// Returns `(ticket_entropy, mega_entropy)`, both read little-endian:
/// `value[0..16]` and `value[16..32]` respectively. Little-endian is pinned
/// by the endianness-lock test — a change must be a loud failure, never a
/// silent re-roll of every historical outcome.
pub fn split_entropy(value: &[u8; 32]) -> (u128, u128) {
    // Constant-bounded slices of a fixed-size array: the copies cannot fail,
    // and going through owned 16-byte buffers keeps this unwrap-free.
    let mut ticket_bytes = [0u8; 16];
    let mut mega_bytes = [0u8; 16];
    ticket_bytes.copy_from_slice(&value[0..16]);
    mega_bytes.copy_from_slice(&value[16..32]);
    (
        u128::from_le_bytes(ticket_bytes),
        u128::from_le_bytes(mega_bytes),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Task 1.6's lock (delivered with the slicing it pins): with
    /// `value = [0x00, 0x01, ..., 0x1F]` both halves must equal these exact
    /// little-endian constants. Hard-coded on purpose.
    #[test]
    fn endianness_lock_exact_constants() {
        let value: [u8; 32] = core::array::from_fn(|i| i as u8);
        let (ticket, mega) = split_entropy(&value);
        assert_eq!(ticket, 0x0F0E_0D0C_0B0A_0908_0706_0504_0302_0100_u128);
        assert_eq!(mega, 0x1F1E_1D1C_1B1A_1918_1716_1514_1312_1110_u128);
    }

    #[test]
    fn all_zero_and_all_max_values() {
        assert_eq!(split_entropy(&[0u8; 32]), (0, 0));
        assert_eq!(split_entropy(&[0xFF; 32]), (u128::MAX, u128::MAX));
    }

    /// The halves are disjoint: touching a byte inside one half never moves
    /// the other. Byte 15 is the most significant of the ticket half,
    /// byte 16 the least significant of the mega half.
    #[test]
    fn halves_are_disjoint() {
        let mut value = [0u8; 32];
        value[15] = 0xAB;
        let (ticket, mega) = split_entropy(&value);
        assert_eq!(ticket, 0xAB_u128 << 120);
        assert_eq!(mega, 0);

        value[15] = 0;
        value[16] = 0xCD;
        let (ticket, mega) = split_entropy(&value);
        assert_eq!(ticket, 0);
        assert_eq!(mega, 0xCD_u128);
    }
}

/// Task 1.8 — the cross-language known-answer fixture (ADR-9).
///
/// One committed JSON file pins, for every vector: the raw 32-byte seed, both
/// entropy halves, the winning ticket and Mega-Pot decision under a sample
/// total, the four-way pot split (winner floor, refund residual, both cuts),
/// the capped Mega-Pot payout split against a sample accrual, and the
/// `theta_target` the client must animate to. The Rust unit tests and the TS
/// suite both read it; the fixture is generated Rust-side only and
/// committed, never regenerated from TS.
///
/// The fixture test below is the single writer and the single verifier: it
/// recomputes the canonical serialization from the pure functions and asserts
/// the committed bytes equal it. To regenerate deliberately, delete the file
/// and rerun the test.
#[cfg(test)]
mod kat {
    use super::split_entropy;
    use crate::constants::{
        FEE_BPS_ADMIN, FEE_BPS_MEGA, MEGA_AWARD_BPS, MEGA_FIELD_BPS, MEGA_PAYOUT_CAP_BPS,
        MEGA_TRIGGER_MODULUS, WINNER_BPS,
    };
    use crate::math::{mega_triggered, split_mega_pot, split_round_pot, ticket_from_entropy};
    // rand 0.9+ split `fill_bytes` out of `RngCore` (now deprecated) into `Rng`.
    use rand_chacha::rand_core::{Rng, SeedableRng};
    use rand_chacha::ChaCha8Rng;

    /// The canonical Mega-Pot odds the fixture exercises — the Phase 11
    /// constant (decision D2: 625), read from `constants` so the fixture
    /// can never disagree with the shipped modulus.
    const MEGA_MODULUS: u32 = MEGA_TRIGGER_MODULUS;
    /// Fixed ChaCha seed: regeneration is byte-identical on every machine.
    const KAT_PRNG_SEED: u64 = 0x0B17_7000_5EED;
    /// The sample Mega-Pot accrual every vector's payout split runs against
    /// (above `Number.MAX_SAFE_INTEGER`, so the TS mirror must use BigInt).
    const SAMPLE_ACCRUED: u64 = 98_765_432_109_876_543;

    struct KatVector {
        raw_seed_hex: String,
        ticket_seed: u128,
        mega_seed: u128,
        total: u64,
        winning_ticket: u64,
        theta_degrees: String,
        mega: bool,
        admin_cut: u64,
        mega_cut: u64,
        winner_payout: u64,
        refund_pool: u64,
        mega_payable: u64,
        mega_awarded: u64,
        mega_field_pool: u64,
        mega_retained: u64,
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn draw_u128(rng: &mut ChaCha8Rng) -> u128 {
        let mut buf = [0u8; 16];
        rng.fill_bytes(&mut buf);
        u128::from_le_bytes(buf)
    }

    /// Computes one vector through the pure functions — the fixture can only
    /// ever contain values these functions produce.
    fn build(ticket_seed: u128, mega_seed: u128, total: u64) -> KatVector {
        let mut raw = [0u8; 32];
        raw[..16].copy_from_slice(&ticket_seed.to_le_bytes());
        raw[16..].copy_from_slice(&mega_seed.to_le_bytes());

        // KAT the slicer itself: the committed hex must decompose back to
        // exactly the seeds it was built from.
        let (ticket_back, mega_back) = split_entropy(&raw);
        assert_eq!(ticket_back, ticket_seed);
        assert_eq!(mega_back, mega_seed);

        let winning_ticket = ticket_from_entropy(ticket_seed, total).expect("total >= 1");
        let mega = mega_triggered(mega_seed, MEGA_MODULUS).expect("canonical modulus");
        let split =
            split_round_pot(total, WINNER_BPS, FEE_BPS_ADMIN, FEE_BPS_MEGA).expect("canonical bps");
        let mega_split = split_mega_pot(
            SAMPLE_ACCRUED,
            total,
            MEGA_AWARD_BPS,
            MEGA_FIELD_BPS,
            MEGA_PAYOUT_CAP_BPS,
        )
        .expect("canonical mega bps");

        // theta_target in micro-degrees, truncated to 6 decimals:
        // floor(winning × 360_000_000 / total). Integer-exact, so the client
        // comparison never depends on floating-point luck.
        let micro_degrees = u128::from(winning_ticket) * 360_000_000_u128 / u128::from(total);
        let theta_degrees = format!(
            "{}.{:06}",
            micro_degrees / 1_000_000,
            micro_degrees % 1_000_000
        );

        KatVector {
            raw_seed_hex: hex(&raw),
            ticket_seed,
            mega_seed,
            total,
            winning_ticket,
            theta_degrees,
            mega,
            admin_cut: split.admin_cut,
            mega_cut: split.mega_cut,
            winner_payout: split.winner_payout,
            refund_pool: split.refund_pool,
            mega_payable: SAMPLE_ACCRUED
                .checked_sub(mega_split.retained)
                .expect("I19: payable = accrued - retained"),
            mega_awarded: mega_split.awarded,
            mega_field_pool: mega_split.field_pool,
            mega_retained: mega_split.retained,
        }
    }

    /// 22 totals × 4 engineered seed patterns = 88 vectors, spanning tiny,
    /// realistic, huge and prime totals; boundary tickets 0 and total − 1;
    /// and 22 Mega-Pot triggers. Patterns per total:
    /// A boundary-zero ticket; B boundary-top ticket + Mega trigger;
    /// C just-below-trigger mega seed; D fully random draw.
    fn canonical_vectors() -> Vec<KatVector> {
        #[rustfmt::skip]
        let totals = [
            // tiny
            1u64, 2, 3, 7, 10, 99, 100, 150, 1_000, 625, 9_999, 10_001,
            // realistic round pots
            10_000_000, 123_456_789, 7_770_000_000, 1_000_000_000_000,
            // huge and/or prime (incl. 2^53+1, 2^63-1, largest u64 prime, u64::MAX)
            1_000_003, 4_294_967_311, 9_007_199_254_740_993,
            9_223_372_036_854_775_807, 18_446_744_073_709_551_557,
            18_446_744_073_709_551_615,
        ];
        let mut rng = ChaCha8Rng::seed_from_u64(KAT_PRNG_SEED);
        let mut vectors = Vec::with_capacity(totals.len() * 4);
        for (i, &total) in totals.iter().enumerate() {
            // A — boundary ticket 0.
            vectors.push(build(0, draw_u128(&mut rng), total));
            // B — boundary ticket total - 1, Mega-Pot triggered
            // (625 × (i + 1) is an exact multiple of the modulus).
            let trigger_seed = u128::from(MEGA_MODULUS) * u128::from(i as u64 + 1);
            vectors.push(build(u128::from(total - 1), trigger_seed, total));
            // C — boundary ticket 2×total − 1; mega seed one shy of, or one
            // past, the trigger threshold.
            let near_miss = if i % 2 == 0 {
                MEGA_MODULUS - 1
            } else {
                MEGA_MODULUS + 1
            };
            vectors.push(build(
                2 * u128::from(total) - 1,
                u128::from(near_miss),
                total,
            ));
            // D — fully random halves.
            vectors.push(build(draw_u128(&mut rng), draw_u128(&mut rng), total));
        }
        vectors
    }

    /// Field order follows the contract: the seven fields every entry must
    /// record, then the cut and pool fields, then the capped-payout fields,
    /// the replay tests consume. All wide integers are decimal strings —
    /// `u64`/`u128` do not survive a JSON number round-trip into client
    /// `Number`s.
    fn serialize(vectors: &[KatVector]) -> String {
        let mut out = String::from("[\n");
        for (i, v) in vectors.iter().enumerate() {
            out.push_str("  {\n");
            out.push_str(&format!("    \"raw_seed_hex\": \"{}\",\n", v.raw_seed_hex));
            out.push_str(&format!(
                "    \"ticket_seed_u128\": \"{}\",\n",
                v.ticket_seed
            ));
            out.push_str(&format!("    \"mega_seed_u128\": \"{}\",\n", v.mega_seed));
            out.push_str(&format!(
                "    \"sample_total_lamports\": \"{}\",\n",
                v.total
            ));
            out.push_str(&format!(
                "    \"winning_ticket\": \"{}\",\n",
                v.winning_ticket
            ));
            out.push_str(&format!(
                "    \"expected_theta_degrees\": \"{}\",\n",
                v.theta_degrees
            ));
            out.push_str(&format!("    \"mega_triggered\": {},\n", v.mega));
            out.push_str(&format!(
                "    \"expected_admin_cut\": \"{}\",\n",
                v.admin_cut
            ));
            out.push_str(&format!("    \"expected_mega_cut\": \"{}\",\n", v.mega_cut));
            out.push_str(&format!(
                "    \"expected_winner_payout\": \"{}\",\n",
                v.winner_payout
            ));
            out.push_str(&format!(
                "    \"expected_refund_pool\": \"{}\",\n",
                v.refund_pool
            ));
            out.push_str(&format!(
                "    \"sample_mega_accrued\": \"{}\",\n",
                SAMPLE_ACCRUED
            ));
            out.push_str(&format!(
                "    \"expected_mega_payable\": \"{}\",\n",
                v.mega_payable
            ));
            out.push_str(&format!(
                "    \"expected_mega_awarded\": \"{}\",\n",
                v.mega_awarded
            ));
            out.push_str(&format!(
                "    \"expected_mega_field_pool\": \"{}\",\n",
                v.mega_field_pool
            ));
            out.push_str(&format!(
                "    \"expected_mega_retained\": \"{}\"\n",
                v.mega_retained
            ));
            out.push_str(if i + 1 == vectors.len() {
                "  }\n"
            } else {
                "  },\n"
            });
        }
        out.push_str("]\n");
        out
    }

    #[test]
    fn entropy_kat_fixture_matches_canonical_generation() {
        let vectors = canonical_vectors();

        // The contract minimums, checked before anything touches the disk.
        assert!(
            vectors.len() >= 64,
            "need >= 64 vectors, got {}",
            vectors.len()
        );
        let mega_true = vectors.iter().filter(|v| v.mega).count();
        assert!(
            mega_true >= 3,
            "need >= 3 Mega-triggering vectors, got {mega_true}"
        );

        let canonical = serialize(&vectors);
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/entropy_kat.json");
        match std::fs::read_to_string(&path) {
            Ok(committed) => assert_eq!(
                committed, canonical,
                "committed KAT fixture diverged from pure-math regeneration; \
                 delete it and rerun this test to regenerate deliberately"
            ),
            Err(_) => {
                std::fs::create_dir_all(path.parent().expect("fixture dir has a parent"))
                    .expect("create fixture dir");
                std::fs::write(&path, &canonical).expect("write KAT fixture");
            }
        }
    }
}
