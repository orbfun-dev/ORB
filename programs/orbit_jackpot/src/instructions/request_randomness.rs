//! `request_randomness` — pin the randomness account (roadmap task 3.7).
//!
//! Enforces all three ADR-4 checks available at request time:
//! 1. **Pinned** — `round.randomness_account` is written exactly once; a
//!    second call is rejected. No re-roll, ever.
//! 2. **Authority-bound** — the randomness account's `authority` must equal
//!    the **round PDA**: only this program can ever commit it, and it
//!    commits exactly once.
//! 3. **Owner-bound** — the account is owned by the configured oracle
//!    program (enforced as a context constraint).
//!
//! The freshness check (`seed_slot > lock_slot`) belongs to
//! `fulfill_settle`, where the committed value is observable.

use crate::constants::{CONFIG_SEED, ROUND_SEED, ROUND_VAULT_SEED};
use crate::errors::OrbitError;
use crate::events::RandomnessRequested;
use crate::invariants::assert_round_vault_solvent;
use crate::oracle::switchboard::SwitchboardRandomness;
use crate::oracle::RandomnessSource;
use crate::state::{GlobalConfig, OracleProvider, Round, RoundState, RoundVault};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct RequestRandomness<'info> {
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
    /// The randomness account to pin. Its owner is constrained to the
    /// configured oracle program; its `authority` must equal the round PDA
    /// (checked in the handler against the parsed account).
    ///
    /// CHECK: owner constrained above; key is pinned on the round below, so
    /// settlement will only ever accept this exact account.
    #[account(owner = config.oracle_program_id @ OrbitError::RandomnessOwnerMismatch)]
    pub randomness_account: UncheckedAccount<'info>,
    /// Permissionless crank caller; plays no role in the outcome (I13).
    pub authority: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn process(ctx: Context<RequestRandomness>) -> Result<()> {
    // Randomness fallback: new rounds use the configured provider only.
    require!(
        ctx.accounts.config.oracle_provider == OracleProvider::Switchboard,
        OrbitError::OracleProviderMismatch
    );
    let round = &mut ctx.accounts.round;
    // No re-roll (ADR-4): the pin is write-once. Checked before the state
    // gate so a re-roll attempt reports the attack, not the symptom.
    require!(
        round.randomness_account == Pubkey::default(),
        OrbitError::RandomnessAlreadyPinned
    );
    require!(
        round.state == RoundState::Locked,
        OrbitError::RoundNotLocked
    );

    // ADR-4 check 2, the critical one: binding the account's authority to
    // the round PDA means only this program can ever commit it.
    let round_key = round.key();
    let randomness_info = ctx.accounts.randomness_account.to_account_info();
    let randomness = SwitchboardRandomness::parse(&randomness_info)?;
    require_keys_eq!(
        randomness.authority(),
        round_key,
        OrbitError::RandomnessAuthorityMismatch
    );

    RoundState::try_transition(round.state, RoundState::AwaitingRandomness)?;
    round.state = RoundState::AwaitingRandomness;
    round.randomness_account = ctx.accounts.randomness_account.key();
    // The reveal-timeout clock starts at the pin.
    round.randomness_commit_slot = Clock::get()?.slot;

    emit!(RandomnessRequested {
        round_id: round.round_id,
        randomness_account: round.randomness_account,
        commit_slot: round.randomness_commit_slot,
    });

    // I1 — nothing moved; the books must still balance.
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
