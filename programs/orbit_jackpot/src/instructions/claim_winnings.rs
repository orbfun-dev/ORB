//! `claim_winnings` — the O(1) membership proof (roadmap task 3.9).
//!
//! Permissionless: anyone can submit the winning entry, and the payout
//! always goes to `entry.player`, never to the caller (ADR-2, I13). The
//! proof is the range check — because the entries' half-open ranges provably
//! partition `[0, total)` (I9), exactly one entry on earth satisfies
//! `ticket_start <= winning_ticket < ticket_end`, so the check is complete
//! and no winner signature is required.
//!
//! The prize is `winner_payout + mega_awarded` — under Phase 11 economics
//! the 9% winner slice plus the winner's share of a triggered Mega-Pot
//! (it was the 98% residual before Phase 11; the shape is unchanged). The
//! Mega award was snapshotted into `round_vault` at settle time (ADR-8),
//! so the claim debits exactly one vault — a concurrently-settling round
//! cannot change this payout. `vault_owed` drops by exactly the prize: the
//! refund and field pools are untouched here and stay claimable through
//! `close_entry` (a lapsed prize is R4-isolated, never the field's money).

use crate::constants::{ENTRY_SEED, ROUND_SEED, ROUND_VAULT_SEED};
use crate::errors::OrbitError;
use crate::events::PrizeClaimed;
use crate::invariants::assert_round_vault_solvent;
use crate::math::{range_contains, TicketRange};
use crate::state::{PlayerEntry, Round, RoundState, RoundVault};
use anchor_lang::prelude::*;

#[event_cpi]
#[derive(Accounts)]
#[instruction(entry_index: u32)]
pub struct ClaimWinnings<'info> {
    #[account(
        mut,
        seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()],
        bump = round.bump
    )]
    pub round: Account<'info, Round>,
    #[account(
        mut,
        seeds = [ROUND_VAULT_SEED, round.round_id.to_le_bytes().as_ref()],
        bump = round.vault_bump
    )]
    pub round_vault: Account<'info, RoundVault>,
    /// The entry claiming to contain the winning ticket, pinned by seeds to
    /// `(round.round_id, entry_index)` — an entry from another round or
    /// index cannot be presented. Retained after the claim (the roadmap's
    /// `close_entry` reclaims its rent later; it refuses to close the winning
    /// entry before the prize is claimed, which is exactly why claim must
    /// not consume it).
    #[account(
        seeds = [
            ENTRY_SEED,
            round.round_id.to_le_bytes().as_ref(),
            entry_index.to_le_bytes().as_ref()
        ],
        bump = entry.bump
    )]
    pub entry: Account<'info, PlayerEntry>,
    /// CHECK: the sole legitimate destination — enforced to equal
    /// `entry.player` so the payout cannot be diverted.
    #[account(mut, constraint = player.key() == entry.player @ OrbitError::RefundDestinationMismatch)]
    pub player: AccountInfo<'info>,
    /// Permissionless submitter; receives nothing (I13).
    pub authority: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn process(ctx: Context<ClaimWinnings>, entry_index: u32) -> Result<()> {
    let round = &mut ctx.accounts.round;
    require!(
        round.state == RoundState::Settled,
        OrbitError::RoundNotSettled
    );
    require!(!round.prize_claimed, OrbitError::PrizeAlreadyClaimed);
    // Belt over the seed pin: this entry belongs to this round.
    require_eq!(
        ctx.accounts.entry.round_id,
        round.round_id,
        OrbitError::EntryRoundMismatch
    );
    require_eq!(
        ctx.accounts.entry.entry_index,
        entry_index,
        OrbitError::EntryRoundMismatch
    );

    // The membership proof (ADR-2 + I9): half-open containment.
    let ticket_range = TicketRange {
        start: ctx.accounts.entry.ticket_start,
        end: ctx.accounts.entry.ticket_end,
    };
    require!(
        range_contains(&ticket_range, round.winning_ticket),
        OrbitError::EntryNotWinning
    );

    // Winner slice + snapshotted Mega award, all from the round vault.
    // Strictly the winner's money: the refund and field pools stay owed.
    let prize = round
        .winner_payout
        .checked_add(round.mega_awarded)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    ctx.accounts.round_vault.sub_lamports(prize)?;
    ctx.accounts.player.add_lamports(prize)?;

    // The winner is established here, not at settle (§8 item 13): indexers
    // read `winning_ticket`; `winner` is zero until this proof runs.
    round.winner = ctx.accounts.entry.player;
    round.prize_claimed = true;
    round.vault_owed = round
        .vault_owed
        .checked_sub(prize)
        .ok_or(OrbitError::RoundVaultInvariant)?;

    emit_cpi!(PrizeClaimed {
        round_id: round.round_id,
        entry_index,
        winner: round.winner,
        winning_ticket: round.winning_ticket,
        winner_payout: round.winner_payout,
        mega_awarded: round.mega_awarded,
    });

    // I1 — the vault still owes the field its pools; the invariant holds
    // against them, not against zero.
    let vault_len = RoundVault::INIT_SPACE
        .checked_add(8)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    let rent_min = ctx.accounts.rent.minimum_balance(vault_len);
    assert_round_vault_solvent(
        ctx.accounts.round_vault.get_lamports(),
        rent_min,
        round.vault_owed,
    )?;
    Ok(())
}
