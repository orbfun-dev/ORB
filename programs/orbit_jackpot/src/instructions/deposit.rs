//! `deposit` — the hot path (roadmap task 3.4; Phase 11.6: the universal
//! profile; Phase 12: stale-window revival).
//!
//! Escrows 100% of `amount` into the `RoundVault` via a System-program CPI
//! (ADR-7: fees are taken at settlement, never here, which is what makes
//! refunds exact), mints one `PlayerEntry` PDA at the current `entry_count`
//! with its half-open ticket range from `next_range`, and maintains the
//! O(1) sole-depositor flag. Everything in this instruction is O(1) in the
//! entry count (ADR-1).
//!
//! Phase 12: a deposit into an **expired-but-empty** round revives the
//! window first, in this same transaction (`RoundWindowRolled`, reason
//! `ROLL_REASON_FIRST_DEPOSIT`) — so while nobody is playing, the keeper
//! can send literally nothing and the round still accepts the first bet
//! whenever it comes. A non-empty expired round stays closed (R3); a
//! deposit into a live window is byte-for-byte unaffected.
//!
//! Phase 11.6 (decision D1, universal): `PlayerEscrow` is THE player
//! profile — a first-ever bet creates it here (and pays the one-time
//! `account_open_fee_lamports` through the same shared
//! `charge_account_open_fee` the escrow path uses, so the fee is
//! exactly-once per wallet across both paths). Two silent footguns the
//! design pins down:
//!
//! - **A profile born here is DORMANT** (`rounds_remaining = 0`, all terms
//!   zeroed): a direct depositor is never silently enrolled into
//!   auto-deposit — `crank_auto_deposit` refuses a zero budget with
//!   `EscrowBudgetExhausted`, and a later `init_or_deposit_escrow` call
//!   re-declares real terms normally.
//! - **`entry.player` stays the wallet**, never the escrow PDA. The
//!   escrow-as-`entry.player` rule is `crank_auto_deposit`'s alone
//!   (Phase 10 R1): routing a direct bet's refund into an escrow the
//!   player never opted into would surprise them and break the web claim
//!   flow.

use crate::constants::{
    CONFIG_SEED, ENTRY_SEED, ESCROW_SEED, MEGA_POT_SEED, ROUND_SEED, ROUND_VAULT_SEED,
};
use crate::errors::OrbitError;
use crate::events::{Deposited, RoundWindowRolled, ROLL_REASON_FIRST_DEPOSIT};
use crate::invariants::{assert_escrow_rent_exempt, assert_round_vault_solvent};
use crate::math::next_range;
use crate::state::{
    GlobalConfig, MegaPotVault, PlayerEntry, PlayerEscrow, Round, RoundState, RoundVault,
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(
        mut,
        seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()],
        bump = round.bump
    )]
    pub round: Account<'info, Round>,
    /// A wrong `entry_index` is structurally unforgeable: the seed is
    /// derived from `round.entry_count` itself (ADR-1), and `init` refuses
    /// an existing account, so index collisions fail cleanly for the client
    /// to retry.
    #[account(
        init,
        seeds = [
            ENTRY_SEED,
            round.round_id.to_le_bytes().as_ref(),
            round.entry_count.to_le_bytes().as_ref()
        ],
        bump,
        payer = player,
        space = 8 + PlayerEntry::INIT_SPACE
    )]
    pub entry: Account<'info, PlayerEntry>,
    #[account(
        mut,
        seeds = [ROUND_VAULT_SEED, round.round_id.to_le_bytes().as_ref()],
        bump = round.vault_bump
    )]
    pub round_vault: Account<'info, RoundVault>,
    /// The player profile (Phase 11.6, decision D1): created on the
    /// first-ever bet, reused by every later one. `init_if_needed` is safe
    /// for the same reason as in `init_or_deposit_escrow`: the seed
    /// contains the SIGNER's key, so a different signer derives a
    /// different PDA and cross-owner reinitialisation is structurally
    /// impossible.
    #[account(
        init_if_needed,
        seeds = [ESCROW_SEED, player.key().as_ref()],
        bump,
        payer = player,
        space = 8 + PlayerEscrow::INIT_SPACE
    )]
    pub escrow: Account<'info, PlayerEscrow>,
    /// Fee sink for the one-time profile charge.
    #[account(mut, seeds = [MEGA_POT_SEED], bump = mega_pot.bump)]
    pub mega_pot: Account<'info, MegaPotVault>,
    #[account(mut)]
    pub player: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn process(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    let config = &ctx.accounts.config;
    let round = &mut ctx.accounts.round;

    require!(!config.paused, OrbitError::Paused);
    require!(round.state == RoundState::Open, OrbitError::RoundNotOpen);
    let clock = Clock::get()?;
    // The time gate, not the state gate, is what closes the window — even if
    // no lock crank has run yet. Phase 12 exception (R2/R3): a window that
    // expired while STILL EMPTY is revived right here, in the first bettor's
    // own transaction — both timestamps move, so the anti-snipe extension
    // below and `crank_auto_deposit`'s window both see a fresh, sane window.
    // A round with any money in it stays closed: re-timing a live pot would
    // re-price the game under the players' feet.
    if clock.unix_timestamp >= round.end_ts {
        require!(
            Round::may_roll_window(round.state, round.total_lamports),
            OrbitError::DepositWindowClosed
        );
        let (start_ts, end_ts) =
            Round::rolled_window(clock.unix_timestamp, config.round_duration_secs)?;
        round.start_ts = start_ts;
        round.end_ts = end_ts;
        emit!(RoundWindowRolled {
            round_id: round.round_id,
            start_ts,
            end_ts,
            reason: ROLL_REASON_FIRST_DEPOSIT,
        });
    }
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

    // ── the player profile (Phase 11.6): born dormant on the first-ever
    // bet, with the one-time fee charged on top of rent through the SAME
    // shared helper the escrow path uses (D1: once per wallet, both
    // paths). A repeat bet touches nothing here. ──
    let escrow_len = PlayerEscrow::INIT_SPACE
        .checked_add(8)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    let escrow_rent_min = ctx.accounts.rent.minimum_balance(escrow_len);
    if ctx.accounts.escrow.owner == Pubkey::default() {
        ctx.accounts.escrow.set_inner(PlayerEscrow {
            owner: ctx.accounts.player.key(),
            // DORMANT by design: a direct depositor never opted into
            // auto-deposit, and `rounds_remaining == 0` is what
            // `crank_auto_deposit` refuses.
            per_round_lamports: 0,
            max_rounds: 0,
            rounds_remaining: 0,
            next_eligible_round_id: 0,
            rounds_funded: 0,
            lifetime_deposited: 0,
            lifetime_staked: 0,
            auto_reinvest: false,
            bump: ctx.bumps.escrow,
            reserved: [0; 32],
        });
        super::init_or_deposit_escrow::charge_account_open_fee(
            config.account_open_fee_lamports,
            escrow_rent_min,
            &ctx.accounts.player,
            &ctx.accounts.escrow.key(),
            &mut ctx.accounts.mega_pot,
            &ctx.accounts.system_program,
        )?;
    }
    assert_escrow_rent_exempt(ctx.accounts.escrow.get_lamports(), escrow_rent_min)?;

    // The ticket range: start = total before, end = total after. This is
    // exactly the fold Phase 1's partition property test drives (I9).
    let total_before = round.total_lamports;
    let range = next_range(total_before, amount).map_err(OrbitError::from)?;
    round.total_lamports = range.end;
    round.vault_owed = round
        .vault_owed
        .checked_add(amount)
        .ok_or(OrbitError::ArithmeticOverflow)?;

    let entry_index = round.entry_count;
    // R5 (identity): the entry belongs to the WALLET, never the escrow —
    // refunds of a direct bet land where the player can see them.
    ctx.accounts.entry.set_inner(PlayerEntry {
        round_id: round.round_id,
        entry_index,
        player: ctx.accounts.player.key(),
        amount,
        ticket_start: range.start,
        ticket_end: range.end,
        deposit_ts: clock.unix_timestamp,
        deposit_slot: clock.slot,
        bump: ctx.bumps.entry,
        reserved: [0; 16],
    });

    // O(1) sole-depositor tracking: true until a different player deposits.
    if entry_index == 0 {
        round.first_depositor = ctx.accounts.player.key();
        round.single_depositor = true;
    } else if ctx.accounts.player.key() != round.first_depositor {
        round.single_depositor = false;
    }

    round.entry_count = round
        .entry_count
        .checked_add(1)
        .ok_or(OrbitError::ArithmeticOverflow)?;

    // Anti-snipe: fairness perception only (roadmap 4.1) — in a pari-mutuel
    // pool entry time does not change EV, and depositing against known
    // randomness is already closed structurally by `seed_slot > lock_slot`.
    let (new_end_ts, extended) = apply_anti_snipe_extension(
        clock.unix_timestamp,
        round.start_ts,
        round.end_ts,
        config.anti_snipe_window_secs,
        config.anti_snipe_extension_secs,
        config.max_round_duration_secs,
        amount,
        config.anti_snipe_min_deposit_lamports,
    )?;
    round.end_ts = new_end_ts;

    // Native-SOL escrow: player → round_vault by System CPI. The vault is
    // program-owned, but the *depositor's* account is System-owned, so the
    // transfer must go through the System program.
    let cpi_ctx = CpiContext::new(
        ctx.accounts.system_program.to_account_info(),
        anchor_lang::system_program::Transfer {
            from: ctx.accounts.player.to_account_info(),
            to: ctx.accounts.round_vault.to_account_info(),
        },
    );
    anchor_lang::system_program::transfer(cpi_ctx, amount)?;

    emit!(Deposited {
        round_id: round.round_id,
        entry_index,
        player: ctx.accounts.player.key(),
        amount,
        ticket_start: range.start,
        ticket_end: range.end,
        round_total: round.total_lamports,
        new_end_ts,
        extended,
    });

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

    // I1: the vault now holds rent + everything it owes.
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

/// The pure decision core of the anti-snipe extension, separated so it is
/// unit-testable without accounts.
///
/// Three load-bearing guards (roadmap 4.1):
/// 1. The **absolute cap** — `end_ts` never exceeds
///    `start_ts + max_round_duration_secs`, stopping infinite extension.
/// 2. The **qualifying minimum deposit** — only amounts ≥
///    `anti_snipe_min_deposit_lamports` extend, stopping 1-lamport spam.
/// 3. **`min`, never additive** — the new end is `min(now + extension, cap)`,
///    so repeated qualifying deposits inside the window cannot compound.
///
/// Returns `(new_end_ts, extended)`; `extended` is true only when the
/// deadline actually moved, so the UI can show the clock jump.
#[allow(clippy::too_many_arguments)] // independent scalars; bundling would obscure the math
pub(crate) fn apply_anti_snipe_extension(
    now: i64,
    start_ts: i64,
    end_ts: i64,
    window_secs: i64,
    extension_secs: i64,
    max_round_duration_secs: i64,
    amount: u64,
    anti_snipe_min_deposit_lamports: u64,
) -> std::result::Result<(i64, bool), OrbitError> {
    let remaining = end_ts
        .checked_sub(now)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    if remaining >= window_secs {
        return Ok((end_ts, false));
    }
    if amount < anti_snipe_min_deposit_lamports {
        return Ok((end_ts, false));
    }
    let candidate = now
        .checked_add(extension_secs)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    let cap = start_ts
        .checked_add(max_round_duration_secs)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    let new_end_ts = candidate.min(cap);
    Ok((new_end_ts, new_end_ts > end_ts))
}

#[cfg(test)]
mod tests {
    use super::*;

    const WINDOW: i64 = 10;
    const EXTENSION: i64 = 10;
    const MAX_DURATION: i64 = 300;
    const MIN_EXTEND_AMOUNT: u64 = 50_000_000;

    fn decide(now: i64, end_ts: i64, start_ts: i64, amount: u64) -> (i64, bool) {
        apply_anti_snipe_extension(
            now,
            start_ts,
            end_ts,
            WINDOW,
            EXTENSION,
            MAX_DURATION,
            amount,
            MIN_EXTEND_AMOUNT,
        )
        .expect("scalar inputs within range")
    }

    #[test]
    fn deposits_outside_the_window_do_not_extend() {
        // end - now = 10 == window: not inside the window (strictly less).
        let (end, extended) = decide(1_000, 1_010, 1_000, MIN_EXTEND_AMOUNT);
        assert_eq!(end, 1_010);
        assert!(!extended);
        let (end, extended) = decide(1_000, 1_011, 1_000, MIN_EXTEND_AMOUNT);
        assert_eq!(end, 1_011);
        assert!(!extended);
    }

    #[test]
    fn small_deposits_inside_the_window_do_not_extend() {
        // 1-lamport extension spam is exactly what this guard stops.
        let (end, extended) = decide(1_005, 1_010, 1_000, MIN_EXTEND_AMOUNT - 1);
        assert_eq!(end, 1_010);
        assert!(!extended);
    }

    #[test]
    fn qualifying_deposit_extends_to_now_plus_extension() {
        let (end, extended) = decide(1_005, 1_010, 1_000, MIN_EXTEND_AMOUNT);
        assert_eq!(end, 1_015); // now + 10, not end + 10
        assert!(extended);
    }

    #[test]
    fn extension_is_capped_by_max_round_duration() {
        // start + max = 1_300; now + ext = 1_295 < cap → uncapped here.
        let (end, _) = decide(1_285, 1_290, 1_000, MIN_EXTEND_AMOUNT);
        assert_eq!(end, 1_295);
        // now + ext = 1_305 > cap → capped.
        let (end, extended) = decide(1_295, 1_300, 1_000, MIN_EXTEND_AMOUNT);
        assert_eq!(end, 1_300);
        assert!(!extended);
    }

    #[test]
    fn repeated_qualifying_deposits_cannot_compound() {
        // Two qualifying deposits one second apart: the second re-derives
        // min(now2 + ext, cap) instead of adding to the extended end.
        let (end1, _) = decide(1_005, 1_010, 1_000, MIN_EXTEND_AMOUNT);
        assert_eq!(end1, 1_015);
        let (end2, extended) = decide(1_006, end1, 1_000, MIN_EXTEND_AMOUNT);
        assert_eq!(end2, 1_016); // now2 + 10 — not end1 + 10 = 1_025
        assert!(extended);
        // Even a thousand qualifying deposits stay bounded by the cap.
        let mut end = 1_010;
        for second in 0..1_000i64 {
            end = decide(1_000 + second, end, 1_000, MIN_EXTEND_AMOUNT).0;
            assert!(end <= 1_300, "cap violated at second {second}: {end}");
        }
        assert_eq!(end, 1_300);
    }
}
