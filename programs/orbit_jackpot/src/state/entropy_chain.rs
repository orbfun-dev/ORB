//! `EntropyChain` — the singleton at ["entropy_chain"]: the operator's
//! hash-chain commitment for the self-hosted randomness provider
//! (docs/design/randomness-fallback.md §2.2, "option F").
//!
//! How one value is produced:
//! 1. The operator generates `x_0` offline and hashes it `N` times; the
//!    last link `x_N` is committed here with `remaining = N`.
//! 2. `request_entropy` pins a Locked round to this account and fixes a
//!    TARGET slot a few slots in the future. Nobody knows that slot's hash
//!    yet, so the operator cannot predict the outcome.
//! 3. After the target, `reveal_entropy` takes the next link (`seed`, with
//!    `sha256(seed) == commit`), samples the target slot's hash from
//!    `SlotHashes`, and fixes
//!    `value = sha256(DOMAIN ‖ round_id ‖ slot_hash ‖ seed)`.
//!    The seed becomes the new commit, so every future seed is locked in.
//!    The slot leader never knows the seed, so it cannot steer the value.
//!
//! Exactly one round can be in flight (`pending_round`), and a revealed
//! value must be settled (`value_round` cleared) before the next request.
//! A withheld reveal therefore halts every later round in public; the
//! stuck round refunds only after `ENTROPY_REVEAL_DEADLINE_SLOTS`.

use crate::errors::OrbitError;
use anchor_lang::prelude::*;

/// Sentinel for "no round" in `pending_round` / `value_round`. Round ids
/// start at 0, so 0 cannot be the sentinel.
pub const ENTROPY_NONE: u64 = u64::MAX;

#[account]
#[derive(InitSpace)]
pub struct EntropyChain {
    /// `sha256` of the next seed to be revealed.
    pub commit: [u8; 32],
    /// Seeds left in the current chain.
    pub remaining: u64,
    /// The round awaiting a reveal, or `ENTROPY_NONE`.
    pub pending_round: u64,
    /// The slot whose hash the pending round will use (the first produced
    /// slot at or after it).
    pub target_slot: u64,
    /// When the pending round was requested.
    pub request_slot: u64,
    /// The last revealed value; meaningful only while `value_round` is set.
    pub value: [u8; 32],
    /// The round `value` belongs to, until it settles; or `ENTROPY_NONE`.
    pub value_round: u64,
    /// The slot whose hash produced `value`.
    pub value_slot: u64,
    /// Lifetime reveals, for indexers.
    pub revealed_count: u64,
    pub bump: u8,
    pub reserved: [u8; 64],
}

impl EntropyChain {
    /// Reads the chain out of a raw account (settle / cancel / close take
    /// the pinned account unchecked, because its type depends on the
    /// round's provider). The Anchor discriminator check is what proves the
    /// account is this type; the caller has already proven ownership.
    pub fn load(info: &AccountInfo<'_>) -> Result<Self> {
        let data = info.try_borrow_data()?;
        let mut slice: &[u8] = &data;
        EntropyChain::try_deserialize(&mut slice)
            .map_err(|_| error!(OrbitError::RandomnessMalformed))
    }

    /// Writes the chain back into a raw account loaded with [`Self::load`].
    pub fn store(&self, info: &AccountInfo<'_>) -> Result<()> {
        let mut data = info.try_borrow_mut_data()?;
        let mut writer: &mut [u8] = &mut data;
        self.try_serialize(&mut writer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Size lock: 193 bytes including the discriminator.
    #[test]
    fn size_is_exactly_193() {
        assert_eq!(8 + EntropyChain::INIT_SPACE, 193);
    }
}
