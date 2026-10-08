//! The three vault PDAs. All are program-owned so they can be debited by
//! direct `lamports()` arithmetic (a System-program CPI cannot debit a
//! non-System-owned account), and none may ever drop below its rent-exempt
//! minimum.

use anchor_lang::prelude::*;

/// Escrow for one round's deposits, at ["round_vault", round_id_le].
///
/// Kept separate from `Round` (ADR-8): co-locating data and lamports would
/// make every balance assertion subtract a rent minimum that changes with
/// the data length. Holds lamports only.
#[account]
#[derive(InitSpace)]
pub struct RoundVault {
    pub round_id: u64,
    pub bump: u8,
    /// Forward-compat padding.
    pub reserved: [u8; 16],
}

/// Fee sink, at ["treasury"]; singleton drained by `admin_sweep_fees`.
#[account]
#[derive(InitSpace)]
pub struct TreasuryVault {
    /// Sweepable balance (I2: `lamports == rent_min + accrued_lamports`).
    pub accrued_lamports: u64,
    pub lifetime_accrued: u64,
    pub lifetime_swept: u64,
    pub bump: u8,
    /// Forward-compat padding.
    pub reserved: [u8; 32],
}

/// The progressive jackpot, at ["mega_pot"]; singleton.
#[account]
#[derive(InitSpace)]
pub struct MegaPotVault {
    /// The **authoritative spendable balance** (I3). Never compute the
    /// awardable amount from `vault.lamports()` — that includes the
    /// rent-exempt minimum and a 90% award could push the account below
    /// exemption.
    pub accrued_lamports: u64,
    pub lifetime_contributed: u64,
    pub lifetime_awarded: u64,
    pub trigger_count: u64,
    pub last_trigger_round_id: u64,
    pub cycle_index: u64,
    pub bump: u8,
    /// Forward-compat padding.
    pub reserved: [u8; 32],
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Size lock (§3): 33 bytes including the 8-byte discriminator.
    #[test]
    fn round_vault_size_is_exactly_33() {
        assert_eq!(8 + RoundVault::INIT_SPACE, 33);
    }

    /// Size lock (§3): 65 bytes including the 8-byte discriminator.
    #[test]
    fn treasury_vault_size_is_exactly_65() {
        assert_eq!(8 + TreasuryVault::INIT_SPACE, 65);
    }

    /// Size lock (§3): 89 bytes including the 8-byte discriminator.
    #[test]
    fn mega_pot_vault_size_is_exactly_89() {
        assert_eq!(8 + MegaPotVault::INIT_SPACE, 89);
    }
}
