//! `withdraw_escrow` — the escrow's fund-exit path (Phase 10 design §3.5).
//!
//! **No `config` account and no pause gate, deliberately.** The protocol's
//! existing rule is that pause blocks `deposit` and `open_round` only,
//! never fund exits; a player's exit must carry the fewest possible
//! dependencies and the greatest possible liveness. That is also why the
//! handler does not recompute `rounds_remaining` — that would need
//! `config` for `round_cost`. The stored budget becomes optimistic,
//! costing at most one failed `crank_auto_deposit`, which both the
//! keeper's off-chain predicate and the on-chain
//! `spendable >= round_cost` guard catch.
//!
//! The escrow is never closed in v1: a closed escrow that later received
//! a prize via `add_lamports` would be a System-owned, dataless PDA
//! holding lamports nobody can ever sign for — permanently stranded.
//! Withdrawal drains to the rent floor and the account stays alive.

use crate::constants::ESCROW_SEED;
use crate::errors::OrbitError;
use crate::events::EscrowWithdrawn;
use crate::invariants::{assert_escrow_rent_exempt, escrow_spendable};
use crate::state::PlayerEscrow;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct WithdrawEscrow<'info> {
    #[account(
        mut,
        seeds = [ESCROW_SEED, owner.key().as_ref()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, PlayerEscrow>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn process(ctx: Context<WithdrawEscrow>, amount: u64) -> Result<()> {
    require!(amount > 0, OrbitError::NothingToWithdraw);

    let escrow_len = PlayerEscrow::INIT_SPACE
        .checked_add(8)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    let rent_min = ctx.accounts.rent.minimum_balance(escrow_len);
    require!(
        escrow_spendable(ctx.accounts.escrow.get_lamports(), rent_min) >= amount,
        OrbitError::EscrowInsufficientBalance
    );

    // Program-owned escrow → owner by direct lamport arithmetic (a System
    // CPI cannot debit a non-System-owned account). The spendable check
    // above guarantees the rent floor is never crossed.
    ctx.accounts.escrow.sub_lamports(amount)?;
    ctx.accounts.owner.add_lamports(amount)?;

    assert_escrow_rent_exempt(ctx.accounts.escrow.get_lamports(), rent_min)?;

    emit!(EscrowWithdrawn {
        owner: ctx.accounts.owner.key(),
        escrow: ctx.accounts.escrow.key(),
        amount,
        remaining: ctx.accounts.escrow.get_lamports(),
    });
    Ok(())
}
