//! `GlobalConfig` — the singleton at ["config"]: authorities, the immutable
//! economic parameters, and the mutable operational knobs.

use anchor_lang::prelude::*;

/// Which randomness source NEW rounds use. Borsh variant indices pin the
/// on-chain encoding: `0 = Switchboard`, `1 = Orao` (never implemented),
/// `2 = Entropy` (the operator hash chain, `EntropyChain`).
///
/// Admin-mutable since the randomness-fallback change: the provider is
/// read when a round requests randomness — after lock, before any value
/// exists under either source — and a pinned round keeps its source until
/// it settles or cancels. Settle/cancel/close classify the PINNED account,
/// never this field, so a flip can never re-route an in-flight round.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum OracleProvider {
    Switchboard,
    Orao,
    Entropy,
}

/// Program-wide configuration, created once by `initialize`.
///
/// Immutable after creation (ADR-10): `fee_bps_admin`, `fee_bps_mega`,
/// `winner_bps`, `mega_award_bps`, `mega_trigger_modulus`. An admin who can
/// retune jackpot odds mid-cycle can rug the progressive pot, so this must
/// be structurally impossible, not merely unauthorized. Everything else
/// stays admin-mutable; admin transfer is two-step via `pending_admin`.
#[account]
#[derive(InitSpace)]
pub struct GlobalConfig {
    pub admin: Pubkey,
    /// Two-step handoff staging slot; `None` when no transfer is pending.
    pub pending_admin: Option<Pubkey>,
    /// Fee-sweep destination authority; separate from `admin` for ops hygiene.
    pub treasury_authority: Pubkey,
    /// Pinned oracle program id; the randomness account's owner must match.
    pub oracle_program_id: Pubkey,
    /// Pinned Switchboard On-Demand queue; `commit_randomness` only ever
    /// commits against this queue, so a crank cannot steer the round at a
    /// different queue. Admin-mutable (queue migration is operational, not
    /// economic — unlike `oracle_program_id`, which is immutable).
    pub oracle_queue: Pubkey,
    /// Admin cut, bps — **immutable**.
    pub fee_bps_admin: u16,
    /// Mega-Pot cut, bps — **immutable**.
    pub fee_bps_mega: u16,
    /// Winner share, bps — **immutable**; the three must sum to 10_000 (I14).
    pub winner_bps: u16,
    /// Mega-Pot award on trigger, bps — **immutable**.
    pub mega_award_bps: u16,
    /// 1-in-N trigger odds — **immutable**; must be ≥ 1.
    pub mega_trigger_modulus: u32,
    /// `0` = unlimited entries.
    pub max_entries_per_round: u32,
    pub round_duration_secs: i64,
    /// Hard ceiling on anti-snipe extension.
    pub max_round_duration_secs: i64,
    pub anti_snipe_window_secs: i64,
    pub anti_snipe_extension_secs: i64,
    /// After this, an unclaimed prize sweeps to the Mega-Pot.
    pub claim_deadline_secs: i64,
    pub min_deposit_lamports: u64,
    /// Only deposits ≥ this extend the anti-snipe timer.
    pub anti_snipe_min_deposit_lamports: u64,
    /// Paid out of the 1% admin cut — never a fourth slice.
    pub keeper_tip_lamports: u64,
    /// Must stay < 512 (`SlotHashes` retention window).
    pub randomness_reveal_deadline_slots: u64,
    pub active_round_id: u64,
    /// Monotonic; ids are never reused.
    pub next_round_id: u64,
    pub oracle_provider: OracleProvider,
    /// Blocks `deposit` and `open_round` only — never fund-exit paths.
    pub paused: bool,
    pub bump: u8,
    /// Permissionless `crank_auto_deposit` is legal only while
    /// `now <= round.start_ts + this`. Outside it, only the escrow owner
    /// may trigger their own deposit (anti-selection; design §4.2).
    pub auto_deposit_window_secs: i64,
    /// Paid to whoever cranks an auto-deposit, out of the ESCROW — capped
    /// by `MAX_AUTO_DEPOSIT_TIP_LAMPORTS`, never admin-raisable past it.
    pub auto_deposit_tip_lamports: u64,
    /// Feature kill switch. `false` on the deployed config (its reserved
    /// bytes are zero), so the program upgrade changes no behaviour.
    pub auto_deposit_enabled: bool,
    /// Refund share of a settled pot, bps — **immutable** after
    /// `migrate_economics_v2`. The fourth slice: returned to every entry
    /// pro-rata, the winner's included (I14, I18).
    pub refund_bps: u16,
    /// Mega-Pot share paid pro-rata to the field on a trigger, bps —
    /// **immutable**. The winner's share is `mega_award_bps`.
    pub mega_field_bps: u16,
    /// Ceiling on a Mega-Pot payout, in bps **of the round's own pot**.
    /// `0` = uncapped (the pre-Phase-11 behaviour). This is the sole
    /// defence against farming the trigger in low-volume rounds, and I21
    /// pins it: a round can never pay out more than it could have been
    /// charged in rake over `mega_trigger_modulus` rounds. `u32`, not
    /// `u16` — the canonical 80_000 exceeds `u16::MAX`.
    pub mega_payout_cap_bps: u32,
    /// One-time fee when a `PlayerEscrow` is first created; seeds the
    /// Mega-Pot. Admin-mutable under `MAX_ACCOUNT_OPEN_FEE_LAMPORTS` —
    /// onboarding cost, not an economic lever (ADR-10 unaffected).
    pub account_open_fee_lamports: u64,
    /// `0`/`1` = the launch 98/1/1 economics; `2` = four-way partial-loss.
    /// One-way latch, set by `migrate_economics_v2` (ADR-11); read by the
    /// UI to know which rules a round played under.
    pub economics_version: u8,
    /// Forward-compat padding: a field can be added later without migration.
    /// Phase 10 took 17 bytes (8+8+1) for the auto-deposit fields, Phase 11
    /// another 17 (2+2+4+8+1) for the partial-loss economics — both sit
    /// **immediately before `reserved`** so every pre-existing field keeps
    /// its byte offset and the total size stays 340 (zero migration).
    pub reserved: [u8; 30],
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Size lock (§3): 340 bytes including the 8-byte discriminator. This is
    /// the single highest-value test in the phase — any accidental field
    /// addition, reorder or type change fails here by name.
    #[test]
    fn size_is_exactly_340() {
        assert_eq!(8 + GlobalConfig::INIT_SPACE, 340);
    }

    /// The provider enum pins its documented wire encoding.
    #[test]
    fn oracle_provider_wire_order_matches_the_spec() {
        let switchboard = OracleProvider::Switchboard;
        let orao = OracleProvider::Orao;
        let mut buf = Vec::new();
        switchboard.serialize(&mut buf).expect("serialize in test");
        assert_eq!(buf, vec![0u8]);
        buf.clear();
        orao.serialize(&mut buf).expect("serialize in test");
        assert_eq!(buf, vec![1u8]);
        buf.clear();
        OracleProvider::Entropy
            .serialize(&mut buf)
            .expect("serialize in test");
        assert_eq!(buf, vec![2u8]);
    }
}
