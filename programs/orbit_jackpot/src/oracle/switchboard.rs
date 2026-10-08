//! Switchboard On-Demand randomness account parsing.
//!
//! Parses the account in place — no signature verification is needed on the
//! consumer side: the oracle's TEE signature is verified by the *Switchboard*
//! program at reveal time, so a consumer reading a committed account only
//! needs the layout. This is also what makes a byte-exact fabricated account
//! a faithful mock in tests (roadmap 0.4).
//!
//! The account is referenced as an `UncheckedAccount` in instruction contexts
//! (never typed via the SDK's anchor integration) and parsed here, per §7's
//! IDL note — keeping Switchboard types out of the IDL and its feature graph.

use crate::errors::OrbitError;
use crate::oracle::RandomnessSource;
use anchor_lang::prelude::*;
use std::cell::Ref;
use switchboard_on_demand::on_demand::accounts::randomness::RandomnessAccountData;

/// A parsed, borrowed view of one Switchboard randomness account.
pub struct SwitchboardRandomness<'a> {
    data: Ref<'a, RandomnessAccountData>,
}

impl<'a> SwitchboardRandomness<'a> {
    /// Parses the account data, checking Switchboard's discriminator and
    /// layout. Fails with [`OrbitError::RandomnessMalformed`] on anything
    /// that is not a well-formed randomness account.
    pub fn parse(account: &'a AccountInfo<'_>) -> Result<Self> {
        let malformed = || anchor_lang::error::Error::from(OrbitError::RandomnessMalformed);
        let data = account.try_borrow_data().map_err(|_| malformed())?;
        let parsed = RandomnessAccountData::parse(data).map_err(|_| malformed())?;
        Ok(Self { data: parsed })
    }
}

impl RandomnessSource for SwitchboardRandomness<'_> {
    fn authority(&self) -> Pubkey {
        self.data.authority
    }

    /// The oracle the commit assigned; `reveal_randomness` re-checks the
    /// presented oracle against it.
    fn oracle(&self) -> Pubkey {
        self.data.oracle
    }

    fn seed_slot(&self) -> u64 {
        self.data.seed_slot
    }

    fn value(&self) -> [u8; 32] {
        self.data.value
    }

    /// `reveal_slot` is zero until the oracle reveals; a revealed account
    /// always carries the slot it was revealed at.
    fn is_revealed(&self) -> bool {
        self.data.reveal_slot > 0
    }
}
