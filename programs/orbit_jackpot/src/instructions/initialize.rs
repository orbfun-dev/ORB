//! `initialize` — one-time program setup (roadmap task 3.1).
//!
//! Creates the three singleton PDAs (`GlobalConfig`, `TreasuryVault`,
//! `MegaPotVault`). The immutable economics — the 900/8900/100/100 bps
//! four-way split, the 5000/4000 Mega award split, 1-in-625 odds and the
//! 80_000 bps payout cap — are hardcoded from `constants` (ADR-10), never
//! taken as arguments, so no caller can birth the program with mutable
//! odds. A fresh deployment starts at `economics_version: 2` and never
//! needs `migrate_economics_v2`. A second call cannot reach the handler at
//! all: anchor `init` refuses to run against an existing account.

use crate::constants::{
    BPS_DENOMINATOR, CONFIG_SEED, FEE_BPS_ADMIN, FEE_BPS_MEGA, MAX_ACCOUNT_OPEN_FEE_LAMPORTS,
    MAX_AUTO_DEPOSIT_TIP_LAMPORTS, MEGA_AWARD_BPS, MEGA_FIELD_BPS, MEGA_PAYOUT_CAP_BPS,
    MEGA_POT_SEED, MEGA_TRIGGER_MODULUS, REFUND_BPS, SLOT_HASHES_RETENTION_SLOTS, TREASURY_SEED,
    WINNER_BPS,
};
use crate::errors::OrbitError;
use crate::invariants::assert_mega_farm_safe;
use crate::state::{GlobalConfig, MegaPotVault, OracleProvider, TreasuryVault};
use anchor_lang::prelude::*;

/// Operational parameters. The immutable economics are deliberately absent
/// (see module docs); everything here stays admin-mutable via
/// `update_config` (Phase 3B).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct InitializeArgs {
    /// Fee-sweep destination authority; separate from `admin` for ops hygiene.
    pub treasury_authority: Pubkey,
    /// Pinned oracle program id; `fulfill_settle` will require the
    /// randomness account's owner to match it.
    pub oracle_program_id: Pubkey,
    /// Pinned Switchboard On-Demand queue; commits only ever run against it.
    pub oracle_queue: Pubkey,
    pub oracle_provider: OracleProvider,
    /// `0` = unlimited entries.
    pub max_entries_per_round: u32,
    pub round_duration_secs: i64,
    /// Hard ceiling on anti-snipe extension.
    pub max_round_duration_secs: i64,
    pub anti_snipe_window_secs: i64,
    pub anti_snipe_extension_secs: i64,
    /// After this, an unclaimed prize sweeps to the Mega-Pot.
    pub claim_deadline_secs: i64,
    /// Suggested 10_000_000 (0.01 SOL): an 8× margin over `PlayerEntry` rent.
    pub min_deposit_lamports: u64,
    /// Only deposits ≥ this extend the anti-snipe timer.
    pub anti_snipe_min_deposit_lamports: u64,
    /// Paid out of the 1% admin cut — never a fourth slice. Default 0.
    pub keeper_tip_lamports: u64,
    /// Must stay < 512 (`SlotHashes` retention window).
    pub randomness_reveal_deadline_slots: u64,
    /// Permissionless `crank_auto_deposit` window (Phase 10). Pass `0`
    /// and `false` to birth the program with the feature off — the
    /// devnet upgrade path reads exactly that from the former reserved
    /// bytes.
    pub auto_deposit_window_secs: i64,
    /// Capped by `MAX_AUTO_DEPOSIT_TIP_LAMPORTS` below.
    pub auto_deposit_tip_lamports: u64,
    pub auto_deposit_enabled: bool,
    /// One-time PlayerEscrow creation fee, seeds the Mega-Pot (Phase 11,
    /// decision D1: universal — the escrow is the player profile). The one
    /// new economics-adjacent field that is an onboarding cost, not an
    /// odds lever, so it takes the same shape as the tip: an arg under a
    /// compile-time ceiling, admin-mutable later via `update_config`.
    /// Suggested `10_000_000` (0.01 SOL).
    pub account_open_fee_lamports: u64,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        seeds = [CONFIG_SEED],
        bump,
        payer = admin,
        space = 8 + GlobalConfig::INIT_SPACE
    )]
    pub config: Account<'info, GlobalConfig>,
    #[account(
        init,
        seeds = [TREASURY_SEED],
        bump,
        payer = admin,
        space = 8 + TreasuryVault::INIT_SPACE
    )]
    pub treasury: Account<'info, TreasuryVault>,
    #[account(
        init,
        seeds = [MEGA_POT_SEED],
        bump,
        payer = admin,
        space = 8 + MegaPotVault::INIT_SPACE
    )]
    pub mega_pot: Account<'info, MegaPotVault>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn process(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
    // I14, four-way form, by construction and by belt: the hardcoded split
    // must consume the denominator exactly.
    let bps_sum = u32::from(FEE_BPS_ADMIN)
        .checked_add(u32::from(FEE_BPS_MEGA))
        .and_then(|sum| sum.checked_add(u32::from(WINNER_BPS)))
        .and_then(|sum| sum.checked_add(u32::from(REFUND_BPS)))
        .ok_or(OrbitError::ArithmeticOverflow)?;
    require_eq!(
        bps_sum,
        u32::from(BPS_DENOMINATOR),
        OrbitError::InvalidFeeSplit
    );

    // A stale randomness commit is unresolvable past the SlotHashes window,
    // so a deadline at or beyond it would strand funds (roadmap 4.4).
    require!(
        args.randomness_reveal_deadline_slots < SLOT_HASHES_RETENTION_SLOTS,
        OrbitError::InvalidRevealDeadline
    );
    // The absolute anti-snipe cap must at least cover the base duration.
    require!(
        args.max_round_duration_secs >= args.round_duration_secs,
        OrbitError::InvalidDurationConfig
    );
    // A default queue would silently disable the commit transport's pin.
    require!(
        args.oracle_queue != Pubkey::default(),
        OrbitError::InvalidOracleQueue
    );
    // Phase 10: the tip is bounded by a compile-time ceiling (never an
    // admin knob past it), and an enabled feature demands a usable window.
    require!(
        args.auto_deposit_tip_lamports <= MAX_AUTO_DEPOSIT_TIP_LAMPORTS,
        OrbitError::AutoDepositTipTooHigh
    );
    if args.auto_deposit_enabled {
        require!(
            args.auto_deposit_window_secs > 0,
            OrbitError::InvalidAutoDepositWindow
        );
        require!(
            args.auto_deposit_window_secs < args.round_duration_secs,
            OrbitError::InvalidAutoDepositWindow
        );
    }

    // Phase 11 guards 5–9 (guard 4, the four-way I14 sum, is above): a
    // fresh deployment births at version 2, so the v2 invariants must hold
    // of the hardcoded constants by construction — and by belt.
    require!(
        u32::from(MEGA_AWARD_BPS) + u32::from(MEGA_FIELD_BPS) <= u32::from(BPS_DENOMINATOR),
        OrbitError::InvalidFeeSplit
    );
    require!(MEGA_TRIGGER_MODULUS >= 1, OrbitError::ZeroModulusConfig);
    // Uncapped is the pre-v2 grandfather only; version 2 ships capped.
    require!(MEGA_PAYOUT_CAP_BPS > 0, OrbitError::MegaFarmGuardViolated);
    assert_mega_farm_safe(
        MEGA_PAYOUT_CAP_BPS,
        MEGA_TRIGGER_MODULUS,
        FEE_BPS_ADMIN,
        FEE_BPS_MEGA,
        MEGA_AWARD_BPS,
        MEGA_FIELD_BPS,
    )?;
    require!(
        args.account_open_fee_lamports <= MAX_ACCOUNT_OPEN_FEE_LAMPORTS,
        OrbitError::AccountOpenFeeTooHigh
    );

    ctx.accounts.config.set_inner(GlobalConfig {
        admin: ctx.accounts.admin.key(),
        pending_admin: None,
        treasury_authority: args.treasury_authority,
        oracle_program_id: args.oracle_program_id,
        oracle_queue: args.oracle_queue,
        fee_bps_admin: FEE_BPS_ADMIN,
        fee_bps_mega: FEE_BPS_MEGA,
        winner_bps: WINNER_BPS,
        mega_award_bps: MEGA_AWARD_BPS,
        mega_trigger_modulus: MEGA_TRIGGER_MODULUS,
        max_entries_per_round: args.max_entries_per_round,
        round_duration_secs: args.round_duration_secs,
        max_round_duration_secs: args.max_round_duration_secs,
        anti_snipe_window_secs: args.anti_snipe_window_secs,
        anti_snipe_extension_secs: args.anti_snipe_extension_secs,
        claim_deadline_secs: args.claim_deadline_secs,
        min_deposit_lamports: args.min_deposit_lamports,
        anti_snipe_min_deposit_lamports: args.anti_snipe_min_deposit_lamports,
        keeper_tip_lamports: args.keeper_tip_lamports,
        randomness_reveal_deadline_slots: args.randomness_reveal_deadline_slots,
        active_round_id: 0,
        next_round_id: 0,
        // No `Mock` variant exists in this build; nothing to reject here.
        oracle_provider: args.oracle_provider,
        paused: false,
        bump: ctx.bumps.config,
        auto_deposit_window_secs: args.auto_deposit_window_secs,
        auto_deposit_tip_lamports: args.auto_deposit_tip_lamports,
        auto_deposit_enabled: args.auto_deposit_enabled,
        // Phase 11 economics: a fresh deployment births at version 2 with
        // the canonical 9/89/1/1 + 50/40/10 constants and never needs the
        // one-way migration.
        refund_bps: REFUND_BPS,
        mega_field_bps: MEGA_FIELD_BPS,
        mega_payout_cap_bps: MEGA_PAYOUT_CAP_BPS,
        account_open_fee_lamports: args.account_open_fee_lamports,
        economics_version: 2,
        reserved: [0; 30],
    });
    ctx.accounts.treasury.set_inner(TreasuryVault {
        accrued_lamports: 0,
        lifetime_accrued: 0,
        lifetime_swept: 0,
        bump: ctx.bumps.treasury,
        reserved: [0; 32],
    });
    ctx.accounts.mega_pot.set_inner(MegaPotVault {
        accrued_lamports: 0,
        lifetime_contributed: 0,
        lifetime_awarded: 0,
        trigger_count: 0,
        last_trigger_round_id: 0,
        cycle_index: 0,
        bump: ctx.bumps.mega_pot,
        reserved: [0; 32],
    });
    Ok(())
}
