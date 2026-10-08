//! `transfer_admin` — step one of the two-step handoff (ADR-10).
//!
//! The admin stages a successor in `pending_admin`. Nothing takes effect
//! until the successor calls `accept_admin`, so a typo'd destination cannot
//! brick governance: the current admin can simply re-stage.

use crate::constants::CONFIG_SEED;
use crate::errors::OrbitError;
use crate::state::GlobalConfig;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct TransferAdmin<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(constraint = admin.key() == config.admin @ OrbitError::UnauthorizedAdmin)]
    pub admin: Signer<'info>,
}

pub fn process(ctx: Context<TransferAdmin>, new_admin: Pubkey) -> Result<()> {
    ctx.accounts.config.pending_admin = Some(new_admin);
    Ok(())
}
