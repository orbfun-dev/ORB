//! `sweep_unclaimed_prize` — lapsed-prize recovery (roadmap task 4.7,
//! R4-isolated in Phase 11.4).
//!
//! Permissionless. After `settle_ts + claim_deadline_secs` (suggested 30
//! days), an unclaimed prize moves to the **Mega-Pot** — value stays in the
//! game rather than becoming protocol revenue, which is both better optics
//! and a weaker incentive for the operator to hope for non-claims. Mitigated
//! upstream anyway: `claim_winnings` is permissionless and pays
//! `entry.player`, so any keeper can claim *for* an absent winner.
//!
//! **R4 — sweep isolation.** The sweep takes exactly the winner's
//! `winner_payout + mega_awarded` and *decrements* `vault_owed` by that
//! amount. Player refunds are principal: they have no deadline, no expiry,
//! and no sweep path — leaving the old `amount = vault_owed; vault_owed = 0`
//! behaviour in place would confiscate every loser's 89% the moment a prize
//! lapsed.

use crate::constants::{CONFIG_SEED, MEGA_POT_SEED, ROUND_SEED, ROUND_VAULT_SEED};
use crate::errors::OrbitError;
use crate::events::UnclaimedPrizeSwept;
use crate::invariants::{assert_mega_pot_consistent, assert_round_vault_solvent};
use crate::state::{GlobalConfig, MegaPotVault, Round, RoundState, RoundVault};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SweepUnclaimedPrize<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
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
    #[account(mut, seeds = [MEGA_POT_SEED], bump = mega_pot.bump)]
    pub mega_pot: Account<'info, MegaPotVault>,
    /// Permissionless crank caller; plays no role in the outcome (I13).
    pub authority: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn process(ctx: Context<SweepUnclaimedPrize>) -> Result<()> {
    let round = &mut ctx.accounts.round;
    require!(
        round.state == RoundState::Settled,
        OrbitError::RoundNotSettled
    );
    require!(!round.prize_claimed, OrbitError::PrizeAlreadyClaimed);
    let now = Clock::get()?.unix_timestamp;
    let deadline = round
        .settle_ts
        .checked_add(ctx.accounts.config.claim_deadline_secs)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    require!(now > deadline, OrbitError::ClaimDeadlineNotElapsed);

    // R4: exactly the winner's prize — never the field's refund pool, which
    // stays owed to the players and keeps its `close_entry` path forever.
    let amount = round
        .winner_payout
        .checked_add(round.mega_awarded)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    ctx.accounts.round_vault.sub_lamports(amount)?;
    ctx.accounts.mega_pot.add_lamports(amount)?;

    // Bookkeeping keeps I4 intact: this is a *contribution* to the pot.
    let mega_pot = &mut ctx.accounts.mega_pot;
    mega_pot.accrued_lamports = mega_pot
        .accrued_lamports
        .checked_add(amount)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    mega_pot.lifetime_contributed = mega_pot
        .lifetime_contributed
        .checked_add(amount)
        .ok_or(OrbitError::ArithmeticOverflow)?;

    round.prize_claimed = true;
    // Decrement, never zero: the vault still owes the field its pools (I1
    // below asserts against the remainder).
    round.vault_owed = round
        .vault_owed
        .checked_sub(amount)
        .ok_or(OrbitError::RoundVaultInvariant)?;

    emit!(UnclaimedPrizeSwept {
        round_id: round.round_id,
        amount,
        mega_pot_accrued_after: mega_pot.accrued_lamports,
    });

    // I1: vault drained to its rent floor; I3 + I4: pot books balanced.
    let vault_len = RoundVault::INIT_SPACE
        .checked_add(8)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    let mega_len = MegaPotVault::INIT_SPACE
        .checked_add(8)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    let rent = &ctx.accounts.rent;
    assert_round_vault_solvent(
        ctx.accounts.round_vault.get_lamports(),
        rent.minimum_balance(vault_len),
        round.vault_owed,
    )?;
    assert_mega_pot_consistent(
        ctx.accounts.mega_pot.get_lamports(),
        rent.minimum_balance(mega_len),
        ctx.accounts.mega_pot.accrued_lamports,
        ctx.accounts.mega_pot.lifetime_contributed,
        ctx.accounts.mega_pot.lifetime_awarded,
    )?;
    Ok(())
}
