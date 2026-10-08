//! `drain_mega_pot_v1_preflight` — the ADR-11 preflight drain.
//!
//! Why this exists: under the v1 config (award 9 000, field 0, cap 0) a pop
//! pays `floor(accrued × 0.9)` and RETAINS the residual, and every settle
//! adds the round's own `mega_cut` before the trigger arithmetic — so
//! `accrued_lamports` can never reach exactly 0 from a non-zero value
//! (the integer fixed point sticks at ≥ 1 lamport, and the odds are frozen
//! at 1-in-6 767 by ADR-10). Guard 2 of `migrate_economics_v2` demands
//! exactly 0. This instruction is the honest resolution: it pays the whole
//! pot out to the protocol's own fee sink — the treasury, where it stays
//! behind the separate `treasury_authority` gate — so the latch's drain
//! precondition is satisfied by real bookkeeping, never by override.
//!
//! One-shot by construction: the handler refuses once
//! `economics_version >= 2`, so the path dies with the migration it
//! enables. No state layout changes (GlobalConfig 340 / Round 302).
//!
//! Bookkeeping keeps I3+I4 and I2+I5 exact: the payout is booked on the
//! pot side as `lifetime_awarded` (value left the pot; `trigger_count` is
//! untouched — this is not a trigger and the 1-in-N statistics stay
//! honest) and on the treasury side as both `accrued_lamports` and
//! `lifetime_accrued`.

use crate::constants::{CONFIG_SEED, MEGA_POT_SEED, TREASURY_SEED};
use crate::errors::OrbitError;
use crate::events::MegaPotDrainedPreflight;
use crate::invariants::{assert_mega_pot_consistent, assert_treasury_consistent};
use crate::state::{GlobalConfig, MegaPotVault, TreasuryVault};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct DrainMegaPotV1Preflight<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(mut, seeds = [MEGA_POT_SEED], bump = mega_pot.bump)]
    pub mega_pot: Account<'info, MegaPotVault>,
    #[account(mut, seeds = [TREASURY_SEED], bump = treasury.bump)]
    pub treasury: Account<'info, TreasuryVault>,
    #[account(constraint = admin.key() == config.admin @ OrbitError::UnauthorizedAdmin)]
    pub admin: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn process(ctx: Context<DrainMegaPotV1Preflight>) -> Result<()> {
    let config = &ctx.accounts.config;
    // 1 — preflight only: once the latch has closed, this path is gone
    // forever (the same refusal the migration itself would give).
    require!(
        config.economics_version < 2,
        OrbitError::EconomicsAlreadyMigrated
    );
    // 2 — the quiescence condition `open_round` and `migrate_economics_v2`
    // both read: no opened-but-unclosed round may straddle the drain.
    require_eq!(
        config.active_round_id,
        config.next_round_id,
        OrbitError::RoundInFlight
    );
    // 3 — there must be something to drain; a silent no-op would mask a
    // wrong-pot mistake at cutover time.
    let amount = ctx.accounts.mega_pot.accrued_lamports;
    require!(amount > 0, OrbitError::MegaPotAlreadyDrained);

    // ── balance moves ──
    ctx.accounts.mega_pot.sub_lamports(amount)?;
    ctx.accounts.treasury.add_lamports(amount)?;

    // ── bookkeeping: the pot's books (I3+I4) and the treasury's (I2+I5) ──
    let mega_pot = &mut ctx.accounts.mega_pot;
    mega_pot.accrued_lamports = 0;
    mega_pot.lifetime_awarded = mega_pot
        .lifetime_awarded
        .checked_add(amount)
        .ok_or(OrbitError::ArithmeticOverflow)?;

    let treasury = &mut ctx.accounts.treasury;
    treasury.accrued_lamports = treasury
        .accrued_lamports
        .checked_add(amount)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    treasury.lifetime_accrued = treasury
        .lifetime_accrued
        .checked_add(amount)
        .ok_or(OrbitError::ArithmeticOverflow)?;

    emit!(MegaPotDrainedPreflight {
        amount,
        destination_treasury: ctx.accounts.treasury.key(),
        mega_pot_accrued_after: mega_pot.accrued_lamports,
    });

    // ── invariant tails: both vaults balance against their books ──
    let mega_len = MegaPotVault::INIT_SPACE
        .checked_add(8)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    let treasury_len = TreasuryVault::INIT_SPACE
        .checked_add(8)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    let rent = &ctx.accounts.rent;
    assert_mega_pot_consistent(
        ctx.accounts.mega_pot.get_lamports(),
        rent.minimum_balance(mega_len),
        ctx.accounts.mega_pot.accrued_lamports,
        ctx.accounts.mega_pot.lifetime_contributed,
        ctx.accounts.mega_pot.lifetime_awarded,
    )?;
    assert_treasury_consistent(
        ctx.accounts.treasury.get_lamports(),
        rent.minimum_balance(treasury_len),
        ctx.accounts.treasury.accrued_lamports,
        ctx.accounts.treasury.lifetime_accrued,
        ctx.accounts.treasury.lifetime_swept,
    )?;
    Ok(())
}
