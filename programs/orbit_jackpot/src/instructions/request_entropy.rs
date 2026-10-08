//! `request_entropy` — pin a Locked round to the entropy chain (randomness
//! fallback, option F). The entropy counterpart of `request_randomness`.
//!
//! Permissionless. The caller supplies nothing that affects the outcome:
//! the target slot is fixed here, `ENTROPY_TARGET_DELAY_SLOTS` ahead, and
//! the seed is already committed on chain. Same write-once pin and the
//! same `Locked → AwaitingRandomness` edge as the Switchboard path.

use crate::constants::{CONFIG_SEED, ENTROPY_CHAIN_SEED, ENTROPY_TARGET_DELAY_SLOTS, ROUND_SEED};
use crate::errors::OrbitError;
use crate::events::RandomnessRequested;
use crate::state::{EntropyChain, GlobalConfig, OracleProvider, Round, RoundState, ENTROPY_NONE};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct RequestEntropy<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(
        mut,
        seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()],
        bump = round.bump
    )]
    pub round: Account<'info, Round>,
    #[account(mut, seeds = [ENTROPY_CHAIN_SEED], bump = chain.bump)]
    pub chain: Account<'info, EntropyChain>,
    /// Permissionless crank caller; plays no role in the outcome (I13).
    pub authority: Signer<'info>,
}

pub fn process(ctx: Context<RequestEntropy>) -> Result<()> {
    require!(
        ctx.accounts.config.oracle_provider == OracleProvider::Entropy,
        OrbitError::OracleProviderMismatch
    );
    let round = &mut ctx.accounts.round;
    require!(
        round.randomness_account == Pubkey::default(),
        OrbitError::RandomnessAlreadyPinned
    );
    require!(round.state == RoundState::Locked, OrbitError::RoundNotLocked);

    let chain = &mut ctx.accounts.chain;
    require!(
        chain.pending_round == ENTROPY_NONE && chain.value_round == ENTROPY_NONE,
        OrbitError::EntropyChainBusy
    );
    require!(chain.remaining > 0, OrbitError::EntropyChainExhausted);

    let slot = Clock::get()?.slot;
    let target = slot
        .checked_add(ENTROPY_TARGET_DELAY_SLOTS)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    // Freshness belt (ADR-4 check 3): the target is strictly after the lock,
    // so its hash did not exist while deposits were open.
    require!(target > round.lock_slot, OrbitError::StaleRandomness);

    chain.pending_round = round.round_id;
    chain.target_slot = target;
    chain.request_slot = slot;

    RoundState::try_transition(round.state, RoundState::AwaitingRandomness)?;
    round.state = RoundState::AwaitingRandomness;
    round.randomness_account = chain.key();
    round.randomness_commit_slot = slot;

    emit!(RandomnessRequested {
        round_id: round.round_id,
        randomness_account: round.randomness_account,
        commit_slot: slot,
    });
    Ok(())
}
