//! `migrate_economics_v3` — one-way latch to the "winner's stake is never
//! raked" settlement (2026-10-08; see `math::split_round_pot_v3`).
//!
//! Nothing economic is re-tuned: every bps stays exactly as v2 set it
//! (ADR-10's immutability holds). What changes is the BASE the rake is
//! charged on — the losers' money instead of the whole pot — which v2's
//! settlement could not compute because it never knew the winner. From
//! this version on, `fulfill_settle` requires the winning entry.
//!
//! Safe with rounds in flight: refunds and claims are untouched, a round
//! settled before the latch keeps its stored v2 split, and a round settled
//! after it only pays its winner more and the house less.

use crate::constants::CONFIG_SEED;
use crate::errors::OrbitError;
use crate::events::EconomicsMigrated;
use crate::state::GlobalConfig;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct MigrateEconomicsV3<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(constraint = admin.key() == config.admin @ OrbitError::UnauthorizedAdmin)]
    pub admin: Signer<'info>,
}

pub fn process(ctx: Context<MigrateEconomicsV3>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require_eq!(config.economics_version, 2, OrbitError::EconomicsVersionMismatch);
    let from_version = config.economics_version;
    config.economics_version = 3;
    emit!(EconomicsMigrated {
        from_version,
        to_version: config.economics_version,
        winner_bps: config.winner_bps,
        refund_bps: config.refund_bps,
        fee_bps_admin: config.fee_bps_admin,
        fee_bps_mega: config.fee_bps_mega,
        mega_award_bps: config.mega_award_bps,
        mega_field_bps: config.mega_field_bps,
        mega_trigger_modulus: config.mega_trigger_modulus,
        mega_payout_cap_bps: config.mega_payout_cap_bps,
        account_open_fee_lamports: config.account_open_fee_lamports,
    });
    Ok(())
}
