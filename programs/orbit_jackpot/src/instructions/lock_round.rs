//! `lock_round` — permissionless window closer (roadmap task 3.5; Phase 12
//! reroutes the zero-deposit case).
//!
//! Gated on `now >= end_ts` (the *time* gate). Routing:
//! - `total_lamports == 0` → **window roll** (Phase 12): the round stays
//!   `Open` and both timestamps move to `now` / `now + round_duration_secs`
//!   (`RoundWindowRolled`, reason `ROLL_REASON_LOCK_SWEEP`). An empty round
//!   is never torn down: the rent stays parked, so an idle keeper burns one
//!   5 000-lamport transaction per roll instead of a 4 128 360-lamport
//!   close/open pair — and a third party can no longer spend 5 000 lamports
//!   to force the keeper into 4 113 360 lamports of fresh rent (the 822×
//!   grief; Phase 12 R4). No entropy path either: an empty round still
//!   never reaches `ticket_from_entropy(_, 0)`, because it never leaves
//!   `Open` (R1: a roll is not a state transition — `try_transition` is
//!   deliberately not called).
//! - `single_depositor` → `Cancelled` (roadmap 4.3): taking a cut from
//!   someone to hand back their own money is indefensible; 100% refund,
//!   zero fees.
//! - otherwise → `Locked`, recording `lock_slot` (security ordering) and
//!   `lock_ts` (display).

use crate::constants::{CONFIG_SEED, ROUND_SEED, ROUND_VAULT_SEED};
use crate::errors::OrbitError;
use crate::events::{
    RoundCancelled, RoundLocked, RoundWindowRolled, CANCEL_REASON_SOLE_DEPOSITOR,
    ROLL_REASON_LOCK_SWEEP,
};
use crate::invariants::assert_round_vault_solvent;
use crate::state::{GlobalConfig, Round, RoundState, RoundVault};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct LockRound<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(
        mut,
        seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()],
        bump = round.bump
    )]
    pub round: Account<'info, Round>,
    #[account(
        seeds = [ROUND_VAULT_SEED, round.round_id.to_le_bytes().as_ref()],
        bump = round.vault_bump
    )]
    pub round_vault: Account<'info, RoundVault>,
    /// Permissionless crank caller; plays no role in the outcome (I13).
    pub authority: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn process(ctx: Context<LockRound>) -> Result<()> {
    let round = &mut ctx.accounts.round;
    require!(round.state == RoundState::Open, OrbitError::RoundNotOpen);
    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp >= round.end_ts,
        OrbitError::LockWindowNotElapsed
    );

    if Round::may_roll_window(round.state, round.total_lamports) {
        // Zero-deposit round (R1–R3): the window rolls forward in place —
        // no state change, no teardown, both accounts (and their rent)
        // stay exactly where they are. `deposit` can revive a stale empty
        // window itself, so this branch is only the keeper/community
        // safety net that keeps the UI countdown from showing a window
        // that died long ago.
        let (start_ts, end_ts) = Round::rolled_window(
            clock.unix_timestamp,
            ctx.accounts.config.round_duration_secs,
        )?;
        round.start_ts = start_ts;
        round.end_ts = end_ts;
        emit!(RoundWindowRolled {
            round_id: round.round_id,
            start_ts,
            end_ts,
            reason: ROLL_REASON_LOCK_SWEEP,
        });
    } else if round.single_depositor {
        // Sole depositor (any number of entries, one player): full refund,
        // zero fees (I15). `vault_owed` still equals `total_lamports`.
        RoundState::try_transition(round.state, RoundState::Cancelled)?;
        round.state = RoundState::Cancelled;
        emit!(RoundCancelled {
            round_id: round.round_id,
            reason: CANCEL_REASON_SOLE_DEPOSITOR,
        });
    } else {
        RoundState::try_transition(round.state, RoundState::Locked)?;
        round.state = RoundState::Locked;
        // Slots are the security timebase; the timestamp is display-only.
        round.lock_slot = clock.slot;
        round.lock_ts = clock.unix_timestamp;
        emit!(RoundLocked {
            round_id: round.round_id,
            lock_ts: round.lock_ts,
            lock_slot: round.lock_slot,
            total_lamports: round.total_lamports,
            entry_count: round.entry_count,
        });
    }

    // I1 — nothing moved, and the books must still balance.
    let vault_len = RoundVault::INIT_SPACE
        .checked_add(8)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    let rent_min = ctx.accounts.rent.minimum_balance(vault_len);
    assert_round_vault_solvent(
        ctx.accounts.round_vault.get_lamports(),
        rent_min,
        round.vault_owed,
    )?;
    Ok(())
}
