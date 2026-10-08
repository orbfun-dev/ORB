//! `set_entropy_chain` — admin: create the `EntropyChain` singleton or
//! rotate it to a fresh hash chain (randomness fallback, option F).
//!
//! Allowed only while no round is in flight on the chain and no revealed
//! value is waiting to settle, so a rotation can never touch a round whose
//! target slot hash or value already exists. Rotating between rounds gives
//! the admin nothing: the next round's target hash is still unknown.

use crate::constants::{CONFIG_SEED, ENTROPY_CHAIN_SEED};
use crate::errors::OrbitError;
use crate::events::EntropyChainSet;
use crate::state::{EntropyChain, GlobalConfig, ENTROPY_NONE};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SetEntropyChain<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + EntropyChain::INIT_SPACE,
        seeds = [ENTROPY_CHAIN_SEED],
        bump
    )]
    pub chain: Account<'info, EntropyChain>,
    #[account(mut, constraint = admin.key() == config.admin @ OrbitError::UnauthorizedAdmin)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn process(ctx: Context<SetEntropyChain>, commit: [u8; 32], length: u64) -> Result<()> {
    require!(
        commit != [0u8; 32] && length > 0,
        OrbitError::InvalidEntropyCommit
    );
    let chain = &mut ctx.accounts.chain;
    // A canonical bump is never 0 in practice, so 0 marks a fresh account
    // (all fields zeroed by `init_if_needed`, where 0 is a real round id).
    let fresh = chain.bump == 0;
    if !fresh {
        require!(
            chain.pending_round == ENTROPY_NONE && chain.value_round == ENTROPY_NONE,
            OrbitError::EntropyChainBusy
        );
    }
    chain.commit = commit;
    chain.remaining = length;
    chain.pending_round = ENTROPY_NONE;
    chain.value_round = ENTROPY_NONE;
    chain.target_slot = 0;
    chain.request_slot = 0;
    chain.value = [0u8; 32];
    chain.value_slot = 0;
    chain.bump = ctx.bumps.chain;
    emit!(EntropyChainSet {
        admin: ctx.accounts.admin.key(),
        commit,
        remaining: length,
    });
    Ok(())
}
