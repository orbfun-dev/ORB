//! `open_round` — permissionless round creation (roadmap task 3.3).
//!
//! Mints the `Round` and `RoundVault` pair at `next_round_id`. Allowed as
//! soon as the previous round is no longer `Open`, so round *N+1* accepts
//! deposits while *N* is still settling — oracle latency never pauses the
//! game, while "at most one `Open` round" still holds trivially.
//!
//! Phase 12: the caller funds both rent-exemptions, and `rent_payer`
//! records who that was so `close_round` can hand the capital back —
//! without it, every round was an unreciprocated 4 113 360-lamport
//! transfer from the keeper to the admin.

use crate::constants::{CONFIG_SEED, ROUND_SEED, ROUND_VAULT_SEED};
use crate::errors::OrbitError;
use crate::events::RoundOpened;
use crate::invariants::assert_round_vault_solvent;
use crate::state::{GlobalConfig, Round, RoundState, RoundVault};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct OpenRound<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(
        init,
        seeds = [ROUND_SEED, config.next_round_id.to_le_bytes().as_ref()],
        bump,
        payer = payer,
        space = 8 + Round::INIT_SPACE
    )]
    pub round: Account<'info, Round>,
    #[account(
        init,
        seeds = [ROUND_VAULT_SEED, config.next_round_id.to_le_bytes().as_ref()],
        bump,
        payer = payer,
        space = 8 + RoundVault::INIT_SPACE
    )]
    pub round_vault: Account<'info, RoundVault>,
    /// Permissionless crank caller; plays no role in the outcome (I13).
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
    /// The active round, when any round has ever been opened. Deliberately
    /// the LAST field: anchor assigns accounts sequentially, so an
    /// `Option<Account>` is only omissible at the tail — clients simply stop
    /// the account list here for the very first round. It cannot carry a
    /// seed constraint (the account legitimately does not exist yet), so it
    /// is bound to `config.active_round_id` in the handler — a program-owned
    /// `Account<Round>` cannot be forged off-PDA, and the round-id field
    /// check pins it to the exact round.
    ///
    /// CHECK: verified against `config.active_round_id` in `process`.
    pub previous_round: Option<Account<'info, Round>>,
}

pub fn process(ctx: Context<OpenRound>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(!config.paused, OrbitError::Paused);

    // At most one Open round: the newest opened-but-unclosed round must have
    // left the Open state. Failing to present it is fail-closed. (`active ==
    // next` means the newest round was fully closed — nothing to present.)
    let has_previous = config.active_round_id < config.next_round_id;
    match (&ctx.accounts.previous_round, has_previous) {
        (None, false) => {}
        (None, true) => return Err(OrbitError::RoundAlreadyOpen.into()),
        (Some(previous), true) => {
            require_eq!(
                previous.round_id,
                config.active_round_id,
                OrbitError::PreviousRoundMismatch
            );
            require!(
                previous.state != RoundState::Open,
                OrbitError::RoundAlreadyOpen
            );
        }
        (Some(_), false) => return Err(OrbitError::PreviousRoundMismatch.into()),
    }

    let round_id = config.next_round_id;
    let clock = Clock::get()?;
    let end_ts = clock
        .unix_timestamp
        .checked_add(config.round_duration_secs)
        .ok_or(OrbitError::ArithmeticOverflow)?;

    ctx.accounts.round.set_inner(Round {
        round_id,
        state: RoundState::Open,
        start_ts: clock.unix_timestamp,
        end_ts,
        lock_ts: 0,
        lock_slot: 0,
        settle_ts: 0,
        total_lamports: 0,
        entry_count: 0,
        entries_closed: 0,
        first_depositor: Pubkey::default(),
        single_depositor: false,
        randomness_account: Pubkey::default(),
        randomness_commit_slot: 0,
        randomness_seed_slot: 0,
        winning_ticket: 0,
        winner: Pubkey::default(),
        winner_payout: 0,
        admin_cut: 0,
        mega_cut: 0,
        mega_awarded: 0,
        vault_owed: 0,
        mega_triggered: false,
        prize_claimed: false,
        vault_bump: ctx.bumps.round_vault,
        bump: ctx.bumps.round,
        // Phase 11 pool accounting: a fresh round owes no refunds yet.
        refund_pool: 0,
        refunds_paid: 0,
        mega_field_pool: 0,
        mega_field_paid: 0,
        // Phase 12: rent reciprocity — remember who funded this round's
        // two rent-exemptions so `close_round` can reclaim to them.
        rent_payer: ctx.accounts.payer.key(),
    });

    config.active_round_id = round_id;
    config.next_round_id = round_id
        .checked_add(1)
        .ok_or(OrbitError::ArithmeticOverflow)?;

    emit!(RoundOpened {
        round_id,
        start_ts: clock.unix_timestamp,
        end_ts,
    });

    // I1 for the fresh vault: exactly its rent-exempt minimum, owing nothing.
    let vault_len = RoundVault::INIT_SPACE
        .checked_add(8)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    let rent_min = ctx.accounts.rent.minimum_balance(vault_len);
    assert_round_vault_solvent(
        ctx.accounts.round_vault.get_lamports(),
        rent_min,
        ctx.accounts.round.vault_owed,
    )?;
    Ok(())
}
