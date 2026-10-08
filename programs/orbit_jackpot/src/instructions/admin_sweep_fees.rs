//! `admin_sweep_fees` — drain the treasury (roadmap task 3.10).
//!
//! Signer is the **treasury authority** (deliberately separate from `admin`
//! for ops hygiene, §5). Drains exactly `accrued_lamports` — the
//! rent-exempt minimum is structurally preserved, because the balance
//! invariant is `lamports == rent_min + accrued` and only `accrued` leaves.

use crate::constants::{CONFIG_SEED, TREASURY_SEED};
use crate::errors::OrbitError;
use crate::events::FeesSwept;
use crate::invariants::assert_treasury_consistent;
use crate::state::{GlobalConfig, TreasuryVault};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct AdminSweepFees<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(mut, seeds = [TREASURY_SEED], bump = treasury.bump)]
    pub treasury: Account<'info, TreasuryVault>,
    #[account(
        constraint = treasury_authority.key() == config.treasury_authority
            @ OrbitError::UnauthorizedTreasuryAuthority
    )]
    pub treasury_authority: Signer<'info>,
    /// CHECK: sweep destination wallet, chosen by the treasury authority.
    #[account(mut)]
    pub destination: AccountInfo<'info>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn process(ctx: Context<AdminSweepFees>) -> Result<()> {
    let amount = ctx.accounts.treasury.accrued_lamports;
    require!(amount > 0, OrbitError::NothingToSweep);

    ctx.accounts.treasury.sub_lamports(amount)?;
    ctx.accounts.destination.add_lamports(amount)?;
    ctx.accounts.treasury.lifetime_swept = ctx
        .accounts
        .treasury
        .lifetime_swept
        .checked_add(amount)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    ctx.accounts.treasury.accrued_lamports = 0;

    emit!(FeesSwept {
        amount,
        destination: ctx.accounts.destination.key(),
    });

    // I2 + I5 — balance matches bookkeeping; lifetime accrual minus sweeps
    // equals what is still sweepable (now zero).
    let treasury_len = TreasuryVault::INIT_SPACE
        .checked_add(8)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    let rent_min = ctx.accounts.rent.minimum_balance(treasury_len);
    assert_treasury_consistent(
        ctx.accounts.treasury.get_lamports(),
        rent_min,
        ctx.accounts.treasury.accrued_lamports,
        ctx.accounts.treasury.lifetime_accrued,
        ctx.accounts.treasury.lifetime_swept,
    )?;
    Ok(())
}
