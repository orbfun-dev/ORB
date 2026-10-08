//! `PlayerEscrow` — the auto-deposit funding account at ["escrow", owner].
//!
//! A player funds this PDA once and declares terms ("0.1 SOL per round for
//! the next 10 rounds"); thereafter any permissionless actor calls
//! `crank_auto_deposit` and the escrow enters the round with no wallet
//! signature (Phase 10 design §1).
//!
//! **Deliberate deviation from ADR-8** (data and lamports co-located, where
//! the vaults keep them separate): the data length here is fixed at 122
//! bytes, the rent minimum is recomputed from the sysvar at every touch,
//! there is no third-party claim on the balance, and splitting lamports
//! into a sibling PDA would double the per-player rent cost for no gain.
//!
//! The escrow has **no balance field**. Prizes, refunds and entry-rent
//! rebates arrive via `add_lamports` from instructions that know nothing
//! about the escrow, so any stored balance would desynchronise instantly;
//! spendable is always derived as `lamports() − rent_minimum` (R4).

use anchor_lang::prelude::*;

/// One player's auto-deposit terms and lifetime accounting, at
/// `["escrow", owner.key().as_ref()]`.
///
/// `next_eligible_round_id` is the double-entry guard: `0` at open, set to
/// `round_id + 1` after each auto-deposit, and **never reset by re-funding**
/// — re-funding must not re-open a round the escrow already played. Round
/// ids are monotonic and never reused, so `round_id >= next_eligible` is
/// simultaneously the same-round and the replay guard (I17).
#[account]
#[derive(InitSpace)]
pub struct PlayerEscrow {
    /// Also the seed. Sole withdrawal authority.
    pub owner: Pubkey,
    /// The stake per round. Re-validated against
    /// `config.min_deposit_lamports` at **every** auto-deposit — the admin
    /// may have raised the floor since the terms were set.
    pub per_round_lamports: u64,
    /// Ceiling on `rounds_remaining`; bounds the commitment under
    /// `auto_reinvest`.
    pub max_rounds: u32,
    /// The budget. `0` ⇒ dormant (re-fund or withdraw; no auto-closure).
    pub rounds_remaining: u32,
    /// Double-entry guard (I17): `round_id + 1` after each auto-deposit.
    pub next_eligible_round_id: u64,
    /// Lifetime count of auto-deposited rounds.
    pub rounds_funded: u64,
    /// Lifetime lamports funded in by the owner.
    pub lifetime_deposited: u64,
    /// Lifetime lamports staked into pots.
    pub lifetime_staked: u64,
    /// Winnings, refunds and rent rebates that land in the escrow buy more
    /// rounds (capped at `max_rounds`); with the flag off, inbound money
    /// just accumulates until withdrawn.
    pub auto_reinvest: bool,
    /// Canonical bump, stored at init.
    pub bump: u8,
    /// Forward-compat padding.
    pub reserved: [u8; 32],
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Size lock (Phase 10 design §3.1): 122 bytes including the 8-byte
    /// discriminator. Distinct from every existing account size (340, 302,
    /// 109, 89, 65, 33), so `{ dataSize: 122 }` alone is an unambiguous
    /// GPA filter for escrows — the keeper registry depends on that.
    #[test]
    fn size_is_exactly_122() {
        assert_eq!(8 + PlayerEscrow::INIT_SPACE, 122);
    }
}
