//! Canonical numeric constants (roadmap §2: "seed literals, BPS_DENOMINATOR,
//! caps, discriminator size" — Phase 1 scope is the basis-point surface).
//!
//! Pure data: this module imports nothing, so the math layer it parameterizes
//! stays verifiable with a bare `cargo test --lib` run.

/// The denominator every basis-point figure is measured against.
/// Invariant I14 (four-way form, Phase 11): `winner_bps + refund_bps +
/// fee_bps_admin + fee_bps_mega == BPS_DENOMINATOR`.
pub const BPS_DENOMINATOR: u16 = 10_000;

/// Winner share of a settled pot, in bps — the 9% slice (Phase 11 economics:
/// was 9_800, the 98% residual). Set by `initialize` or the one-way
/// `migrate_economics_v2` latch; immutable everywhere else (ADR-10/11).
pub const WINNER_BPS: u16 = 900;

/// Refund share of a settled pot, in bps — **the fourth slice**: returned to
/// every entry pro-rata, the winner's included (I14, I18). Phase 11 economics;
/// `0` on the deployed v1 config, whose reserved bytes read as zero.
pub const REFUND_BPS: u16 = 8_900;

/// Admin cut of a settled pot, in bps (spec §2). Immutable after `initialize`.
pub const FEE_BPS_ADMIN: u16 = 100;

/// Mega-Pot cut of a settled pot, in bps (spec §2). Immutable after `initialize`.
pub const FEE_BPS_MEGA: u16 = 100;

/// Mega-Pot award to the round winner on trigger, in bps. Phase 11 economics:
/// was 9_000; the pro-rata field share (below) now carries 4_000 of the pop.
pub const MEGA_AWARD_BPS: u16 = 5_000;

/// Mega-Pot share paid pro-rata to every entry on a trigger, in bps —
/// Phase 11's second new slice. `0` on the deployed v1 config.
pub const MEGA_FIELD_BPS: u16 = 4_000;

/// The 1-in-N Mega-Pot trigger odds. Phase 11 (decision D2, resolved): was
/// 6_767 (~14-day pops); 625 pops roughly every 1.3 days at 180-second
/// rounds, trading headline size for cadence and the 40% field share.
pub const MEGA_TRIGGER_MODULUS: u32 = 625;

/// Ceiling on a Mega-Pot payout, in bps **of the round's own pot** — the I21
/// farm guard. 80_000 = 8× the round pot, 1.56× inside the I21 bound of
/// `MEGA_TRIGGER_MODULUS × (FEE_BPS_ADMIN + FEE_BPS_MEGA) = 125_000`.
/// `u32`, not `u16`: 80_000 exceeds `u16::MAX`. `0` means uncapped (the
/// pre-Phase-11 behaviour, legal only below `economics_version` 2).
pub const MEGA_PAYOUT_CAP_BPS: u32 = 80_000;

/// One-time fee charged when a `PlayerEscrow` is first created; seeds the
/// Mega-Pot. 0.01 SOL (decision D1, universal: the escrow is the player
/// profile and both entry paths pay it exactly once per wallet).
pub const ACCOUNT_OPEN_FEE_LAMPORTS: u64 = 10_000_000;

/// Compile-time ceiling on `config.account_open_fee_lamports` — 0.05 SOL.
/// Like `MAX_AUTO_DEPOSIT_TIP_LAMPORTS`: the fee is an onboarding cost, not
/// a jackpot-odds lever (ADR-10 unaffected), but still needs a hard bound.
pub const MAX_ACCOUNT_OPEN_FEE_LAMPORTS: u64 = 50_000_000;

/// `SlotHashes` retention bound. The randomness reveal deadline must stay
/// strictly below this, past which the randomness is unresolvable regardless
/// of policy (roadmap 4.4).
pub const SLOT_HASHES_RETENTION_SLOTS: u64 = 512;

// ── PDA seed literals (roadmap §3 seed table; all integers little-endian) ──
// A typo'd seed is a silently different, permanently inaccessible address —
// the byte-exact test below is what makes a typo loud.

/// `GlobalConfig` = ["config"], singleton.
pub const CONFIG_SEED: &[u8] = b"config";
/// `TreasuryVault` = ["treasury"], singleton.
pub const TREASURY_SEED: &[u8] = b"treasury";
/// `MegaPotVault` = ["mega_pot"], singleton.
pub const MEGA_POT_SEED: &[u8] = b"mega_pot";
/// `Round` = ["round", round_id.to_le_bytes()].
pub const ROUND_SEED: &[u8] = b"round";
/// `RoundVault` = ["round_vault", round_id.to_le_bytes()].
pub const ROUND_VAULT_SEED: &[u8] = b"round_vault";
/// `EntropyChain` = ["entropy_chain"], singleton (self-hosted randomness).
pub const ENTROPY_CHAIN_SEED: &[u8] = b"entropy_chain";
/// `PlayerEntry` = ["entry", round_id.to_le_bytes(), entry_index.to_le_bytes()].
pub const ENTRY_SEED: &[u8] = b"entry";
/// `PlayerEscrow` = ["escrow", owner] — one escrow per wallet (no nonce:
/// it would buy multiple strategies per wallet at the cost of the trivial
/// escrow↔owner mapping the UI and the keeper registry both depend on).
pub const ESCROW_SEED: &[u8] = b"escrow";

/// Compile-time ceiling on `config.auto_deposit_tip_lamports` — 0.001 SOL.
/// Never an instruction argument: it is the security boundary that stops an
/// admin from setting a tip that siphons player escrows; `update_config`
/// can move the tip only underneath it (§3.2).
pub const MAX_AUTO_DEPOSIT_TIP_LAMPORTS: u64 = 1_000_000;

#[cfg(test)]
mod tests {
    use super::*;

    /// Invariant I14, four-way form (Phase 11): the canonical 9/89/1/1
    /// split must consume the denominator exactly.
    #[test]
    fn canonical_split_sums_to_exactly_the_denominator() {
        let sum = u32::from(WINNER_BPS)
            + u32::from(REFUND_BPS)
            + u32::from(FEE_BPS_ADMIN)
            + u32::from(FEE_BPS_MEGA);
        assert_eq!(sum, u32::from(BPS_DENOMINATOR));
    }

    /// The Mega-Pot award + field shares never exceed one whole pop.
    #[test]
    fn mega_award_and_field_fit_the_denominator() {
        assert!(
            u32::from(MEGA_AWARD_BPS) + u32::from(MEGA_FIELD_BPS) <= u32::from(BPS_DENOMINATOR)
        );
    }

    /// I21 at the constant level — the single most important test in the
    /// phase. A round can never pay out more in a Mega-Pot pop than the rake
    /// it could have been charged over `mega_trigger_modulus` rounds, so
    /// farming the trigger in low-volume rounds is non-positive-EV for every
    /// attacker share, pot size and wallet split (design §4).
    #[test]
    fn mega_payout_cap_sits_within_the_farm_guard_bound() {
        let bound =
            u64::from(MEGA_TRIGGER_MODULUS) * (u64::from(FEE_BPS_ADMIN) + u64::from(FEE_BPS_MEGA));
        assert!(u64::from(MEGA_PAYOUT_CAP_BPS) <= bound);
    }

    /// The account-open fee never exceeds its own compile-time ceiling
    /// (stated as a clamp so the compiler cannot const-fold it away).
    #[test]
    fn account_open_fee_within_ceiling() {
        assert_eq!(
            ACCOUNT_OPEN_FEE_LAMPORTS.min(MAX_ACCOUNT_OPEN_FEE_LAMPORTS),
            ACCOUNT_OPEN_FEE_LAMPORTS
        );
    }

    /// Task 2.5 — each seed literal is pinned to its exact bytes, spelled as
    /// raw ASCII codes so an edit anywhere in the literal fails here.
    #[test]
    fn seed_literals_are_byte_exact() {
        assert_eq!(CONFIG_SEED, &[99u8, 111, 110, 102, 105, 103]);
        assert_eq!(TREASURY_SEED, &[116u8, 114, 101, 97, 115, 117, 114, 121]);
        assert_eq!(MEGA_POT_SEED, &[109u8, 101, 103, 97, 95, 112, 111, 116]);
        assert_eq!(ROUND_SEED, &[114u8, 111, 117, 110, 100]);
        assert_eq!(
            ROUND_VAULT_SEED,
            &[114u8, 111, 117, 110, 100, 95, 118, 97, 117, 108, 116]
        );
        assert_eq!(ENTRY_SEED, &[101u8, 110, 116, 114, 121]);
        assert_eq!(ESCROW_SEED, &[101u8, 115, 99, 114, 111, 119]);
    }
}

/// AUDIT P-3: floors on the admin-mutable levers that could otherwise void
/// rounds or prizes outright. Enforced on every `update_config` that
/// changes the field (values set before these floors are grandfathered
/// until next touched).
/// A reveal deadline of 0 would make every round cancellable the slot
/// after its commit (see `cancel_round`).
pub const MIN_REVEAL_DEADLINE_SLOTS: u64 = 150;
/// Entropy provider: the target slot sits this far past the request, so
/// its hash cannot be known by anyone when the round is pinned.
pub const ENTROPY_TARGET_DELAY_SLOTS: u64 = 2;
/// Entropy provider: a pinned round with no reveal may be cancelled only
/// after ~24 h (at 0.4 s/slot). Deliberately long: the operator holds the
/// seeds and sees the outcome first, so a short cancel would be a free
/// abort. A withheld reveal instead halts the game in public for a day.
pub const ENTROPY_REVEAL_DEADLINE_SLOTS: u64 = 216_000;
/// Domain separator for the entropy value hash.
pub const ENTROPY_VALUE_DOMAIN: &[u8] = b"orb-entropy-v1";
/// A claim deadline of 0 would let unclaimed prizes be swept immediately.
pub const MIN_CLAIM_DEADLINE_SECS: i64 = 86_400;
/// A round shorter than this leaves no time to deposit.
pub const MIN_ROUND_DURATION_SECS: i64 = 30;
