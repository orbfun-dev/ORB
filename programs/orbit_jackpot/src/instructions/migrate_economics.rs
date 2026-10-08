//! `migrate_economics_v2` — the one-shot economics cutover (ADR-11).
//!
//! `winner_bps`, `fee_bps_admin`, `fee_bps_mega`, `mega_award_bps` and
//! `mega_trigger_modulus` are immutable by construction (ADR-10) —
//! structurally absent from `UpdateConfigArgs`, so they cannot be
//! expressed, let alone accepted. There is therefore no path today to move
//! `winner_bps` from 9 800 to 900. This instruction is that path, and it
//! is a **one-way latch**: once `economics_version` reaches 2 it can never
//! run again, and `update_config` still cannot express any of these
//! fields (R7).
//!
//! The guards, in order, each with its own typed error:
//!
//! 1. `economics_version < 2` — the latch itself.
//! 2. `mega_pot.accrued_lamports == 0` — retuning the odds and the award
//!    while the pot holds lamports contributed under the old odds is the
//!    precise rug ADR-10 was built to prevent. Drain it first (settle a
//!    triggered round, or sweep to treasury). **Do not relax this.**
//! 3. `active_round_id == next_round_id` — no round may straddle the two
//!    rule sets; this is the same "no round is live" condition `open_round`
//!    uses (`active < next` means there is an opened-but-unclosed round).
//! 4. The four-way I14 sum consumes the denominator exactly.
//! 5. `mega_award_bps + mega_field_bps <= 10_000`.
//! 6. `mega_trigger_modulus >= 1`.
//! 7. `mega_payout_cap_bps > 0` — uncapped is legal only below version 2.
//! 8. `assert_mega_farm_safe` on the **effective** post-write values (I21).
//! 9. `account_open_fee_lamports <= MAX_ACCOUNT_OPEN_FEE_LAMPORTS`.
//!
//! Emits `EconomicsMigrated` with every before/after value, then sets
//! `economics_version = 2` last of all.

use crate::constants::{
    BPS_DENOMINATOR, CONFIG_SEED, MAX_ACCOUNT_OPEN_FEE_LAMPORTS, MEGA_POT_SEED,
};
use crate::errors::OrbitError;
use crate::events::EconomicsMigrated;
use crate::invariants::assert_mega_farm_safe;
use crate::state::{GlobalConfig, MegaPotVault};
use anchor_lang::prelude::*;

/// The v2 economics, written once by the latch. Every field is immutable
/// afterwards; `fee_bps_admin`/`fee_bps_mega` are NOT args (they stay at
/// their launch values — moving them was never part of the pivot).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct MigrateEconomicsV2Args {
    pub winner_bps: u16,
    pub refund_bps: u16,
    pub mega_award_bps: u16,
    pub mega_field_bps: u16,
    pub mega_trigger_modulus: u32,
    pub mega_payout_cap_bps: u32,
    pub account_open_fee_lamports: u64,
}

#[derive(Accounts)]
pub struct MigrateEconomicsV2<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    /// Read-only: the guard refuses to retune odds while the pot still
    /// holds lamports contributed under them (see guard 2).
    #[account(seeds = [MEGA_POT_SEED], bump = mega_pot.bump)]
    pub mega_pot: Account<'info, MegaPotVault>,
    #[account(constraint = admin.key() == config.admin @ OrbitError::UnauthorizedAdmin)]
    pub admin: Signer<'info>,
    /// Reserved by the cutover checklist for post-migration verification;
    /// the latch itself moves no lamports.
    pub rent: Sysvar<'info, Rent>,
}

pub fn process(ctx: Context<MigrateEconomicsV2>, args: MigrateEconomicsV2Args) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let from_version = config.economics_version;

    // 1 — the one-way latch.
    require!(
        config.economics_version < 2,
        OrbitError::EconomicsAlreadyMigrated
    );
    // 2 — the Mega-Pot must be drained before the odds it funded change.
    require!(
        ctx.accounts.mega_pot.accrued_lamports == 0,
        OrbitError::MegaPotNotDrained
    );
    // 3 — no round in flight: the newest opened-but-unclosed round must
    // have been fully closed (`open_round` reads this same condition).
    require_eq!(
        config.active_round_id,
        config.next_round_id,
        OrbitError::RoundInFlight
    );
    // 4 — I14, four-way form, on the effective post-write values.
    let bps_sum = u32::from(args.winner_bps)
        .checked_add(u32::from(args.refund_bps))
        .and_then(|sum| sum.checked_add(u32::from(config.fee_bps_admin)))
        .and_then(|sum| sum.checked_add(u32::from(config.fee_bps_mega)))
        .ok_or(OrbitError::ArithmeticOverflow)?;
    require_eq!(
        bps_sum,
        u32::from(BPS_DENOMINATOR),
        OrbitError::InvalidFeeSplit
    );
    // 5 — the pop never pays more than one whole pot.
    let mega_bps_sum = u32::from(args.mega_award_bps) + u32::from(args.mega_field_bps);
    require!(
        mega_bps_sum <= u32::from(BPS_DENOMINATOR),
        OrbitError::InvalidFeeSplit
    );
    // 6 — a zero modulus is a division-by-zero at settle.
    require!(
        args.mega_trigger_modulus >= 1,
        OrbitError::ZeroModulusConfig
    );
    // 7 — uncapped is the grandfathered pre-v2 behaviour only.
    require!(
        args.mega_payout_cap_bps > 0,
        OrbitError::MegaFarmGuardViolated
    );
    // 8 — I21 on the effective values (fees are the immutable config's).
    assert_mega_farm_safe(
        args.mega_payout_cap_bps,
        args.mega_trigger_modulus,
        config.fee_bps_admin,
        config.fee_bps_mega,
        args.mega_award_bps,
        args.mega_field_bps,
    )?;
    // 9 — the one admin-mutable new field, under its compile-time ceiling.
    require!(
        args.account_open_fee_lamports <= MAX_ACCOUNT_OPEN_FEE_LAMPORTS,
        OrbitError::AccountOpenFeeTooHigh
    );

    config.winner_bps = args.winner_bps;
    config.refund_bps = args.refund_bps;
    config.mega_award_bps = args.mega_award_bps;
    config.mega_field_bps = args.mega_field_bps;
    config.mega_trigger_modulus = args.mega_trigger_modulus;
    config.mega_payout_cap_bps = args.mega_payout_cap_bps;
    config.account_open_fee_lamports = args.account_open_fee_lamports;
    // Last of all: the latch closes behind the write.
    config.economics_version = 2;

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
