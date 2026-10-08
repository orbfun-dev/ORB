//! Cancellation and refunds.
//!
//! `cancel_round` (roadmap 4.4): permissionless oracle-timeout cancellation —
//! an `AwaitingRandomness` round whose pinned randomness was committed more
//! than `randomness_reveal_deadline_slots` slots ago without a settle goes
//! to `Cancelled`. **No re-roll, ever** (ADR-4): a re-roll would hand a free
//! extra randomness sample to anyone able to stall the first one. The cost
//! of this choice is an occasional cancelled round with full refunds.
//!
//! The zero-deposit and sole-depositor cancellations are *not* here — they
//! are `lock_round`'s `Open → Cancelled` routing (the state machine has no
//! `Locked → Cancelled` edge).
//!
//! `refund_entry` (roadmap 4.5): permissionless refund of one entry of a
//! cancelled round — `entry.amount` plus the entry's reclaimed rent to
//! `entry.player`, decrementing `vault_owed` and counting `entries_closed`.

use crate::constants::{
    CONFIG_SEED, ENTROPY_REVEAL_DEADLINE_SLOTS, ENTRY_SEED, ROUND_SEED, ROUND_VAULT_SEED,
};
use crate::errors::OrbitError;
use crate::events::{EntryRefunded, RoundCancelled, CANCEL_REASON_ORACLE_TIMEOUT};
use crate::invariants::assert_round_vault_solvent;
use crate::oracle::switchboard::SwitchboardRandomness;
use crate::oracle::{classify_pinned, PinnedSource, RandomnessSource};
use crate::state::{
    EntropyChain, GlobalConfig, PlayerEntry, Round, RoundState, RoundVault, ENTROPY_NONE,
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct CancelRound<'info> {
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
    /// AUDIT P-1: the round's pinned randomness account. A revealed value
    /// means the outcome is public — the round must settle, never cancel
    /// (otherwise every loser races `fulfill_settle` with a cancel that
    /// voids the winner). A CLOSED account (no longer owned by the oracle
    /// program) cannot reveal anymore, so cancelling stays allowed and an
    /// orphaned pin can always be refunded.
    ///
    ///
    /// Randomness fallback: may also be the `EntropyChain` singleton
    /// (writable: a cancel releases the chain's pending round). The source
    /// is classified from the account itself (`classify_pinned`), never from
    /// config, so a provider switch cannot turn a revealed account into a
    /// "closed" one.
    ///
    /// CHECK: key pinned to `round.randomness_account` in the handler;
    /// classified and parsed there.
    #[account(mut)]
    pub randomness_account: UncheckedAccount<'info>,
}

pub fn process(ctx: Context<CancelRound>) -> Result<()> {
    let round = &mut ctx.accounts.round;
    require!(
        round.state == RoundState::AwaitingRandomness,
        OrbitError::RoundNotAwaitingRandomness
    );
    require_keys_eq!(
        ctx.accounts.randomness_account.key(),
        round.randomness_account,
        OrbitError::RandomnessAccountMismatch
    );
    // Slot-based deadline: `unix_timestamp` is an estimate and is not
    // monotonic across forks — slots are (global timebase constraint).
    let slot = Clock::get()?.slot;
    let randomness_info = ctx.accounts.randomness_account.to_account_info();
    match classify_pinned(&randomness_info, &ctx.accounts.config.oracle_program_id)? {
        PinnedSource::Switchboard => {
            let deadline = round
                .randomness_commit_slot
                .checked_add(ctx.accounts.config.randomness_reveal_deadline_slots)
                .ok_or(OrbitError::ArithmeticOverflow)?;
            require!(slot > deadline, OrbitError::RevealDeadlineNotElapsed);
            let randomness = SwitchboardRandomness::parse(&randomness_info)?;
            require!(
                !randomness.is_revealed(),
                OrbitError::RandomnessAlreadyRevealed
            );
        }
        PinnedSource::Entropy => {
            // The long deadline is the anti-abort mechanism (design §2.2):
            // the seed holder sees the outcome first, so a withheld reveal
            // must cost a public day-long halt, not buy a quick refund.
            let deadline = round
                .randomness_commit_slot
                .checked_add(ENTROPY_REVEAL_DEADLINE_SLOTS)
                .ok_or(OrbitError::ArithmeticOverflow)?;
            require!(slot > deadline, OrbitError::RevealDeadlineNotElapsed);
            let mut chain = EntropyChain::load(&randomness_info)?;
            // AUDIT P-1 for the entropy source: a revealed value is public.
            require!(
                chain.value_round != round.round_id,
                OrbitError::RandomnessAlreadyRevealed
            );
            if chain.pending_round == round.round_id {
                chain.pending_round = ENTROPY_NONE;
                chain.store(&randomness_info)?;
            }
        }
        PinnedSource::Closed => {
            // An orphaned pin can always be refunded (it can never reveal).
            let deadline = round
                .randomness_commit_slot
                .checked_add(ctx.accounts.config.randomness_reveal_deadline_slots)
                .ok_or(OrbitError::ArithmeticOverflow)?;
            require!(slot > deadline, OrbitError::RevealDeadlineNotElapsed);
        }
    }

    RoundState::try_transition(round.state, RoundState::Cancelled)?;
    round.state = RoundState::Cancelled;
    // `vault_owed` stays at `total_lamports` (I15: no fees on cancellation);
    // refunds drain it entry by entry.
    emit!(RoundCancelled {
        round_id: round.round_id,
        reason: CANCEL_REASON_ORACLE_TIMEOUT,
    });

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

#[derive(Accounts)]
#[instruction(entry_index: u32)]
pub struct RefundEntry<'info> {
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
    /// The entry being refunded, pinned by seeds to
    /// `(round.round_id, entry_index)` — an entry from another round or
    /// index cannot be presented. `close = player` returns the entry's rent
    /// to the player at instruction exit.
    #[account(
        mut,
        seeds = [
            ENTRY_SEED,
            round.round_id.to_le_bytes().as_ref(),
            entry_index.to_le_bytes().as_ref()
        ],
        bump = entry.bump,
        close = player
    )]
    pub entry: Account<'info, PlayerEntry>,
    /// CHECK: the sole legitimate destination — enforced to equal
    /// `entry.player` so refunds and reclaimed rent cannot be diverted.
    #[account(mut, constraint = player.key() == entry.player @ OrbitError::RefundDestinationMismatch)]
    pub player: AccountInfo<'info>,
    /// Permissionless crank caller; plays no role in the outcome (I13).
    pub authority: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn refund(ctx: Context<RefundEntry>, entry_index: u32) -> Result<()> {
    let round = &mut ctx.accounts.round;
    require!(
        round.state == RoundState::Cancelled,
        OrbitError::RoundNotCancelled
    );
    // Belt over the seed pin (also documents the argument's role).
    require_eq!(
        ctx.accounts.entry.entry_index,
        entry_index,
        OrbitError::EntryRoundMismatch
    );

    let amount = ctx.accounts.entry.amount;
    let player = ctx.accounts.entry.player;

    // Bookkeeping first: the vault stops owing this entry exactly what it
    // deposited (ADR-7: no fees were ever taken, so the refund is exact).
    round.vault_owed = round
        .vault_owed
        .checked_sub(amount)
        .ok_or(OrbitError::RoundVaultInvariant)?;
    round.entries_closed = round
        .entries_closed
        .checked_add(1)
        .ok_or(OrbitError::ArithmeticOverflow)?;

    // Program-owned vault → player by direct lamport arithmetic (a System
    // CPI cannot debit a non-System-owned account). Both methods are checked
    // under the hood; `vault_owed >= amount` guarantees the rent floor is
    // never crossed.
    ctx.accounts.round_vault.sub_lamports(amount)?;
    ctx.accounts.player.add_lamports(amount)?;

    emit!(EntryRefunded {
        round_id: round.round_id,
        entry_index,
        player,
        amount,
    });

    // I1 after the refund: rent minimum + whatever is still owed.
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
