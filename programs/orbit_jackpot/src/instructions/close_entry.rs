//! `close_entry` — refund delivery + rent reclamation (roadmap task 4.6,
//! Phase 11.4).
//!
//! Permissionless cleanup of a `PlayerEntry` PDA from a **`Settled`** round
//! that now pays the player's money, not just the rent:
//!
//! - `refund_i = entry_share(amount, round.refund_pool, total_lamports)` —
//!   the pro-rata slice of the 89% pool (R2; never a re-derived percentage
//!   of the stake, which can overdraw the vault and lock the round).
//! - `field_i = entry_share(amount, round.mega_field_pool, total_lamports)`
//!   — the pro-rata slice of a triggered Mega-Pot's field share, `0` when
//!   the round did not trigger (a v1-config round reads both pools as 0 and
//!   this instruction degenerates to the old rent-only close, R6).
//! - the entry's rent, via Anchor's `close = player`.
//!
//! All three go to `entry.player`, never the caller (I13). Per Phase 10 R1
//! the minted entry's `player` **is the escrow PDA** for auto-deposit
//! players, so their refund lands in the escrow where `auto_reinvest` rolls
//! it into the next round; a direct depositor's `player` is their wallet.
//! **This permissionless close is also the manual claim** — a player can
//! call it themselves if the keeper is down; there is deliberately no
//! second code path to keep consistent.
//!
//! A refund is the player's principal: it has no deadline and no sweep path
//! (`sweep_unclaimed_prize` is R4-isolated to the winner's prize). In a
//! `Cancelled` round this instruction is refused outright — `refund_entry`
//! is the one sanctioned cleanup there (it pays the exact stake, closes the
//! entry and counts it); a rent-only close would destroy the player's
//! refund proof and trap the deposit forever.
//!
//! The winning entry cannot close while `!prize_claimed`: that would destroy
//! the membership proof before `claim_winnings` could use it. After a claim
//! — or after `sweep_unclaimed_prize` — closing it is allowed.
//!
//! No `config` account by design: the formula needs only `Round` fields,
//! and every extra shared account costs the keeper's batch width (11.8).

use crate::constants::{ENTRY_SEED, ROUND_SEED, ROUND_VAULT_SEED};
use crate::errors::OrbitError;
use crate::events::EntryRefundPaid;
use crate::invariants::{assert_pools_solvent, assert_round_vault_solvent};
use crate::math::{entry_share, range_contains, TicketRange};
use crate::state::{PlayerEntry, Round, RoundState, RoundVault};
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(entry_index: u32)]
pub struct CloseEntry<'info> {
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
    #[account(
        mut,
        seeds = [
            ENTRY_SEED,
            round.round_id.to_le_bytes().as_ref(),
            entry_index.to_le_bytes().as_ref()
        ],
        bump = entry.bump,
        close = player
    )]
    pub entry: Account<'info, PlayerEntry>,
    /// CHECK: the sole legitimate destination — enforced to equal
    /// `entry.player` so the refund and reclaimed rent cannot be diverted.
    #[account(mut, constraint = player.key() == entry.player @ OrbitError::RefundDestinationMismatch)]
    pub player: AccountInfo<'info>,
    /// Permissionless crank caller; receives nothing (I13).
    pub authority: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn process(ctx: Context<CloseEntry>, entry_index: u32) -> Result<()> {
    let round = &mut ctx.accounts.round;
    require!(
        round.state == RoundState::Settled,
        OrbitError::RoundNotSettled
    );
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

    // Refuse to destroy the winning membership proof before it is used.
    let ticket_range = TicketRange {
        start: ctx.accounts.entry.ticket_start,
        end: ctx.accounts.entry.ticket_end,
    };
    if range_contains(&ticket_range, round.winning_ticket) {
        require!(round.prize_claimed, OrbitError::WinningEntryNotClaimed);
    }

    // ── the player's pro-rata money (R2: pro-rata of the stored pools,
    // floored, through u128 — the only sanctioned formula) ──
    let amount = ctx.accounts.entry.amount;
    let player = ctx.accounts.entry.player;
    // A Settled round always has total_lamports > 0 (zero-deposit rounds
    // cancel at lock), so ZeroTotal here is a belt, not a live path.
    let refund =
        entry_share(amount, round.refund_pool, round.total_lamports).map_err(OrbitError::from)?;
    let field = entry_share(amount, round.mega_field_pool, round.total_lamports)
        .map_err(OrbitError::from)?;
    let payout = refund
        .checked_add(field)
        .ok_or(OrbitError::ArithmeticOverflow)?;

    // ── bookkeeping first (the refund_entry pattern): pools stay solvent
    // (I20), the vault stops owing exactly what is about to move (I1), and
    // each entry closes exactly once (I11 holds by construction — the
    // account no longer exists afterwards). ──
    round.refunds_paid = round
        .refunds_paid
        .checked_add(refund)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    round.mega_field_paid = round
        .mega_field_paid
        .checked_add(field)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    assert_pools_solvent(
        round.refund_pool,
        round.refunds_paid,
        round.mega_field_pool,
        round.mega_field_paid,
    )?;
    round.vault_owed = round
        .vault_owed
        .checked_sub(payout)
        .ok_or(OrbitError::RoundVaultInvariant)?;
    round.entries_closed = round
        .entries_closed
        .checked_add(1)
        .ok_or(OrbitError::ArithmeticOverflow)?;

    // ── the lamport move: program-owned vault → player by direct arithmetic
    // (a System CPI cannot debit a program-owned account). `vault_owed >=
    // payout` plus the pools' solvency guarantee the rent floor is never
    // crossed. ──
    if payout > 0 {
        ctx.accounts.round_vault.sub_lamports(payout)?;
        ctx.accounts.player.add_lamports(payout)?;
    }

    emit!(EntryRefundPaid {
        round_id: round.round_id,
        entry_index,
        player,
        amount,
        refund,
        mega_field: field,
    });

    // I1 after the payout: rent minimum + whatever is still owed. (The
    // entry's own rent returns via Anchor's `close = player` at exit.)
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
