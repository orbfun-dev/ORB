//! `fulfill_settle` — the economic core (roadmap task 3.8, Phase 11.3).
//!
//! Permissionless and outcome-independent of the caller (ADR-2, I13): every
//! account is seed-derived or pinned, and `winning_ticket` is a function of
//! `(pinned randomness value, total_lamports)` alone. A crank cannot bias it.
//! Settlement records a *ticket*, never a winner — claiming proves
//! membership. Nothing here iterates entries: the crank is O(1).
//!
//! Money flow at settle, four-way under Phase 11 economics (all direct
//! lamport arithmetic on program-owned vaults; fees are taken here and only
//! here, ADR-7):
//!
//! ```text
//! round_vault: rent+total ──(admin_cut)──> treasury  (less keeper tip ──> crank)
//! round_vault: rent+total ──(mega_cut)───> mega_pot  (contribution)
//! if triggered: mega_pot ──(mega_awarded + mega_field_pool)──> round_vault  (ADR-8 snapshot)
//! round_vault ends at: rent + winner_payout + refund_pool + mega_awarded + mega_field_pool
//!                     == rent + vault_owed
//! ```
//!
//! The pro-rata denominator is `total_lamports`, never "losers' stakes" (R1).
//! Under economics v2 settlement does not know who the winner is, and the
//! uniform dock keeps every player's expected value at a flat −2% of stake.
//! Under v3 (2026-10-08) the crank passes the winning entry so the 2% rake
//! falls on the losers' money only and the winner's stake is never docked —
//! see `split_round_pot_v3`; refunds and claims are unchanged. Under a
//! pre-Phase-11 config (zeroed new fields) every formula below collapses to
//! v1 arithmetic bit-for-bit — no version branches (R6).

use crate::constants::{
    CONFIG_SEED, ENTRY_SEED, MEGA_POT_SEED, ROUND_SEED, ROUND_VAULT_SEED, TREASURY_SEED,
};
use crate::entropy::split_entropy;
use crate::errors::OrbitError;
use crate::events::{MegaPotContribution, MegaPotTriggered, RoundSettled};
use crate::invariants::{
    assert_mega_pot_consistent, assert_mega_split_exact_3, assert_pools_solvent,
    assert_pot_split_exact, assert_round_vault_solvent, assert_treasury_consistent,
};
use crate::math::{
    mega_triggered, range_contains, split_mega_pot, split_round_pot, split_round_pot_v3,
    ticket_from_entropy, TicketRange,
};
use crate::oracle::switchboard::SwitchboardRandomness;
use crate::oracle::{classify_pinned, PinnedSource, RandomnessSource};
use crate::state::{
    EntropyChain, GlobalConfig, MegaPotVault, PlayerEntry, Round, RoundState, RoundVault,
    TreasuryVault, ENTROPY_NONE,
};
use anchor_lang::prelude::*;

#[event_cpi]
#[derive(Accounts)]
pub struct FulfillSettle<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
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
    #[account(mut, seeds = [TREASURY_SEED], bump = treasury.bump)]
    pub treasury: Account<'info, TreasuryVault>,
    #[account(mut, seeds = [MEGA_POT_SEED], bump = mega_pot.bump)]
    pub mega_pot: Account<'info, MegaPotVault>,
    /// The exact account pinned at request time: a Switchboard randomness
    /// account, or the `EntropyChain` singleton (writable: settle clears its
    /// `value_round`). Key equality with the pin, the source classification
    /// (`classify_pinned`), authority binding, reveal state and freshness
    /// are all checked in the handler.
    ///
    /// CHECK: key pinned on the round; ownership classified in the handler.
    #[account(mut)]
    pub randomness_account: UncheckedAccount<'info>,
    /// Permissionless crank caller (I13); receives the keeper tip, which is
    /// paid out of the 1% admin cut — never a fourth slice.
    #[account(mut)]
    pub authority: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn process(ctx: Context<FulfillSettle>) -> Result<()> {
    let config = &ctx.accounts.config;
    let round = &mut ctx.accounts.round;
    require!(
        round.state == RoundState::AwaitingRandomness,
        OrbitError::RoundNotAwaitingRandomness
    );
    // The pin: settlement accepts exactly the account request_randomness
    // recorded — no shopping among accounts for a favorable value.
    require_keys_eq!(
        ctx.accounts.randomness_account.key(),
        round.randomness_account,
        OrbitError::RandomnessAccountMismatch
    );

    let randomness_info = ctx.accounts.randomness_account.to_account_info();
    let (value, seed_slot) =
        match classify_pinned(&randomness_info, &config.oracle_program_id)? {
            PinnedSource::Switchboard => {
                let randomness = SwitchboardRandomness::parse(&randomness_info)?;
                // ADR-4 check 2, restated at settle: the authority is still
                // the round PDA.
                require_keys_eq!(
                    randomness.authority(),
                    round.key(),
                    OrbitError::RandomnessAuthorityMismatch
                );
                require!(randomness.is_revealed(), OrbitError::RandomnessNotRevealed);
                (randomness.value(), randomness.seed_slot())
            }
            PinnedSource::Entropy => {
                let mut chain = EntropyChain::load(&randomness_info)?;
                require!(
                    chain.value_round == round.round_id,
                    OrbitError::RandomnessNotRevealed
                );
                let revealed = (chain.value, chain.value_slot);
                // Consumed: the chain may now serve the next round.
                chain.value_round = ENTROPY_NONE;
                chain.store(&randomness_info)?;
                revealed
            }
            PinnedSource::Closed => return err!(OrbitError::RandomnessNotRevealed),
        };
    // ADR-4 check 3 — freshness: the randomness was seeded strictly after
    // the deposit window closed, so no one deposited against a known outcome.
    require!(seed_slot > round.lock_slot, OrbitError::StaleRandomness);

    // ── pure-math core (Phase 1, property-tested) ──
    let total = round.total_lamports;
    let (ticket_seed, mega_seed) = split_entropy(&value);
    // A zero-deposit round can never reach here (it cancels at lock), so the
    // ZeroTotal guard is a hard belt, not a live path (ADR-5).
    let winning_ticket = ticket_from_entropy(ticket_seed, total).map_err(OrbitError::from)?;
    // Economics v3: the winner's own stake is never raked. Settlement then
    // has to know that stake, so the crank passes the winning entry as the
    // first remaining account (it can compute the ticket off-chain from the
    // revealed value, exactly as below); everything about it is verified
    // here. v2 rounds ignore remaining accounts and keep the old math.
    // `rake_base` is what the 2% is charged on — and therefore also what
    // the Mega-Pot payout cap scales with (I21: a round can never be paid
    // more than it could have been charged in rake).
    let (split, rake_base) = if config.economics_version >= 3 {
        let winner_stake =
            winning_entry_stake(ctx.remaining_accounts.first(), round.round_id, winning_ticket)?;
        let split = split_round_pot_v3(
            total,
            winner_stake,
            config.winner_bps,
            config.fee_bps_admin,
            config.fee_bps_mega,
        )
        .map_err(OrbitError::from)?;
        (split, total - winner_stake)
    } else {
        let split = split_round_pot(
            total,
            config.winner_bps,
            config.fee_bps_admin,
            config.fee_bps_mega,
        )
        .map_err(OrbitError::from)?;
        (split, total)
    };
    let triggered =
        mega_triggered(mega_seed, config.mega_trigger_modulus).map_err(OrbitError::from)?;
    // I18 — the four-way split reassembles the pot to the lamport, at the
    // only place money moves.
    assert_pot_split_exact(
        total,
        split.winner_payout,
        split.refund_pool,
        split.admin_cut,
        split.mega_cut,
    )?;

    // The keeper tip comes out of the admin slice, never a fourth slice.
    let (treasury_credit, keeper_tip) =
        split_admin_cut(split.admin_cut, config.keeper_tip_lamports)?;

    // The Mega-Pot split is decided from the AUTHORITATIVE accrual — never
    // from `lamports()`, which includes the rent-exempt minimum and would
    // let an award push the vault below exemption (§3, MegaPotVault) — and
    // it is read BEFORE any balance move, preserving the v1 convention that
    // a round cannot win its own contribution. Do not reorder this: reading
    // it after the moves would silently change payouts.
    let accrued_before = ctx.accounts.mega_pot.accrued_lamports;
    let (mega_awarded, mega_field_pool, mega_retained) = if triggered {
        let mega_split = split_mega_pot(
            accrued_before,
            rake_base,
            config.mega_award_bps,
            config.mega_field_bps,
            config.mega_payout_cap_bps,
        )
        .map_err(OrbitError::from)?;
        // I19 — the trigger split reassembles the accrual exactly, capped
        // or not.
        assert_mega_split_exact_3(
            accrued_before,
            mega_split.awarded,
            mega_split.field_pool,
            mega_split.retained,
        )?;
        (
            mega_split.awarded,
            mega_split.field_pool,
            mega_split.retained,
        )
    } else {
        (0, 0, 0)
    };

    // ── balance moves ──
    ctx.accounts.round_vault.sub_lamports(split.admin_cut)?;
    ctx.accounts.treasury.add_lamports(treasury_credit)?;
    ctx.accounts.authority.add_lamports(keeper_tip)?;
    ctx.accounts.round_vault.sub_lamports(split.mega_cut)?;
    ctx.accounts.mega_pot.add_lamports(split.mega_cut)?;
    if triggered {
        let mega_payout = mega_awarded
            .checked_add(mega_field_pool)
            .ok_or(OrbitError::ArithmeticOverflow)?;
        ctx.accounts.mega_pot.sub_lamports(mega_payout)?;
        // ADR-8 snapshot: the whole trigger payout moves into round_vault
        // now, so a concurrently-settling round can never change it. The
        // winner's share leaves at `claim_winnings`; the field's share at
        // each `close_entry`.
        ctx.accounts.round_vault.add_lamports(mega_payout)?;
    }

    // ── bookkeeping ──
    let treasury = &mut ctx.accounts.treasury;
    treasury.accrued_lamports = treasury
        .accrued_lamports
        .checked_add(treasury_credit)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    treasury.lifetime_accrued = treasury
        .lifetime_accrued
        .checked_add(treasury_credit)
        .ok_or(OrbitError::ArithmeticOverflow)?;

    let mega_pot = &mut ctx.accounts.mega_pot;
    mega_pot.accrued_lamports = mega_pot
        .accrued_lamports
        .checked_add(split.mega_cut)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    mega_pot.lifetime_contributed = mega_pot
        .lifetime_contributed
        .checked_add(split.mega_cut)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    emit!(MegaPotContribution {
        round_id: round.round_id,
        amount: split.mega_cut,
        accrued_after: mega_pot.accrued_lamports,
    });
    if triggered {
        // Emitted even on a zero balance, keeping the 1-in-N statistics
        // honest and auditable (§8 item 12).
        let awarded_total = mega_awarded
            .checked_add(mega_field_pool)
            .ok_or(OrbitError::ArithmeticOverflow)?;
        mega_pot.accrued_lamports = mega_pot
            .accrued_lamports
            .checked_sub(awarded_total)
            .ok_or(OrbitError::MegaPotInvariant)?;
        mega_pot.lifetime_awarded = mega_pot
            .lifetime_awarded
            .checked_add(awarded_total)
            .ok_or(OrbitError::ArithmeticOverflow)?;
        mega_pot.trigger_count = mega_pot
            .trigger_count
            .checked_add(1)
            .ok_or(OrbitError::ArithmeticOverflow)?;
        mega_pot.last_trigger_round_id = round.round_id;
        mega_pot.cycle_index = mega_pot
            .cycle_index
            .checked_add(1)
            .ok_or(OrbitError::ArithmeticOverflow)?;
        emit_cpi!(MegaPotTriggered {
            round_id: round.round_id,
            cycle_index: mega_pot.cycle_index,
            awarded: mega_awarded,
            field_pool: mega_field_pool,
            retained: mega_retained,
        });
    }
    let mega_pot_remaining = mega_pot.accrued_lamports;

    // ── round resolution ──
    round.winning_ticket = winning_ticket;
    round.winner_payout = split.winner_payout;
    round.refund_pool = split.refund_pool;
    round.refunds_paid = 0;
    round.mega_field_pool = mega_field_pool;
    round.mega_field_paid = 0;
    round.admin_cut = split.admin_cut;
    round.mega_cut = split.mega_cut;
    round.mega_awarded = mega_awarded;
    round.mega_triggered = triggered;
    round.randomness_seed_slot = seed_slot;
    round.settle_ts = Clock::get()?.unix_timestamp;
    // ADR-6: `Settled` owes the winner's slice, the field's refund pool and
    // both trigger slices snapshotted into the vault — the single balance
    // invariant, restated. Under a v1 config `refund_pool` and
    // `mega_field_pool` read zero and this is exactly the v1 obligation.
    round.vault_owed = split
        .winner_payout
        .checked_add(split.refund_pool)
        .and_then(|sum| sum.checked_add(mega_awarded))
        .and_then(|sum| sum.checked_add(mega_field_pool))
        .ok_or(OrbitError::ArithmeticOverflow)?;
    RoundState::try_transition(round.state, RoundState::Settled)?;
    round.state = RoundState::Settled;
    // I10, runtime belt over Phase 1's proof: a settled ticket is inside the
    // space.
    require!(
        round.winning_ticket < round.total_lamports,
        OrbitError::InvalidTicketTotal
    );

    // Carries the raw value so any third party can recompute the outcome —
    // public verifiability is a product feature here, not just hygiene.
    // `winner_payout` is the 9% slice under v2 economics (indexers: it was
    // the 98% residual before Phase 11).
    emit_cpi!(RoundSettled {
        round_id: round.round_id,
        winning_ticket,
        total_lamports: total,
        winner_payout: split.winner_payout,
        refund_pool: split.refund_pool,
        admin_cut: split.admin_cut,
        mega_cut: split.mega_cut,
        mega_triggered: triggered,
        mega_awarded,
        mega_field_pool,
        mega_pot_remaining,
        randomness_seed_slot: seed_slot,
        randomness_value: value,
    });

    // ── invariant tails: I1, I2+I5, I3+I4, I20 (both pools untouched) ──
    let round_vault_len = RoundVault::INIT_SPACE
        .checked_add(8)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    let treasury_len = TreasuryVault::INIT_SPACE
        .checked_add(8)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    let mega_len = MegaPotVault::INIT_SPACE
        .checked_add(8)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    let rent = &ctx.accounts.rent;
    assert_round_vault_solvent(
        ctx.accounts.round_vault.get_lamports(),
        rent.minimum_balance(round_vault_len),
        round.vault_owed,
    )?;
    assert_treasury_consistent(
        ctx.accounts.treasury.get_lamports(),
        rent.minimum_balance(treasury_len),
        ctx.accounts.treasury.accrued_lamports,
        ctx.accounts.treasury.lifetime_accrued,
        ctx.accounts.treasury.lifetime_swept,
    )?;
    assert_mega_pot_consistent(
        ctx.accounts.mega_pot.get_lamports(),
        rent.minimum_balance(mega_len),
        ctx.accounts.mega_pot.accrued_lamports,
        ctx.accounts.mega_pot.lifetime_contributed,
        ctx.accounts.mega_pot.lifetime_awarded,
    )?;
    assert_pools_solvent(
        round.refund_pool,
        round.refunds_paid,
        round.mega_field_pool,
        round.mega_field_paid,
    )?;
    Ok(())
}

/// Economics v3: the stake of the entry holding `winning_ticket`, from an
/// account the crank supplies. Verified completely — owned by this program,
/// a real `PlayerEntry` at its canonical PDA, for THIS round, and its ticket
/// range contains the winning ticket — so a caller cannot shrink or inflate
/// the winner's stake by passing some other entry.
fn winning_entry_stake(
    account: Option<&AccountInfo>,
    round_id: u64,
    winning_ticket: u64,
) -> Result<u64> {
    let info = account.ok_or(OrbitError::WinningEntryRequired)?;
    require_keys_eq!(*info.owner, crate::ID, OrbitError::WinningEntryMismatch);
    let entry = {
        let data = info.try_borrow_data()?;
        PlayerEntry::try_deserialize(&mut &data[..]).map_err(|_| OrbitError::WinningEntryMismatch)?
    };
    require_eq!(entry.round_id, round_id, OrbitError::WinningEntryMismatch);
    let expected = Pubkey::create_program_address(
        &[
            ENTRY_SEED,
            round_id.to_le_bytes().as_ref(),
            entry.entry_index.to_le_bytes().as_ref(),
            &[entry.bump],
        ],
        &crate::ID,
    )
    .map_err(|_| OrbitError::WinningEntryMismatch)?;
    require_keys_eq!(info.key(), expected, OrbitError::WinningEntryMismatch);
    require!(
        range_contains(
            &TicketRange {
                start: entry.ticket_start,
                end: entry.ticket_end,
            },
            winning_ticket
        ),
        OrbitError::WinningEntryMismatch
    );
    Ok(entry.amount)
}

/// Splits the admin cut into the treasury credit and the keeper tip.
///
/// The tip is capped at the cut itself — the keeper incentive comes out of
/// the 1% admin slice and can never become a fourth charge on the pot
/// (§8 item 9). Returns `(treasury_credit, keeper_tip)`.
pub(crate) fn split_admin_cut(
    admin_cut: u64,
    keeper_tip_lamports: u64,
) -> std::result::Result<(u64, u64), OrbitError> {
    let tip = keeper_tip_lamports.min(admin_cut);
    let treasury_credit = admin_cut
        .checked_sub(tip)
        .ok_or(OrbitError::ArithmeticOverflow)?;
    Ok((treasury_credit, tip))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeper_tip_never_exceeds_its_slice() {
        assert_eq!(split_admin_cut(100, 0).expect("plain cut"), (100, 0));
        assert_eq!(split_admin_cut(100, 30).expect("partial tip"), (70, 30));
        assert_eq!(split_admin_cut(100, 100).expect("full tip"), (0, 100));
        // An oversized configured tip is clamped to the cut, never a fourth
        // slice on the pot.
        assert_eq!(split_admin_cut(100, 5_000).expect("clamped tip"), (0, 100));
        assert_eq!(split_admin_cut(0, 10).expect("empty cut"), (0, 0));
        assert_eq!(
            split_admin_cut(u64::MAX, u64::MAX).expect("max values"),
            (0, u64::MAX)
        );
    }
}
