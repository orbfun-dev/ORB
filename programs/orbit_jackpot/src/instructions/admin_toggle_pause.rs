//! `toggle_pause` — the operator brake (roadmap global constraint).
//!
//! Admin-only. `paused` blocks exactly two instructions — `deposit` and
//! `open_round` — and nothing else, by design: a pause must never trap user
//! funds, so `lock_round`, `fulfill_settle`, `claim_winnings`,
//! `refund_entry`, `close_entry`, `cancel_round` and `close_round` all stay
//! live while paused (Phase 4.9 asserts this).

use crate::constants::CONFIG_SEED;
use crate::errors::OrbitError;
use crate::state::GlobalConfig;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct TogglePause<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(constraint = admin.key() == config.admin @ OrbitError::UnauthorizedAdmin)]
    pub admin: Signer<'info>,
}

pub fn process(ctx: Context<TogglePause>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.paused = !config.paused;
    emit!(crate::events::PauseToggled {
        admin: ctx.accounts.admin.key(),
        paused: config.paused,
    });
    Ok(())
}
