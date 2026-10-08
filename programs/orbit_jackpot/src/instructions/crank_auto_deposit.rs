//! `crank_auto_deposit` — the permissionless escrow spend (Phase 10 §3.4).
//!
//! Any actor — the keeper, the player's own browser, a third party — enters
//! a funded escrow into an open round with no wallet signature. Three rules
//! make that safe:
//!
//! - **R1** the minted entry's `player` is the ESCROW PDA, not the owner's
//!   wallet. Every existing payout path routes to `entry.player`, so
//!   prizes, refunds and rent rebates land in the escrow with zero changes
//!   to those instructions — reinvestment is free.
//! - **R2** the escrow reimburses the crank for the entry rent **in this
//!   instruction**: `payer = crank` on the entry `init` (Anchor requires a
//!   Signer), then `escrow.sub_lamports(amount + entry_rent + tip)` and
//!   `crank.add_lamports(entry_rent + tip)`. Without the reimbursement a
//!   permissionless caller could farm the keeper's wallet 1,203,960
//!   lamports per escrow, without bound.
//! - **R3** `apply_anti_snipe_extension` is structurally absent and
//!   `round.end_ts` is never written. A permissionless instruction that
//!   extends the deadline using someone else's lamports is a free griefing
//!   lever; in a pari-mutuel pool entry time does not change EV anyway
//!   (see `deposit.rs`'s header), so excluding it costs nothing.
//!
//! The escrow account is bound by its own `owner` field exactly as `round`
//! is bound by its own `round_id` — a forged escrow address cannot be
//! presented. The anti-selection boundary (§4.2) is the window gate:
//! permissionless callers may act only while `now <= start_ts + window`,
//! where the observable pot carries almost no information about the final
//! pot; the owner is exempt and can always spend their own funds at a
//! moment of their choosing.

use crate::constants::{CONFIG_SEED, ENTRY_SEED, ESCROW_SEED, ROUND_SEED, ROUND_VAULT_SEED};
use crate::errors::OrbitError;
use crate::events::{AutoDeposited, EscrowDepleted};
use crate::invariants::{
    assert_escrow_rent_exempt, assert_round_vault_solvent, auto_deposit_round_cost,
    escrow_spendable, rounds_affordable,
};
use crate::math::next_range;
use crate::state::{GlobalConfig, PlayerEntry, PlayerEscrow, Round, RoundState, RoundVault};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct CrankAutoDeposit<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(
        mut,
        seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()],
        bump = round.bump
    )]
    pub round: Account<'info, Round>,
    /// Same index-unforgeability as `deposit`: the seed is derived from
    /// `round.entry_count` itself, and `init` refuses an existing account,
    /// so index collisions (a human deposit landing mid-flight) fail
    /// cleanly for the caller to retry with fresh indices.
    #[account(
        init,
        seeds = [
            ENTRY_SEED,
            round.round_id.to_le_bytes().as_ref(),
            round.entry_count.to_le_bytes().as_ref()
        ],
        bump,
        payer = crank,
        space = 8 + PlayerEntry::INIT_SPACE
    )]
    pub entry: Account<'info, PlayerEntry>,
    #[account(
        mut,
        seeds = [ROUND_VAULT_SEED, round.round_id.to_le_bytes().as_ref()],
        bump = round.vault_bump
    )]
    pub round_vault: Account<'info, RoundVault>,
    /// Bound by its own `owner` field (see module docs): the seed check
    /// alone would accept any PDA of the form ["escrow", x] — this pins x
    /// to the account's self-declared owner, so the escrow presented is
    /// exactly the escrow that will be debited.
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.owner.as_ref()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, PlayerEscrow>,
    /// The permissionless crank. Pays the entry rent during `init` and is
    /// reimbursed `entry_rent + tip` from the escrow below (R2); with any
    /// tip above ~5_000 lamports the net `+tip − tx_fee` is positive, so
    /// there is no configuration in which a stranger's entry costs the
    /// keeper money. The owner signing here bypasses the window gate.
    #[account(mut)]
    pub crank: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn process(ctx: Context<CrankAutoDeposit>, round_id: u64) -> Result<()> {
    let config = &ctx.accounts.config;
    let round = &mut ctx.accounts.round;

    require!(!config.paused, OrbitError::Paused);
    require!(config.auto_deposit_enabled, OrbitError::AutoDepositDisabled);
    // Belt over the seed pin: keeps the caller-supplied argument meaningful.
    require_eq!(round.round_id, round_id, OrbitError::RoundIdMismatch);
    require!(round.state == RoundState::Open, OrbitError::RoundNotOpen);
    let clock = Clock::get()?;
    // The time gate, not the state gate, closes the window (as in `deposit`).
    require!(
        clock.unix_timestamp < round.end_ts,
        OrbitError::DepositWindowClosed
    );

    // The anti-selection boundary: inside a short start-of-round window the
    // observable pot says almost nothing about the final pot, so a hostile
    // caller cannot condition on it. The owner is exempt — an owner timing
    // their own spend is not griefing, and the exemption is the escape
    // hatch that makes "a griefer cannot withhold entry" survivable.
    let window_end = round
        .start_ts
        .checked_add(config.auto_deposit_window_secs)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    let in_window = clock.unix_timestamp <= window_end;
    require!(
        in_window || ctx.accounts.crank.key() == ctx.accounts.escrow.owner,
        OrbitError::AutoDepositWindowClosed
    );

    // I17's guard: round ids are monotonic and never reused, so this is
    // simultaneously the same-round and the replay-into-older-rounds gate.
    require!(
        round.round_id >= ctx.accounts.escrow.next_eligible_round_id,
        OrbitError::AutoDepositAlreadyThisRound
    );
    require!(
        ctx.accounts.escrow.rounds_remaining > 0,
        OrbitError::EscrowBudgetExhausted
    );

    let amount = ctx.accounts.escrow.per_round_lamports;
    // The admin may have raised the floor since the terms were set.
    require!(
        amount >= config.min_deposit_lamports,
        OrbitError::DepositBelowMinimum
    );

    if config.max_entries_per_round > 0 {
        require!(
            round.entry_count < config.max_entries_per_round,
            OrbitError::MaxEntriesReached
        );
    }

    let entry_rent = ctx
        .accounts
        .rent
        .minimum_balance(8 + PlayerEntry::INIT_SPACE);
    let escrow_len = PlayerEscrow::INIT_SPACE
        .checked_add(8)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    let escrow_rent_min = ctx.accounts.rent.minimum_balance(escrow_len);
    let tip = config.auto_deposit_tip_lamports;
    let round_cost = auto_deposit_round_cost(amount, entry_rent, tip)?;
    let spendable = escrow_spendable(ctx.accounts.escrow.get_lamports(), escrow_rent_min);
    require!(
        spendable >= round_cost,
        OrbitError::EscrowInsufficientBalance
    );

    // The ticket range: start = total before, end = total after — exactly
    // the fold the Phase 1 partition property test drives (I9).
    let total_before = round.total_lamports;
    let range = next_range(total_before, amount).map_err(OrbitError::from)?;
    round.total_lamports = range.end;
    round.vault_owed = round
        .vault_owed
        .checked_add(amount)
        .ok_or(OrbitError::ArithmeticOverflow)?;

    let entry_index = round.entry_count;
    ctx.accounts.entry.set_inner(PlayerEntry {
        round_id: round.round_id,
        entry_index,
        // R1: the escrow PDA, never the owner's wallet. Every payout path
        // (claim_winnings, close_entry, refund_entry) routes here, which is
        // what makes reinvestment free with zero changes to those handlers.
        player: ctx.accounts.escrow.key(),
        amount,
        ticket_start: range.start,
        ticket_end: range.end,
        deposit_ts: clock.unix_timestamp,
        deposit_slot: clock.slot,
        bump: ctx.bumps.entry,
        reserved: [0; 16],
    });

    // O(1) sole-depositor tracking, byte-identical to `deposit` but keyed
    // on the escrow PDA. Consequence accepted in the design (§2.1.4): a
    // wallet deposit plus its own escrow in one round reads as two players,
    // so the round settles instead of auto-cancelling.
    if entry_index == 0 {
        round.first_depositor = ctx.accounts.escrow.key();
        round.single_depositor = true;
    } else if ctx.accounts.escrow.key() != round.first_depositor {
        round.single_depositor = false;
    }

    round.entry_count = round
        .entry_count
        .checked_add(1)
        .ok_or(OrbitError::ArithmeticOverflow)?;

    // R3: no anti-snipe extension, no `end_ts` write. The extension is
    // structurally absent from this instruction — a permissionless caller
    // extending the deadline with the escrow's lamports is exactly the
    // griefing lever this omission closes.

    // Lamport moves — direct arithmetic only (a System CPI cannot debit a
    // program-owned account). Conservation: the crank already paid
    // `entry_rent` into the entry during `init`, so its net delta across
    // the transaction is `+tip − tx_fee`; nothing but `amount` enters the
    // `RoundVault`, so I1 holds with `vault_owed` up by exactly `amount`.
    ctx.accounts.escrow.sub_lamports(round_cost)?;
    ctx.accounts.round_vault.add_lamports(amount)?;
    let crank_credit = entry_rent
        .checked_add(tip)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    ctx.accounts.crank.add_lamports(crank_credit)?;

    // Escrow bookkeeping. `rounds_remaining` under `auto_reinvest` is
    // re-derived from what the spendable balance now buys (capped at
    // `max_rounds` so exposure stays bounded); winnings, refunds and rent
    // rebates that landed in the escrow therefore buy more rounds. With
    // the flag off it strictly counts down (`> 0` proven above).
    let escrow = &mut ctx.accounts.escrow;
    escrow.next_eligible_round_id = round_id
        .checked_add(1)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    escrow.rounds_funded = escrow
        .rounds_funded
        .checked_add(1)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    escrow.lifetime_staked = escrow
        .lifetime_staked
        .checked_add(amount)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    let spendable_after = escrow_spendable(escrow.get_lamports(), escrow_rent_min);
    let rounds_remaining = if escrow.auto_reinvest {
        rounds_affordable(spendable_after, round_cost, escrow.max_rounds)
    } else {
        escrow.rounds_remaining - 1
    };
    escrow.rounds_remaining = rounds_remaining;

    emit!(AutoDeposited {
        round_id: round.round_id,
        entry_index,
        owner: escrow.owner,
        escrow: escrow.key(),
        amount,
        tip,
        entry_rent,
        ticket_start: range.start,
        ticket_end: range.end,
        round_total: round.total_lamports,
        rounds_remaining,
    });
    if rounds_remaining == 0 {
        emit!(EscrowDepleted {
            owner: escrow.owner,
            escrow: escrow.key(),
            last_round_id: round_id,
        });
    }

    // I8, belt over Phase 1's proof: the minted range is exactly the
    // pre/post totals of this deposit.
    require_eq!(
        ctx.accounts.entry.ticket_start,
        total_before,
        OrbitError::IllegalStateTransition
    );
    require_eq!(
        ctx.accounts.entry.ticket_end,
        round.total_lamports,
        OrbitError::IllegalStateTransition
    );

    // I1: the vault now holds rent + everything it owes — the entry rent
    // and the tip never transit it.
    let vault_len = RoundVault::INIT_SPACE
        .checked_add(8)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    let vault_rent_min = ctx.accounts.rent.minimum_balance(vault_len);
    assert_round_vault_solvent(
        ctx.accounts.round_vault.get_lamports(),
        vault_rent_min,
        round.vault_owed,
    )?;
    // I16: the escrow never dropped below its rent floor.
    assert_escrow_rent_exempt(ctx.accounts.escrow.get_lamports(), escrow_rent_min)?;
    Ok(())
}
