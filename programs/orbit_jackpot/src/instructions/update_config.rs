//! `update_config` — operational parameter updates (roadmap task 3.2,
//! ADR-10).
//!
//! Admin-only, and **structurally** limited to the operational surface: the
//! args type carries `Option` fields for exactly the mutable subset, so the
//! immutable economics — fee bps, Mega-Pot odds and award, oracle program
//! id and provider, authorities — cannot even be *expressed* here, let
//! alone accepted. An admin who can retune jackpot odds mid-cycle can rug
//! the progressive pot; this must be impossible by construction, not merely
//! unauthorized. (`pending_admin` moves via the two-step transfer; `paused`
//! via `toggle_pause`.)

use crate::constants::{
    CONFIG_SEED, MAX_ACCOUNT_OPEN_FEE_LAMPORTS, MAX_AUTO_DEPOSIT_TIP_LAMPORTS,
    SLOT_HASHES_RETENTION_SLOTS, MIN_CLAIM_DEADLINE_SECS,
    MIN_REVEAL_DEADLINE_SLOTS, MIN_ROUND_DURATION_SECS,
};
use crate::errors::OrbitError;
use crate::events::{ConfigUpdated, OracleProviderChanged};
use crate::state::{GlobalConfig, OracleProvider};
use anchor_lang::prelude::*;

/// Operational updates. `None` leaves a field untouched.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq, Default)]
pub struct UpdateConfigArgs {
    pub max_entries_per_round: Option<u32>,
    pub round_duration_secs: Option<i64>,
    /// Hard ceiling on anti-snipe extension.
    pub max_round_duration_secs: Option<i64>,
    pub anti_snipe_window_secs: Option<i64>,
    pub anti_snipe_extension_secs: Option<i64>,
    /// After this, an unclaimed prize sweeps to the Mega-Pot.
    pub claim_deadline_secs: Option<i64>,
    pub min_deposit_lamports: Option<u64>,
    /// Only deposits ≥ this extend the anti-snipe timer.
    pub anti_snipe_min_deposit_lamports: Option<u64>,
    /// Paid out of the 1% admin cut — never a fourth slice.
    pub keeper_tip_lamports: Option<u64>,
    /// Must stay < 512 (`SlotHashes` retention window).
    pub randomness_reveal_deadline_slots: Option<u64>,
    /// Queue migration is operational, not economic — unlike the oracle
    /// program id, which stays structurally absent here.
    pub oracle_queue: Option<Pubkey>,
    /// Phase 10 auto-deposit surface (operational, ADR-10-compatible):
    /// the permissionless-caller window, the crank tip, and the feature
    /// kill switch. The tip can only ever move *underneath*
    /// `MAX_AUTO_DEPOSIT_TIP_LAMPORTS`.
    pub auto_deposit_window_secs: Option<i64>,
    pub auto_deposit_tip_lamports: Option<u64>,
    pub auto_deposit_enabled: Option<bool>,
    /// Phase 11: the one-time PlayerEscrow creation fee. The sole
    /// economics-adjacent field allowed here — an onboarding cost, not a
    /// jackpot-odds lever (R7/ADR-10), movable only underneath
    /// `MAX_ACCOUNT_OPEN_FEE_LAMPORTS`.
    pub account_open_fee_lamports: Option<u64>,
    /// Randomness fallback: the source NEW rounds request from. Rounds
    /// already pinned keep theirs (settle/cancel classify the pinned
    /// account), so switching is safe at any time. Operational, not
    /// economic: it changes no odds, fees or payouts.
    pub oracle_provider: Option<OracleProvider>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(constraint = admin.key() == config.admin @ OrbitError::UnauthorizedAdmin)]
    pub admin: Signer<'info>,
}

pub fn process(ctx: Context<UpdateConfig>, args: UpdateConfigArgs) -> Result<()> {
    let config = &mut ctx.accounts.config;

    if let Some(v) = args.max_entries_per_round {
        config.max_entries_per_round = v;
    }
    if let Some(v) = args.round_duration_secs {
        require!(v >= MIN_ROUND_DURATION_SECS, OrbitError::ConfigBelowMinimum);
        config.round_duration_secs = v;
    }
    if let Some(v) = args.max_round_duration_secs {
        config.max_round_duration_secs = v;
    }
    if let Some(v) = args.anti_snipe_window_secs {
        config.anti_snipe_window_secs = v;
    }
    if let Some(v) = args.anti_snipe_extension_secs {
        config.anti_snipe_extension_secs = v;
    }
    if let Some(v) = args.claim_deadline_secs {
        require!(v >= MIN_CLAIM_DEADLINE_SECS, OrbitError::ConfigBelowMinimum);
        config.claim_deadline_secs = v;
    }
    if let Some(v) = args.min_deposit_lamports {
        config.min_deposit_lamports = v;
    }
    if let Some(v) = args.anti_snipe_min_deposit_lamports {
        config.anti_snipe_min_deposit_lamports = v;
    }
    if let Some(v) = args.keeper_tip_lamports {
        config.keeper_tip_lamports = v;
    }
    if let Some(v) = args.randomness_reveal_deadline_slots {
        require!(v >= MIN_REVEAL_DEADLINE_SLOTS, OrbitError::ConfigBelowMinimum);
        config.randomness_reveal_deadline_slots = v;
    }
    if let Some(v) = args.oracle_queue {
        // The one config field that touches randomness integrity: only
        // while paused (no new rounds or deposits), never mid-flight.
        if v != config.oracle_queue {
            require!(config.paused, OrbitError::OracleQueueChangeRequiresPause);
        }
        config.oracle_queue = v;
    }
    if let Some(v) = args.auto_deposit_window_secs {
        config.auto_deposit_window_secs = v;
    }
    if let Some(v) = args.auto_deposit_tip_lamports {
        config.auto_deposit_tip_lamports = v;
    }
    if let Some(v) = args.auto_deposit_enabled {
        config.auto_deposit_enabled = v;
    }
    if let Some(v) = args.account_open_fee_lamports {
        config.account_open_fee_lamports = v;
    }
    if let Some(v) = args.oracle_provider {
        if v != config.oracle_provider {
            config.oracle_provider = v;
            emit!(OracleProviderChanged {
                admin: ctx.accounts.admin.key(),
                provider: v as u8,
            });
        }
    }

    // Validate the EFFECTIVE values (partially-updated mixes included).
    require!(
        config.randomness_reveal_deadline_slots < SLOT_HASHES_RETENTION_SLOTS,
        OrbitError::InvalidRevealDeadline
    );
    require!(
        config.max_round_duration_secs >= config.round_duration_secs,
        OrbitError::InvalidDurationConfig
    );
    require!(
        config.oracle_queue != Pubkey::default(),
        OrbitError::InvalidOracleQueue
    );
    // The tip ceiling is the security boundary that stops an admin from
    // setting a tip that siphons player escrows — enforced against the
    // effective value, so a `None`-patched mix cannot dodge it.
    require!(
        config.auto_deposit_tip_lamports <= MAX_AUTO_DEPOSIT_TIP_LAMPORTS,
        OrbitError::AutoDepositTipTooHigh
    );
    // The account-open fee ceiling, same shape as the tip check above:
    // enforced against the effective value, so a `None`-patched mix cannot
    // dodge it (R7's single sanctioned exception).
    require!(
        config.account_open_fee_lamports <= MAX_ACCOUNT_OPEN_FEE_LAMPORTS,
        OrbitError::AccountOpenFeeTooHigh
    );
    if config.auto_deposit_enabled {
        require!(
            config.auto_deposit_window_secs > 0,
            OrbitError::InvalidAutoDepositWindow
        );
        require!(
            config.auto_deposit_window_secs < config.round_duration_secs,
            OrbitError::InvalidAutoDepositWindow
        );
    }
    emit!(ConfigUpdated {
        admin: ctx.accounts.admin.key(),
        round_duration_secs: config.round_duration_secs,
        claim_deadline_secs: config.claim_deadline_secs,
        min_deposit_lamports: config.min_deposit_lamports,
        keeper_tip_lamports: config.keeper_tip_lamports,
        randomness_reveal_deadline_slots: config.randomness_reveal_deadline_slots,
        oracle_queue: config.oracle_queue,
        auto_deposit_tip_lamports: config.auto_deposit_tip_lamports,
        auto_deposit_enabled: config.auto_deposit_enabled,
        account_open_fee_lamports: config.account_open_fee_lamports,
    });
    Ok(())
}
