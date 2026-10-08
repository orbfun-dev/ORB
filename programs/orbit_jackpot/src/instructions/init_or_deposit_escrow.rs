//! `init_or_deposit_escrow` — fund an auto-deposit escrow, set its terms
//! (Phase 10 design §3.3; Phase 11.6: the account-open fee).
//!
//! One instruction for both birth and re-fund: the owner moves `amount` in
//! by a System-program CPI (their wallet account is System-owned, exactly
//! as in `deposit`) and declares `per_round_lamports` / `max_rounds` /
//! `auto_reinvest`. `amount == 0` is legal and means "change my terms
//! only".
//!
//! `init_if_needed` is safe **only because the seed contains the signer's
//! key**: a different signer derives a different PDA, so cross-owner
//! reinitialisation is structurally impossible. A brand-new account is
//! zeroed by the runtime, so freshness is detected as
//! `escrow.owner == Pubkey::default()` — the same detector `deposit` uses,
//! which is what makes the one-time `account_open_fee_lamports` exactly
//! once per wallet across BOTH creation paths (decision D1): the fee is
//! charged on the fresh branch only, by the shared
//! [`charge_account_open_fee`], so the two paths cannot drift.
//!
//! Re-funding **never resets `next_eligible_round_id`** — that would
//! re-open a round the escrow already played (I17). It also never
//! accumulates `rounds_remaining`: the budget is re-declared as
//! `max_rounds`, so the owner's intent is always the freshest terms.

use crate::constants::{CONFIG_SEED, ESCROW_SEED, MEGA_POT_SEED};
use crate::errors::OrbitError;
use crate::events::{AccountOpened, EscrowFunded};
use crate::invariants::{assert_escrow_rent_exempt, assert_mega_pot_consistent};
use crate::state::{GlobalConfig, MegaPotVault, PlayerEscrow};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct InitOrDepositEscrow<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(
        init_if_needed,
        seeds = [ESCROW_SEED, owner.key().as_ref()],
        bump,
        payer = owner,
        space = 8 + PlayerEscrow::INIT_SPACE
    )]
    pub escrow: Account<'info, PlayerEscrow>,
    /// Fee sink for the one-time profile charge (Phase 11.6, decision D1).
    #[account(mut, seeds = [MEGA_POT_SEED], bump = mega_pot.bump)]
    pub mega_pot: Account<'info, MegaPotVault>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

/// The one-time `account_open_fee_lamports` charge, shared verbatim by both
/// profile-creation paths (`init_or_deposit_escrow`, `deposit`) so the fee
/// is exactly-once per wallet by construction. Called ONLY on the
/// fresh-account branch (`escrow.owner == Pubkey::default()`).
///
/// The fee is charged **on top of** the escrow's rent, never netted out of
/// it: netting would make the player's effective cost depend on Solana's
/// rent schedule. The full fee seeds the Mega-Pot (I3 + I4 books updated),
/// and `AccountOpened` records fee and rent separately so the UI can show
/// "0.01 SOL to the jackpot — one-time" and "~0.00174 SOL account rent" as
/// two honest lines.
pub(crate) fn charge_account_open_fee<'info>(
    fee_lamports: u64,
    escrow_rent_lamports: u64,
    owner: &Signer<'info>,
    escrow: &Pubkey,
    mega_pot: &mut Account<'info, MegaPotVault>,
    system_program: &Program<'info, System>,
) -> Result<()> {
    if fee_lamports == 0 {
        return Ok(());
    }
    // Owner wallet (System-owned) → Mega-Pot PDA by System CPI: the sender
    // is System-owned and signs; crediting a program-owned recipient is
    // exactly the `deposit` stake move in reverse shape.
    let cpi_ctx = CpiContext::new(
        system_program.to_account_info(),
        anchor_lang::system_program::Transfer {
            from: owner.to_account_info(),
            to: mega_pot.to_account_info(),
        },
    );
    anchor_lang::system_program::transfer(cpi_ctx, fee_lamports)?;
    mega_pot.accrued_lamports = mega_pot
        .accrued_lamports
        .checked_add(fee_lamports)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    mega_pot.lifetime_contributed = mega_pot
        .lifetime_contributed
        .checked_add(fee_lamports)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    emit!(AccountOpened {
        owner: owner.key(),
        escrow: *escrow,
        fee_lamports,
        rent_lamports: escrow_rent_lamports,
        mega_pot_accrued_after: mega_pot.accrued_lamports,
    });
    Ok(())
}

pub fn process(
    ctx: Context<InitOrDepositEscrow>,
    amount: u64,
    per_round_lamports: u64,
    max_rounds: u32,
    auto_reinvest: bool,
) -> Result<()> {
    // A money-in path: gated like `deposit`, never like the fund exits.
    require!(!ctx.accounts.config.paused, OrbitError::Paused);
    require!(max_rounds > 0, OrbitError::InvalidEscrowTerms);
    require!(
        per_round_lamports >= ctx.accounts.config.min_deposit_lamports,
        OrbitError::InvalidEscrowTerms
    );

    let escrow_len = PlayerEscrow::INIT_SPACE
        .checked_add(8)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    let escrow_rent_min = ctx.accounts.rent.minimum_balance(escrow_len);

    if ctx.accounts.escrow.owner == Pubkey::default() {
        ctx.accounts.escrow.set_inner(PlayerEscrow {
            owner: ctx.accounts.owner.key(),
            per_round_lamports,
            max_rounds,
            rounds_remaining: max_rounds,
            next_eligible_round_id: 0,
            rounds_funded: 0,
            lifetime_deposited: amount,
            lifetime_staked: 0,
            auto_reinvest,
            bump: ctx.bumps.escrow,
            reserved: [0; 32],
        });
        // The one-time profile charge, fresh branch only (D1).
        charge_account_open_fee(
            ctx.accounts.config.account_open_fee_lamports,
            escrow_rent_min,
            &ctx.accounts.owner,
            &ctx.accounts.escrow.key(),
            &mut ctx.accounts.mega_pot,
            &ctx.accounts.system_program,
        )?;
    } else {
        // Belt over the seed: only the owner can reach this account at all,
        // but the check documents that ownership is load-bearing here.
        require_keys_eq!(
            ctx.accounts.escrow.owner,
            ctx.accounts.owner.key(),
            OrbitError::EscrowOwnerMismatch
        );
        let escrow = &mut ctx.accounts.escrow;
        escrow.per_round_lamports = per_round_lamports;
        escrow.max_rounds = max_rounds;
        escrow.auto_reinvest = auto_reinvest;
        escrow.rounds_remaining = max_rounds;
        escrow.lifetime_deposited = escrow
            .lifetime_deposited
            .checked_add(amount)
            .ok_or(OrbitError::ArithmeticOverflow)?;
        // `next_eligible_round_id` is deliberately untouched (I17): a
        // re-fund must not re-open a round the escrow already played.
    }

    if amount > 0 {
        // Owner wallet → escrow PDA by System CPI: the escrow is
        // program-owned, but the *sender* is System-owned, so the transfer
        // must go through the System program (same reasoning as `deposit`).
        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.owner.to_account_info(),
                to: ctx.accounts.escrow.to_account_info(),
            },
        );
        anchor_lang::system_program::transfer(cpi_ctx, amount)?;
    }

    // I16: the escrow sits at or above its rent floor.
    assert_escrow_rent_exempt(ctx.accounts.escrow.get_lamports(), escrow_rent_min)?;

    emit!(EscrowFunded {
        owner: ctx.accounts.owner.key(),
        escrow: ctx.accounts.escrow.key(),
        amount,
        per_round_lamports,
        max_rounds,
        rounds_remaining: ctx.accounts.escrow.rounds_remaining,
        auto_reinvest,
        total_lamports: ctx.accounts.escrow.get_lamports(),
    });

    // I3 + I4: the pot's books hold after the (possible) fee credit.
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
    Ok(())
}
