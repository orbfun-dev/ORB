//! `reveal_entropy` — publish the next hash-chain seed for the pending
//! round and fix its value (randomness fallback, option F).
//!
//! Permissionless in form; in practice only the seed holder (the keeper)
//! can call it. The seed must hash to the chain's commit, so it was fixed
//! long before the round; the slot hash is the first produced slot at or
//! after the target, read from `SlotHashes`, so it is fixed by the chain
//! and not by when this is sent. Once the target leaves the 512-slot
//! window the round can never reveal and only cancels at its deadline —
//! re-targeting would hand the seed holder a second draw.

use crate::constants::{ENTROPY_CHAIN_SEED, ENTROPY_VALUE_DOMAIN, ROUND_SEED};
use crate::errors::OrbitError;
use crate::events::EntropyRevealed;
use crate::oracle::entropy::{commit_of, entropy_value, find_slot_hash, SlotHashLookup};
use crate::state::{EntropyChain, Round, RoundState, ENTROPY_NONE};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct RevealEntropy<'info> {
    #[account(
        seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()],
        bump = round.bump
    )]
    pub round: Account<'info, Round>,
    #[account(mut, seeds = [ENTROPY_CHAIN_SEED], bump = chain.bump)]
    pub chain: Account<'info, EntropyChain>,
    /// CHECK: address-constrained to the SlotHashes sysvar; parsed by hand
    /// (it is too large for `Sysvar` deserialization).
    #[account(address = anchor_lang::solana_program::sysvar::slot_hashes::ID)]
    pub slot_hashes: UncheckedAccount<'info>,
    pub authority: Signer<'info>,
}

pub fn process(ctx: Context<RevealEntropy>, seed: [u8; 32]) -> Result<()> {
    let round = &ctx.accounts.round;
    let chain = &mut ctx.accounts.chain;
    require!(
        round.state == RoundState::AwaitingRandomness
            && round.randomness_account == chain.key()
            && chain.pending_round == round.round_id,
        OrbitError::EntropyNotPending
    );
    require!(commit_of(&seed) == chain.commit, OrbitError::EntropySeedMismatch);

    let (slot, slot_hash) = {
        let data = ctx.accounts.slot_hashes.try_borrow_data()?;
        find_slot_hash(&data, chain.target_slot).map_err(|e| match e {
            SlotHashLookup::NotReached => error!(OrbitError::EntropyTargetNotReached),
            SlotHashLookup::Expired => error!(OrbitError::EntropyTargetExpired),
            SlotHashLookup::Malformed => error!(OrbitError::RandomnessMalformed),
        })?
    };
    let value = entropy_value(ENTROPY_VALUE_DOMAIN, round.round_id, &slot_hash, &seed);

    chain.commit = seed; // the next link is now locked in
    chain.remaining = chain
        .remaining
        .checked_sub(1)
        .ok_or(OrbitError::EntropyChainExhausted)?;
    chain.pending_round = ENTROPY_NONE;
    chain.value = value;
    chain.value_round = round.round_id;
    chain.value_slot = slot;
    chain.revealed_count = chain.revealed_count.saturating_add(1);

    emit!(EntropyRevealed {
        round_id: round.round_id,
        seed,
        slot,
        slot_hash,
        value,
    });
    Ok(())
}
