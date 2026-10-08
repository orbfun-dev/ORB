//! `accept_admin` — step two of the two-step handoff (ADR-10).
//!
//! The staged successor signs, takes the admin seat, and clears the staging
//! slot. Only this path can ever change `GlobalConfig.admin`.

use crate::constants::CONFIG_SEED;
use crate::errors::OrbitError;
use crate::state::GlobalConfig;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    pub pending: Signer<'info>,
}

pub fn process(ctx: Context<AcceptAdmin>) -> Result<()> {
    let pending = ctx
        .accounts
        .config
        .pending_admin
        .ok_or(OrbitError::UnauthorizedPendingAdmin)?;
    require_keys_eq!(
        ctx.accounts.pending.key(),
        pending,
        OrbitError::UnauthorizedPendingAdmin
    );
    ctx.accounts.config.admin = pending;
    ctx.accounts.config.pending_admin = None;
    Ok(())
}
