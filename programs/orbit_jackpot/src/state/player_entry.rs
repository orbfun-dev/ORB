//! `PlayerEntry` — the append-only, index-keyed deposit record.

use anchor_lang::prelude::*;

/// One deposit, minted at
/// `["entry", round_id.to_le_bytes(), entry_index.to_le_bytes()]`.
///
/// Keyed by **index, not player** — the player pubkey is a field, and
/// payouts, refunds and reclaimed rent always route to `entry.player`.
/// Index keying is what enables the client's O(log n) binary search on
/// `ticket_start` (ADR-2).
///
/// The immutable half-open range `[ticket_start, ticket_end)` partitions
/// `[0, round.total_lamports)` with every other entry of the round (I9):
/// `ticket_end` is stored rather than derived so the range check is auditable
/// at a glance, and `amount > 0` is enforced at deposit — an empty range
/// would break the partition.
///
/// For client indexing: `round_id` sits at byte offset 8 (after the
/// discriminator) and `player` at offset 20, giving the `memcmp` filters for
/// `getProgramAccounts`.
#[account]
#[derive(InitSpace)]
pub struct PlayerEntry {
    /// Checked against `round.round_id` on every use.
    pub round_id: u64,
    pub entry_index: u32,
    /// Sole destination for payout, refund and reclaimed rent.
    pub player: Pubkey,
    /// The deposited amount; `> 0` by construction (I8).
    pub amount: u64,
    /// Inclusive range lower bound — the round's total before this deposit.
    pub ticket_start: u64,
    /// Exclusive range upper bound.
    pub ticket_end: u64,
    pub deposit_ts: i64,
    pub deposit_slot: u64,
    pub bump: u8,
    /// Forward-compat padding.
    pub reserved: [u8; 16],
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Size lock (§3): 109 bytes including the 8-byte discriminator.
    #[test]
    fn size_is_exactly_109() {
        assert_eq!(8 + PlayerEntry::INIT_SPACE, 109);
    }
}
