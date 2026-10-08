//! `close_round` — final round teardown (roadmap task 4.8, Phase 11.4).
//!
//! Permissionless, once the round is fully pruned: `entries_closed ==
//! entry_count` and the vault owes nothing but rounding dust. The two
//! pro-rata pools (`refund_pool`, `mega_field_pool`) can each strand at
//! most one lamport per entry — the sum-of-floors deficit — so once every
//! entry has drawn its share, the residual `vault_owed` is bounded by
//! `2 × entry_count` (I22). Anything larger is an accounting bug, not
//! dust, and fails loudly here rather than silently donating player money
//! to the pot; the legitimate dust sweeps to the Mega-Pot (`RoundDustSwept`)
//! — never to the treasury. A `Cancelled` round arrives with
//! `vault_owed == 0` (`refund_entry` pays exact amounts), so the sweep is
//! a no-op there.
//!
//! Then the `RoundVault` and `Round` close, reclaiming both rents to
//! `round.rent_reclaim_destination(config.admin)` — whoever funded the
//! pair at `open_round` (the crank, typically), falling back to
//! `config.admin` for rounds opened before Phase 12, whose `rent_payer`
//! reads as the all-zero legacy sentinel. The crank caller receives
//! nothing beyond that (I13).

use crate::constants::{CONFIG_SEED, MEGA_POT_SEED, ROUND_SEED, ROUND_VAULT_SEED};
use crate::errors::OrbitError;
use crate::events::RoundDustSwept;
use crate::invariants::{assert_dust_within_bounds, assert_mega_pot_consistent};
use crate::state::{GlobalConfig, MegaPotVault, Round, RoundState, RoundVault};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct CloseRound<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(
        mut,
        seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()],
        bump = round.bump,
        close = destination
    )]
    pub round: Account<'info, Round>,
    #[account(
        mut,
        seeds = [ROUND_VAULT_SEED, round.round_id.to_le_bytes().as_ref()],
        bump = round.vault_bump,
        close = destination
    )]
    pub round_vault: Account<'info, RoundVault>,
    /// Dust sink: the one residual destination that keeps stranded lamports
    /// inside the game.
    #[account(mut, seeds = [MEGA_POT_SEED], bump = mega_pot.bump)]
    pub mega_pot: Account<'info, MegaPotVault>,
    /// CHECK: deterministic reclaim destination — the account that funded
    /// this round's rent at `open_round`, or `config.admin` for rounds
    /// opened before Phase 12. Constrained, so a crank cannot redirect it.
    #[account(
        mut,
        constraint = destination.key() == round.rent_reclaim_destination(config.admin)
            @ OrbitError::UnauthorizedAdmin
    )]
    pub destination: AccountInfo<'info>,
    /// Permissionless crank caller; receives nothing (I13).
    pub authority: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn process(ctx: Context<CloseRound>) -> Result<()> {
    let round = &mut ctx.accounts.round;
    // Only a terminal round can be fully drained and pruned.
    require!(
        matches!(round.state, RoundState::Settled | RoundState::Cancelled),
        OrbitError::IllegalStateTransition
    );
    require!(
        round.entries_closed == round.entry_count,
        OrbitError::EntriesNotClosed
    );
    // AUDIT P-4: the round PDA is the randomness account's only authority;
    // deleting it first would strand the Switchboard rent for good.
    // `close_randomness` clears the pin (a round cancelled at lock never set it).
    require!(
        round.randomness_account == Pubkey::default(),
        OrbitError::RandomnessNotClosed
    );

    // ── the dust sweep (I22): one lamport per entry from each of the two
    // pro-rata pools is rounding; more than that is a bug and must fail
    // loudly instead of silently donating player money to the pot. ──
    let dust = round.vault_owed;
    assert_dust_within_bounds(dust, round.entry_count)?;
    if dust > 0 {
        ctx.accounts.round_vault.sub_lamports(dust)?;
        ctx.accounts.mega_pot.add_lamports(dust)?;
        // A dust sweep books as a *contribution*: I3 + I4 stay intact.
        let mega_pot = &mut ctx.accounts.mega_pot;
        mega_pot.accrued_lamports = mega_pot
            .accrued_lamports
            .checked_add(dust)
            .ok_or(OrbitError::ArithmeticOverflow)?;
        mega_pot.lifetime_contributed = mega_pot
            .lifetime_contributed
            .checked_add(dust)
            .ok_or(OrbitError::ArithmeticOverflow)?;
        round.vault_owed = 0;
        emit!(RoundDustSwept {
            round_id: round.round_id,
            amount: dust,
            mega_pot_accrued_after: ctx.accounts.mega_pot.accrued_lamports,
        });
    }
    require!(round.vault_owed == 0, OrbitError::VaultNotDrained);

    // I3 + I4 after the (possible) dust credit.
    let mega_len = MegaPotVault::INIT_SPACE
        .checked_add(8)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    assert_mega_pot_consistent(
        ctx.accounts.mega_pot.get_lamports(),
        ctx.accounts.rent.minimum_balance(mega_len),
        ctx.accounts.mega_pot.accrued_lamports,
        ctx.accounts.mega_pot.lifetime_contributed,
        ctx.accounts.mega_pot.lifetime_awarded,
    )?;

    // If this was the newest round, retire the active pointer so the next
    // `open_round` knows there is no predecessor left to present (its
    // account is about to be deleted). Closing an *older* round leaves the
    // pointer on the newest round untouched.
    let config = &mut ctx.accounts.config;
    let newest = round
        .round_id
        .checked_add(1)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    if config.next_round_id == newest {
        config.active_round_id = config.next_round_id;
    }
    // Anchor's `close` on both accounts returns their rent to `destination`
    // at instruction exit; nothing else moves. The constraint already pinned
    // `destination` to the round's recorded rent payer (or the admin
    // fallback), so the reclaim is reciprocal by construction.
    Ok(())
}
