//! Oracle isolation layer (roadmap task 3.6).
//!
//! A read-only view over a committed randomness account. Isolating the SDK
//! behind this trait is what keeps a future oracle swap out of the
//! instruction handlers — `fulfill_settle` speaks only to
//! `RandomnessSource`.

pub mod entropy;
pub mod switchboard;

use anchor_lang::prelude::*;

/// The randomized-commit view a settlement needs (ADR-4):
///
/// - [`RandomnessSource::authority`] — the account's authority, which must
///   be the **round PDA**. This is the critical check: if a third party held
///   the authority they could re-commit the account to a new seed slot after
///   seeing an unfavorable value.
/// - [`RandomnessSource::seed_slot`] — the slot whose hash seeded the value;
///   it must exceed the round's `lock_slot`, so no one can deposit against a
///   known outcome.
/// - [`RandomnessSource::value`] / [`RandomnessSource::is_revealed`] — the
///   revealed 32 bytes, uniform across all of them.
pub trait RandomnessSource {
    fn authority(&self) -> Pubkey;
    /// The oracle the commit assigned; the reveal must present exactly it.
    fn oracle(&self) -> Pubkey;
    fn seed_slot(&self) -> u64;
    fn value(&self) -> [u8; 32];
    fn is_revealed(&self) -> bool;
}

/// Which source a round's PINNED randomness account belongs to.
///
/// Randomness-fallback rule (design §4.3): every handler that reads the pin
/// classifies the account itself — never `config.oracle_provider` — so an
/// admin switching providers cannot re-route a round already in flight.
/// Before this rule `cancel_round` treated "not owned by the configured
/// oracle program" as closed; with a switchable provider that would have
/// let a loser cancel a round whose value was already public (AUDIT P-1).
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum PinnedSource {
    /// Owned by the configured Switchboard program.
    Switchboard,
    /// The `EntropyChain` singleton (owned by this program, its PDA).
    Entropy,
    /// Gone: System-owned (closed or never created). Lamports are NOT
    /// checked — anyone can send lamports to any address, and a rule that
    /// required zero would let a griefer block a refund forever.
    Closed,
}

/// Classifies a pinned randomness account. Anything that is none of the
/// three — e.g. a live account of some other program — is an error, never
/// "closed". (A Switchboard account can only ever become System-owned by
/// being closed; it cannot be reassigned to another program.)
pub fn classify_pinned(
    info: &AccountInfo<'_>,
    switchboard_program: &Pubkey,
) -> Result<PinnedSource> {
    if info.owner == &crate::ID {
        let chain = crate::state::EntropyChain::load(info)?;
        let expected = Pubkey::create_program_address(
            &[crate::constants::ENTROPY_CHAIN_SEED, &[chain.bump]],
            &crate::ID,
        )
        .map_err(|_| error!(crate::errors::OrbitError::RandomnessAccountMismatch))?;
        require_keys_eq!(
            info.key(),
            expected,
            crate::errors::OrbitError::RandomnessAccountMismatch
        );
        return Ok(PinnedSource::Entropy);
    }
    if info.owner == switchboard_program {
        return Ok(PinnedSource::Switchboard);
    }
    if info.owner == &anchor_lang::system_program::ID {
        return Ok(PinnedSource::Closed);
    }
    err!(crate::errors::OrbitError::RandomnessOwnerMismatch)
}
