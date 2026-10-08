//! Cross-language account/event layout fixture (Phase 7.0).
//!
//! Single writer and single verifier of
//! `packages/sdk/tests/fixtures/account_layouts.json`: serializes
//! known-value instances of the four client-relevant accounts and three
//! client-relevant events to hex, alongside the expected decoded values as
//! JSON. The TypeScript decoder suite reads the same file — so every byte
//! offset the SDK pins is proven against Rust's own borsh writer, never
//! against a hand-counted layout (the same ADR-9 discipline as the entropy
//! KAT fixture: Rust generates, TS only reads).
//!
//! Like `entropy_kat`, this test regenerates the fixture when absent and
//! asserts byte-for-byte equality when present, so any struct change that
//! survives the size-lock tests still fails loudly here until the fixture
//! is deliberately regenerated.

use crate::events::{
    AccountOpened, AutoDeposited, Deposited, EconomicsMigrated, EntryRefundPaid, EntryRefunded,
    EscrowDepleted, EscrowFunded, EscrowWithdrawn, FeesSwept, MegaPotContribution,
    MegaPotDrainedPreflight, MegaPotTriggered, PrizeClaimed, RandomnessCommitted,
    RandomnessRequested, RoundCancelled, RoundDustSwept, RoundLocked, RoundOpened, RoundSettled,
    RoundWindowRolled, UnclaimedPrizeSwept,
};
use crate::state::{
    GlobalConfig, MegaPotVault, OracleProvider, PlayerEntry, PlayerEscrow, Round, RoundState,
};

use anchor_lang::prelude::Pubkey;
use anchor_lang::{Discriminator, Event};
use borsh::BorshSerialize;
use serde_json::{json, Value};

/// Distinct constant pubkeys so a shifted offset decodes to a visibly wrong
/// key instead of a plausible one.
fn key(byte: u8) -> Pubkey {
    Pubkey::new_from_array([byte; 32])
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn global_config() -> GlobalConfig {
    GlobalConfig {
        admin: key(0x11),
        pending_admin: Some(key(0x22)),
        treasury_authority: key(0x33),
        oracle_program_id: key(0x44),
        oracle_queue: key(0x45),
        fee_bps_admin: 100,
        fee_bps_mega: 100,
        // Phase 11 canonical economics: a coherent version-2 config.
        winner_bps: 900,
        refund_bps: 8_900,
        mega_award_bps: 5_000,
        mega_field_bps: 4_000,
        mega_trigger_modulus: 625,
        mega_payout_cap_bps: 80_000,
        account_open_fee_lamports: 10_000_000,
        economics_version: 2,
        max_entries_per_round: 500,
        round_duration_secs: 300,
        max_round_duration_secs: 600,
        anti_snipe_window_secs: 30,
        anti_snipe_extension_secs: 15,
        claim_deadline_secs: 2_592_000,
        min_deposit_lamports: 10_000_000,
        anti_snipe_min_deposit_lamports: 100_000_000,
        keeper_tip_lamports: 1_000_000,
        randomness_reveal_deadline_slots: 400,
        active_round_id: 7,
        next_round_id: 8,
        oracle_provider: OracleProvider::Switchboard,
        paused: false,
        bump: 254,
        auto_deposit_window_secs: 20,
        auto_deposit_tip_lamports: 200_000,
        auto_deposit_enabled: true,
        reserved: [0xAB; 30],
    }
}

fn round() -> Round {
    Round {
        round_id: 7,
        state: RoundState::Settled,
        // Negative i64: an unsigned read in the SDK decoder must fail this field.
        start_ts: -1_700_000_001,
        end_ts: 1_700_000_002,
        lock_ts: 1_700_000_003,
        lock_slot: 2_700_000_004,
        settle_ts: 1_700_000_005,
        // Above Number.MAX_SAFE_INTEGER: any float detour loses digits.
        total_lamports: 123_456_789_012_345_678,
        entry_count: 3,
        entries_closed: 1,
        first_depositor: key(0x55),
        single_depositor: false,
        randomness_account: key(0x66),
        randomness_commit_slot: 2_700_000_006,
        randomness_seed_slot: 2_700_000_007,
        winning_ticket: 98_765_432_101_234_567,
        winner: key(0x77),
        winner_payout: 121_212_121_212_121_212,
        admin_cut: 1_234_567_890_123_456,
        mega_cut: 1_234_567_890_123_457,
        mega_awarded: 90_000_000_000_000_000,
        vault_owed: 121_212_121_212_121_213,
        mega_triggered: true,
        prize_claimed: false,
        vault_bump: 253,
        bump: 255,
        // Phase 11 pool accounting: distinctive large values (above
        // Number.MAX_SAFE_INTEGER — a float detour must lose digits), with
        // the paid counters strictly inside their pools (I20) and the
        // refund pool consistent with the split fields above.
        refund_pool: 109_890_109_890_109_890,
        refunds_paid: 10_989_010_989_010_989,
        mega_field_pool: 48_888_488_884_888_488,
        mega_field_paid: 4_888_848_888_488_848,
        // Phase 12: the former `reserved` padding, repurposed in place —
        // same bytes (`[0xBC; 32]`), so the fixture hex does not move.
        rent_payer: Pubkey::new_from_array([0xBC; 32]),
    }
}

fn player_entry() -> PlayerEntry {
    PlayerEntry {
        round_id: 7,
        entry_index: 2,
        player: key(0x88),
        amount: 5_550_000_000,
        ticket_start: 100_000_000_000,
        ticket_end: 105_550_000_000,
        deposit_ts: 1_700_000_010,
        deposit_slot: 2_700_000_011,
        bump: 252,
        reserved: [0xCD; 16],
    }
}

fn player_escrow() -> PlayerEscrow {
    PlayerEscrow {
        owner: key(0xEF),
        // Large u64s (above Number.MAX_SAFE_INTEGER, where a float detour
        // loses digits) and a `true` bool — the struct holds no i64.
        per_round_lamports: 123_456_789_012_345,
        max_rounds: 40,
        rounds_remaining: 37,
        next_eligible_round_id: 987_654_321,
        rounds_funded: 3,
        lifetime_deposited: 4_999_999_999_999_999,
        lifetime_staked: 370_370_367_037_035,
        auto_reinvest: true,
        bump: 250,
        reserved: [0xEE; 32],
    }
}

fn mega_pot_vault() -> MegaPotVault {
    MegaPotVault {
        accrued_lamports: 888_888_888_888_888,
        lifetime_contributed: 999_999_999_999_999,
        lifetime_awarded: 777_777_777_777,
        trigger_count: 3,
        last_trigger_round_id: 5,
        cycle_index: 2,
        bump: 251,
        reserved: [0xDE; 32],
    }
}

fn round_settled_event() -> RoundSettled {
    RoundSettled {
        round_id: 7,
        winning_ticket: 98_765_432_101_234_567,
        total_lamports: 123_456_789_012_345_678,
        winner_payout: 121_212_121_212_121_212,
        refund_pool: 109_890_109_890_109_890,
        admin_cut: 1_234_567_890_123_456,
        mega_cut: 1_234_567_890_123_457,
        mega_triggered: true,
        mega_awarded: 90_000_000_000_000_000,
        mega_field_pool: 48_888_488_884_888_488,
        mega_pot_remaining: 788_888_888_888_888,
        randomness_seed_slot: 2_700_000_007,
        randomness_value: [0x5A; 32],
    }
}

fn deposited_event() -> Deposited {
    Deposited {
        round_id: 7,
        entry_index: 2,
        player: key(0x88),
        amount: 5_550_000_000,
        ticket_start: 100_000_000_000,
        ticket_end: 105_550_000_000,
        round_total: 105_550_000_000,
        new_end_ts: 1_700_000_012,
        extended: true,
    }
}

fn mega_pot_triggered_event() -> MegaPotTriggered {
    MegaPotTriggered {
        round_id: 7,
        cycle_index: 2,
        awarded: 90_000_000_000_000_000,
        field_pool: 48_888_488_884_888_488,
        retained: 888_888_888_888_888,
    }
}

fn round_opened_event() -> RoundOpened {
    RoundOpened {
        round_id: 7,
        start_ts: 1_700_000_020,
        end_ts: 1_700_000_320,
    }
}

fn round_locked_event() -> RoundLocked {
    RoundLocked {
        round_id: 7,
        lock_ts: 1_700_000_021,
        lock_slot: 2_700_000_008,
        total_lamports: 123_456_789_012_345_678,
        entry_count: 3,
    }
}

fn randomness_requested_event() -> RandomnessRequested {
    RandomnessRequested {
        round_id: 7,
        randomness_account: key(0x99),
        commit_slot: 2_700_000_009,
    }
}

fn randomness_committed_event() -> RandomnessCommitted {
    RandomnessCommitted {
        round_id: 7,
        randomness_account: key(0x99),
        oracle: key(0x9A),
        seed_slot: 2_700_000_010,
    }
}

fn prize_claimed_event() -> PrizeClaimed {
    PrizeClaimed {
        round_id: 7,
        entry_index: 2,
        winner: key(0x77),
        winning_ticket: 98_765_432_101_234_567,
        winner_payout: 121_212_121_212_121_212,
        mega_awarded: 90_000_000_000_000_000,
    }
}

fn round_cancelled_event() -> RoundCancelled {
    RoundCancelled {
        round_id: 7,
        reason: 2,
    }
}

fn entry_refunded_event() -> EntryRefunded {
    EntryRefunded {
        round_id: 7,
        entry_index: 2,
        player: key(0x88),
        amount: 5_550_000_000,
    }
}

fn mega_pot_contribution_event() -> MegaPotContribution {
    MegaPotContribution {
        round_id: 7,
        amount: 1_234_567_890_123_457,
        accrued_after: 888_888_888_888_888,
    }
}

fn fees_swept_event() -> FeesSwept {
    FeesSwept {
        amount: 1_234_567_890_123_456,
        destination: key(0xAA),
    }
}

fn unclaimed_prize_swept_event() -> UnclaimedPrizeSwept {
    UnclaimedPrizeSwept {
        round_id: 7,
        amount: 121_212_121_212_121_213,
        mega_pot_accrued_after: 888_888_888_888_889,
    }
}

fn escrow_funded_event() -> EscrowFunded {
    EscrowFunded {
        owner: key(0xEF),
        escrow: key(0xF1),
        amount: 1_014_039_600,
        per_round_lamports: 100_000_000,
        max_rounds: 10,
        rounds_remaining: 10,
        auto_reinvest: true,
        total_lamports: 1_015_309_600,
    }
}

fn escrow_withdrawn_event() -> EscrowWithdrawn {
    EscrowWithdrawn {
        owner: key(0xEF),
        escrow: key(0xF1),
        amount: 500_000_000,
        remaining: 1_270_000,
    }
}

fn auto_deposited_event() -> AutoDeposited {
    AutoDeposited {
        round_id: 7,
        entry_index: 2,
        owner: key(0xEF),
        escrow: key(0xF1),
        amount: 100_000_000,
        tip: 200_000,
        entry_rent: 1_203_960,
        ticket_start: 100_000_000_000,
        ticket_end: 100_100_000_000,
        round_total: 100_100_000_000,
        rounds_remaining: 9,
    }
}

fn escrow_depleted_event() -> EscrowDepleted {
    EscrowDepleted {
        owner: key(0xEF),
        escrow: key(0xF1),
        last_round_id: 7,
    }
}

fn entry_refund_paid_event() -> EntryRefundPaid {
    EntryRefundPaid {
        round_id: 7,
        entry_index: 2,
        player: key(0x88),
        amount: 5_550_000_000,
        refund: 4_939_500_000,
        mega_field: 2_220_000_000,
    }
}

fn round_dust_swept_event() -> RoundDustSwept {
    RoundDustSwept {
        round_id: 7,
        amount: 3,
        mega_pot_accrued_after: 888_888_888_888_891,
    }
}

fn account_opened_event() -> AccountOpened {
    AccountOpened {
        owner: key(0xEF),
        escrow: key(0xF1),
        fee_lamports: 10_000_000,
        rent_lamports: 1_740_000,
        mega_pot_accrued_after: 888_888_888_898_888,
    }
}

fn economics_migrated_event() -> EconomicsMigrated {
    EconomicsMigrated {
        from_version: 0,
        to_version: 2,
        winner_bps: 900,
        refund_bps: 8_900,
        fee_bps_admin: 100,
        fee_bps_mega: 100,
        mega_award_bps: 5_000,
        mega_field_bps: 4_000,
        mega_trigger_modulus: 625,
        mega_payout_cap_bps: 80_000,
        account_open_fee_lamports: 10_000_000,
    }
}

fn mega_pot_drained_preflight_event() -> MegaPotDrainedPreflight {
    MegaPotDrainedPreflight {
        amount: 3_069_000_000,
        destination_treasury: key(0xC3),
        mega_pot_accrued_after: 0,
    }
}

fn round_window_rolled_event() -> RoundWindowRolled {
    RoundWindowRolled {
        round_id: 7,
        start_ts: 1_700_000_030,
        end_ts: 1_700_000_330,
        // ROLL_REASON_FIRST_DEPOSIT — the first bettor's own revival.
        reason: 1,
    }
}

fn expected_global_config() -> Value {
    let c = global_config();
    json!({
        "admin": c.admin.to_string(),
        "pendingAdmin": c.pending_admin.map(|k| k.to_string()),
        "treasuryAuthority": c.treasury_authority.to_string(),
        "oracleProgramId": c.oracle_program_id.to_string(),
        "oracleQueue": c.oracle_queue.to_string(),
        "feeBpsAdmin": c.fee_bps_admin,
        "feeBpsMega": c.fee_bps_mega,
        "winnerBps": c.winner_bps,
        "refundBps": c.refund_bps,
        "megaAwardBps": c.mega_award_bps,
        "megaFieldBps": c.mega_field_bps,
        "megaTriggerModulus": c.mega_trigger_modulus,
        "megaPayoutCapBps": c.mega_payout_cap_bps,
        "accountOpenFeeLamports": c.account_open_fee_lamports.to_string(),
        "economicsVersion": c.economics_version,
        "maxEntriesPerRound": c.max_entries_per_round,
        "roundDurationSecs": c.round_duration_secs.to_string(),
        "maxRoundDurationSecs": c.max_round_duration_secs.to_string(),
        "antiSnipeWindowSecs": c.anti_snipe_window_secs.to_string(),
        "antiSnipeExtensionSecs": c.anti_snipe_extension_secs.to_string(),
        "claimDeadlineSecs": c.claim_deadline_secs.to_string(),
        "minDepositLamports": c.min_deposit_lamports.to_string(),
        "antiSnipeMinDepositLamports": c.anti_snipe_min_deposit_lamports.to_string(),
        "keeperTipLamports": c.keeper_tip_lamports.to_string(),
        "randomnessRevealDeadlineSlots": c.randomness_reveal_deadline_slots.to_string(),
        "activeRoundId": c.active_round_id.to_string(),
        "nextRoundId": c.next_round_id.to_string(),
        "oracleProvider": "switchboard",
        "paused": c.paused,
        "bump": c.bump,
        "autoDepositWindowSecs": c.auto_deposit_window_secs.to_string(),
        "autoDepositTipLamports": c.auto_deposit_tip_lamports.to_string(),
        "autoDepositEnabled": c.auto_deposit_enabled,
    })
}

fn expected_round() -> Value {
    let r = round();
    json!({
        "roundId": r.round_id.to_string(),
        "state": "settled",
        "startTs": r.start_ts.to_string(),
        "endTs": r.end_ts.to_string(),
        "lockTs": r.lock_ts.to_string(),
        "lockSlot": r.lock_slot.to_string(),
        "settleTs": r.settle_ts.to_string(),
        "totalLamports": r.total_lamports.to_string(),
        "entryCount": r.entry_count,
        "entriesClosed": r.entries_closed,
        "firstDepositor": r.first_depositor.to_string(),
        "singleDepositor": r.single_depositor,
        "randomnessAccount": r.randomness_account.to_string(),
        "randomnessCommitSlot": r.randomness_commit_slot.to_string(),
        "randomnessSeedSlot": r.randomness_seed_slot.to_string(),
        "winningTicket": r.winning_ticket.to_string(),
        "winner": r.winner.to_string(),
        "winnerPayout": r.winner_payout.to_string(),
        "adminCut": r.admin_cut.to_string(),
        "megaCut": r.mega_cut.to_string(),
        "megaAwarded": r.mega_awarded.to_string(),
        "vaultOwed": r.vault_owed.to_string(),
        "refundPool": r.refund_pool.to_string(),
        "refundsPaid": r.refunds_paid.to_string(),
        "megaFieldPool": r.mega_field_pool.to_string(),
        "megaFieldPaid": r.mega_field_paid.to_string(),
        "megaTriggered": r.mega_triggered,
        "prizeClaimed": r.prize_claimed,
        "vaultBump": r.vault_bump,
        "bump": r.bump,
        "rentPayer": r.rent_payer.to_string(),
    })
}

fn expected_player_entry() -> Value {
    let e = player_entry();
    json!({
        "roundId": e.round_id.to_string(),
        "entryIndex": e.entry_index,
        "player": e.player.to_string(),
        "amountLamports": e.amount.to_string(),
        "ticketStart": e.ticket_start.to_string(),
        "ticketEnd": e.ticket_end.to_string(),
        "depositTs": e.deposit_ts.to_string(),
        "depositSlot": e.deposit_slot.to_string(),
        "bump": e.bump,
    })
}

fn expected_player_escrow() -> Value {
    let e = player_escrow();
    json!({
        "owner": e.owner.to_string(),
        "perRoundLamports": e.per_round_lamports.to_string(),
        "maxRounds": e.max_rounds,
        "roundsRemaining": e.rounds_remaining,
        "nextEligibleRoundId": e.next_eligible_round_id.to_string(),
        "roundsFunded": e.rounds_funded.to_string(),
        "lifetimeDeposited": e.lifetime_deposited.to_string(),
        "lifetimeStaked": e.lifetime_staked.to_string(),
        "autoReinvest": e.auto_reinvest,
        "bump": e.bump,
    })
}

fn expected_mega_pot_vault() -> Value {
    let v = mega_pot_vault();
    json!({
        "accruedLamports": v.accrued_lamports.to_string(),
        "lifetimeContributed": v.lifetime_contributed.to_string(),
        "lifetimeAwarded": v.lifetime_awarded.to_string(),
        "triggerCount": v.trigger_count.to_string(),
        "lastTriggerRoundId": v.last_trigger_round_id.to_string(),
        "cycleIndex": v.cycle_index.to_string(),
        "bump": v.bump,
    })
}

fn expected_round_settled() -> Value {
    let e = round_settled_event();
    json!({
        "roundId": e.round_id.to_string(),
        "winningTicket": e.winning_ticket.to_string(),
        "totalLamports": e.total_lamports.to_string(),
        "winnerPayout": e.winner_payout.to_string(),
        "refundPool": e.refund_pool.to_string(),
        "adminCut": e.admin_cut.to_string(),
        "megaCut": e.mega_cut.to_string(),
        "megaTriggered": e.mega_triggered,
        "megaAwarded": e.mega_awarded.to_string(),
        "megaFieldPool": e.mega_field_pool.to_string(),
        "megaPotRemaining": e.mega_pot_remaining.to_string(),
        "randomnessSeedSlot": e.randomness_seed_slot.to_string(),
        "randomnessValue": hex(&e.randomness_value),
    })
}

fn expected_deposited() -> Value {
    let e = deposited_event();
    json!({
        "roundId": e.round_id.to_string(),
        "entryIndex": e.entry_index,
        "player": e.player.to_string(),
        "amountLamports": e.amount.to_string(),
        "ticketStart": e.ticket_start.to_string(),
        "ticketEnd": e.ticket_end.to_string(),
        "roundTotalLamports": e.round_total.to_string(),
        "newEndTs": e.new_end_ts.to_string(),
        "extended": e.extended,
    })
}

fn expected_mega_pot_triggered() -> Value {
    let e = mega_pot_triggered_event();
    json!({
        "roundId": e.round_id.to_string(),
        "cycleIndex": e.cycle_index.to_string(),
        "awarded": e.awarded.to_string(),
        "fieldPool": e.field_pool.to_string(),
        "retained": e.retained.to_string(),
    })
}

fn expected_round_opened() -> Value {
    let e = round_opened_event();
    json!({
        "roundId": e.round_id.to_string(),
        "startTs": e.start_ts.to_string(),
        "endTs": e.end_ts.to_string(),
    })
}

fn expected_round_locked() -> Value {
    let e = round_locked_event();
    json!({
        "roundId": e.round_id.to_string(),
        "lockTs": e.lock_ts.to_string(),
        "lockSlot": e.lock_slot.to_string(),
        "totalLamports": e.total_lamports.to_string(),
        "entryCount": e.entry_count,
    })
}

fn expected_randomness_requested() -> Value {
    let e = randomness_requested_event();
    json!({
        "roundId": e.round_id.to_string(),
        "randomnessAccount": e.randomness_account.to_string(),
        "commitSlot": e.commit_slot.to_string(),
    })
}

fn expected_randomness_committed() -> Value {
    let e = randomness_committed_event();
    json!({
        "roundId": e.round_id.to_string(),
        "randomnessAccount": e.randomness_account.to_string(),
        "oracle": e.oracle.to_string(),
        "seedSlot": e.seed_slot.to_string(),
    })
}

fn expected_prize_claimed() -> Value {
    let e = prize_claimed_event();
    json!({
        "roundId": e.round_id.to_string(),
        "entryIndex": e.entry_index,
        "winner": e.winner.to_string(),
        "winningTicket": e.winning_ticket.to_string(),
        "winnerPayout": e.winner_payout.to_string(),
        "megaAwarded": e.mega_awarded.to_string(),
    })
}

fn expected_round_cancelled() -> Value {
    let e = round_cancelled_event();
    json!({
        "roundId": e.round_id.to_string(),
        "reason": e.reason,
    })
}

fn expected_entry_refunded() -> Value {
    let e = entry_refunded_event();
    json!({
        "roundId": e.round_id.to_string(),
        "entryIndex": e.entry_index,
        "player": e.player.to_string(),
        "amountLamports": e.amount.to_string(),
    })
}

fn expected_mega_pot_contribution() -> Value {
    let e = mega_pot_contribution_event();
    json!({
        "roundId": e.round_id.to_string(),
        "amountLamports": e.amount.to_string(),
        "accruedAfter": e.accrued_after.to_string(),
    })
}

fn expected_fees_swept() -> Value {
    let e = fees_swept_event();
    json!({
        "amountLamports": e.amount.to_string(),
        "destination": e.destination.to_string(),
    })
}

fn expected_unclaimed_prize_swept() -> Value {
    let e = unclaimed_prize_swept_event();
    json!({
        "roundId": e.round_id.to_string(),
        "amountLamports": e.amount.to_string(),
        "megaPotAccruedAfter": e.mega_pot_accrued_after.to_string(),
    })
}

fn expected_escrow_funded() -> Value {
    let e = escrow_funded_event();
    json!({
        "owner": e.owner.to_string(),
        "escrow": e.escrow.to_string(),
        "amountLamports": e.amount.to_string(),
        "perRoundLamports": e.per_round_lamports.to_string(),
        "maxRounds": e.max_rounds,
        "roundsRemaining": e.rounds_remaining,
        "autoReinvest": e.auto_reinvest,
        "totalLamports": e.total_lamports.to_string(),
    })
}

fn expected_escrow_withdrawn() -> Value {
    let e = escrow_withdrawn_event();
    json!({
        "owner": e.owner.to_string(),
        "escrow": e.escrow.to_string(),
        "amountLamports": e.amount.to_string(),
        "remainingLamports": e.remaining.to_string(),
    })
}

fn expected_auto_deposited() -> Value {
    let e = auto_deposited_event();
    json!({
        "roundId": e.round_id.to_string(),
        "entryIndex": e.entry_index,
        "owner": e.owner.to_string(),
        "escrow": e.escrow.to_string(),
        "amountLamports": e.amount.to_string(),
        "tipLamports": e.tip.to_string(),
        "entryRentLamports": e.entry_rent.to_string(),
        "ticketStart": e.ticket_start.to_string(),
        "ticketEnd": e.ticket_end.to_string(),
        "roundTotalLamports": e.round_total.to_string(),
        "roundsRemaining": e.rounds_remaining,
    })
}

fn expected_escrow_depleted() -> Value {
    let e = escrow_depleted_event();
    json!({
        "owner": e.owner.to_string(),
        "escrow": e.escrow.to_string(),
        "lastRoundId": e.last_round_id.to_string(),
    })
}

fn expected_entry_refund_paid() -> Value {
    let e = entry_refund_paid_event();
    json!({
        "roundId": e.round_id.to_string(),
        "entryIndex": e.entry_index,
        "player": e.player.to_string(),
        "amountLamports": e.amount.to_string(),
        "refundLamports": e.refund.to_string(),
        "megaFieldLamports": e.mega_field.to_string(),
    })
}

fn expected_round_dust_swept() -> Value {
    let e = round_dust_swept_event();
    json!({
        "roundId": e.round_id.to_string(),
        "amountLamports": e.amount.to_string(),
        "megaPotAccruedAfter": e.mega_pot_accrued_after.to_string(),
    })
}

fn expected_account_opened() -> Value {
    let e = account_opened_event();
    json!({
        "owner": e.owner.to_string(),
        "escrow": e.escrow.to_string(),
        "feeLamports": e.fee_lamports.to_string(),
        "rentLamports": e.rent_lamports.to_string(),
        "megaPotAccruedAfter": e.mega_pot_accrued_after.to_string(),
    })
}

fn expected_economics_migrated() -> Value {
    let e = economics_migrated_event();
    json!({
        "fromVersion": e.from_version,
        "toVersion": e.to_version,
        "winnerBps": e.winner_bps,
        "refundBps": e.refund_bps,
        "feeBpsAdmin": e.fee_bps_admin,
        "feeBpsMega": e.fee_bps_mega,
        "megaAwardBps": e.mega_award_bps,
        "megaFieldBps": e.mega_field_bps,
        "megaTriggerModulus": e.mega_trigger_modulus,
        "megaPayoutCapBps": e.mega_payout_cap_bps,
        "accountOpenFeeLamports": e.account_open_fee_lamports.to_string(),
    })
}

fn expected_mega_pot_drained_preflight() -> Value {
    let e = mega_pot_drained_preflight_event();
    json!({
        "amountLamports": e.amount.to_string(),
        "destinationTreasury": e.destination_treasury.to_string(),
        "megaPotAccruedAfter": e.mega_pot_accrued_after.to_string(),
    })
}

fn expected_round_window_rolled() -> Value {
    let e = round_window_rolled_event();
    json!({
        "roundId": e.round_id.to_string(),
        "startTs": e.start_ts.to_string(),
        "endTs": e.end_ts.to_string(),
        "reason": e.reason,
    })
}

/// On-chain account bytes = anchor discriminator ++ borsh struct — exactly
/// what `getAccountInfo` returns.
fn account_hex<T>(account: &T) -> String
where
    T: Discriminator + BorshSerialize,
{
    let mut bytes = T::DISCRIMINATOR.to_vec();
    account
        .try_to_vec()
        .expect("serialize account struct")
        .into_iter()
        .for_each(|b| bytes.push(b));
    hex(&bytes)
}

fn serialize() -> String {
    let config_bytes = global_config()
        .try_to_vec()
        .expect("serialize GlobalConfig");
    let round_bytes = round().try_to_vec().expect("serialize Round");
    let entry_bytes = player_entry().try_to_vec().expect("serialize PlayerEntry");
    let escrow_bytes = player_escrow()
        .try_to_vec()
        .expect("serialize PlayerEscrow");
    let mega_bytes = mega_pot_vault()
        .try_to_vec()
        .expect("serialize MegaPotVault");

    // Account fixtures mirror the on-chain bytes (discriminator included);
    // event fixtures are `Event::data` = discriminator ++ borsh payload —
    // exactly what `emit_cpi!` chains after the event-ix tag on the wire.
    let config_hex = account_hex(&global_config());
    let round_hex = account_hex(&round());
    let entry_hex = account_hex(&player_entry());
    let escrow_hex = account_hex(&player_escrow());
    let mega_hex = account_hex(&mega_pot_vault());
    let settled_bytes = Event::data(&round_settled_event());
    let deposited_bytes = Event::data(&deposited_event());
    let triggered_bytes = Event::data(&mega_pot_triggered_event());
    let opened_bytes = Event::data(&round_opened_event());
    let locked_bytes = Event::data(&round_locked_event());
    let requested_bytes = Event::data(&randomness_requested_event());
    let committed_bytes = Event::data(&randomness_committed_event());
    let claimed_bytes = Event::data(&prize_claimed_event());
    let cancelled_bytes = Event::data(&round_cancelled_event());
    let refunded_bytes = Event::data(&entry_refunded_event());
    let contributed_bytes = Event::data(&mega_pot_contribution_event());
    let swept_bytes = Event::data(&fees_swept_event());
    let unclaimed_bytes = Event::data(&unclaimed_prize_swept_event());
    let escrow_funded_bytes = Event::data(&escrow_funded_event());
    let escrow_withdrawn_bytes = Event::data(&escrow_withdrawn_event());
    let auto_deposited_bytes = Event::data(&auto_deposited_event());
    let escrow_depleted_bytes = Event::data(&escrow_depleted_event());
    let entry_refund_paid_bytes = Event::data(&entry_refund_paid_event());
    let round_dust_swept_bytes = Event::data(&round_dust_swept_event());
    let account_opened_bytes = Event::data(&account_opened_event());
    let economics_migrated_bytes = Event::data(&economics_migrated_event());
    let mega_pot_drained_preflight_bytes = Event::data(&mega_pot_drained_preflight_event());
    let round_window_rolled_bytes = Event::data(&round_window_rolled_event());

    let size_asserts = [
        ("GlobalConfig", config_bytes.len(), 332),
        ("Round", round_bytes.len(), 294),
        ("PlayerEntry", entry_bytes.len(), 101),
        ("PlayerEscrow", escrow_bytes.len(), 114),
        ("MegaPotVault", mega_bytes.len(), 81),
    ];
    for (name, got, want) in size_asserts {
        assert_eq!(
            got, want,
            "{name} serialized to {got} struct bytes; 8-byte discriminator + {want} must hold"
        );
    }

    let fixture = json!({
        "comment": "Byte-exact layout fixture for the TypeScript SDK decoders. \
    Single writer: state/layout_fixture.rs (regenerates when absent, verifies when present). \
    TS reads only — never regenerate from TS.",
        "accounts": {
            "GlobalConfig": { "hex": config_hex, "expected": expected_global_config() },
            "Round": { "hex": round_hex, "expected": expected_round() },
            "PlayerEntry": { "hex": entry_hex, "expected": expected_player_entry() },
            "PlayerEscrow": { "hex": escrow_hex, "expected": expected_player_escrow() },
            "MegaPotVault": { "hex": mega_hex, "expected": expected_mega_pot_vault() },
        },
        "events": {
            "RoundOpened": { "hex": hex(&opened_bytes), "expected": expected_round_opened() },
            "Deposited": { "hex": hex(&deposited_bytes), "expected": expected_deposited() },
            "RoundLocked": { "hex": hex(&locked_bytes), "expected": expected_round_locked() },
            "RandomnessRequested": { "hex": hex(&requested_bytes), "expected": expected_randomness_requested() },
            "RandomnessCommitted": { "hex": hex(&committed_bytes), "expected": expected_randomness_committed() },
            "RoundSettled": { "hex": hex(&settled_bytes), "expected": expected_round_settled() },
            "PrizeClaimed": { "hex": hex(&claimed_bytes), "expected": expected_prize_claimed() },
            "RoundCancelled": { "hex": hex(&cancelled_bytes), "expected": expected_round_cancelled() },
            "EntryRefunded": { "hex": hex(&refunded_bytes), "expected": expected_entry_refunded() },
            "MegaPotContribution": { "hex": hex(&contributed_bytes), "expected": expected_mega_pot_contribution() },
            "MegaPotTriggered": { "hex": hex(&triggered_bytes), "expected": expected_mega_pot_triggered() },
            "FeesSwept": { "hex": hex(&swept_bytes), "expected": expected_fees_swept() },
            "UnclaimedPrizeSwept": { "hex": hex(&unclaimed_bytes), "expected": expected_unclaimed_prize_swept() },
            "EscrowFunded": { "hex": hex(&escrow_funded_bytes), "expected": expected_escrow_funded() },
            "EscrowWithdrawn": { "hex": hex(&escrow_withdrawn_bytes), "expected": expected_escrow_withdrawn() },
            "AutoDeposited": { "hex": hex(&auto_deposited_bytes), "expected": expected_auto_deposited() },
            "EscrowDepleted": { "hex": hex(&escrow_depleted_bytes), "expected": expected_escrow_depleted() },
            "EntryRefundPaid": { "hex": hex(&entry_refund_paid_bytes), "expected": expected_entry_refund_paid() },
            "RoundDustSwept": { "hex": hex(&round_dust_swept_bytes), "expected": expected_round_dust_swept() },
            "AccountOpened": { "hex": hex(&account_opened_bytes), "expected": expected_account_opened() },
            "EconomicsMigrated": { "hex": hex(&economics_migrated_bytes), "expected": expected_economics_migrated() },
            "MegaPotDrainedPreflight": { "hex": hex(&mega_pot_drained_preflight_bytes), "expected": expected_mega_pot_drained_preflight() },
            "RoundWindowRolled": { "hex": hex(&round_window_rolled_bytes), "expected": expected_round_window_rolled() },
        },
    });
    serde_json::to_string_pretty(&fixture).expect("fixture json serializes")
}

#[test]
fn account_layout_fixture_matches_canonical_serialization() {
    let canonical = serialize();
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/sdk/tests/fixtures/account_layouts.json");
    match std::fs::read_to_string(&path) {
        Ok(committed) => assert_eq!(
            committed.trim_end(),
            canonical,
            "committed layout fixture diverged from Rust serialization; a struct \
             layout changed — delete the file and rerun to regenerate deliberately"
        ),
        Err(_) => {
            std::fs::create_dir_all(path.parent().expect("fixture dir has a parent"))
                .expect("create fixture dir");
            std::fs::write(&path, &canonical).expect("write layout fixture");
        }
    }
}
