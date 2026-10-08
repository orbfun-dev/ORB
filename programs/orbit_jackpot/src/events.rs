//! The program's event catalog (roadmap task 2.7 + Phase 10 + Phase 11 +
//! Phase 12): twenty-two events.
//!
//! The three economically significant ones (`RoundSettled`, `PrizeClaimed`,
//! `MegaPotTriggered`) must survive log truncation: plain `emit!` writes to
//! program logs, which truncate under load, and an indexer that misses a
//! settlement cannot reconstruct it. In `anchor-lang 0.32.2` the mechanism
//! (verified against the macro source) is that Phase 3's emitting
//! instructions mark their `#[derive(Accounts)]` context with
//! `#[event_cpi]` — which appends the `event_authority` and `program`
//! accounts — and emit via `emit_cpi!`, a self-CPI that lands in the
//! transaction metadata instead of the truncated program log. The event
//! structs themselves are plain `#[event]` either way.
//!
//! The four Phase 10 escrow events are plain `emit!` (consistent with
//! `Deposited`): the keeper's escrow registry treats a missed log as a
//! latency problem, not a correctness one — the bounded GPA reconciliation
//! decides.

use anchor_lang::prelude::*;

/// A new round began accepting deposits.
#[event]
pub struct RoundOpened {
    pub round_id: u64,
    pub start_ts: i64,
    pub end_ts: i64,
}

/// A deposit minted one entry and its ticket range. `extended` is set when
/// the anti-snipe timer moved, so the UI can show the clock jumping rather
/// than appearing to freeze.
#[event]
pub struct Deposited {
    pub round_id: u64,
    pub entry_index: u32,
    pub player: Pubkey,
    pub amount: u64,
    pub ticket_start: u64,
    pub ticket_end: u64,
    pub round_total: u64,
    pub new_end_ts: i64,
    pub extended: bool,
}

/// The deposit window closed.
#[event]
pub struct RoundLocked {
    pub round_id: u64,
    pub lock_ts: i64,
    pub lock_slot: u64,
    pub total_lamports: u64,
    pub entry_count: u32,
}

/// The round pinned its randomness account (ADR-4). There is exactly one
/// such event per non-cancelled-at-lock round; re-pinning is impossible.
#[event]
pub struct RandomnessRequested {
    pub round_id: u64,
    pub randomness_account: Pubkey,
    pub commit_slot: u64,
}

/// The round PDA itself committed its pinned randomness account through the
/// Switchboard On-Demand `randomness_commit` CPI — the commit half of ADR-4.
/// The account's authority is the round PDA, so only this program can ever
/// commit, and exactly once. `seed_slot` is read back from the account after
/// the CPI; `fulfill_settle` re-checks its freshness against `lock_slot`.
#[event]
pub struct RandomnessCommitted {
    pub round_id: u64,
    pub randomness_account: Pubkey,
    pub oracle: Pubkey,
    pub seed_slot: u64,
}

/// The economic core: outcome and split of a settled round. Carries
/// `winning_ticket`, `total_lamports` **and** the raw `randomness_value` so
/// any third party can independently recompute the outcome — public
/// verifiability is a product feature here, not just hygiene.
///
/// **Phase 11 semantics change — indexers must be told:** `winner_payout`
/// now means *the 9% winner slice* (`floor(total × winner_bps/10_000)`),
/// not the v1 98% residual; the residual lives in `refund_pool`, paid
/// pro-rata to every entry by `close_entry`.
#[event]
pub struct RoundSettled {
    pub round_id: u64,
    pub winning_ticket: u64,
    pub total_lamports: u64,
    /// The winner's slice (9% of the pot under v2 economics).
    pub winner_payout: u64,
    /// The field's slice, drawn down pro-rata by `close_entry`.
    pub refund_pool: u64,
    pub admin_cut: u64,
    pub mega_cut: u64,
    pub mega_triggered: bool,
    pub mega_awarded: u64,
    /// The Mega-Pot field share snapshotted into the vault (ADR-8); `0`
    /// when the trigger did not fire.
    pub mega_field_pool: u64,
    pub mega_pot_remaining: u64,
    pub randomness_seed_slot: u64,
    pub randomness_value: [u8; 32],
}

/// The winning entry proved membership and was paid.
#[event]
pub struct PrizeClaimed {
    pub round_id: u64,
    pub entry_index: u32,
    pub winner: Pubkey,
    pub winning_ticket: u64,
    pub winner_payout: u64,
    pub mega_awarded: u64,
}

/// A round entered the terminal refund state.
/// `reason`: `0` = zero deposits (**historical** — pre-Phase-12 `lock_round`
/// cancelled empty rounds; since the window roll, no instruction produces
/// it, but devnet logs and indexers still carry it), `1` = sole depositor,
/// `2` = oracle timeout.
#[event]
pub struct RoundCancelled {
    pub round_id: u64,
    pub reason: u8,
}

/// The documented `RoundCancelled::reason` encodings.
pub const CANCEL_REASON_SOLE_DEPOSITOR: u8 = 1;
pub const CANCEL_REASON_ORACLE_TIMEOUT: u8 = 2;

/// The documented `RoundWindowRolled::reason` encodings (Phase 12).
/// `0` = rolled by `lock_round` (keeper or community crank);
/// `1` = revived by `deposit` (the first bettor's own transaction).
pub const ROLL_REASON_LOCK_SWEEP: u8 = 0;
pub const ROLL_REASON_FIRST_DEPOSIT: u8 = 1;

/// A cancelled round refunded one entry in full (ADR-7: fees are taken at
/// settlement only, so refunds are exact).
#[event]
pub struct EntryRefunded {
    pub round_id: u64,
    pub entry_index: u32,
    pub player: Pubkey,
    pub amount: u64,
}

/// A settled round's 1% cut landed in the progressive pot.
#[event]
pub struct MegaPotContribution {
    pub round_id: u64,
    pub amount: u64,
    pub accrued_after: u64,
}

/// The 1-in-N event (N = `mega_trigger_modulus`, 625 under Phase 11
/// economics): the pot fired and its payable split was snapshotted into
/// the round's vault (ADR-8) — `awarded` for the winner via
/// `claim_winnings`, `field_pool` pro-rata to every entry via
/// `close_entry`. Emitted even on a zero balance, so the trigger
/// statistics stay honest (§8 item 12).
#[event]
pub struct MegaPotTriggered {
    pub round_id: u64,
    pub cycle_index: u64,
    pub awarded: u64,
    pub field_pool: u64,
    pub retained: u64,
}

/// The treasury authority swept accrued fees out of the treasury vault.
#[event]
pub struct FeesSwept {
    pub amount: u64,
    pub destination: Pubkey,
}

/// An unclaimed prize lapsed into the Mega-Pot — value stays in the game
/// rather than becoming protocol revenue.
#[event]
pub struct UnclaimedPrizeSwept {
    pub round_id: u64,
    pub amount: u64,
    pub mega_pot_accrued_after: u64,
}

/// An escrow was funded (or re-funded) and its terms set. The keeper's
/// event-sourced registry keys off this; a missed log is healed by the
/// next GPA reconciliation.
#[event]
pub struct EscrowFunded {
    pub owner: Pubkey,
    pub escrow: Pubkey,
    pub amount: u64,
    pub per_round_lamports: u64,
    pub max_rounds: u32,
    pub rounds_remaining: u32,
    pub auto_reinvest: bool,
    /// The escrow's post-call on-chain balance (rent floor included).
    pub total_lamports: u64,
}

/// The owner withdrew spendable escrow lamports to their wallet. Not
/// pause-gated and carries no config dependency — fund exits keep maximum
/// liveness.
#[event]
pub struct EscrowWithdrawn {
    pub owner: Pubkey,
    pub escrow: Pubkey,
    pub amount: u64,
    /// The escrow's post-withdrawal on-chain balance (rent floor included).
    pub remaining: u64,
}

/// A permissionless crank entered an escrow into a round: one entry minted
/// with `player = escrow`, the stake moved to the round vault, and the
/// entry rent + tip reimbursed to the crank out of the escrow.
#[event]
pub struct AutoDeposited {
    pub round_id: u64,
    pub entry_index: u32,
    pub owner: Pubkey,
    pub escrow: Pubkey,
    pub amount: u64,
    pub tip: u64,
    pub entry_rent: u64,
    pub ticket_start: u64,
    pub ticket_end: u64,
    pub round_total: u64,
    pub rounds_remaining: u32,
}

/// An escrow's budget ran dry (or its balance can no longer buy a round);
/// fired once so the UI and the keeper registry can demote it without
/// polling. The account survives — the owner can re-fund or withdraw.
#[event]
pub struct EscrowDepleted {
    pub owner: Pubkey,
    pub escrow: Pubkey,
    pub last_round_id: u64,
}

// ── Phase 11 partial-loss economics ──

/// A settled round paid one entry its pro-rata slice of `refund_pool` and
/// (on a trigger) `mega_field_pool` at `close_entry`. `close_entry` is
/// permissionless and pays `entry.player` — for auto-deposit players that
/// is the escrow PDA, so the refund lands where `auto_reinvest` can roll
/// it into the next round; for direct depositors it is the wallet.
#[event]
pub struct EntryRefundPaid {
    pub round_id: u64,
    pub entry_index: u32,
    pub player: Pubkey,
    /// The entry's stake, for context.
    pub amount: u64,
    /// Pro-rata share of `refund_pool`.
    pub refund: u64,
    /// Pro-rata share of `mega_field_pool` (0 unless the round triggered).
    pub mega_field: u64,
}

/// At `close_round`, the two pro-rata pools' rounding dust (at most one
/// lamport per entry each, I22) swept to the Mega-Pot — the single
/// residual sink. Dust never reaches the treasury.
#[event]
pub struct RoundDustSwept {
    pub round_id: u64,
    pub amount: u64,
    pub mega_pot_accrued_after: u64,
}

/// A player's `PlayerEscrow` profile was created and the one-time
/// `account_open_fee_lamports` seeded the Mega-Pot. Charged on top of
/// rent (recorded separately here) and exactly once per wallet across
/// both creation paths.
#[event]
pub struct AccountOpened {
    pub owner: Pubkey,
    pub escrow: Pubkey,
    pub fee_lamports: u64,
    pub rent_lamports: u64,
    pub mega_pot_accrued_after: u64,
}

/// ADR-11 preflight: the pre-v2 Mega-Pot was drained to the treasury so the
/// migration's `accrued_lamports == 0` guard is satisfied by real
/// bookkeeping. Booked as a pot payout (`lifetime_awarded`), not a trigger;
/// the path refuses once `economics_version >= 2`.
#[event]
pub struct MegaPotDrainedPreflight {
    pub amount: u64,
    pub destination_treasury: Pubkey,
    pub mega_pot_accrued_after: u64,
}

/// ADR-11: the one-way economics cutover ran. Carries every after value
/// (the immutable fee bps are restated for indexer convenience) and both
/// version numbers; `economics_version` can never move again.
#[event]
pub struct EconomicsMigrated {
    pub from_version: u8,
    pub to_version: u8,
    pub winner_bps: u16,
    pub refund_bps: u16,
    pub fee_bps_admin: u16,
    pub fee_bps_mega: u16,
    pub mega_award_bps: u16,
    pub mega_field_bps: u16,
    pub mega_trigger_modulus: u32,
    pub mega_payout_cap_bps: u32,
    pub account_open_fee_lamports: u64,
}

// ── Phase 12 idle-burn elimination ──

/// An empty `Open` round's deposit window rolled forward in place (Phase
/// 12): same `Round` account, same `RoundVault`, same parked rent — no
/// teardown, no reopen, no state change. The idle-burn fix's on-chain
/// footprint: one 5 000-lamport transaction instead of a
/// 4 128 360-lamport close/open pair. `reason` distinguishes who rolled —
/// see the `ROLL_REASON_*` constants.
#[event]
pub struct RoundWindowRolled {
    pub round_id: u64,
    /// The new window start — `now` at roll time (R2: both timestamps
    /// move, so `crank_auto_deposit`'s window and the anti-snipe absolute
    /// cap stay meaningful).
    pub start_ts: i64,
    /// The new window end — `now + config.round_duration_secs`.
    pub end_ts: i64,
    /// `0` = rolled by `lock_round` (keeper or community crank);
    /// `1` = revived by `deposit` (the first bettor's own transaction).
    pub reason: u8,
}

/// AUDIT P-3: every `update_config` emits the effective values of the
/// levers that matter to players, so indexers and players can see changes.
#[event]
pub struct ConfigUpdated {
    pub admin: Pubkey,
    pub round_duration_secs: i64,
    pub claim_deadline_secs: i64,
    pub min_deposit_lamports: u64,
    pub keeper_tip_lamports: u64,
    pub randomness_reveal_deadline_slots: u64,
    pub oracle_queue: Pubkey,
    pub auto_deposit_tip_lamports: u64,
    pub auto_deposit_enabled: bool,
    pub account_open_fee_lamports: u64,
}

/// AUDIT P-3: pause / unpause is public.
#[event]
pub struct PauseToggled {
    pub admin: Pubkey,
    pub paused: bool,
}

/// Randomness fallback: the admin set (or rotated) the entropy chain.
#[event]
pub struct EntropyChainSet {
    pub admin: Pubkey,
    pub commit: [u8; 32],
    pub remaining: u64,
}

/// Randomness fallback: a round's entropy was revealed. Carries every
/// input, so anyone can recompute `value` and check `sha256(seed)` against
/// the previous commit.
#[event]
pub struct EntropyRevealed {
    pub round_id: u64,
    pub seed: [u8; 32],
    pub slot: u64,
    pub slot_hash: [u8; 32],
    pub value: [u8; 32],
}

/// Randomness fallback: the provider for NEW rounds changed.
#[event]
pub struct OracleProviderChanged {
    pub admin: Pubkey,
    /// `0 = Switchboard`, `1 = Orao`, `2 = Entropy`.
    pub provider: u8,
}
